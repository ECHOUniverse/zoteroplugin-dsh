/**
 * `ZoteroWrites` — the single write path to Zotero (spec review red line:
 * every writing code goes through this facade, so it stays auditable and
 * testable). All methods require the user's Local API authorization via
 * `ZoteroLocalClient.authorize()` and never partially succeed silently:
 *
 * - `create` batches at most `LIMITS.writeBatch` (50) objects per request,
 *   each stamped with a random `Zotero-Write-Token`;
 * - `patchItem` sends `If-Unmodified-Since-Version` and, on 412, re-reads the
 *   item and retries **once** before giving up with `version_conflict`;
 * - `attachFile` performs the three-step upload (create attachment entry →
 *   POST bytes to Zotero's `/api/local/uploads/<token>` → register md5/mtime)
 *   and deletes the just-created entry when the upload fails;
 * - `deleteItems` exists for tests and rollback only (the plugin exposes no
 *   user-facing deletion).
 *
 * Write capability is detected lazily (`probeWrites` on the client, keyless
 * POST) — read paths never probe. Keys live inside the client/`KeyStore` and
 * never appear in results, logs, or wire types.
 *
 * Attribution: batch/patch/upload flows are adapted from
 * zai-org/zcode-plugins `ui-plugins/zotero` `src/zotero/writes.ts`
 * (repo LICENSE: Apache-2.0). Modifications: dropped the hard dependency on
 * a `Library` writer-key file (keys come from the client's `KeyStore`),
 * library cache invalidation goes through `ZoteroLibrary.invalidate`, and
 * upload URL validation happens in `ZoteroLocalClient.upload`. See
 * THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/zotero/writes
 */

import { createHash, randomBytes } from 'node:crypto'
import { LIMITS, ZoteroError, libraryPrefix, type LibraryId } from '../domain/model.ts'
import type { RawItem } from '../domain/items.ts'
import type { ZoteroLocalClient } from './client.ts'
import type { ZoteroLibrary } from './library.ts'

interface MultiWriteResult {
  successful?: Record<string, { key: string; version: number }>
  success?: Record<string, string>
  unchanged?: Record<string, string>
  failed?: Record<string, { code: number; message: string }>
}

const enc = encodeURIComponent

export interface AttachFileInput {
  bytes: Uint8Array
  filename: string
  contentType: string
  title: string
}

export class ZoteroWrites {
  constructor(
    private readonly client: ZoteroLocalClient,
    private readonly library: ZoteroLibrary,
  ) {}

  /** Batch-create items or collections; returns keys in input order. */
  async create(libraryId: LibraryId, kind: 'items' | 'collections', objects: Record<string, unknown>[]): Promise<string[]> {
    if (objects.length === 0) return []
    const keys: string[] = []
    for (let index = 0; index < objects.length; index += LIMITS.writeBatch) {
      const batch = objects.slice(index, index + LIMITS.writeBatch)
      const response = await this.client.write('POST', `${libraryPrefix(libraryId)}/${kind}`, {
        body: JSON.stringify(batch),
        contentType: 'application/json',
        headers: { 'Zotero-Write-Token': randomToken() },
      })
      if (response.status !== 200) throw httpWriteError(response, `Creating ${kind}`)
      const result = response.json as MultiWriteResult | undefined
      if (!result) throw new ZoteroError('write_failed', `Zotero did not return a write result for ${kind}.`)
      const failed = Object.entries(result.failed ?? {})
      if (failed.length > 0) {
        const [position, failure] = failed[0]!
        throw new ZoteroError('write_failed', `Zotero rejected ${kind === 'items' ? 'item' : 'collection'} ${Number(position) + index + 1}: ${failure.message} (HTTP ${failure.code})`)
      }
      for (let position = 0; position < batch.length; position++) {
        const key = result.successful?.[String(position)]?.key ?? result.success?.[String(position)] ?? result.unchanged?.[String(position)]
        if (!key) throw new ZoteroError('write_failed', `Zotero did not report a key for ${kind} ${position + 1}.`)
        keys.push(key)
      }
    }
    this.library.invalidate(libraryId)
    return keys
  }

