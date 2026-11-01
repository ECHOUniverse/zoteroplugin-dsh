/**
 * `ZoteroSession` — the host-half facade every consumer (routes, Agent
 * tools) goes through instead of importing `zotero/*` directly
 * (implementation spec §10.4). It composes:
 *
 * - `ZoteroLocalClient` (probe/authorize/write transport, the only owner of
 *   the key),
 * - `ZoteroLibrary` (read projections and caches),
 * - `ZoteroWrites` (the single write path, spec red line),
 * - `HostPdfService` + `PdfStore` (M4: verified PDF file access, parsed page
 *   text),
 * - the `HighlightStore` (in-session Agent highlights) and
 * - a durable `KeyStore` over the official credentials seam (falling back to
 *   in-memory when the profile has no credential service),
 * - the `ViewEventHub` behind the SSE `/events` channel.
 *
 * M7 adds the desktop/metadata side: DOI/arXiv import (`addItem`, duplicate
 * detection via read-only Local API queries, SSRF-guarded PDF downloads
 * through the same `ZoteroWrites` attach flow), the desktop install probe /
 * launch / `zotero://` deep-link open (spawn-whitelisted), and the official
 * workspace-file write for `export_bib` (`ctx.fs` + `ctx.workingDirectory`).
 *
 * Configuration hot updates: `config.localApiBaseUrl` is a live volatile
 * reference. `ensureCurrent` compares it with the active client on every
 * consumer entry point and, on a change, safely rebuilds the stack — the
 * old client (with any in-memory one-time key) is dropped, remembered keys
 * survive because they live in the `KeyStore` keyed by `Zotero-Server-ID`.
 * A non-loopback URL is rejected by the client constructor (`invalid_input`)
 * and leaves the previous stack untouched: the client half can never inject
 * an arbitrary Zotero URL through the config form.
 *
 * Host-service late binding: composition services may activate (or cycle)
 * long after this session was assembled by `apply`. `attachServices` /
 * `detachServices` reconcile that at runtime — a `credentials` face takes
 * effect through the same safe client rebuild as a base-URL hot update (the
 * durable `KeyStore` goes live before the next write; unbinding falls back
 * to the in-memory store without copying key material out of the credential
 * records), and `fs`/`workingDirectory` switch `export_bib` between real
 * workspace writes and the text-only degrade.
 *
 * Highlights are session state of the PLUGIN process (one store per host
 * session), filtered per library/attachment in the accessors.
 *
 * @module @hanxu131/dsh-zotero/host/session
 */

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findQuote, pageIndexFor, rectsFor, sortIndex, textAt, type PageText } from '../domain/text.ts'
import { bestPdfKeyOf } from '../domain/items.ts'
import { resolveColor, ZoteroError, type AgentHighlight, type ConnectionStatus, type LibraryId, type ZoteroInstall } from '../domain/model.ts'
import { downloadPdf, parseIdentifier, resolveIdentifier, zoteroFilename, type FetchLike, type LookupLike, type MetadataNetOptions, type NewItem } from '../metadata/metadata.ts'
import { MemoryKeyStore } from '../zotero/auth.ts'
import { assertLoopbackBaseUrl, ZoteroLocalClient, type ZoteroLocalClientOptions } from '../zotero/client.ts'
import { ZoteroLibrary } from '../zotero/library.ts'
import { ZoteroWrites } from '../zotero/writes.ts'
import { launchZotero, findZotero } from '../zotero/install.ts'
import { openZoteroUrl, zoteroDesktopUrl, type DesktopTarget } from '../zotero/desktop.ts'
import { createViewEventHub, type ViewEventHub } from './events.ts'
import { HighlightStore } from './highlights.ts'
import { CredentialsKeyStore } from './keystore.ts'
import { HostPdfService } from './pdf.ts'
import type { CredentialsFace, FsFace, WorkingDirectoryFace } from './services.ts'
import { PdfStore, pdfjsDataDir } from '../pdf/extract.ts'

/** Live config reference (`Volatile<string>` from cordis/cosmokit). */
export interface VolatileRef<T> {
  get(): T
}

