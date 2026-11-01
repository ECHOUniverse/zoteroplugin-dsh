/**
 * Wire contract shared by the host half and the client half of
 * `@hanxu131/dsh-zotero`.
 *
 * This module is the single source for the plugin identity, the
 * `webServer` route table the host half registers (see
 * `docs/adr/0002-dsh-two-halves-webserver-single-right-tab.md`), and the
 * JSON payloads both halves exchange. It is pure data: no Node or browser
 * imports, so both halves and the test suite can import it freely.
 *
 * Security posture (task red lines):
 * - Every route except `health` requires an authenticated DSH browser or API
 *   Peer, enforced with the official `ctx.connection.requestRejection` fence
 *   (Host/Origin check, `sec-fetch-site: cross-site` refusal, cookie auth).
 * - No wire type may carry the Zotero API key or server id.
 * - Error payloads use the uniform `{ error: { code, message, details? } }`
 *   envelope and never echo credentials.
 *
 * @module @hanxu131/dsh-zotero/shared/protocol
 */

/** Plugin identity; must equal the manifest `name`. */
export const PLUGIN_NAME = '@hanxu131/dsh-zotero'

/** Plugin version; `tests/protocol.test.ts` keeps this in sync with package.json. */
export const PLUGIN_VERSION = '0.2.0'

/**
 * Route namespace this bundle claims on the DSH webServer. One `prefix`
 * registration covers every endpoint below, so a route collision can only
 * happen with another plugin claiming the same namespace.
 */
export const ROUTE_BASE = '/dsh-zotero'

/** Static endpoints exposed by the host half on the DSH webServer. */
export const ROUTES = {
  /**
   * Liveness + plugin identity; the client half uses it as its reachability
   * probe. The one minimal-public route: it carries no library data.
   */
  health: `${ROUTE_BASE}/health`,
  /** Zotero connection probe (not running / local API disabled / ready). */
  status: `${ROUTE_BASE}/status`,
  /** Personal library + groups. */
  libraries: `${ROUTE_BASE}/libraries`,
  /** Collection tree + saved searches (`?library=`). */
  collections: `${ROUTE_BASE}/collections`,
  /** Item search / list (`?library=&q=&mode=&tag=&sort=&…`). */
  items: `${ROUTE_BASE}/items`,
  /** BibTeX/RIS export text (`?library=&format=&keys=…`), local paths stripped. */
  export: `${ROUTE_BASE}/export`,
  /** Trigger Zotero's write-authorization dialog (POST, no key in response). */
  writesAuthorize: `${ROUTE_BASE}/writes/authorize`,
  /** Create items (POST). */
  writesItems: `${ROUTE_BASE}/writes/items`,
  /** Create collections (POST). */
  writesCollections: `${ROUTE_BASE}/writes/collections`,
  /** Start the installed Zotero desktop app (POST; explicit UI action only). */
  desktopLaunch: `${ROUTE_BASE}/desktop/launch`,
  /** Open a zotero:// deep link built server-side (POST; library/key/page). */
  desktopOpen: `${ROUTE_BASE}/desktop/open`,
  /** Server-sent events: view navigation intents with monotonic `seq`. */
  events: `${ROUTE_BASE}/events`,
} as const

/** Dynamic (per-item) route paths. Callers must pass a validated item key. */
export const routeItem = {
  /** `GET` item detail / `PATCH`-via-`/writes` update target. */
  detail: (key: string) => `${ROUTE_BASE}/items/${key}`,
  /** `GET` attachments + notes of an item. */
  children: (key: string) => `${ROUTE_BASE}/items/${key}/children`,
  /** `GET` annotations of an item (own or best child PDF attachment). */
  annotations: (key: string) => `${ROUTE_BASE}/items/${key}/annotations`,
  /** `POST` a child note. */
  note: (key: string) => `${ROUTE_BASE}/writes/items/${key}/note`,
  /** `POST` an attachment upload (three-step Local API flow, ≤100 MB bytes). */
  attachment: (key: string) => `${ROUTE_BASE}/writes/items/${key}/attachment`,
  /** `PATCH` update item fields. */
  update: (key: string) => `${ROUTE_BASE}/writes/items/${key}`,
} as const

/**
 * PDF content surface (M4). Query-parameter routes (library/attachment are
 * validated Zotero references — never file paths); bytes stream in 2 MiB
 * chunks; the pdf.js data assets are whitelisted static files. Everything
 * below is behind the trust fence (only `health` is public).
 */
