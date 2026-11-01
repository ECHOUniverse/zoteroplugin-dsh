/**
 * Domain contract shared by every later consumer (routes, Agent tools, stores):
 * Zotero library types, item projections, connection status, limits and the
 * error taxonomy. Pure data + pure validation functions only — no I/O.
 *
 * Attribution: `ZoteroError`, `KEY_PATTERN`, `libraryPrefix` and several type
 * shapes are adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/contract.ts` (repo LICENSE: Apache-2.0). Modifications: renamed
 * (`ZoteroStatus` → `ConnectionStatus`), added the `unsupported` connection
 * state and `unsupported_version` error code for the Zotero 10+ floor, added
 * multi-tag `ItemQuery` support, runtime validation helpers and the
 * `parseTotalResults`/`parseLinkHeader` helpers; limits re-derived for the DSH
 * panel. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/domain/model
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Numbers the implementation spec fixes. Callers pick their own budget from
 * these; the data layer never invents limits.
 *
 * - `pageSize` — one list page in the panel.
 * - `searchDefault` / `searchMax` — Agent search tool defaults (25) and cap
 *   (100).
 * - `panelMax` — cumulative cap for any panel-driven list query.
 * - `writeBatch` — objects per write request (Zotero itemKey/batch cap).
 * - `itemKeyBatch` — keys per `itemKey=` read request (Web API v3: 50).
 */
export const LIMITS = {
  pageSize: 50,
  searchDefault: 25,
  searchMax: 100,
  panelMax: 500,
  writeBatch: 50,
  itemKeyBatch: 50,
  /** Read timeout for one Local API request. */
  readTimeoutMs: 30_000,
  /** Probe (`GET /api/`) timeout. */
  probeTimeoutMs: 5_000,
  /** Time to wait for the user to answer Zotero's authorization dialog. */
  authorizeTimeoutMs: 180_000,
  /** Write request timeout (uploads can be slow). */
  writeTimeoutMs: 120_000,
  /** How long a probe result stays fresh before calls re-probe. */
  probeFreshMs: 1_000,
  /**
   * PDF byte chunk served by `GET /dsh-zotero/pdf/part` (2 MiB per request,
   * so a 100 MiB attachment streams over ~50 bounded responses instead of one
   * giant JSON/base64 blob).
   */
  pdfChunkBytes: 2 * 1024 * 1024,
  /** Largest PDF the reader/text tools will open (matches the panel budget). */
  pdfMaxBytes: 256 * 1024 * 1024,
  /** Parsed-PDF text cache capacity (`PdfStore` LRU, keyed by path+mtime+size). */
  pdfCache: 4,
  /** Default character budget of the `read_fulltext` tool. */
  fulltextChars: 30_000,
  /** Longest quote accepted by the highlight tool. */
  quoteMaxChars: 5_000,
  /**
   * Metadata services (doi.org content negotiation, arXiv Atom) timeout for
   * one request (reference parity: reference `LIMITS.metadataTimeoutMs`).
   */
  metadataTimeoutMs: 20_000,
  /** PDF download budget for `attach_pdf`/`add_item` URL mode (60 s). */
  downloadTimeoutMs: 60_000,
  /** PDF download size cap (100 MiB — same as the attachment ceiling). */
  downloadBytes: 100 * 1024 * 1024,
  /** Redirect hops a metadata/PDF download may follow (SSRF re-check per hop). */
  downloadRedirects: 5,
} as const

// ---------------------------------------------------------------------------
// Annotation colors and session highlights
// ---------------------------------------------------------------------------

/**
 * Zotero's annotation color palette (named colors the annotation editor
 * offers). Values are the exact hex strings Zotero stores in
 * `annotationColor`. Adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/app/session.ts` (Apache-2.0); moved into the pure model so tools,
 * routes and tests share one table.
 */
export const ANNOTATION_COLORS: Record<string, string> = {
  yellow: '#ffd400',
  red: '#ff6666',
  green: '#5fb236',
  blue: '#2ea8e5',
  purple: '#a28ae5',
  magenta: '#e56eee',
  orange: '#f19837',
  gray: '#aaaaaa',
}

/** Agent highlights render in Zotero's purple so they read as "not mine". */
export const AGENT_COLOR = ANNOTATION_COLORS.purple!