export interface ZoteroSessionOptions {
  /** Live base-URL reference (volatile config field). */
  baseUrl: VolatileRef<string>
  /** Credentials service for durable keys; undefined → in-memory keys. */
  credentials?: CredentialsFace
  /** Application name shown in Zotero's authorization dialog. */
  appName?: string
  /** Transport override for tests. */
  fetch?: ZoteroLocalClientOptions['fetch']
  /** Override for the packaged pdf.js asset dir (tests). */
  pdfAssetDir?: string | null
  /** Desktop install probe override (tests; default: real filesystem). */
  findApp?: () => Promise<ZoteroInstall>
  /** Zotero launcher override (tests; default: whitelisted spawn). */
  launchApp?: () => Promise<string>
  /** Deep-link opener override (tests; default: whitelisted spawn). */
  openLink?: (url: string) => Promise<void>
  /**
   * Transport seam for the M7 metadata/PDF downloads (doi.org, arXiv and
   * caller-supplied PDF links). Production leaves both undefined — the
   * SSRF-guarded default fetcher + DNS resolver run; tests inject fakes so
   * no real external request is ever executed.
   */
  metadataFetch?: FetchLike
  /** DNS seam for the metadata SSRF guard (tests inject; default dns.lookup). */
  metadataLookup?: LookupLike
  /** Official filesystem service (`ctx.fs`) for workspace writes. */
  fs?: FsFace
  /** Official working-directory service (workspace root source). */
  workingDirectory?: WorkingDirectoryFace
}

/** Services that can be (re)bound while the session is live (`attachServices`). */
export interface LateHostServices {
  /** Official credentials face → the durable `KeyStore` goes live. */
  credentials?: CredentialsFace
  /** Official fs face → real workspace writes. */
  fs?: FsFace
  /** Official working-directory face → `export_bib` resolves its cwd. */
  workingDirectory?: WorkingDirectoryFace
}

/** Service names `detachServices` can unbind back to the degraded state. */
export type DetachableService = 'credentials' | 'fs' | 'workingDirectory'

export class ZoteroSession {
  private readonly baseUrlRef: VolatileRef<string>
  private credentialsFace: CredentialsFace | undefined
  private readonly appName: string
  private readonly fetchImpl: ZoteroLocalClientOptions['fetch'] | undefined
  private readonly pdfAssetDir: string | null
  private readonly findAppImpl: () => Promise<ZoteroInstall>
  private readonly launchAppImpl: () => Promise<string>
  private readonly openLinkImpl: (url: string) => Promise<void>
  private readonly metadataNet: MetadataNetOptions
  private fsFace: FsFace | undefined
  private workingDirectoryFace: WorkingDirectoryFace | undefined
  private clientValue: ZoteroLocalClient
  private readonly hub: ViewEventHub
  /** Agent highlights of this host session (all libraries). */
  readonly highlights = new HighlightStore()
  private installCache: ZoteroInstall | null = null
  /** Set by attach/detach: the KeyStore changed and the client must be rebuilt. */
  private pendingClientRebuild = false

  constructor(options: ZoteroSessionOptions) {
    this.baseUrlRef = options.baseUrl
    this.credentialsFace = options.credentials
    this.appName = options.appName ?? 'DSH Zotero'
    this.fetchImpl = options.fetch
    this.pdfAssetDir =
      options.pdfAssetDir === undefined ? resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/pdfjs') : options.pdfAssetDir
    this.findAppImpl = options.findApp ?? (() => findZotero())
    this.launchAppImpl = options.launchApp ?? (() => launchZotero())
    this.openLinkImpl = options.openLink ?? ((url) => openZoteroUrl(url).then(() => undefined))
    this.metadataNet = {
      ...(options.metadataFetch !== undefined ? { fetchImpl: options.metadataFetch } : {}),
      ...(options.metadataLookup !== undefined ? { lookup: options.metadataLookup } : {}),
    }
    this.fsFace = options.fs
    this.workingDirectoryFace = options.workingDirectory
    this.clientValue = this.buildClient(assertLoopbackOrThrow(this.baseUrlRef.get()))
    this.hub = createViewEventHub()
  }

