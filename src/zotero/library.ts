/**
 * `ZoteroLibrary` — read-only access layer over the Zotero Local API: search
 * with correct pagination, collections, saved searches, item details,
 * children and annotations, projected into the domain model (`domain/`).
 *
 * Endpoint routing follows the official Zotero Web API v3 / Local API docs:
 * - library-level search → `GET {p}/items/top?q=<q>&qmode=<m>&tag=<t>&…`
 *   (`qmode=titleCreatorYear` metadata search, `qmode=everything` full-text);
 * - collection filter → `GET {p}/collections/<key>/items/top` (a **path**
 *   endpoint — the Web API has no `collection=` query parameter);
 * - saved searches → `GET {p}/searches/<key>/items` (Local API extension).
 * Totals come from the `Total-Results` header; `Link` headers are parsed into
 * paging targets. Collections are cached per library version and revalidated
 * with `If-Modified-Since-Version` (304 → no re-fetch).
 *
 * This layer never writes and never talks to anything but the local API
 * (no Web API, no SQLite). Attachment local paths stay behind
 * `resolveAttachmentPath` until the on-the-wire path shape is verified (V-4).
 *
 * Attribution: read flows, version bookkeeping and collection-name resolution
 * are adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/zotero/library.ts` (repo LICENSE: Apache-2.0). Modifications: query
 * normalization/validation via `domain/model.ts` (multi-tag support,
 * injection guards), `Total-Results`/`Link` parsing moved here, detail
 * projection extracted into the pure `buildItemDetail`, and the attachment
 * path resolution kept as the only file-path seam. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/zotero/library
 */

import { fileURLToPath } from 'node:url'
import {
  LIMITS,
  ZoteroError,
  libraryPrefix,
  normalizeItemQuery,
  parseItemKey,
  parseLinkHeader,
  parseTotalResults,
  type Annotation,
  type CollectionNode,
  type CollectionsDoc,
  type ItemDetail,
  type ItemList,
  type LibraryId,
  type LibraryInfo,
  type NormalizedItemQuery,
  type SavedSearch,
} from '../domain/model.ts'
import { buildItemDetail, parseAnnotation, stripLocalPaths, summarize, type RawItem } from '../domain/items.ts'
import type { ZoteroLocalClient } from './client.ts'

interface RawCollection {
  key: string
  version: number
  meta?: { numItems?: number; numCollections?: number }
  data: { key: string; name: string; parentCollection: string | false }
}

interface RawSearch {
  key: string
  data: { key: string; name: string }
}

interface RawGroup {
  id: number
  data?: { name?: string; libraryEditing?: string }
  meta?: { numItems?: number }
}

const enc = encodeURIComponent

export class ZoteroLibrary {
  private readonly collectionsCache = new Map<LibraryId, CollectionsDoc>()
  private readonly versions = new Map<LibraryId, number>()
  private readonly fieldsCache = new Map<string, Set<string>>()

  constructor(readonly client: ZoteroLocalClient) {}

  /** Last observed library version, or 0 before the first poll. */
  versionOf(library: LibraryId): number {
    return this.versions.get(library) ?? 0
  }

  private noteVersion(library: LibraryId, header: string | null): void {
    const version = Number(header)
    if (Number.isFinite(version) && version > 0) this.versions.set(library, version)
  }

  /**
   * Library version poll: `GET {p}/items/top?limit=1&format=keys` with
   * `If-Modified-Since-Version`; 304 means unchanged and is cheap.
   */
  async checkVersion(library: LibraryId): Promise<{ version: number; changed: boolean }> {
    const since = this.versions.get(library)
    const response = await this.client.get(`${libraryPrefix(library)}/items/top?limit=1&format=keys`, {
      headers: since !== undefined ? { 'If-Modified-Since-Version': String(since) } : {},
    })
    if (response.status === 304) return { version: since!, changed: false }
    this.noteVersion(library, response.headers.get('last-modified-version'))
    const current = this.versionOf(library)
    return { version: current, changed: since !== current }
  }

  /** Personal library first, then groups (`g<id>`); `editable` mirrors group settings. */
  async libraries(): Promise<LibraryInfo[]> {
    const { data: groups } = await this.client.getJson<RawGroup[]>('/api/users/0/groups')
    const userVersion = this.versions.get('user')
    const user: LibraryInfo = { id: 'user', name: 'My Library', type: 'user', editable: true, ...(userVersion !== undefined ? { version: userVersion } : {}) }
    return [
      user,
      ...groups.map((group): LibraryInfo => {
        const id = `g${group.id}`
        const version = this.versions.get(id)
        return {
          id,
          name: group.data?.name ?? `Group ${group.id}`,
          type: 'group',
          editable: group.data?.libraryEditing !== 'admins',
          ...(version !== undefined ? { version } : {}),
        }
      }),
    ]
  }