/**
 * Resolve a color given by name or `#rrggbb`; `undefined` defaults to the
 * agent purple. Throws `invalid_input` on anything else.
 */
export function resolveColor(color: string | undefined): string {
  if (color === undefined || color === '') return AGENT_COLOR
  const named = ANNOTATION_COLORS[color.toLowerCase()]
  if (named !== undefined) return named
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase()
  throw new ZoteroError('invalid_input', `Unknown color "${color}". Use one of ${Object.keys(ANNOTATION_COLORS).join(', ')} or #rrggbb.`)
}

/**
 * One in-session Agent highlight: exists only in host memory (never Zotero)
 * until `save_highlights` / the UI save route turns it into a real Zotero
 * highlight annotation. `savedAs` records the annotation key after saving, so
 * repeated saves skip it and the reader can de-duplicate the drawing.
 */
export interface AgentHighlight {
  /** Session-unique id (`h1`, `h2`, …). */
  id: string
  library: LibraryId
  attachmentKey: string
  /** Parent item key (the reader route opens through it). */
  itemKey: string
  /** 0-based physical page index. */
  pageIndex: number
  /** Zotero's printed page label (falls back to the physical number). */
  pageLabel: string
  /** The quote as it is actually written in the PDF. */
  quote: string
  comment: string
  color: string
  /** Page-space rectangles (PDF user space, pt). */
  rects: Rect[]
  createdAt: number
  /** Zotero annotation key once saved. */
  savedAs?: string
}

/** Minimum supported Zotero major version (writes are Zotero 10+, reads we only support there too). */
export const MIN_ZOTERO_MAJOR = 10

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ZoteroErrorCode =
  | 'zotero_not_running'
  | 'zotero_not_installed'
  | 'local_api_disabled'
  /** Zotero answered but its major version is below the supported floor (10). */
  | 'unsupported_version'
  | 'zotero_error'
  | 'not_found'
  | 'invalid_input'
  | 'not_pdf'
  | 'file_missing'
  | 'quote_not_found'
  | 'writes_unsupported'
  | 'write_denied'
  | 'authorize_rate_limited'
  | 'version_conflict'
  | 'write_failed'
  | 'metadata_not_found'
  | 'download_failed'
  /** A workspace path escaped the workspace root (absolute, `..`, or symlink). */
  | 'path_outside_workspace'
  /** A plugin-side failure not attributable to Zotero (e.g. pdf.js failed to load). */
  | 'internal'

/**
 * Every data-layer failure surfaces as this error; routes and tools switch on
 * `code` and never re-parse HTTP statuses.
 */
export class ZoteroError extends Error {
  constructor(
    readonly code: ZoteroErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ZoteroError'
  }
}

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------

/** Library id: `"user"` for the personal library, `"g<groupId>"` for groups. */
export type LibraryId = string

/** Parsed library id. */
export type ParsedLibrary = { type: 'user' } | { type: 'group'; id: number }

/**
 * Zotero item key as an embeddable regex fragment (charset + length, NO
 * anchors) — for building larger route patterns around it.
 */
export const KEY_SOURCE = '[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}'

/** Zotero item key: 8 chars of `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ` (no 0/1/O/I). */
export const KEY_PATTERN = new RegExp(`^${KEY_SOURCE}$`)

/**
 * Zotero-owned fields no client may set through any write path (single home
 * shared by the route gate and the tool-layer check).
 */
export const ZOTERO_MANAGED_FIELDS: readonly string[] = ['key', 'version', 'dateAdded', 'dateModified']

export function isItemKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value)
}

/** Validate an item key coming from outside; throws `invalid_input`. */
export function parseItemKey(value: unknown, field: string): string {
  if (!isItemKey(value)) throw new ZoteroError('invalid_input', `${field} must be a Zotero item key (8 chars, charset ${'23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'}); got ${JSON.stringify(value)}.`)
  return value
}

/** Parse a library id; throws `invalid_input` on anything else. */
export function parseLibraryId(library: LibraryId): ParsedLibrary {
  if (library === 'user') return { type: 'user' }
  const match = /^g(\d+)$/.exec(library)
  if (!match) throw new ZoteroError('invalid_input', `Unknown library "${library}". Use "user" or "g<groupId>".`)
  return { type: 'group', id: Number(match[1]) }
}