  /** Active client (rebuilt transparently when the configured URL changes). */
  get client(): ZoteroLocalClient {
    this.ensureCurrent()
    return this.clientValue
  }

  /** Read projections and caches over the active client. */
  get library(): ZoteroLibrary {
    return this.libraryValue(this.client)
  }

  /** The single write path (spec red line) over the active client. */
  get writes(): ZoteroWrites {
    return this.writesValue(this.client)
  }

  /** PDF file service over the active library layer (M4). */
  get pdf(): HostPdfService {
    return this.pdfValue()
  }

  /** View navigation event hub behind `GET /dsh-zotero/events`. */
  get events(): ViewEventHub {
    return this.hub
  }

  /** Current connection status (last probe result; does not probe). */
  get status(): ConnectionStatus {
    return this.client.status
  }

  /** Probe Zotero (read-only `GET /api/`) and return the fresh status. */
  async probe(): Promise<ConnectionStatus> {
    return this.client.probe()
  }

  /**
   * Open Zotero's write-authorization dialog. Resolves `{authorized: true,
   * remembered}` on success — never the key; `write_denied` and other
   * failures surface as `ZoteroError` and must not be retried by callers.
   */
  async authorizeWrites(): Promise<{ authorized: true; remembered: boolean }> {
    await this.client.authorize()
    return { authorized: true, remembered: this.client.status.auth === 'remembered' }
  }

  // ------------------------------------------------------------------ M4 PDF

  /**
   * Locate a quote in one item's (or attachment's) PDF and record an
   * in-session Agent highlight with its page rectangles. Returns the exact
   * text found; `quote_not_found` when the PDF does not contain it.
   */
  async createHighlight(
    library: LibraryId,
    key: string,
    options: { quote: string; page?: number; comment?: string; color?: string },
  ): Promise<{ highlight: AgentHighlight; exact: string }> {
    const { itemKey, attachmentKey, pdf } = await this.pdfText(library, key)
    const preferred = options.page !== undefined ? pageIndexFor(pdf.pages, options.page) : undefined
    const match = findQuote(pdf.pages, options.quote, preferred)
    if (match === null) {
      throw new ZoteroError('quote_not_found', `Could not find the quote in this PDF. Copy the passage exactly from read_fulltext or find_in_pdf (a shorter, distinctive quote works best).`)
    }
    const page = pdf.pages[match.pageIndex]!
    const highlight = this.highlights.add({
      library,
      attachmentKey,
      itemKey,
      pageIndex: page.index,
      pageLabel: page.label,
      quote: textAt(page, match.start, match.end),
      comment: options.comment?.trim() ?? '',
      color: resolveColor(options.color),
      rects: rectsFor(page, match.start, match.end),
      createdAt: Date.now(),
    })
    this.publishHighlightChange(library, attachmentKey)
    return { highlight, exact: highlight.quote }
  }

  /** Session highlights by ids / item key / all (thin wrapper over the store). */
  findHighlights(ids?: string[], key?: string): AgentHighlight[] {
    return this.highlights.find(ids, key)
  }

  /** Remove session highlights (Zotero annotations are never touched). */
  clearHighlights(ids?: string[], key?: string): number {
    const doomed = this.highlights.find(ids, key)
    const removed = this.highlights.remove(ids, key)
    if (removed > 0) {
      for (const highlight of doomed) this.publishHighlightChange(highlight.library, highlight.attachmentKey)
    }
    return removed
  }

