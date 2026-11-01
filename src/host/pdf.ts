/**
 * Host-side PDF file service: the ONLY module that turns a validated
 * `library + attachmentKey` pair into local file access. Route handlers and
 * tools never see file paths — they call this service, which
 *
 * 1. resolves the attachment through `ZoteroLibrary.resolveAttachmentPath`
 *    (the existing single file-path seam; a route never accepts an arbitrary
 *    path),
 * 2. verifies the item really is a stored PDF attachment,
 * 3. hardens the path against symlink swaps: the path is resolved to its
 *    `realpath` and a SECOND resolve through Zotero must land on the same
 *    real file — an attacker swapping the attachment's symlink target between
 *    the two resolutions makes the check fail instead of reading a planted
 *    file. All reads go through the verified real path.
 * 4. enforces existence (`file_missing`), regular file (`not_pdf`) and the
 *    size cap (`LIMITS.pdfMaxBytes`).
 *
 * Byte serving is range-based: `part()` reads exactly one 2 MiB chunk from
 * the verified file, never the whole PDF into one JSON payload. Assets
 * (`lib/pdfjs/**`) are served through a strict whitelist (`resolveAsset`)
 * with no path-traversal surface by construction.
 *
 * @module @hanxu131/dsh-zotero/host/pdf
 */

import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import { LIMITS, ZoteroError, parseItemKey, type LibraryId } from '../domain/model.ts'
import { isPdf, type PdfStore, type PdfText } from '../pdf/extract.ts'
import type { RawItem } from '../domain/items.ts'
import type { ZoteroLibrary } from '../zotero/library.ts'

export interface PdfFile {
  /** Verified real path; every read goes through it. */
  path: string
  /** Basename of the stored file (safe to surface; no key material). */
  filename: string
  bytes: number
}

export interface PdfInfoPayload {
  library: LibraryId
  attachmentKey: string
  /** Parent item key (self when the attachment has no parent). */
  itemKey: string
  title: string
  filename: string
  bytes: number
  /** Number of 2 MiB chunks the byte route serves. */
  parts: number
  sha256: string
  /** Page count from text extraction; `null` when it failed (bytes still serve). */
  pageCount: number | null
}

const ASSET_KINDS = new Set(['cmaps', 'standard_fonts', 'wasm'])

export class HostPdfService {
  /** sha256 cache keyed by verified path, invalidated by mtime:size stamp. */
  private readonly digests = new Map<string, { stamp: string; sha256: string }>()

  constructor(
    private readonly library: ZoteroLibrary,
    private readonly pdfs: PdfStore,
    /** Absolute dir of the packaged pdf.js static assets (`lib/pdfjs`); null → assets unavailable (dev without a build). */
    private readonly assetRoot: string | null,
  ) {}

  /** The raw attachment item, mapped to `not_found` for unknown keys. */
  private async attachmentItem(library: LibraryId, attachmentKey: string): Promise<RawItem> {
    parseItemKey(attachmentKey, 'attachmentKey')
    let raw: RawItem
    try {
      raw = await this.library.raw(library, attachmentKey)
    } catch (error) {
      if (error instanceof ZoteroError && error.code === 'not_found') {
        throw new ZoteroError('not_found', `No attachment ${attachmentKey} in ${library === 'user' ? 'My Library' : `library ${library}`}.`)
      }
      throw error
    }
    if (raw.data.itemType !== 'attachment') {
      throw new ZoteroError('not_pdf', `${attachmentKey} is a ${String(raw.data.itemType)}, not a PDF attachment.`)
    }
    if (String(raw.data.contentType ?? '') !== 'application/pdf' || String(raw.data.linkMode ?? '') === 'linked_url') {
      throw new ZoteroError('not_pdf', `Attachment ${attachmentKey} is not a stored PDF (${String(raw.data.contentType ?? '') || String(raw.data.linkMode ?? 'unknown')}).`)
    }
    return raw
  }