/** Library id to Local API path prefix (`/api/users/0`, `/api/groups/<id>`). */
export function libraryPrefix(library: LibraryId): string {
  const parsed = parseLibraryId(library)
  return parsed.type === 'user' ? '/api/users/0' : `/api/groups/${parsed.id}`
}

export interface LibraryInfo {
  id: LibraryId
  name: string
  type: 'user' | 'group'
  /** Whether writes may be attempted at all (group settings can forbid editing). */
  editable: boolean
  /** Last known library version (`Last-Modified-Version`), if polled. */
  version?: number
}

// ---------------------------------------------------------------------------
// Collections and saved searches
// ---------------------------------------------------------------------------

export interface CollectionNode {
  key: string
  name: string
  /** Parent collection key, or null for root collections. */
  parent: string | null
  numItems: number
  numCollections: number
}

export interface SavedSearch {
  key: string
  name: string
}

/** Alias for `CollectionNode` (contract name used across consumers). */
export type CollectionInfo = CollectionNode

export interface CollectionsDoc {
  library: LibraryId
  /** Library version this snapshot was read at (cache key). */
  version: number
  collections: CollectionNode[]
  searches: SavedSearch[]
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type SearchMode = 'titleCreatorYear' | 'everything'

export type SortField = 'dateModified' | 'dateAdded' | 'title' | 'creator' | 'date'

export type SortDirection = 'asc' | 'desc'

/** Query as callers express it; `normalizeItemQuery` turns it into a safe shape. */
export interface ItemQuery {
  /** Quick search text. */
  q?: string
  /** `titleCreatorYear` (default) or `everything` (full-text + notes). */
  mode?: SearchMode
  /** Collection key or name reference (`"父/子"` paths allowed). */
  collection?: string
  /** Tags: one string with Zotero tag syntax, or several strings (AND). */
  tag?: string | string[]
  /** Saved-search key (executed via `/searches/<key>/items`). */
  search?: string
  /** Explicit item keys (`itemKey=`). */
  keys?: string[]
  sort?: SortField
  direction?: SortDirection
  start?: number
  limit?: number
}

export interface NormalizedItemQuery {
  q?: string
  mode: SearchMode
  tag?: string[]
  collection?: string
  search?: string
  keys?: string[]
  sort: SortField
  direction: SortDirection
  start: number
  limit: number
}

const SORT_FIELDS: readonly SortField[] = ['dateModified', 'dateAdded', 'title', 'creator', 'date']
const DIRECTIONS: readonly SortDirection[] = ['asc', 'desc']
const MODES: readonly SearchMode[] = ['titleCreatorYear', 'everything']
/** Characters that must never reach a query value (injection hygiene). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const MAX_TEXT_LENGTH = 500
const MAX_REF_LENGTH = 200

function text(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ZoteroError('invalid_input', `${field} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) throw new ZoteroError('invalid_input', `${field} is longer than ${maxLength} characters.`)
  if (CONTROL_CHARS.test(trimmed)) throw new ZoteroError('invalid_input', `${field} must not contain control characters.`)
  return trimmed
}

function intIn(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ZoteroError('invalid_input', `${field} must be an integer between ${min} and ${max}.`)
  }
  return value
}

/** Pagination numbers clamp instead of throwing; only non-integers are invalid. */
function clampInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    throw new ZoteroError('invalid_input', `${field} must be an integer.`)
  }
  return Math.min(Math.max(value, min), max)
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ZoteroError('invalid_input', `${field} must be one of ${allowed.join(', ')}.`)
  }
  return value as T
}

/**
 * Validate and normalize an `ItemQuery`. Throws `ZoteroError('invalid_input')`
 * on anything unsafe; the result is safe to turn into query parameters (the
 * transport still percent-encodes every value).
 */
