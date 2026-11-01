/**
 * Browser-side API client for the host half's `/dsh-zotero` routes
 * (implementation spec §2: the client half never talks to Zotero directly and
 * never holds a key — every call is a document-relative `fetch` reference that
 * the DSH webServer authenticates with its own browser session; see
 * `browserRef` for the official document-relative boundary rule).
 *
 * - Every request may carry an `AbortSignal`; view unmounts abort in flight.
 * - Non-2xx answers surface as `ApiError` carrying the unified error
 *   envelope's `code` (`{ error: { code, message } }`, shared/protocol.ts).
 * - The view-event SSE stream reconnects through the browser's native
 *   `Last-Event-ID` resume and additionally dedupes by the monotonic `seq`
 *   so a replayed event never navigates twice.
 *
 * @module @hanxu131/dsh-zotero/client/api
 */

import {
  ROUTES,
  ROUTES_HIGHLIGHT_WRITES,
  ROUTES_PDF,
  routeItem,
  type AnnotationsResponse,
  type ChildrenResponse,
  type CollectionsResponse,
  type ItemDetailWire,
  type ItemsResponse,
  type LibrariesResponse,
  type PdfInfoResponse,
  type StatusResponse,
  type ViewEvent,
} from '../shared/protocol.ts'

/** Error thrown for any non-2xx (or unparseable) host answer. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable code from the host envelope (`internal` when absent). */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Browser reference for one host route key. Route keys in `shared/protocol.ts`
 * are absolute (`/dsh-zotero/...`) because that is how the HOST half registers
 * them on the webServer table; the browser half references them
 * document-relative — the official boundary rule, stated on
 * `dsh-client-modules` combo URLs ("app-owned browser routes are
 * document-relative, so the route key's leading slash is stripped … at the
 * boundary between the two halves") and followed by every official client
 * half that calls custom webServer routes (`dsh-client-ui-open-in-app` fetches
 * `open-in-app/apps`, `dsh-client-hmr` subscribes `plugins/events`).
 *
 * Under the carriers that host this tab the reference lands on the host
 * origin without the page ever holding credentials or touching Zotero's
 * 23119 port:
 * - Desktop (Electron): the SPA document is `dsh-app://app/` and the shell's
 *   protocol handler forwards every non-static path to the host webServer
 *   with its own authentication cookie (`forwardWebRequest`, app.asar
 *   `lib/main.js`), so this relative fetch rides the official authenticated
 *   bridge.
 * - Web GUI: the SPA is served at the webServer root, so the reference is the
 *   same-origin relative URL it always was.
 *
 * A `file://` document cannot reach an HTTP host by any relative reference —
 * which is why the desktop carrier serves the SPA over `dsh-app://app` instead
 * of `file://`; the client must never embed an absolute host origin to work
 * around a carrier (it would bypass the shell's cookie bridge and the trust
 * fence would refuse it).
 */
export function browserRef(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

/** Structural fetch so tests can inject stubs; matches the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Shared JSON-endpoint handling: unified error envelope + JSON parse fallback. */
async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw envelopeError(response.status, text)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(response.status, 'internal', 'Host returned malformed JSON.')
  }
}