  /**
   * Modify an item: `update` computes the patch from the current raw item
   * (return null to mean "nothing to change"). On 412 the item is re-read and
   * the patch recomputed once; persistent conflicts throw `version_conflict`.
   */
  async patchItem(libraryId: LibraryId, key: string, update: (current: RawItem) => Record<string, unknown> | null): Promise<{ changed: boolean; item: RawItem }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.library.raw(libraryId, key)
      const patch = update(current)
      if (!patch || Object.keys(patch).length === 0) return { changed: false, item: current }
      const response = await this.client.write('PATCH', `${libraryPrefix(libraryId)}/items/${enc(key)}`, {
        body: JSON.stringify(patch),
        contentType: 'application/json',
        headers: { 'If-Unmodified-Since-Version': String(current.version) },
      })
      if (response.status === 412 && attempt === 0) continue
      if (response.status !== 204 && response.status !== 200) throw httpWriteError(response, `Updating item ${key}`)
      this.library.invalidate(libraryId)
      return { changed: true, item: await this.library.raw(libraryId, key) }
    }
    throw new ZoteroError('version_conflict', `Item ${key} kept changing in Zotero; try again.`)
  }

  /** Delete items (rollback/test helper; not exposed to users). */
  async deleteItems(libraryId: LibraryId, keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += LIMITS.writeBatch) {
      const batch = keys.slice(index, index + LIMITS.writeBatch)
      const { version } = await this.library.checkVersion(libraryId)
      const response = await this.client.write('DELETE', `${libraryPrefix(libraryId)}/items?itemKey=${batch.map(enc).join(',')}`, {
        headers: { 'If-Unmodified-Since-Version': String(version) },
      })
      if (response.status !== 204) throw httpWriteError(response, 'Deleting items')
    }
    this.library.invalidate(libraryId)
  }

  /**
   * Attach a stored file to an item: create the attachment entry, upload the
   * bytes through Zotero's local upload endpoint, register md5/mtime. If any
   * upload step fails the just-created entry is deleted again.
   */
  async attachFile(libraryId: LibraryId, parentKey: string | null, file: AttachFileInput): Promise<string> {
    const [attachmentKey] = await this.create(libraryId, 'items', [
      {
        itemType: 'attachment',
        ...(parentKey !== null ? { parentItem: parentKey } : {}),
        linkMode: 'imported_file',
        title: file.title,
        contentType: file.contentType,
        filename: file.filename,
        tags: [],
        relations: {},
      },
    ])
    const key = attachmentKey as string
    try {
      await this.uploadFile(libraryId, key, file)
    } catch (error) {
      await this.deleteItems(libraryId, [key]).catch(() => undefined)
      throw error
    }
    return key
  }

  private async uploadFile(libraryId: LibraryId, attachmentKey: string, file: AttachFileInput): Promise<void> {
    const md5 = createHash('md5').update(file.bytes).digest('hex')
    const path = `${libraryPrefix(libraryId)}/items/${enc(attachmentKey)}/file`
    const form = new URLSearchParams({
      md5,
      filename: file.filename,
      filesize: String(file.bytes.length),
      mtime: String(Date.now()),
      contentType: file.contentType,
    })
    const authorize = await this.client.write('POST', path, {
      body: form.toString(),
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'If-None-Match': '*' },
    })
    if (authorize.status !== 200) throw httpWriteError(authorize, 'Authorizing the file upload')
    const grant = authorize.json as { exists?: number; url?: string; uploadKey?: string } | undefined
    if (grant?.exists) return
    if (!grant?.url || !grant.uploadKey) throw new ZoteroError('write_failed', 'Zotero did not return an upload URL.')
    // client.upload enforces the loopback + /api/local/uploads/<token> contract (SSRF guard).
    const sent = await this.client.upload(grant.url, file.bytes, file.contentType)
    if (sent.status !== 200 && sent.status !== 201 && sent.status !== 204) throw httpWriteError(sent, 'Uploading the file')
    const register = await this.client.write('POST', path, {
      body: new URLSearchParams({ upload: grant.uploadKey }).toString(),
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'If-None-Match': '*' },
    })
    if (register.status !== 200 && register.status !== 204) throw httpWriteError(register, 'Registering the uploaded file')
  }
}

/** Same mapping as client.httpError, phrased for writes. */
function httpWriteError(response: { status: number; text: string }, what: string): ZoteroError {
  const text = response.text.trim().slice(0, 500)
  if (response.status === 404) return new ZoteroError('not_found', `${what}: not found.`)
  if (response.status === 412) return new ZoteroError('version_conflict', `${what}: the object changed in Zotero meanwhile.`)
  if (response.status === 400) return new ZoteroError('invalid_input', `${what}: ${text || 'bad request'}`)
  return new ZoteroError('write_failed', `${what} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`)
}

/** Random write token (Zotero uses it to dedupe retries). */
function randomToken(): string {
  return randomBytes(16).toString('hex')
}
