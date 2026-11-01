/**
 * PDF text extraction for the host half: pdf.js (legacy build) on the Node
 * main thread, page labels, per-page text + geometry (`domain/text.ts`
 * `PageText`), an LRU of parsed documents keyed by `path:mtime:size`, and the
 * `%PDF-` magic check.
 *
 * pdf.js is loaded lazily (dynamic `import()` of the packaged legacy build)
 * so importing this module — and therefore the whole host half — never pulls
 * the multi-megabyte pdf.js body unless a PDF is actually parsed.
 *
 * Distribution: the build copies `pdfjs-dist`'s legacy `pdf.mjs` +
 * `pdf.worker.mjs` and the `cmaps` / `standard_fonts` / `wasm` data into
 * `lib/pdfjs/` (shipped via the npm `files` list). At runtime the packaged
 * copy under `lib/pdfjs/legacy/` is preferred; the `node_modules` copy is a
 * dev/test fallback so `vitest` runs before a build. Nothing depends on a
 * developer's `node_modules` layout in production.
 *
 * Attribution: adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/pdf/extract.ts` (repo LICENSE: Apache-2.0). Modifications: pdf.js is
 * dynamically imported from the packaged asset directory instead of a static
 * import of `pdfjs-dist` (which keeps it out of the host module graph and
 * makes the npm package self-contained); `LIMITS` come from
 * `domain/model.ts`; the worker/CMap wiring is equivalent. See
 * THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/pdf/extract
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LIMITS, ZoteroError } from '../domain/model.ts'
import { buildPage, type PageText, type TextItem } from '../domain/text.ts'

/** Directory of the compiled host bundle (`lib/`), for the packaged assets. */
const LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Locate the pdf.js CMap/standard-font/wasm data directory. Packaged runs use
 * `lib/pdfjs`; dev/test runs fall back to the `pdfjs-dist` package inside
 * `node_modules`. Returns a path WITH a trailing separator (pdf.js requires a
 * trailing "/" and does not accept "\"), or `null` — without it, CID/CJK text
 * extraction degrades.
 */
export function pdfjsDataDir(hint?: string): string | null {
  const candidates: string[] = []
  if (hint !== undefined) candidates.push(hint)
  candidates.push(join(LIB_DIR, 'pdfjs'))
  try {
    const require = createRequire(import.meta.url)
    candidates.push(dirname(require.resolve('pdfjs-dist/package.json')))
  } catch {
    // Packaged installs have no node_modules; the lib copy covers them.
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'cmaps'))) return resolve(candidate) + sep
  }
  return null
}

/** `getDocument` CMap/standard-font URLs (pdf.js requires the trailing "/"). */
export function pdfjsFactoryUrls(dataDir: string) {
  return { cMapUrl: `${dataDir}cmaps/`, standardFontDataUrl: `${dataDir}standard_fonts/`, wasmUrl: `${dataDir}wasm/` }
}

// ---------------------------------------------------------------------------
// Lazy pdf.js module loading (packaged copy first, node_modules fallback)
// ---------------------------------------------------------------------------

/** Minimal structural face of the pdf.js API surface this module touches. */
export interface PdfJsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocumentProxy>; destroy(): Promise<void> }
}

export interface PdfPageProxy {
  view: number[]
  getTextContent(): Promise<{ items: unknown[] }>
  cleanup(): void
}

export interface PdfDocumentProxy {
  numPages: number
  getPageLabels(): Promise<string[] | null>
  getPage(pageNumber: number): Promise<PdfPageProxy>
}

interface PdfJsWorkerModule {
  WorkerMessageHandler?: unknown
}

let pdfjsPromise: Promise<PdfJsModule> | null = null

function legacyEntryCandidates(): string[] {
  return [
    // Packaged (shipped inside the npm files list).
    join(LIB_DIR, 'pdfjs', 'legacy', 'pdf.mjs'),
    // Dev/test fallback before (or without) a build.
    (() => {
      try {
        return join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'legacy', 'build', 'pdf.mjs')
      } catch {
        return join(LIB_DIR, 'pdfjs', 'legacy', 'pdf.mjs')
      }
    })(),
  ]
}