export const ROUTES_PDF = {
  /** `GET` reader bootstrap: size, chunk count, sha256, page count. */
  info: `${ROUTE_BASE}/pdf/info`,
  /** `GET` one 2 MiB chunk (`?library=&attachment=&part=N`, octet-stream). */
  part: `${ROUTE_BASE}/pdf/part`,
  /** Static pdf.js data (`/pdfjs/<cmaps|standard_fonts|wasm>/<file>`). */
  assets: `${ROUTE_BASE}/pdfjs`,
} as const

/** Whitelisted static asset kinds under `ROUTES_PDF.assets`. */
export const PDF_ASSET_KINDS = ['cmaps', 'standard_fonts', 'wasm'] as const

/** Static asset path builder (filename is host-whitelisted again). */
export const routePdfAsset = (kind: string, filename: string): string => `${ROUTES_PDF.assets}/${kind}/${encodeURIComponent(filename)}`

/** Session-highlight UI write routes (explicit UI actions; no DSH approval). */
export const ROUTES_HIGHLIGHT_WRITES = {
  /** `POST` save session highlights as Zotero annotations. */
  save: `${ROUTE_BASE}/writes/highlights/save`,
  /** `POST` remove session highlights (session state only; Zotero untouched). */
  clear: `${ROUTE_BASE}/writes/highlights/clear`,
} as const

// ---------------------------------------------------------------------------
// Transport limits (shared by host enforcement and client expectations)
// ---------------------------------------------------------------------------

/** Hard cap for JSON request bodies of the write routes (except attachments). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024

/**
 * Attachment upload cap: 100 MiB of attachment bytes; base64 inflates by
 * 4/3, and the JSON wrapper adds a little more, so the request-body ceiling
 * is 140 MiB while the decoded bytes are re-checked against 100 MiB.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
/** Request-body ceiling for the attachment route (base64 + JSON wrapper). */
export const MAX_ATTACHMENT_BODY_BYTES = 140 * 1024 * 1024

/** Maximum concurrent SSE clients on `events`. */
export const MAX_EVENT_CLIENTS = 16
/** Maximum retained event history for `Last-Event-ID` replay. */
export const MAX_EVENT_HISTORY = 100

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

/** `GET ${ROUTES.health}` response body. */
export interface HealthResponse {
  /** Always true when the route answered. */
  ok: true
  /** Serving plugin name (`PLUGIN_NAME`). */
  plugin: string
  /** Serving plugin version (`PLUGIN_VERSION`). */
  version: string
}

/** Zotero reachability as reported by `GET ${ROUTES.status}`. */
export type ZoteroConnectionState =
  /** No probe has run yet. */
  | 'unknown'
  /** The local API answered. */
  | 'ready'
  /** Nothing listens on the configured address: Zotero is not running. */
  | 'not_running'
  /** Zotero runs but its local API is turned off in settings. */
  | 'api_disabled'
  /** The local API answered but the Zotero major version is below 10. */
  | 'unsupported'
  /** The probe failed in another way; `error` carries the message. */
  | 'error'

/** Write support as probed by the host (never probed on read paths). */
export type WriteSupport = 'unknown' | 'available' | 'unsupported'

/** Zotero write authorization as seen by the host (no key material). */
export type WriteAuth = 'none' | 'remembered' | 'pending' | 'denied'

/**
 * Local Zotero install as surfaced to the UI. Deliberately NO absolute path:
 * the install location stays host-side (session diagnostics); the UI gets
 * only the state, the version read from the bundle (never path-guessed) and,
 * when missing, the searched locations.
 */
export interface InstallWire {
  state: 'found' | 'missing'
  /** Version read from Info.plist / application.ini; absent when unreadable. */
  version?: string
  /** When missing: the locations probed (home abbreviated to `~`). */
  searched?: string[]
}

/** `GET ${ROUTES.status}` response body. */
export interface StatusResponse {
  plugin: string
  state: ZoteroConnectionState
  /**
   * Loopback base URL the host half uses for the Zotero Local API (the
   * configured `localApiBaseUrl`, already validated loopback + credential-free
   * host-side). Display-only: edits happen in the DSH plugin settings form —
   * no write route exists for it.
   */
  baseUrl: string
  /** Write-capability probe result, when known. */
  writes?: WriteSupport
  /** Authorization state, when known. */
  auth?: WriteAuth
  /** Zotero application version when the local API reported one. */
  zoteroVersion?: string
  error?: string
  checkedAt: number
  /** Local install probe (present when Zotero is not answering). */
  install?: InstallWire
}