export function normalizeItemQuery(query: ItemQuery): NormalizedItemQuery {
  const sort = oneOf(query.sort, 'sort', SORT_FIELDS) ?? 'dateModified'
  const direction =
    oneOf(query.direction, 'direction', DIRECTIONS) ?? (sort === 'title' || sort === 'creator' ? 'asc' : 'desc')
  const mode = oneOf(query.mode, 'mode', MODES) ?? 'titleCreatorYear'
  const q = text(query.q, 'q', MAX_TEXT_LENGTH)
  const collection = text(query.collection, 'collection', MAX_REF_LENGTH)
  const search = text(query.search, 'search', MAX_REF_LENGTH)
  // 显式传入的引用不允许为空（空串与纯空白都会静默丢失语义）。
  if (query.collection !== undefined && query.collection !== null && collection === undefined) {
    throw new ZoteroError('invalid_input', 'collection must be a non-empty key or name reference.')
  }
  if (query.search !== undefined && query.search !== null && search === undefined) {
    throw new ZoteroError('invalid_input', 'search must be a non-empty key or name reference.')
  }
  const tags = query.tag === undefined || query.tag === null
    ? undefined
    : (Array.isArray(query.tag) ? query.tag : [query.tag]).map((tag, index) => {
        const parsed = text(tag, `tag[${index}]`, MAX_TEXT_LENGTH)
        if (!parsed) throw new ZoteroError('invalid_input', `tag[${index}] must be a non-empty string.`)
        return parsed
      })
  let keys: string[] | undefined
  if (query.keys !== undefined && query.keys !== null) {
    if (!Array.isArray(query.keys)) throw new ZoteroError('invalid_input', 'keys must be an array of item keys.')
    if (query.keys.length > LIMITS.itemKeyBatch) {
      throw new ZoteroError('invalid_input', `keys supports at most ${LIMITS.itemKeyBatch} keys per query.`)
    }
    keys = query.keys.map((key, index) => parseItemKey(key, `keys[${index}]`))
  }
  const normalized: NormalizedItemQuery = {
    ...(q !== undefined ? { q } : {}),
    mode,
    ...(tags !== undefined ? { tag: tags } : {}),
    ...(collection !== undefined ? { collection } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(keys !== undefined ? { keys } : {}),
    sort,
    direction,
    start: clampInt(query.start, 'start', 0, 10_000_000) ?? 0,
    limit: clampInt(query.limit, 'limit', 1, LIMITS.panelMax) ?? LIMITS.pageSize,
  }
  return normalized
}

// ---------------------------------------------------------------------------
// Item projections
// ---------------------------------------------------------------------------

export interface Creator {
  creatorType: string
  firstName?: string
  lastName?: string
  name?: string
}

export interface ItemSummary {
  key: string
  itemType: string
  /** Non-empty: falls back to note excerpt / filename / "(untitled)". */
  title: string
  /** Zotero's creator summary, e.g. "Lovelace et al.". */
  creatorSummary: string
  /** Four-digit year, or "" when unknown. */
  year: string
  /** Journal / conference / publisher / repository… first non-empty venue field. */
  venue: string
  tags: string[]
  numChildren: number
  /** Best PDF attachment: the item itself for PDF attachments, else Zotero's best attachment link. */
  pdf: { key: string; size?: number } | null
  dateAdded: string
  dateModified: string
}

export interface ItemList {
  library: LibraryId
  /** Library version the list was read at. */
  version: number
  query: NormalizedItemQuery
  /** Total matched items (`Total-Results`), independent of paging. */
  total: number
  items: ItemSummary[]
  /** Parsed `Link` header pagination targets, when Zotero sent them. */
  paging?: LinkPaging
}

export interface AttachmentInfo {
  key: string
  title: string
  contentType: string
  linkMode: string
  filename?: string
  url?: string
  /** Local readable PDF (stored/imported, not a linked URL). */
  isPdf: boolean
  parent: string | null
  /**
   * Intentionally no local path here: whether Zotero exposes absolute paths in
   * children JSON is unverified (spec V-4). Paths come from
   * `ZoteroLibrary.resolveAttachmentPath` only.
   */
}

export interface NoteInfo {
  key: string
  html: string
  excerpt: string
  dateModified: string
}

export interface ItemDetail extends ItemSummary {
  library: LibraryId
  version: number
  /** The item's own version (`If-Unmodified-Since-Version` for PATCH). */
  itemVersion: number
  creators: Creator[]
  /** Non-empty scalar fields besides title/creators/abstract/tags/collections/relations. */
  fields: Record<string, string>
  abstract: string
  collections: { key: string; name: string }[]
  attachments: AttachmentInfo[]
  notes: NoteInfo[]
  /** Parent item key when this item is a child attachment/note. */
  parent: string | null
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/** PDF user-space rectangle (origin bottom-left, pt): [x1, y1, x2, y2]. */
export type Rect = [number, number, number, number]

export interface Annotation {
  key: string
  type: string
  text: string
  comment: string
  color: string
  pageIndex: number
  pageLabel: string
  rects: Rect[]
  sortIndex: string
  tags: string[]
  dateModified: string
}

/** Alias for `Annotation` (contract name used across consumers). */
export type AnnotationInfo = Annotation

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export type ConnectionState =
  /** No probe has run yet. */
  | 'unknown'
  /** The local API answered. */
  | 'ready'
  /** Nothing listens on the configured address. */
  | 'not_running'
  /** Zotero runs but its local API is off (or absent in old versions). */
  | 'api_disabled'
  /** The local API answered but the Zotero major version is below 10. */
  | 'unsupported'
  /** The probe failed in another way. */
  | 'error'

export type WriteSupport =
  /** Not probed yet (write detection never runs on read paths). */
  | 'unknown'
  /** Zotero accepted the write-probe signature (428/401/412). */
  | 'available'
  /** Zotero rejected the write-probe signature; local API is read-only here. */
  | 'unsupported'

export type WriteAuth =
  /** No usable key. */
  | 'none'
  /** A remembered ("always allow") key is stored for this server id. */
  | 'remembered'
  /** An authorization dialog is currently open. */
  | 'pending'
  /** The user denied the last authorization request. */
  | 'denied'

export interface ConnectionStatus {
  state: ConnectionState
  writes: WriteSupport
  auth: WriteAuth
  /** Zotero application version from `X-Zotero-Version`, e.g. "10.0.2". */
  version?: string
  /** Instance identity from `Zotero-Server-ID`; keys are stored per id. */
  serverId?: string
  /** Error message when `state === 'error'`. */
  error?: string
  /** Clock at the last status change (injectable clock, ms epoch). */
  checkedAt: number
}

// ---------------------------------------------------------------------------
// Desktop install (M7)
// ---------------------------------------------------------------------------

/**
 * Whether the Zotero desktop app is installed on this machine. Detection is
 * filesystem-based per platform (macOS .app bundles, Windows exe locations,
 * Linux common paths + PATH); the version is only reported when it was
 * actually read from the bundle (`Info.plist` / `application.ini`) — never
 * guessed from a path.
 *
 * Attribution: candidate layout and version reads adapted from
 * zai-org/zcode-plugins `ui-plugins/zotero` `src/zotero/install.ts`
 * (Apache-2.0); the UI never receives absolute paths (host logs them).
 */
export interface ZoteroInstall {
  state: 'found' | 'missing'
  /**
   * Install location with the home directory abbreviated to `~`. Host-side
   * diagnostics only — stripped before anything crosses the wire to the UI.
   */
  path?: string
  /** Version read from the install (e.g. "7.0.15"); absent when unreadable. */
  version?: string
  /** When missing: the locations that were searched (for user guidance). */
  searched: string[]
}

// ---------------------------------------------------------------------------
// Response header parsing
// ---------------------------------------------------------------------------

/** One pagination target parsed from a `Link` header. */
export interface LinkPaging {
  next?: { start: number; limit: number }
  prev?: { start: number; limit: number }
  first?: { start: number; limit: number }
  last?: { start: number; limit: number }
}

/** `Total-Results` header to number; undefined when absent/invalid. */
export function parseTotalResults(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function pagingFromUrl(url: string): { start: number; limit: number } | undefined {
  try {
    const params = new URL(url, 'http://dsh.invalid').searchParams
    const start = Number(params.get('start') ?? Number.NaN)
    const limit = Number(params.get('limit') ?? Number.NaN)
    if (!Number.isInteger(start) || !Number.isInteger(limit) || start < 0 || limit <= 0) return undefined
    return { start, limit }
  } catch {
    return undefined
  }
}

/**
 * Parse a `Link` header (`<url>; rel="next", …`) into pagination targets.
 * Tolerates missing/malformed input; unknown rels are dropped.
 */
export function parseLinkHeader(value: string | null | undefined): LinkPaging {
  if (!value) return {}
  const paging: LinkPaging = {}
  for (const part of value.split(',')) {
    const match = /^\s*<([^>]*)>\s*;\s*rel="?([a-z]+)"?\s*$/i.exec(part)
    if (!match) continue
    const target = pagingFromUrl(match[1]!)
    if (!target) continue
    const rel = match[2]!.toLowerCase()
    if (rel === 'next' || rel === 'prev' || rel === 'first' || rel === 'last') paging[rel] = target
  }
  return paging
}