  /** Collection tree + saved searches, cached per library version. */
  async collections(library: LibraryId): Promise<CollectionsDoc> {
    const { version } = await this.checkVersion(library)
    const cached = this.collectionsCache.get(library)
    if (cached && cached.version === version) return cached
    const prefix = libraryPrefix(library)
    const [{ data: rawCollections }, { data: rawSearches }] = await Promise.all([
      this.client.getJson<RawCollection[]>(`${prefix}/collections`),
      this.client.getJson<RawSearch[]>(`${prefix}/searches`),
    ])
    const doc: CollectionsDoc = {
      library,
      version,
      collections: rawCollections
        .map((raw): CollectionNode => ({
          key: raw.key,
          name: raw.data.name,
          parent: raw.data.parentCollection || null,
          numItems: raw.meta?.numItems ?? 0,
          numCollections: raw.meta?.numCollections ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      searches: rawSearches.map((raw): SavedSearch => ({ key: raw.key, name: raw.data.name })).sort((a, b) => a.name.localeCompare(b.name)),
    }
    this.collectionsCache.set(library, doc)
    return doc
  }

  /**
   * Resolve a collection reference to a node: an exact key, or a
   * case-insensitive name (optionally `"父/子"` path segments). Ambiguous
   * names throw `invalid_input`; unknown names throw `not_found`.
   */
  async resolveCollection(library: LibraryId, ref: string): Promise<CollectionNode> {
    const { collections } = await this.collections(library)
    const byKey = collections.find((node) => node.key === ref)
    if (byKey) return byKey
    const path = ref.split('/').map((part) => part.trim().toLowerCase()).filter(Boolean)
    const matches = collections.filter((node) => {
      let current: CollectionNode | undefined = node
      for (let index = path.length - 1; index >= 0; index--) {
        if (!current || current.name.toLowerCase() !== path[index]) return false
        current = current.parent ? collections.find((other) => other.key === current!.parent) : undefined
      }
      return true
    })
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new ZoteroError('invalid_input', `Several collections are named "${ref}" (${matches.map((node) => node.key).join(', ')}); pass a key instead.`)
    }
    throw new ZoteroError('not_found', `No collection "${ref}".`)
  }

  /** The collection and all its descendant keys. */
  async collectionTree(library: LibraryId, key: string): Promise<string[]> {
    const { collections } = await this.collections(library)
    const keys = [key]
    for (let index = 0; index < keys.length; index++) {
      for (const node of collections) {
        if (node.parent === keys[index]) keys.push(node.key)
      }
    }
    return keys
  }

  /** Search + pagination facade. Only the caller decides its budget (Agent 25/100, panel 50/500). */
  async items(library: LibraryId, query: NormalizedItemQuery | Parameters<typeof normalizeItemQuery>[0]): Promise<ItemList> {
    const normalized = normalizeItemQuery(query)
    const prefix = libraryPrefix(library)
    if (normalized.keys?.length) {
      const raw = await this.itemsByKey(library, normalized.keys)
      const order = new Map(normalized.keys.map((key, index) => [key, index]))
      raw.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
      return { library, version: this.versionOf(library), query: normalized, total: raw.length, items: raw.map(summarize) }
    }
    const params = new URLSearchParams()
    if (normalized.q !== undefined) {
      params.set('q', normalized.q)
      params.set('qmode', normalized.mode)
    }
    for (const tag of normalized.tag ?? []) params.append('tag', tag)
    params.set('sort', normalized.sort)
    params.set('direction', normalized.direction)
    params.set('start', String(normalized.start))
    params.set('limit', String(Math.min(normalized.limit, LIMITS.panelMax)))
    let path: string
    if (normalized.search !== undefined) {
      // Saved searches execute on their own path endpoint (Local API extension).
      path = `${prefix}/searches/${enc(normalized.search)}/items`
    } else if (normalized.collection !== undefined) {
      // Collection filters use the /collections/<key>/items/top endpoint; there is no collection= parameter.
      const node = await this.resolveCollection(library, normalized.collection)
      path = `${prefix}/collections/${enc(node.key)}/items/top`
    } else {
      path = `${prefix}/items/top`
    }
    const { data, response } = await this.client.getJson<RawItem[]>(`${path}?${params}`)
    this.noteVersion(library, response.headers.get('last-modified-version'))
    // Saved searches may return child items and annotations; panels list top-level items only.
    const filtered = data.filter((item) => {
      if (item.data.itemType === 'annotation') return false
      if (normalized.search !== undefined && item.data.parentItem) return false
      return true
    })
    const total = parseTotalResults(response.headers.get('total-results')) ?? filtered.length
    const paging = parseLinkHeader(response.headers.get('link'))
    return {
      library,
      version: this.versionOf(library),
      query: normalized,
      total,
      items: filtered.map(summarize),
      ...(Object.keys(paging).length > 0 ? { paging } : {}),
    }
  }

  /** Fetch explicit keys in `itemKey=` batches of 50. */
  async itemsByKey(library: LibraryId, keys: string[]): Promise<RawItem[]> {
    const prefix = libraryPrefix(library)
    const results: RawItem[] = []
    for (let index = 0; index < keys.length; index += LIMITS.itemKeyBatch) {
      const batch = keys.slice(index, index + LIMITS.itemKeyBatch)
      const { data } = await this.client.getJson<RawItem[]>(`${prefix}/items?itemKey=${batch.map(enc).join(',')}`)
      results.push(...data)
    }
    return results
  }

  /** One raw item; single-object versions are item versions, not library versions. */
  async raw(library: LibraryId, key: string): Promise<RawItem> {
    parseItemKey(key, 'key')
    try {
      const { data } = await this.client.getJson<RawItem>(`${libraryPrefix(library)}/items/${enc(key)}`)
      return data
    } catch (error) {
      if (error instanceof ZoteroError && error.code === 'not_found') {
        throw new ZoteroError('not_found', `No item with key ${key} in ${library === 'user' ? 'My Library' : `library ${library}`}.`)
      }
      throw error
    }
  }

  /** Child items (attachments + notes; annotations are excluded by Zotero unless filtered). */
  async children(library: LibraryId, key: string): Promise<RawItem[]> {
    parseItemKey(key, 'key')
    const { data } = await this.client.getJson<RawItem[]>(`${libraryPrefix(library)}/items/${enc(key)}/children`)
    return data
  }

  /** Detail projection: raw item + children + collection names. */
  async item(library: LibraryId, key: string): Promise<ItemDetail> {
    const raw = await this.raw(library, key)
    const children = raw.data.itemType === 'attachment' || raw.data.itemType === 'note' ? [] : await this.children(library, key)
    const doc = await this.collections(library)
    const names = doc.collections.map((node) => ({ key: node.key, name: node.name }))
    return buildItemDetail(raw, children, names, this.versionOf(library), library)
  }

  /**
   * Export text through Zotero's own export formats (`format=bibtex` /
   * `format=ris` on the items endpoint). The result is stripped of local
   * storage paths (BibTeX `file` fields, RIS `L1` lines) so shared exports
   * never leak machine paths. V-point: the exact format value set accepted by
   * the Local API build under test is verified against real Zotero 10 before
   * the M2 milestone signs this route off; failures surface as data-layer
   * errors either way.
   */
  async exportText(library: LibraryId, format: 'bibtex' | 'ris', query: NormalizedItemQuery | Parameters<typeof normalizeItemQuery>[0]): Promise<string> {
    const normalized = normalizeItemQuery(query)
    const prefix = libraryPrefix(library)
    const params = new URLSearchParams()
    if (normalized.keys?.length) {
      params.set('itemKey', normalized.keys.join(','))
    } else {
      if (normalized.q !== undefined) {
        params.set('q', normalized.q)
        params.set('qmode', normalized.mode)
      }
      for (const tag of normalized.tag ?? []) params.append('tag', tag)
      params.set('start', String(normalized.start))
      params.set('limit', String(Math.min(normalized.limit, LIMITS.panelMax)))
    }
    params.set('format', format)
    const response = await this.client.get(`${prefix}/items?${params}`)
    return stripLocalPaths(response.text)
  }

  /**
   * Resolve an attachment to a local file path — the **only** place this
   * module produces one. Reads Zotero's `file/view/url` endpoint (a `file://`
   * URL on Zotero 10) and converts it; whether children JSON also carries
   * absolute paths remains unverified (V-4), so nothing else may guess paths.
   */
  async resolveAttachmentPath(library: LibraryId, attachmentKey: string): Promise<string> {
    parseItemKey(attachmentKey, 'attachmentKey')
    const response = await this.client.get(`${libraryPrefix(library)}/items/${enc(attachmentKey)}/file/view/url`, { allow: [400] })
    if (response.status === 400) throw new ZoteroError('not_pdf', `${attachmentKey} is not a file attachment.`)
    const url = response.text.trim()
    if (!url.startsWith('file:')) throw new ZoteroError('file_missing', `Zotero has no local file for attachment ${attachmentKey}.`)
    return fileURLToPath(url)
  }

  /** Annotations of a PDF attachment, parsed and sorted by `sortIndex`. */
  async annotations(library: LibraryId, attachmentKey: string): Promise<Annotation[]> {
    parseItemKey(attachmentKey, 'attachmentKey')
    const { data } = await this.client.getJson<RawItem[]>(`${libraryPrefix(library)}/items/${enc(attachmentKey)}/children?itemType=annotation`)
    return data.map(parseAnnotation).sort((a, b) => a.sortIndex.localeCompare(b.sortIndex))
  }

  /**
   * Fields valid for one item type (`GET /api/itemTypeFields?itemType=…` —
   * the Local API's schema endpoint). Cached per type. Import flows use it
   * to drop fields Zotero would reject before writing.
   */
  async validFields(itemType: string): Promise<Set<string>> {
    const cached = this.fieldsCache.get(itemType)
    if (cached) return cached
    const { data } = await this.client.getJson<{ field: string }[]>(`/api/itemTypeFields?itemType=${enc(itemType)}`)
    const fields = new Set(data.map((entry) => entry.field))
    this.fieldsCache.set(itemType, fields)
    return fields
  }

  /** Drop caches (after a write or for explicit refreshes). */
  invalidate(library?: LibraryId): void {
    if (library !== undefined) this.collectionsCache.delete(library)
    else this.collectionsCache.clear()
  }
}