/** `GET ${ROUTES.libraries}` response body. */
export interface LibrariesResponse {
  libraries: { id: string; name: string; type: 'user' | 'group'; editable: boolean; version?: number }[]
}

/** Collection tree node. */
export interface CollectionWire {
  key: string
  name: string
  parent: string | null
  numItems: number
  numCollections: number
}

/** Saved search entry. */
export interface SavedSearchWire {
  key: string
  name: string
}

/** `GET ${ROUTES.collections}?library=` response body. */
export interface CollectionsResponse {
  library: string
  version: number
  collections: CollectionWire[]
  searches: SavedSearchWire[]
}

/** Creator row of a summary/detail. */
export interface CreatorWire {
  creatorType: string
  firstName?: string
  lastName?: string
  name?: string
}

/** One item in list responses. */
export interface ItemSummaryWire {
  key: string
  itemType: string
  title: string
  creatorSummary: string
  year: string
  venue: string
  tags: string[]
  numChildren: number
  pdf: { key: string; size?: number } | null
  dateAdded: string
  dateModified: string
}

/** Pagination targets (parsed from Zotero `Link` headers). */
export interface PagingWire {
  next?: { start: number; limit: number }
  prev?: { start: number; limit: number }
  first?: { start: number; limit: number }
  last?: { start: number; limit: number }
}

/** `GET ${ROUTES.items}?…` response body. */
export interface ItemsResponse {
  library: string
  version: number
  total: number
  start: number
  limit: number
  items: ItemSummaryWire[]
  paging?: PagingWire
}

/** Attachment row of a detail/children response (no local paths — see M1). */
export interface AttachmentWire {
  key: string
  title: string
  contentType: string
  linkMode: string
  filename?: string
  url?: string
  isPdf: boolean
  parent: string | null
}

/** Note row of a detail/children response. */
export interface NoteWire {
  key: string
  html: string
  excerpt: string
  dateModified: string
}

/** `GET` item detail response body. */
export interface ItemDetailWire extends ItemSummaryWire {
  library: string
  version: number
  /** The item's own version (`If-Unmodified-Since-Version` for updates). */
  itemVersion: number
  creators: CreatorWire[]
  fields: Record<string, string>
  abstract: string
  collections: { key: string; name: string }[]
  attachments: AttachmentWire[]
  notes: NoteWire[]
  parent: string | null
}

/** `GET …/children` response body. */
export interface ChildrenResponse {
  item: string
  attachments: AttachmentWire[]
  notes: NoteWire[]
}

/** PDF user-space rectangle (origin bottom-left, pt): [x1, y1, x2, y2]. */
export type RectWire = [number, number, number, number]

/** One annotation of a PDF attachment. */
export interface AnnotationWire {
  key: string
  type: string
  text: string
  comment: string
  color: string
  pageIndex: number
  pageLabel: string
  rects: RectWire[]
  sortIndex: string
  tags: string[]
  dateModified: string
}

/** `GET …/annotations` response body. */
export interface AnnotationsResponse {
  item: string
  attachment: string | null
  annotations: AnnotationWire[]
  /** In-session Agent highlights for the same attachment (empty when none). */
  highlights: HighlightWire[]
}

/** One in-session Agent highlight as served to the reader. */
export interface HighlightWire {
  id: string
  library: string
  attachmentKey: string
  itemKey: string
  pageIndex: number
  pageLabel: string
  quote: string
  comment: string
  color: string
  rects: RectWire[]
  createdAt: number
  /** Zotero annotation key once saved through save_highlights / the UI route. */
  savedAs?: string
}