  /**
   * Save Agent highlights as Zotero highlight annotations (batched through
   * the single write path). Already-saved entries are skipped. The Zotero
   * annotation carries the exact fields Zotero's own reader writes:
   * annotationText/Comment/Color/PageLabel/SortIndex plus the
   * pageIndex+rects position JSON.
   */
  async saveHighlights(list: AgentHighlight[]): Promise<{ id: string; key: string }[]> {
    const pending = list.filter((highlight) => highlight.savedAs === undefined)
    if (pending.length === 0) return []
    const byLibrary = new Map<LibraryId, AgentHighlight[]>()
    for (const highlight of pending) {
      byLibrary.set(highlight.library, [...(byLibrary.get(highlight.library) ?? []), highlight])
    }
    const saved: { id: string; key: string }[] = []
    for (const [library, group] of byLibrary) {
      const objects: Record<string, unknown>[] = []
      for (const highlight of group) {
        const pdf = await this.pdfText(library, highlight.attachmentKey).then((entry) => entry.pdf)
        const page: PageText | undefined = pdf.pages[highlight.pageIndex]
        // Re-match the quote for a stable sortIndex; fall back to offset 0.
        const match = page !== undefined ? findQuote([page], highlight.quote) : null
        objects.push({
          itemType: 'annotation',
          parentItem: highlight.attachmentKey,
          annotationType: 'highlight',
          annotationText: highlight.quote,
          annotationComment: highlight.comment,
          annotationColor: highlight.color,
          annotationPageLabel: highlight.pageLabel,
          annotationSortIndex: page !== undefined ? sortIndex(page, match?.start ?? 0, highlight.rects) : '00000|000000|00000',
          annotationPosition: JSON.stringify({ pageIndex: highlight.pageIndex, rects: highlight.rects }),
          tags: [],
        })
      }
      const keys = await this.writes.create(library, 'items', objects)
      const marked = group.map((highlight, index) => ({ id: highlight.id, key: keys[index] ?? '' })).filter((entry) => entry.key !== '')
      this.highlights.markSaved(marked)
      saved.push(...marked)
      this.library.invalidate(library)
    }
    for (const entry of saved) {
      const highlight = pending.find((candidate) => candidate.id === entry.id)
      if (highlight !== undefined) this.publishHighlightChange(highlight.library, highlight.attachmentKey)
    }
    return saved
  }

  /** Item + best PDF attachment + parsed page text for one item/attachment key. */
  async pdfText(library: LibraryId, key: string): Promise<{ itemKey: string; attachmentKey: string; pdf: Awaited<ReturnType<HostPdfService['text']>> }> {
    const detail = await this.library.item(library, key)
    const attachmentKey = bestPdfKeyOf(detail) ?? undefined
    if (attachmentKey === undefined) throw new ZoteroError('not_pdf', `Item ${key} has no PDF attachment to read.`)
    // For a PDF attachment the item is its own parent (or itself when standalone).
    const itemKey = detail.itemType === 'attachment' ? (detail.parent ?? detail.key) : detail.key
    return { itemKey, attachmentKey, pdf: await this.pdf.text(library, attachmentKey) }
  }

  /** Publish the SSE nudge that makes open readers refresh their highlights. */
  publishHighlightChange(library: LibraryId, attachmentKey: string): void {
    this.hub.publish({ kind: 'highlights', library, attachmentKey })
  }

  // -------------------------------------------------------- M7 desktop

  /**
   * Probe the local Zotero install (cached). Purely filesystem-based; the
   * version is only present when it was actually read from the bundle.
   * Errors degrade to `null` (the Setup view then shows the connection
   * state only).
   */
  async installInfo(): Promise<ZoteroInstall | null> {
    if (this.installCache !== null) return this.installCache
    try {
      this.installCache = await this.findAppImpl()
    } catch {
      this.installCache = null
    }
    return this.installCache
  }

  /** Start the installed Zotero desktop app (explicit user action only). */
  async launchZoteroApp(): Promise<void> {
    await this.launchAppImpl()
  }

  /**
   * Open a strictly constructed `zotero://select` / `zotero://open-pdf`
   * deep link (library/key/page validated server-side; the spawn command is
   * a platform whitelist, never client input).
   */
  async openInZotero(target: DesktopTarget): Promise<{ url: string }> {
    const url = zoteroDesktopUrl(target)
    await this.openLinkImpl(url)
    return { url }
  }

  // ------------------------------------------------- M7 metadata import