/** Import pdf.js once; the worker part runs on the main thread (no Worker in Node). */
export function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= (async () => {
    let lastError: unknown = new Error('no pdf.js legacy build found')
    for (const candidate of legacyEntryCandidates()) {
      if (!existsSync(candidate)) continue
      try {
        const pdfjs = (await import(/* @vite-ignore */ pathToFileURL(candidate).href)) as PdfJsModule & Record<string, unknown>
        const worker = (await import(/* @vite-ignore */ pathToFileURL(join(dirname(candidate), 'pdf.worker.mjs')).href)) as PdfJsWorkerModule
        ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
        return pdfjs
      } catch (error) {
        lastError = error
      }
    }
    throw new ZoteroError('internal', `Could not load the pdf.js library: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  })()
  pdfjsPromise.catch(() => {
    pdfjsPromise = null // allow a retry after a fix/rebuild
  })
  return pdfjsPromise
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface PdfText {
  pageCount: number
  pages: PageText[]
  sha256: string
  bytes: number
}

export async function extractPdf(data: Uint8Array, dataDir: string | null): Promise<PdfText> {
  const sha256 = createHash('sha256').update(data).digest('hex')
  const pdfjs = await loadPdfjs()
  // pdf.js may transfer (detach) the buffer it is given, so hand it a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    ...(dataDir !== null ? { ...pdfjsFactoryUrls(dataDir), cMapPacked: true } : {}),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  })
  let doc: PdfDocumentProxy
  try {
    doc = await task.promise
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'PasswordException') throw new ZoteroError('not_pdf', 'The PDF is password-protected.')
    throw new ZoteroError('not_pdf', `Could not read the PDF: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const labels = await doc.getPageLabels().catch(() => null)
    const pages: PageText[] = []
    for (let index = 0; index < doc.numPages; index++) {
      const page = await doc.getPage(index + 1)
      const [x1 = 0, y1 = 0, x2 = 612, y2 = 792] = page.view
      const content = await page.getTextContent()
      const label = labels?.[index]
      pages.push(
        buildPage(content.items as TextItem[], {
          index,
          label: label !== undefined && label !== '' ? label : String(index + 1),
          width: x2 - x1,
          height: y2 - y1,
          originX: x1,
          originY: y1,
        }),
      )
      page.cleanup()
    }
    return { pageCount: doc.numPages, pages, sha256, bytes: data.length }
  } finally {
    await task.destroy()
  }
}

/** `%PDF-` may sit anywhere in the first 1 KB. */
export function isPdf(data: Uint8Array): boolean {
  const head = Buffer.from(data.subarray(0, 1024)).toString('latin1')
  return head.includes('%PDF-')
}

// ---------------------------------------------------------------------------
// PdfStore: LRU of parsed documents keyed by path + mtime + size
// ---------------------------------------------------------------------------

interface PdfStoreEntry {
  stamp: string
  text: Promise<PdfText>
  bytes?: Uint8Array
}

/** Parsed-PDF cache; invalidated whenever the file's mtime or size changes. */
export class PdfStore {
  private cache = new Map<string, PdfStoreEntry>()

  constructor(
    private readonly dataDir: string | null = pdfjsDataDir(),
    private readonly capacity: number = LIMITS.pdfCache,
  ) {}

  /** Size/mtime stamp; throws `file_missing` / size-cap `not_pdf`. */
  private async stamp(path: string): Promise<string> {
    const info = await stat(path).catch(() => {
      throw new ZoteroError('file_missing', `The attachment file is missing on disk (${path}). It may not have been synced or downloaded yet.`)
    })
    if (info.size > LIMITS.pdfMaxBytes) {
      throw new ZoteroError('not_pdf', `The PDF is too large (${Math.round(info.size / 1024 / 1024)} MB).`)
    }
    return `${info.mtimeMs}:${info.size}`
  }

  private remember(path: string, entry: PdfStoreEntry): void {
    entry.text.catch(() => undefined) // nobody may be attached yet; swallow the rejection
    this.cache.delete(path)
    this.cache.set(path, entry)
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async readAndCheck(path: string): Promise<Uint8Array> {
    const data = new Uint8Array(await readFile(path))
    if (!isPdf(data)) throw new ZoteroError('not_pdf', 'The attachment file is not a PDF.')
    return data
  }

  /** Cached parsed text for `path`, re-extracting when the file changed. */
  async text(path: string): Promise<PdfText> {
    const stamp = await this.stamp(path)
    const entry = this.cache.get(path)
    if (entry !== undefined && entry.stamp === stamp) {
      this.cache.delete(path)
      this.cache.set(path, entry) // LRU refresh
      return entry.text
    }
    const data = await this.readAndCheck(path)
    const text = extractPdf(data, this.dataDir)
    this.remember(path, { stamp, text, bytes: data })
    text.catch(() => {
      const current = this.cache.get(path)
      if (current !== undefined && current.text === text) this.cache.delete(path)
    })
    return text
  }

  /** File bytes (cached alongside the parsed text when it is fresh). */
  async bytes(path: string): Promise<Uint8Array> {
    const stamp = await this.stamp(path)
    const entry = this.cache.get(path)
    if (entry !== undefined && entry.stamp === stamp && entry.bytes !== undefined) return entry.bytes
    const data = await this.readAndCheck(path)
    if (entry !== undefined && entry.stamp === stamp) entry.bytes = data
    else this.remember(path, { stamp, text: extractPdf(data, this.dataDir), bytes: data })
    return data
  }
}