/** `GET ${ROUTES_PDF.info}` response body. */
export interface PdfInfoResponse {
  library: string
  attachmentKey: string
  itemKey: string
  title: string
  filename: string
  bytes: number
  /** Number of 2 MiB chunks `ROUTES_PDF.part` serves. */
  parts: number
  sha256: string
  /** Page count when text extraction succeeded (null otherwise). */
  pageCount: number | null
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

/** `POST ${ROUTES.writesAuthorize}` request body. */
export interface AuthorizeWritesRequest {
  /** Optional reason shown to the user in future UIs; ignored by Zotero. */
  reason?: string
}

/** `POST ${ROUTES.writesAuthorize}` response body — never carries the key. */
export interface AuthorizeWritesResponse {
  authorized: true
  /** Whether Zotero issued a remembered ("always allow") key. */
  remembered: boolean
}

/** Structured item fields for `POST ${ROUTES.writesItems}`. */
export interface CreateItemRequest {
  /** Target library (`user` or `g<id>`). */
  library: string
  /** Zotero item type, e.g. `journalArticle`. */
  itemType: string
  /** Field values (`title`, `creators`, `tags`, `DOI`, …). Server-owned fields rejected. */
  fields?: Record<string, unknown>
}

/** `POST ${ROUTES.writesItems}` response body. */
export interface CreateItemResponse {
  key: string
}

/** `PATCH ${routeItem.update(key)}` request body. */
export interface UpdateItemRequest {
  library: string
  /** Field overrides applied onto the current item. */
  fields: Record<string, unknown>
}

/** `PATCH ${routeItem.update(key)}` response body. */
export interface UpdateItemResponse {
  changed: boolean
  item: ItemSummaryWire
}

/** `POST ${routeItem.note(key)}` request body. */
export interface AddNoteRequest {
  library: string
  /** Note HTML (rendered safely downstream; stored verbatim in Zotero). */
  html: string
  tags?: string[]
}

/** `POST ${routeItem.note(key)}` / collection / attachment response bodies. */
export interface CreatedKeyResponse {
  key: string
}

/** `POST ${ROUTES.writesCollections}` request body. */
export interface CreateCollectionRequest {
  library: string
  name: string
  /** Parent collection key, or omitted/null for a root collection. */
  parentKey?: string | null
}

/** `POST ${ROUTES.desktopLaunch}` response body. */
export interface DesktopLaunchResponse {
  launched: true
}

/** `POST ${ROUTES.desktopOpen}` request body (URL is built server-side). */
export interface DesktopOpenRequest {
  /** Target library (`user` or `g<id>`). */
  library: string
  /** Item (select) or attachment (open-pdf) key. */
  key: string
  /** `select` reveals the item; `open-pdf` opens the reader. */
  target: 'select' | 'open-pdf'
  /** 1-based page for `open-pdf`. */
  page?: number
}

/** `POST ${ROUTES.desktopOpen}` response body. */
export interface DesktopOpenResponse {
  opened: true
  /** The strictly constructed deep link that was opened. */
  url: string
}

/** `POST ${routeItem.attachment(key)}` request body. */
export interface AttachRequest {
  library: string
  /** Attachment file name (no path separators), ≤255 chars. */
  filename: string
  /** MIME type, e.g. `application/pdf`. */
  contentType: string
  /** Attachment title shown in Zotero. */
  title: string
  /** File bytes, base64-encoded; ≤100 MiB decoded. */
  bytesBase64: string
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/** Machine-readable error codes surfaced over the wire. */
export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_pdf'
  | 'file_missing'
  | 'metadata_not_found'
  | 'quote_not_found'
  | 'version_conflict'
  | 'write_denied'
  | 'writes_unsupported'
  | 'unsupported_version'
  | 'authorize_rate_limited'
  | 'zotero_not_running'
  | 'zotero_not_installed'
  | 'local_api_disabled'
  | 'zotero_error'
  | 'write_failed'
  | 'download_failed'
  | 'path_outside_workspace'
  | 'unauthenticated'
  | 'forbidden'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'not_implemented'
  | 'service_unavailable'
  | 'internal'

/** Uniform error body for every non-2xx JSON response. */
export interface ErrorResponse {
  error: {
    code: ErrorCode
    /** Human-readable message; never contains credential material. */
    message: string
    details?: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------
// View events (`GET ${ROUTES.events}`, SSE)
// ---------------------------------------------------------------------------

/** Navigation intent produced by the `open_item` / `show_items` tools, or the in-session highlight nudge. */
export type ViewIntent =
  | { kind: 'open_item'; library: string; key: string; attachmentKey?: string; page?: number }
  | { kind: 'show_items'; library: string; keys: string[]; title?: string }
  /**
   * Session highlights changed (added/cleared/saved). No navigation: open
   * readers refresh their highlight layer; other views ignore it.
   */
  | { kind: 'highlights'; library: string; attachmentKey: string }

/**
 * One view event as pushed over SSE (`event: view`). `seq` is monotonic per
 * host process; the client half dedupes by it. Events carry navigation data
 * only — never credentials.
 */
export interface ViewEvent {
  seq: number
  /** Wall-clock publish time (ms epoch). */
  at: number
  intent: ViewIntent
}