  /**
   * Create one item from structured metadata or a DOI/arXiv identifier
   * (reference-parity flow). Resolution hits doi.org / export.arxiv.org via
   * the SSRF-guarded metadata module; the write goes through
   * `ZoteroWrites.create` — callers MUST have completed the DSH approval
   * BEFORE invoking this (the tool layer guarantees that order).
   *
   * Duplicate detection runs a read-only Local API query for the DOI and
   * returns the existing item's key without creating anything (reference
   * semantics). arXiv items auto-attach their open-access PDF unless
   * `attachPdf: false`; download failures degrade to warnings and never
   * block the item creation. Success publishes the panel `open_item`
   * intent (the caller returns the real key).
   */
  async addItem(
    library: LibraryId,
    input: {
      identifier?: string
      metadata?: Record<string, unknown>
      collections?: string[]
      tags?: string[]
      pdfUrl?: string
      attachPdf?: boolean
    },
  ): Promise<{ key: string; title: string; attachmentKey?: string; source: string; warnings: string[]; duplicate?: string }> {
    const warnings: string[] = []
    let item: NewItem
    let pdfUrl = input.pdfUrl
    let source = 'metadata'
    if (input.identifier !== undefined) {
      const identifier = parseIdentifier(input.identifier)
      if (identifier === null) {
        throw new ZoteroError('invalid_input', `"${input.identifier}" is not a DOI or arXiv id. Pass metadata instead for other kinds of items.`)
      }
      const resolved = await resolveIdentifier(identifier, this.metadataNet)
      item = { ...resolved.item, ...(input.metadata as NewItem | undefined) }
      if (input.attachPdf !== false) pdfUrl ??= resolved.pdfUrl
      source = resolved.source === 'arxiv' ? `arXiv ${identifier.value}` : `doi.org (${identifier.value})`
    } else if (input.metadata !== undefined) {
      const metadata = input.metadata
      item = {
        itemType: typeof metadata.itemType === 'string' ? metadata.itemType : '',
        title: typeof metadata.title === 'string' ? metadata.title : '',
        creators: (Array.isArray(metadata.creators) ? metadata.creators : []) as NewItem['creators'],
        ...metadata,
      }
    } else {
      throw new ZoteroError('invalid_input', 'Give an identifier (DOI or arXiv id) or metadata.')
    }

    // Duplicate check: an item carrying the same DOI already exists → report
    // it instead of creating a second copy (read-only Local API query). The
    // search may rank a mere DOI mention (title/abstract text) before the real
    // match, so EVERY non-attachment/non-note candidate is read and compared
    // against its raw DOI/extra; the first true hit wins and nothing is
    // created. Comparison semantics: case-insensitive DOI equality or a DOI
    // occurrence in `extra` (unchanged).
    const doi = String(item.DOI ?? '').trim()
    if (doi !== '') {
      const needle = doi.toLowerCase()
      const found = await this.library.items(library, { q: doi, mode: 'everything', limit: 5 })
      for (const candidate of found.items) {
        if (candidate.itemType === 'attachment' || candidate.itemType === 'note') continue
        const raw = await this.library.raw(library, candidate.key)
        const rawDoi = String(raw.data.DOI ?? '').toLowerCase()
        if (rawDoi === needle || String(raw.data.extra ?? '').toLowerCase().includes(needle)) {
          return {
            key: candidate.key,
            title: candidate.title,
            source,
            warnings: [`Already in the library as ${candidate.key}; nothing was added.`],
            duplicate: candidate.key,
          }
        }
      }
    }

    const collectionKeys: string[] = []
    for (const ref of input.collections ?? []) collectionKeys.push((await this.library.resolveCollection(library, ref)).key)
    const tags = [
      ...((item.tags as { tag: string; type?: number }[] | undefined) ?? []),
      ...(input.tags ?? []).map((tag) => ({ tag })),
    ]
    const data = await this.cleanItem({ ...item, tags, collections: collectionKeys })

    // Prepare the PDF first: a failed download only warns, never blocks the item.
    let file: { bytes: Uint8Array; filename: string } | null = null
    if (pdfUrl !== undefined) {
      try {
        const download = await downloadPdf(pdfUrl, this.metadataNet)
        file = { bytes: download.bytes, filename: zoteroFilename({ title: String(data.title ?? ''), creators: item.creators, date: data.date }) }
      } catch (error) {
        warnings.push(`The PDF was not attached: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const [key] = await this.writes.create(library, 'items', [data])
    let attachmentKey: string | undefined
    if (file !== null) {
      try {
        attachmentKey = await this.writes.attachFile(library, key!, {
          ...file,
          contentType: 'application/pdf',
          title: source.startsWith('arXiv') ? 'Preprint PDF' : 'Full Text PDF',
        })
      } catch (error) {
        warnings.push(`The item was added, but attaching the PDF failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.library.invalidate(library)
    // Panel intent: show the fresh item (reference opens it unless duplicate).
    if (attachmentKey !== undefined) {
      this.hub.publish({ kind: 'open_item', library, key: key!, attachmentKey })
    } else {
      this.hub.publish({ kind: 'open_item', library, key: key! })
    }
    return { key: key!, title: String(data.title ?? ''), ...(attachmentKey !== undefined ? { attachmentKey } : {}), source, warnings }
  }

  /**
   * Keep only fields valid for the item type and non-empty values (reference
   * `cleanItem`): Zotero re-validates deeply, but filtering here turns its
   * per-field 400s into a clean item. Types without a `DOI` field keep the
   * DOI in `extra`. A title is required — metadata without one is refused.
   */
  private async cleanItem(item: NewItem): Promise<Record<string, unknown>> {
    const valid = await this.library.validFields(item.itemType).catch(() => {
      throw new ZoteroError('invalid_input', `Unknown item type "${item.itemType}".`)
    })
    const result: Record<string, unknown> = {
      itemType: item.itemType,
      creators: item.creators ?? [],
      tags: item.tags ?? [],
      collections: item.collections ?? [],
    }
    for (const [field, value] of Object.entries(item)) {
      if (field === 'itemType' || field === 'creators' || field === 'tags' || field === 'collections') continue
      if (value === undefined || value === null || value === '') continue
      if (valid.has(field)) result[field] = typeof value === 'string' ? value : String(value)
      else if (field === 'DOI' && value) {
        // Types without a DOI field (e.g. older schemas) keep it in Extra.
        result.extra = [result.extra, `DOI: ${String(value)}`].filter(Boolean).join('\n')
      }
    }
    if (!result.title) throw new ZoteroError('invalid_input', 'A title is required.')
    return result
  }

  /**
   * Attach a downloaded PDF (already fetched by the caller through the
   * SSRF-guarded downloader) to an existing regular item. The parent is
   * validated: attachments/notes/annotations cannot take children.
   */
  async attachPdfBytes(library: LibraryId, item: string, file: { bytes: Uint8Array; filename: string; title?: string }): Promise<{ key: string; title: string; bytes: number }> {
    const raw = await this.library.raw(library, item)
    if (['attachment', 'note', 'annotation'].includes(String(raw.data.itemType))) {
      throw new ZoteroError('invalid_input', `${item} is a ${String(raw.data.itemType)}; attach PDFs to a regular item.`)
    }
    const filename = safeAttachmentFilename(file.filename)
    const key = await this.writes.attachFile(library, item, {
      bytes: file.bytes,
      filename,
      contentType: 'application/pdf',
      title: file.title?.trim() || 'Full Text PDF',
    })
    this.library.invalidate(library)
    return { key, title: String(raw.data.title ?? ''), bytes: file.bytes.length }
  }

  /** Download a PDF through the SSRF-guarded downloader (caller approved already). */
  async downloadPdfBytes(url: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const download = await downloadPdf(url, this.metadataNet)
    return { bytes: download.bytes, filename: download.filename }
  }

  // --------------------------------------------- M7 workspace write (.bib)

  /**
   * Write export text to a workspace file through the OFFICIAL workspace
   * file API (`ctx.fs.resolve` + `ctx.fs.writeText`; the cwd comes from
   * `ctx.workingDirectory.ensure(agent)` — never `process.cwd`). Guards:
   *
   * - the path must be relative and stay inside the workspace (absolute
   *   paths, `..` segments and symlink escapes are refused — the backend
   *   resolves through realpaths, and the resolved display path is checked
   *   against the workspace root);
   * - the file must end in `.bib`;
   * - existing files are refused unless `overwrite: true` — and even then
   *   the write goes through the backend's atomic writeText (an unguarded
   *   write), never a blind truncation.
   *
   * Without the official services this fails closed: no `process.cwd`
   * guessing, no arbitrary file writes.
   */
  async writeWorkspaceFile(input: {
    path: string
    content: string
    overwrite?: boolean
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ displayPath: string; operation: 'create' | 'update' }> {
    if (this.fsFace === undefined || this.workingDirectoryFace === undefined) {
      throw new ZoteroError('invalid_input', 'Workspace file access is not available in this host (missing fs/workingDirectory services); export_bib returns text only.')
    }
    const rawPath = input.path
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new ZoteroError('invalid_input', 'path must be a non-empty workspace-relative string.')
    if (rawPath.length > 512) throw new ZoteroError('invalid_input', 'path is too long.')
    if (isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
      throw new ZoteroError('path_outside_workspace', 'path must be relative to the workspace (absolute paths are not allowed).')
    }
    const segments = rawPath.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.')
    if (segments.length === 0) throw new ZoteroError('invalid_input', 'path must name a .bib file.')
    if (segments.some((segment) => segment === '..')) {
      throw new ZoteroError('path_outside_workspace', 'path must not contain ".." segments.')
    }
    if (!/\.(bib|bibtex)$/i.test(segments[segments.length - 1]!)) {
      throw new ZoteroError('invalid_input', 'The export path must end in .bib.')
    }
    const cwd = await this.workingDirectoryFace.ensure(input.agent ?? undefined, input.signal)
    if (cwd === undefined) {
      throw new ZoteroError('invalid_input', 'No workspace directory is attached to this session; export_bib returns text only.')
    }
    const target = await this.fsFace.resolve(segments.join('/'), { cwd, ...(input.signal !== undefined ? { signal: input.signal } : {}) })
    if (!isInside(cwd, target.displayPath)) {
      throw new ZoteroError('path_outside_workspace', `${rawPath} resolves outside the workspace.`)
    }
    const expected = input.overwrite === true ? undefined : ({ kind: 'createIfAbsent' } as const)
    try {
      const outcome = await this.fsFace.writeText(target, input.content, expected, input.signal)
      return { displayPath: target.displayPath, operation: outcome.operation }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'FS_NOT_OBSERVED') {
        throw new ZoteroError('invalid_input', `${rawPath} already exists. Read it first, then pass overwrite: true to replace it.`)
      }
      if (code === 'FS_NOT_FOUND') {
        throw new ZoteroError('invalid_input', error instanceof Error ? error.message : String(error))
      }
      throw error
    }
  }

  // ------------------------------------------------- late host services

  /**
   * Attach composition services that activated after assembly (official
   * `ctx.inject` late binding, `src/index.ts`). A `credentials` face takes
   * effect by scheduling the same safe client rebuild a base-URL hot update
   * uses — the durable `KeyStore` is live before the next read/write entry
   * point; `fs`/`workingDirectory` enable the real `export_bib` workspace
   * write. Attaching the same face again is a no-op.
   */
  attachServices(services: LateHostServices): void {
    if (services.credentials !== undefined && services.credentials !== this.credentialsFace) {
      this.credentialsFace = services.credentials
      this.rebuildClientFor()
    }
    if (services.fs !== undefined) this.fsFace = services.fs
    if (services.workingDirectory !== undefined) this.workingDirectoryFace = services.workingDirectory
  }

  /**
   * Unbind cycled services (the composition fiber that provided them went
   * away). `credentials` → the client is rebuilt onto a FRESH in-memory
   * store: keys fall back to process memory and no key material is ever
   * copied out of the credential records; `fs`/`workingDirectory` →
   * `export_bib` degrades to text-only (fail-closed).
   */
  detachServices(names: DetachableService[]): void {
    let rebuild = false
    for (const name of names) {
      if (name === 'credentials') {
        if (this.credentialsFace !== undefined) {
          this.credentialsFace = undefined
          rebuild = true
        }
      } else if (name === 'fs') {
        this.fsFace = undefined
      } else if (name === 'workingDirectory') {
        this.workingDirectoryFace = undefined
      }
    }
    if (rebuild) this.rebuildClientFor()
  }

  /** Whether the official workspace-file write path is currently mounted. */
  canWriteWorkspace(): boolean {
    return this.fsFace !== undefined && this.workingDirectoryFace !== undefined
  }

  /** Schedule a client rebuild for a KeyStore change (never throws). */
  private rebuildClientFor(): void {
    this.pendingClientRebuild = true
    // ensureCurrent is total (an invalid live URL defers the rebuild to the
    // next valid hot update), so this cannot throw into an effect callback.
    this.ensureCurrent()
  }

  /**
   * Rebuild the whole stack when the configured base URL changed (or a
   * KeyStore change was scheduled by attach/detach). An invalid new URL is
   * ignored (the last good stack stays active), so a bad settings value
   * degrades to "still pointing at the previous Zotero address" instead of a
   * dead plugin; the constructor, by contrast, fails fast on an invalid
   * initial URL.
   */
  ensureCurrent(): void {
    let wanted: string
    try {
      wanted = assertLoopbackOrThrow(this.baseUrlRef.get())
    } catch {
      return
    }
    if (wanted === this.clientValue.baseUrl && !this.pendingClientRebuild) return
    this.pendingClientRebuild = false
    this.clientValue = this.buildClient(wanted)
  }

  /** Drop caches and detach SSE subscribers. */
  dispose(): void {
    this.hub.dispose()
    this.libraryValue(this.clientValue).invalidate()
  }

  private buildClient(baseUrl: string): ZoteroLocalClient {
    const keyStore = this.credentialsFace !== undefined ? new CredentialsKeyStore(this.credentialsFace) : new MemoryKeyStore()
    const options: ZoteroLocalClientOptions = { baseUrl, appName: this.appName, keyStore }
    if (this.fetchImpl !== undefined) options.fetch = this.fetchImpl
    return new ZoteroLocalClient(options)
  }

  // Lazily bound access layers: they follow whichever client is active.
  private libraryCache: ZoteroLibrary | null = null
  private writesCache: ZoteroWrites | null = null
  private pdfCache: HostPdfService | null = null
  private boundClient: ZoteroLocalClient | null = null

  private libraryValue(client: ZoteroLocalClient): ZoteroLibrary {
    if (this.libraryCache === null || this.boundClient !== client) {
      this.libraryCache = new ZoteroLibrary(client)
      this.writesCache = null
      this.pdfCache = null
      this.boundClient = client
    }
    return this.libraryCache
  }

  private writesValue(client: ZoteroLocalClient): ZoteroWrites {
    const library = this.libraryValue(client)
    if (this.writesCache === null || this.boundClient !== client) {
      this.writesCache = new ZoteroWrites(client, library)
      this.boundClient = client
    }
    return this.writesCache
  }

  private pdfValue(): HostPdfService {
    const library = this.libraryValue(this.client)
    if (this.pdfCache === null || this.boundClient !== this.client) {
      this.pdfCache = new HostPdfService(library, new PdfStore(), this.pdfAssetDir ?? pdfjsDataDir())
      this.boundClient = this.client
    }
    return this.pdfCache
  }
}

/** Validate the configured base URL up front (same rules as the client). */
function assertLoopbackOrThrow(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new ZoteroError('invalid_input', 'localApiBaseUrl is not configured.')
  }
  return assertLoopbackBaseUrl(rawUrl)
}

/**
 * Whether `target` is inside `root` (including root itself), judged with
 * `path.relative` so Windows drive changes and case-insensitivity behave
 * (attribution: reference `isInside`, Apache-2.0).
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Bare PDF filename for attachments (path separators and control chars out). */
function safeAttachmentFilename(name: string): string {
  const base = name.replace(/[/\\]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (base === '' || base === '.' || base === '..' || base.includes('..')) {
    throw new ZoteroError('invalid_input', 'filename must be a bare file name.')
  }
  return base.slice(0, 250)
}