  /**
   * Resolve + verify the attachment file. Every consumer funnels through
   * here so the path-safety guarantees hold uniformly. `raw` may carry the
   * already-fetched attachment item (an extra Local API GET saved).
   */
  async file(library: LibraryId, attachmentKey: string, raw?: RawItem): Promise<PdfFile> {
    if (raw === undefined) await this.attachmentItem(library, attachmentKey) // type/linkMode gate
    // Two resolutions through Zotero with realpaths: a symlink target swapped
    // between the calls no longer matches, so the read cannot be redirected
    // by racing the resolution.
    const first = await this.library.resolveAttachmentPath(library, attachmentKey)
    if (!isAbsolute(first)) throw new ZoteroError('file_missing', `Zotero returned a relative path for attachment ${attachmentKey}.`)
    const real = await realpath(first).catch(() => {
      throw new ZoteroError('file_missing', `The attachment file is missing on disk (${basename(first)}). It may not have been synced or downloaded yet.`)
    })
    const secondReal = await this.library
      .resolveAttachmentPath(library, attachmentKey)
      .then((second) => realpath(second))
      .catch(() => '')
    if (secondReal !== real) {
      throw new ZoteroError('file_missing', `The attachment file changed while being verified (${basename(first)}); refusing to read it.`)
    }
    const info = await stat(real).catch(() => {
      throw new ZoteroError('file_missing', `The attachment file is missing on disk (${basename(real)}).`)
    })
    if (!info.isFile()) throw new ZoteroError('not_pdf', `Attachment ${attachmentKey} is not a regular file.`)
    if (info.size > LIMITS.pdfMaxBytes) {
      throw new ZoteroError('not_pdf', `The PDF is too large (${Math.round(info.size / 1024 / 1024)} MB).`)
    }
    if (info.size === 0) throw new ZoteroError('file_missing', `The attachment file is empty (${basename(real)}).`)
    return { path: real, filename: basename(real), bytes: info.size }
  }

  /** Reader bootstrap info: size, chunk count, digest, page count. */
  async info(library: LibraryId, attachmentKey: string): Promise<PdfInfoPayload> {
    const attachment = await this.attachmentItem(library, attachmentKey)
    const file = await this.file(library, attachmentKey, attachment)
    let pageCount: number | null = null
    try {
      pageCount = (await this.text(library, attachmentKey)).pageCount
    } catch {
      pageCount = null // text extraction failures must not break byte serving
    }
    return {
      library,
      attachmentKey,
      itemKey: (attachment.data.parentItem as string | undefined) ?? attachment.key,
      title: String(attachment.data.title || attachment.data.filename || 'PDF'),
      filename: file.filename,
      bytes: file.bytes,
      parts: Math.max(1, Math.ceil(file.bytes / LIMITS.pdfChunkBytes)),
      sha256: await this.sha256(file),
      pageCount,
    }
  }

  /**
   * One 2 MiB chunk, read range-only from the verified path. `part` indexes
   * chunks; out-of-range throws `invalid_input`.
   */
  async part(library: LibraryId, attachmentKey: string, part: number): Promise<Uint8Array> {
    if (!Number.isInteger(part) || part < 0) throw new ZoteroError('invalid_input', `PDF part must be a non-negative integer; got ${part}.`)
    const file = await this.file(library, attachmentKey)
    const start = part * LIMITS.pdfChunkBytes
    if (start >= file.bytes) throw new ZoteroError('invalid_input', `PDF part ${part} is out of range (file is ${file.bytes} bytes).`)
    const length = Math.min(LIMITS.pdfChunkBytes, file.bytes - start)
    return readRange(file.path, start, length)
  }

  /** Parsed page text (LRU-cached); the input of read_fulltext/find/highlight. */
  async text(library: LibraryId, attachmentKey: string): Promise<PdfText> {
    const file = await this.file(library, attachmentKey)
    return this.pdfs.text(file.path)
  }

  /**
   * A packaged pdf.js static asset. The kind is a fixed set and the filename
   * must be a plain name (no separators, no `..`), resolved inside the asset
   * root; anything else answers `null` (route turns it into 404).
   */
  async resolveAsset(kind: string, filename: string): Promise<Buffer | null> {
    if (this.assetRoot === null) return null
    if (!ASSET_KINDS.has(kind)) return null
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename) || filename.includes('..')) return null
    const root = resolve(this.assetRoot)
    const path = resolve(root, kind, filename)
    if (!path.startsWith(root + sep)) return null
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isFile() || info.size === 0 || info.size > LIMITS.pdfChunkBytes) return null
    return readRange(path, 0, info.size)
  }

  /** sha256 of the whole file, cached per mtime:size stamp. */
  private async sha256(file: PdfFile): Promise<string> {
    const info = await stat(file.path)
    const stamp = `${info.mtimeMs}:${info.size}`
    const cached = this.digests.get(file.path)
    if (cached !== undefined && cached.stamp === stamp) return cached.sha256
    const digest = createHash('sha256')
    const handle = await open(file.path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(LIMITS.pdfChunkBytes)
      let position = 0
      for (;;) {
        const read = await handle.read(buffer, 0, buffer.length, position)
        if (read.bytesRead === 0) break
        digest.update(buffer.subarray(0, read.bytesRead))
        position += read.bytesRead
      }
    } finally {
      await handle.close()
    }
    const sha256 = digest.digest('hex')
    this.digests.set(file.path, { stamp, sha256 })
    return sha256
  }
}

/** Range read at one offset (used by `part` and asset loading). */
async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const read = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, read.bytesRead)
  } finally {
    await handle.close()
  }
}

export { isPdf }