/** Fetch one JSON endpoint (relative path, same-origin). */
export async function apiJson<T>(path: string, options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<T> {
  return parseJsonResponse<T>(await doFetch(path, { method: 'GET', ...options }))
}

/** POST one JSON body and parse the JSON answer (UI write routes). */
export async function apiPost<T>(path: string, body: unknown, options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<T> {
  return parseJsonResponse<T>(await doFetch(path, { method: 'POST', body, ...options }))
}

/** Fetch a plain-text endpoint (export routes answer `text/plain`). */
export async function apiText(path: string, options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<string> {
  const response = await doFetch(path, { method: 'GET', ...options })
  const text = await response.text()
  if (!response.ok) throw envelopeError(response.status, text)
  return text
}

/** Fetch raw bytes (PDF chunks, pdf.js data assets). */
export async function apiBytes(path: string, options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<Uint8Array> {
  const response = await doFetch(path, { method: 'GET', ...options, accept: 'application/octet-stream' })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw envelopeError(response.status, text)
  }
  return new Uint8Array(await response.arrayBuffer())
}

interface DoFetchOptions {
  method: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
  body?: unknown
  accept?: string
}

async function doFetch(path: string, options: DoFetchOptions): Promise<Response> {
  const doFetchImpl = options.fetchImpl ?? fetch
  const init: RequestInit = {
    method: options.method,
    headers: { accept: options.accept ?? 'application/json' },
    credentials: 'same-origin',
  }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { ...init.headers, 'content-type': 'application/json' } as Record<string, string>
  }
  if (options.signal !== undefined) init.signal = options.signal
  let response: Response
  try {
    // The single network boundary: every host call leaves as a
    // document-relative reference (see `browserRef` for the official rule and
    // the carrier evidence).
    response = await doFetchImpl(browserRef(path), init)
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError(0, 'host_unreachable', error instanceof Error ? error.message : String(error))
  }
  return response
}

/** Parse the unified error envelope; fall back to raw text when absent. */
function envelopeError(status: number, text: string): ApiError {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    if (parsed.error !== undefined && typeof parsed.error.code === 'string') {
      return new ApiError(status, parsed.error.code, parsed.error.message ?? parsed.error.code)
    }
  } catch {
    // not JSON — fall through
  }
  const snippet = text.length > 160 ? `${text.slice(0, 160)}…` : text
  return new ApiError(status, 'internal', snippet === '' ? `Host error ${status}.` : snippet)
}

// ---------------------------------------------------------------------------
// Endpoint path builders (pure; the client only ever uses these relative paths)
// ---------------------------------------------------------------------------

/** Query string helpers shared by the builders below. */
function append(params: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return
  params.set(key, String(value))
}

/** `GET ${ROUTES.status}` */
export const statusPath = (): string => ROUTES.status
/** `GET ${ROUTES.libraries}` */
export const librariesPath = (): string => ROUTES.libraries
/** `GET ${ROUTES.collections}?library=` */
export const collectionsPath = (library: string): string => `${ROUTES.collections}?${new URLSearchParams({ library })}`
/** `GET` item detail. */
export const itemPath = (library: string, key: string): string => `${routeItem.detail(key)}?${new URLSearchParams({ library })}`
/** `GET` annotations of an item (best PDF child resolved host-side). */
export const annotationsPath = (library: string, key: string): string => `${routeItem.annotations(key)}?${new URLSearchParams({ library })}`
/** `GET` children (attachments + notes). */
export const childrenPath = (library: string, key: string): string => `${routeItem.children(key)}?${new URLSearchParams({ library })}`

/** Parameters of the items list route the panel uses. */
export interface ItemsQueryParams {
  library: string
  q?: string
  /** `titleCreatorYear` (default) or `everything` (full-text). */
  mode?: string
  collection?: string
  search?: string
  tag?: string
  sort?: string
  direction?: string
  start?: number
  limit?: number
  keys?: string[]
}

/** `GET ${ROUTES.items}?…` for list views. */
export function itemsPath(params: ItemsQueryParams): string {
  const search = new URLSearchParams({ library: params.library })
  append(search, 'q', params.q)
  append(search, 'mode', params.mode === 'everything' ? 'everything' : undefined)
  append(search, 'collection', params.collection)
  append(search, 'search', params.search)
  append(search, 'tag', params.tag)
  append(search, 'sort', params.sort)
  append(search, 'direction', params.direction)
  append(search, 'start', params.start)
  append(search, 'limit', params.limit)
  if (params.keys !== undefined && params.keys.length > 0) append(search, 'keys', params.keys.join(','))
  return `${ROUTES.items}?${search}`
}

/** `GET ${ROUTES.export}?…` (BibTeX `bib` / RIS `ris` text, local paths stripped). */
export function exportPath(library: string, format: 'bib' | 'ris', params: { keys?: string[]; q?: string } = {}): string {
  const search = new URLSearchParams({ library, format })
  if (params.keys !== undefined && params.keys.length > 0) append(search, 'keys', params.keys.join(','))
  append(search, 'q', params.q)
  return `${ROUTES.export}?${search}`
}

// ---------------------------------------------------------------------------
// PDF surface (M4)
// ---------------------------------------------------------------------------

/** `GET ${ROUTES_PDF.info}?…` — reader bootstrap. */
export const pdfInfoPath = (library: string, attachmentKey: string): string =>
  `${ROUTES_PDF.info}?${new URLSearchParams({ library, attachment: attachmentKey })}`

/** `GET ${ROUTES_PDF.part}?…` — one 2 MiB chunk of the PDF file. */
export const pdfPartPath = (library: string, attachmentKey: string, part: number): string =>
  `${ROUTES_PDF.part}?${new URLSearchParams({ library, attachment: attachmentKey, part: String(part) })}`

/** `GET ${ROUTES_PDF.assets}/…` — whitelisted pdf.js data asset. */
export const pdfAssetPath = (kind: string, filename: string): string => `${ROUTES_PDF.assets}/${kind}/${encodeURIComponent(filename)}`

// ---------------------------------------------------------------------------
// Typed endpoint wrappers used by views
// ---------------------------------------------------------------------------

export const getStatus = (o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) => apiJson<StatusResponse>(statusPath(), o)
export const getLibraries = (o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) => apiJson<LibrariesResponse>(librariesPath(), o)
export const getCollections = (library: string, o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) =>
  apiJson<CollectionsResponse>(collectionsPath(library), o)
export const getItems = (params: ItemsQueryParams, o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) =>
  apiJson<ItemsResponse>(itemsPath(params), o)
export const getItem = (library: string, key: string, o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) =>
  apiJson<ItemDetailWire>(itemPath(library, key), o)
export const getAnnotations = (library: string, key: string, o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) =>
  apiJson<AnnotationsResponse>(annotationsPath(library, key), o)
export const getChildren = (library: string, key: string, o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) =>
  apiJson<ChildrenResponse>(childrenPath(library, key), o)
export const getPdfInfo = (library: string, attachmentKey: string, o?: { signal?: AbortSignal; fetchImpl?: FetchLike }) =>
  apiJson<PdfInfoResponse>(pdfInfoPath(library, attachmentKey), o)

/** Outcome of the UI save-highlights route. */
export interface SaveHighlightsResult {
  saved: { id: string; key: string }[]
}

/** Outcome of the UI clear-highlights route (session state only). */
export interface ClearHighlightsResult {
  removed: number
}

/** Save session highlights as Zotero annotations (explicit UI action). */
export const saveHighlights = (
  body: { ids?: string[]; attachmentKey?: string },
  o?: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<SaveHighlightsResult> => apiPost<SaveHighlightsResult>(ROUTES_HIGHLIGHT_WRITES.save, body, o)

/** Remove session highlights (never touches Zotero annotations). */
export const clearSessionHighlights = (
  body: { ids?: string[]; attachmentKey?: string },
  o?: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<ClearHighlightsResult> => apiPost<ClearHighlightsResult>(ROUTES_HIGHLIGHT_WRITES.clear, body, o)

// ---------------------------------------------------------------------------
// Desktop actions (M7): Open Zotero / Show in Zotero
// ---------------------------------------------------------------------------

/** Start the installed Zotero desktop app (explicit UI action). */
export const launchZotero = (o?: { signal?: AbortSignal; fetchImpl?: FetchLike }): Promise<{ launched: true }> =>
  apiPost<{ launched: true }>(ROUTES.desktopLaunch, {}, o)

/**
 * Open the server-constructed zotero:// deep link: `select` reveals the item,
 * `open-pdf` opens the Zotero reader (optionally at a page).
 */
export const showInZotero = (
  body: { library: string; key: string; target: 'select' | 'open-pdf'; page?: number },
  o?: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<{ opened: true; url: string }> => apiPost<{ opened: true; url: string }>(ROUTES.desktopOpen, body, o)

// ---------------------------------------------------------------------------
// View events (SSE)
// ---------------------------------------------------------------------------

/** Structural EventSource for tests; matches the browser constructor surface. */
export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(): void
  /** Named-event delivery (real browsers route `event: view` here, not onmessage). */
  addEventListener?(type: string, listener: (event: { data: string }) => void): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

/** Connection state reported to the UI. */
export type EventStreamState = 'connecting' | 'open' | 'error'

export interface ViewStreamHandle {
  /** Stop the stream and release listeners (tab teardown). */
  close(): void
  /** Last applied `seq`; the next higher event is the first one applied. */
  lastSeq(): number
}

/**
 * Subscribe to `${ROUTES.events}` (SSE, `event: view`). The browser resumes
 * from `Last-Event-ID` automatically; `onEvent` additionally only ever sees
 * strictly increasing `seq` values, so replays around reconnects are dropped.
 *
 * Dedupe survives a full re-subscribe too: pass `fromSeq` (the store's
 * `seenSeq`) when opening the stream.
 */
export function connectViewEvents(options: {
  fromSeq?: number
  onEvent: (event: ViewEvent) => void
  onState?: (state: EventStreamState) => void
  sourceFactory?: EventSourceFactory
}): ViewStreamHandle {
  const { onEvent, onState } = options
  let lastSeq = options.fromSeq ?? 0
  let closed = false
  let source: EventSourceLike | null = null

  const factory =
    options.sourceFactory ??
    (typeof EventSource !== 'undefined'
      ? (url: string) => new EventSource(url) as unknown as EventSourceLike
      : null)

  if (factory === null) {
    onState?.('error')
    return { close() {}, lastSeq: () => lastSeq }
  }

  const open = (): void => {
    if (closed) return
    onState?.('connecting')
    try {
      // Same document-relative boundary as `doFetch` (official rule; the
      // desktop shell forwards the EventSource stream like any other path).
      source = factory(browserRef(ROUTES.events))
    } catch {
      source = null
      onState?.('error')
      return
    }
    source.onopen = () => {
      onState?.('open')
    }
    const consume = (message: { data: string }) => {
      let parsed: ViewEvent
      try {
        parsed = JSON.parse(message.data) as ViewEvent
      } catch {
        return
      }
      if (typeof parsed?.seq !== 'number' || parsed.seq <= lastSeq) return
      lastSeq = parsed.seq
      onEvent(parsed)
    }
    source.onmessage = consume
    // Real browsers deliver named SSE events (`event: view`) only through
    // addEventListener; test stubs deliver through onmessage. Both routes
    // converge on the same dedupe.
    source.addEventListener?.('view', consume)
    source.onerror = () => {
      // EventSource retries on its own with Last-Event-ID; surface the state.
      onState?.('error')
    }
  }

  open()
  return {
    close() {
      closed = true
      source?.close()
      source = null
    },
    lastSeq: () => lastSeq,
  }
}

// ---------------------------------------------------------------------------
// Export download
// ---------------------------------------------------------------------------

/** Download the export text as a file through a blob URL (browser only). */
export async function downloadExport(
  library: string,
  format: 'bib' | 'ris',
  params: { keys?: string[]; q?: string } = {},
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const text = await apiText(exportPath(library, format, params), options)
  const blob = new Blob([text], { type: format === 'bib' ? 'application/x-bibtex' : 'application/x-research-info-systems' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `zotero-export.${format}`
  anchor.click()
  URL.revokeObjectURL(url)
}
