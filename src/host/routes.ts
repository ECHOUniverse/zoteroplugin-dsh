/**
 * Host route table: thin `(req, res)` processors on the `/dsh-zotero`
 * namespace (implementation spec §3 `routes/`, §8 DSH-route seam).
 *
 * Every handler follows the official custom-route contract demonstrated by
 * `@deepseek-ai/dsh-host-open-in-app`: the official
 * `ctx.connection.requestRejection` fence runs first (authentication +
 * Host/Origin/`sec-fetch-site` trust), then the method gate, then — for
 * bodies — the `application/json` media-type gate, the bounded-body ceiling,
 * and field validation. Only `health` is reachable without the fence, and it
 * carries nothing but the plugin identity (no library data).
 *
 * Handlers only validate parameters, call the `ZoteroSession` facade, and
 * serialize the `shared/protocol.ts` wire types; all Zotero I/O and error
 * mapping live below them.
 *
 * PDF surface (M4): `/pdf/info` + `/pdf/part` stream a validated
 * library+attachment pair's file in 2 MiB chunks (the path itself never
 * crosses the wire and comes only from `resolveAttachmentPath` through the
 * `HostPdfService` verification); `/pdfjs/<kind>/<file>` serves the packaged
 * pdf.js data assets through a strict whitelist. The UI highlight writes
 * (`/writes/highlights/*`) are explicit UI actions — they skip the DSH
 * approval seam by design (ADR 0003) but go through the same Zotero
 * authorization facade as every other write.
 *
 * @module @hanxu131/dsh-zotero/host/routes
 */

import type { ServerResponse } from 'node:http'
import {
  KEY_SOURCE,
  ZOTERO_MANAGED_FIELDS,
  isItemKey,
  parseItemKey,
  parseLibraryId,
  type ItemQuery,
  type LibraryId,
} from '../domain/model.ts'
import { attachmentInfo, bestPdfKeyOf, noteInfo, summarize, stripLocalPaths } from '../domain/items.ts'
import {
  MAX_ATTACHMENT_BODY_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_EVENT_CLIENTS,
  MAX_JSON_BODY_BYTES,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  ROUTE_BASE,
  ROUTES,
  ROUTES_HIGHLIGHT_WRITES,
  ROUTES_PDF,
  routeItem,
  type AnnotationsResponse,
  type ChildrenResponse,
  type DesktopLaunchResponse,
  type DesktopOpenResponse,
  type HighlightWire,
  type InstallWire,
  type ItemsResponse,
  type PdfInfoResponse,
  type StatusResponse,
  type ViewEvent,
} from '../shared/protocol.ts'
import type { ConnectionFace, WebServerFace } from './services.ts'
import {
  mediaTypeOf,
  readJsonObject,
  rejectUntrusted,
  sendError,
  sendJson,
  sendMethodNotAllowed,
  sendUnknownError,
  requireString,
  type RouteRequest,
  type RouteResponse,
} from './respond.ts'
import type { ZoteroSession } from './session.ts'

export interface RouteDeps {
  session: ZoteroSession
  /** Official connection trust fence; protected routes answer 503 without it. */
  connection?: ConnectionFace
}

const ITEM_KEY_SEGMENT = `(${KEY_SOURCE})`
const ITEM_DETAIL = new RegExp(`^${ROUTE_BASE}/items/${ITEM_KEY_SEGMENT}$`)
const ITEM_CHILDREN = new RegExp(`^${ROUTE_BASE}/items/${ITEM_KEY_SEGMENT}/children$`)
const ITEM_ANNOTATIONS = new RegExp(`^${ROUTE_BASE}/items/${ITEM_KEY_SEGMENT}/annotations$`)
const WRITE_UPDATE = new RegExp(`^${ROUTE_BASE}/writes/items/${ITEM_KEY_SEGMENT}$`)
const WRITE_NOTE = new RegExp(`^${ROUTE_BASE}/writes/items/${ITEM_KEY_SEGMENT}/note$`)
const WRITE_ATTACHMENT = new RegExp(`^${ROUTE_BASE}/writes/items/${ITEM_KEY_SEGMENT}/attachment$`)
const PDF_ASSET = new RegExp(`^${ROUTES_PDF.assets}/(cmaps|standard_fonts|wasm)/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$`)

/** Server-owned fields a client may never set through the write routes. */
const FORBIDDEN_FIELDS = new Set(ZOTERO_MANAGED_FIELDS)

/** Register the whole route table on the composition's webServer. */
export function registerRoutes(webServer: WebServerFace, deps: RouteDeps): () => void {
  const { session } = deps
  const sseSlots = { count: 0 }

  return webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: async (req, res) => {
      const url = new URL(String(req.url ?? '/'), 'http://dsh.invalid')
      const pathname = url.pathname
      const method = String(req.method ?? 'GET').toUpperCase()
      try {
        // ------------------------------------------------- public: health
        if (pathname === ROUTES.health) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          // Minimal-public: plugin identity only, never library data.
          return sendJson(res, 200, { ok: true, plugin: PLUGIN_NAME, version: PLUGIN_VERSION })
        }

        // --------------------------------- protected: official trust fence
        if (rejectUntrusted(req, res, deps.connection)) return

        // ----------------------------------------------------- reads (GET)
        if (pathname === ROUTES.status) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const status = await session.probe()
          // When Zotero is not answering, the Setup view needs the local
          // install facts (installed? which version?) to tell "not
          // installed" from "installed but not started". The install PATH is
          // deliberately NOT included (UI never receives absolute paths).
          const install =
            status.state === 'ready'
              ? undefined
              : installWire(await session.installInfo())
          const body: StatusResponse = {
            plugin: PLUGIN_NAME,
            state: status.state,
            // The active loopback base URL (display-only; the Setup view shows
            // it and points edits to the DSH plugin settings form). Safe by
            // construction: assertLoopbackBaseUrl already refused credentials.
            baseUrl: session.client.baseUrl,
            checkedAt: status.checkedAt,
            ...(status.writes !== undefined ? { writes: status.writes } : {}),
            ...(status.auth !== undefined ? { auth: status.auth } : {}),
            ...(status.version !== undefined ? { zoteroVersion: status.version } : {}),
            ...(status.error !== undefined ? { error: status.error } : {}),
            ...(install !== undefined ? { install } : {}),
          }
          return sendJson(res, 200, body)
        }
        if (pathname === ROUTES.libraries) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const libraries = await session.library.libraries()
          return sendJson(res, 200, { libraries })
        }
        if (pathname === ROUTES.collections) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const library = libraryOf(url)
          const doc = await session.library.collections(library)
          return sendJson(res, 200, doc)
        }
        if (pathname === ROUTES.items) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const list = await session.library.items(libraryOf(url), itemQueryFromUrl(url))
          const body: ItemsResponse = {
            library: list.library,
            version: list.version,
            total: list.total,
            start: list.query.start,
            limit: list.query.limit,
            items: list.items,
            ...(list.paging !== undefined && Object.keys(list.paging).length > 0 ? { paging: list.paging } : {}),
          }
          return sendJson(res, 200, body)
        }
        const detail = ITEM_DETAIL.exec(pathname)
        if (detail !== null) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const library = libraryOf(url)
          return sendJson(res, 200, await session.library.item(library, keyOf(detail[1])))
        }
        const children = ITEM_CHILDREN.exec(pathname)
        if (children !== null) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          return sendJson(res, 200, await childrenOf(session, libraryOf(url), keyOf(children[1])))
        }
        const annotations = ITEM_ANNOTATIONS.exec(pathname)
        if (annotations !== null) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          return sendJson(res, 200, await annotationsOf(session, libraryOf(url), keyOf(annotations[1])))
        }
        if (pathname === ROUTES.export) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const library = libraryOf(url)
          const formatParam = url.searchParams.get('format')
          if (formatParam !== 'bib' && formatParam !== 'ris') {
            return sendError(res, 400, 'invalid_input', 'format must be "bib" or "ris"')
          }
          const text = await session.library.exportText(library, formatParam === 'bib' ? 'bibtex' : 'ris', itemQueryFromUrl(url))
          res.statusCode = 200
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(text)
          return
        }

        // ------------------------------------------------------ SSE events
        if (pathname === ROUTES.events) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          return openEventStream(req, res, session, sseSlots)
        }

        // ------------------------------------------------------- PDF (M4)
        if (pathname === ROUTES_PDF.info) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const library = libraryOf(url)
          const attachment = attachmentKeyOf(url)
          const info = await session.pdf.info(library, attachment)
          const body: PdfInfoResponse = {
            library: info.library,
            attachmentKey: info.attachmentKey,
            itemKey: info.itemKey,
            title: info.title,
            filename: info.filename,
            bytes: info.bytes,
            parts: info.parts,
            sha256: info.sha256,
            pageCount: info.pageCount,
          }
          return sendJson(res, 200, body)
        }
        if (pathname === ROUTES_PDF.part) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const library = libraryOf(url)
          const attachment = attachmentKeyOf(url)
          const rawPart = url.searchParams.get('part')
          const part = rawPart === null ? Number.NaN : Number(rawPart)
          if (!Number.isInteger(part)) return sendError(res, 400, 'invalid_input', 'part must be an integer')
          const bytes = await session.pdf.part(library, attachment, part)
          res.statusCode = 200
          res.setHeader('content-type', 'application/octet-stream')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('x-part-index', String(part))
          res.end(Buffer.from(bytes))
          return
        }
        const asset = PDF_ASSET.exec(pathname)
        if (asset !== null) {
          if (method !== 'GET') return sendMethodNotAllowed(res, 'GET')
          const bytes = await session.pdf.resolveAsset(asset[1]!, decodeURIComponent(asset[2]!))
          if (bytes === null) return sendError(res, 404, 'not_found', 'No such pdf.js asset')
          res.statusCode = 200
          res.setHeader('content-type', 'application/octet-stream')
          // Immutable, content-addressed library data; still behind the fence.
          res.setHeader('cache-control', 'private, max-age=86400')
          res.end(bytes)
          return
        }

        // ----------------------------------------------------- write paths
        if (pathname === ROUTES.writesAuthorize) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          await readJsonObject(req, res, MAX_JSON_BODY_BYTES) // optional; validated if present
          if (res.writableEnded) return
          const outcome = await session.authorizeWrites()
          return sendJson(res, 200, outcome)
        }
        if (pathname === ROUTES.writesItems) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const body = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (body === null) return
          return await createItemRoute(session, res, body)
        }
        if (pathname === ROUTES.writesCollections) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const body = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (body === null) return
          return await createCollectionRoute(session, res, body)
        }
        if (pathname === ROUTES_HIGHLIGHT_WRITES.save) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const body = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (body === null) return
          return await saveHighlightsRoute(session, res, body)
        }
        if (pathname === ROUTES_HIGHLIGHT_WRITES.clear) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const body = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (body === null) return
          return await clearHighlightsRoute(session, res, body)
        }
        const update = WRITE_UPDATE.exec(pathname)
        if (update !== null) {
          if (method !== 'PATCH') return sendMethodNotAllowed(res, 'PATCH')
          const body = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (body === null) return
          return await updateItemRoute(session, res, keyOf(update[1]), body)
        }
        const note = WRITE_NOTE.exec(pathname)
        if (note !== null) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const body = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (body === null) return
          return await addNoteRoute(session, res, keyOf(note[1]), body)
        }
        const attachment = WRITE_ATTACHMENT.exec(pathname)
        if (attachment !== null) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const body = await readJsonObject(req, res, MAX_ATTACHMENT_BODY_BYTES)
          if (body === null) return
          return await attachRoute(session, res, keyOf(attachment[1]), body)
        }

        // --------------------------------------- desktop (M7, UI actions)
        // Explicit UI actions only (Setup "Open Zotero", item/reader "Show
        // in Zotero"); the URL is constructed server-side from validated
        // library/key/page references — never from client-provided paths or
        // commands (the spawn whitelist lives in zotero/desktop.ts).
        if (pathname === ROUTES.desktopLaunch) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          await readJsonObject(req, res, MAX_JSON_BODY_BYTES) // optional; ignored
          if (res.writableEnded) return
          await session.launchZoteroApp()
          const body: DesktopLaunchResponse = { launched: true }
          return sendJson(res, 200, body)
        }
        if (pathname === ROUTES.desktopOpen) {
          if (method !== 'POST') return sendMethodNotAllowed(res, 'POST')
          const payload = await readJsonObject(req, res, MAX_JSON_BODY_BYTES)
          if (payload === null) return
          return await desktopOpenRoute(session, res, payload)
        }

        // Deletion is intentionally not exposed anywhere (spec non-goal).
        return sendError(res, 404, 'not_found', `No route ${method} ${pathname}`)
      } catch (error) {
        // A failed handler answers the envelope; an SSE stream whose headers
        // already went out can only be torn down, not re-answered.
        if (!res.writableEnded && !res.headersSent) sendUnknownError(res, error)
        else if (!res.writableEnded) res.end()
      }
    },
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Validated `library=` query parameter (default `user`). */
function libraryOf(url: URL): LibraryId {
  const raw = url.searchParams.get('library') ?? 'user'
  parseLibraryId(raw) // throws invalid_input on anything unsafe
  return raw
}

/** Validated item key from a route match. */
function keyOf(value: string | undefined): string {
  return parseItemKey(value, 'key')
}

/** Validated `attachment=` query parameter (a Zotero attachment key). */
function attachmentKeyOf(url: URL): string {
  return parseItemKey(url.searchParams.get('attachment'), 'attachment')
}

/** Install facts for the wire: state/version/searched, never the path. */
function installWire(install: Awaited<ReturnType<ZoteroSession['installInfo']>>): InstallWire | undefined {
  if (install === null) return undefined
  return {
    state: install.state,
    ...(install.version !== undefined ? { version: install.version } : {}),
    ...(install.state === 'missing' && install.searched.length > 0 ? { searched: install.searched.slice(0, 12) } : {}),
  }
}

/**
 * UI "Show in Zotero" route: validates library/key/target/page and opens the
 * server-constructed `zotero://` deep link (spawn-whitelisted host-side).
 */
async function desktopOpenRoute(session: ZoteroSession, res: RouteResponse, body: Record<string, unknown>): Promise<void> {
  const library = libraryFromBody(body, res)
  if (library === undefined) return
  const key = typeof body.key === 'string' ? keyOf(body.key) : undefined
  if (key === undefined) return sendError(res, 400, 'invalid_input', 'key must be a Zotero item key')
  const target = body.target
  if (target !== 'select' && target !== 'open-pdf') {
    return sendError(res, 400, 'invalid_input', 'target must be "select" or "open-pdf"')
  }
  let page: number | undefined
  if (body.page !== undefined) {
    if (typeof body.page !== 'number' || !Number.isInteger(body.page) || body.page < 1) {
      return sendError(res, 400, 'invalid_input', 'page must be a positive integer')
    }
    page = body.page
  }
  const opened = await session.openInZotero(
    target === 'select' ? { kind: 'select', library, key } : { kind: 'open-pdf', library, key, ...(page !== undefined ? { page } : {}) },
  )
  const payload: DesktopOpenResponse = { opened: true, url: opened.url }
  sendJson(res, 200, payload)
}

/** Validated `library` from a POST body (default `user`); null after 400. */
function libraryFromBody(body: Record<string, unknown>, res: RouteResponse): LibraryId | undefined {
  const raw = typeof body.library === 'string' && body.library.trim() !== '' ? body.library : 'user'
  try {
    parseLibraryId(raw)
  } catch {
    sendError(res, 400, 'invalid_input', 'library must be "user" or "g<groupId>"')
    return undefined
  }
  return raw
}

/** Build an `ItemQuery` from URL search parameters (validation below in the data layer). */
function itemQueryFromUrl(url: URL): ItemQuery {
  const params = url.searchParams
  const number = (name: string) => {
    const raw = params.get(name)
    if (raw === null || raw.trim() === '') return undefined
    const parsed = Number(raw)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const tag = params.getAll('tag')
  const keys = params.get('keys')
  const query: ItemQuery = {
    ...(params.get('q') !== null ? { q: params.get('q')! } : {}),
    ...(params.get('mode') !== null ? { mode: params.get('mode') as ItemQuery['mode'] } : {}),
    ...(params.get('collection') !== null ? { collection: params.get('collection')! } : {}),
    ...(params.get('search') !== null ? { search: params.get('search')! } : {}),
    ...(tag.length > 0 ? { tag: tag.length === 1 ? tag[0]! : tag } : {}),
    ...(keys !== null ? { keys: keys.split(',').map((key) => key.trim()).filter(Boolean) } : {}),
    ...(params.get('sort') !== null ? { sort: params.get('sort') as ItemQuery['sort'] } : {}),
    ...(params.get('direction') !== null ? { direction: params.get('direction') as ItemQuery['direction'] } : {}),
    ...(number('start') !== undefined ? { start: number('start') } : {}),
    ...(number('limit') !== undefined ? { limit: number('limit') } : {}),
  }
  return query
}

/** Children projection: attachments + notes of one item. */
async function childrenOf(session: ZoteroSession, library: LibraryId, key: string): Promise<ChildrenResponse> {
  const raw = await session.library.children(library, key)
  const attachments = raw.filter((child) => child.data.itemType === 'attachment').map(attachmentInfo)
  const notes = raw.filter((child) => child.data.itemType === 'note').map(noteInfo)
  return { item: key, attachments, notes }
}

/**
 * Annotations of an item: the item's own annotations when it is a PDF
 * attachment, otherwise the annotations of its best PDF attachment — plus
 * the session's Agent highlights for the same attachment (reader layer).
 */
async function annotationsOf(session: ZoteroSession, library: LibraryId, key: string): Promise<AnnotationsResponse> {
  const detail = await session.library.item(library, key)
  const attachmentKey = bestPdfKeyOf(detail) ?? undefined
  if (attachmentKey === undefined) return { item: key, attachment: null, annotations: [], highlights: [] }
  const annotations = await session.library.annotations(library, attachmentKey)
  const highlights: HighlightWire[] = session.highlights.forAttachment(library, attachmentKey).map((highlight) => ({
    id: highlight.id,
    library: highlight.library,
    attachmentKey: highlight.attachmentKey,
    itemKey: highlight.itemKey,
    pageIndex: highlight.pageIndex,
    pageLabel: highlight.pageLabel,
    quote: highlight.quote,
    comment: highlight.comment,
    color: highlight.color,
    rects: highlight.rects,
    createdAt: highlight.createdAt,
    ...(highlight.savedAs !== undefined ? { savedAs: highlight.savedAs } : {}),
  }))
  return { item: key, attachment: attachmentKey, annotations, highlights }
}

/**
 * UI save route: persist the named session highlights as Zotero annotations.
 * An explicit UI action — it goes straight through the Zotero authorization
 * facade (no DSH approval; ADR 0003 scope is Agent-initiated writes only).
 */
async function saveHighlightsRoute(session: ZoteroSession, res: RouteResponse, body: Record<string, unknown>): Promise<void> {
  const ids = highlightIdsOf(res, body)
  if (ids === null) return
  const keyFilter = typeof body.attachmentKey === 'string' && isItemKey(body.attachmentKey) ? body.attachmentKey : undefined
  const highlights = session.findHighlights(ids.length > 0 ? ids : undefined, keyFilter)
  const saved = await session.saveHighlights(highlights)
  sendJson(res, 200, { saved })
}

/** UI clear route: drop session highlights; Zotero annotations are untouched. */
async function clearHighlightsRoute(session: ZoteroSession, res: RouteResponse, body: Record<string, unknown>): Promise<void> {
  const ids = highlightIdsOf(res, body)
  if (ids === null) return
  const key = typeof body.attachmentKey === 'string' && isItemKey(body.attachmentKey) ? body.attachmentKey : undefined
  const removed = session.clearHighlights(ids.length > 0 ? ids : undefined, key)
  sendJson(res, 200, { removed })
}

/** Validate the optional `ids` array (strings); null after answering 400. */
function highlightIdsOf(res: RouteResponse, body: Record<string, unknown>): string[] | null {
  if (body.ids === undefined) return []
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string') || body.ids.length > 200) {
    sendError(res, 400, 'invalid_input', 'ids must be an array of highlight ids (max 200)')
    return null
  }
  return body.ids as string[]
}

/** Field-value sanity gate for the write routes (Zotero re-validates deeply). */
function validateFields(res: RouteResponse, fields: Record<string, unknown>): boolean {
  for (const [name, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELDS.has(name)) {
      sendError(res, 400, 'invalid_input', `field "${name}" is managed by Zotero and cannot be set`)
      return false
    }
    if (name.length > 64) {
      sendError(res, 400, 'invalid_input', `field name "${name.slice(0, 24)}…" is too long`)
      return false
    }
    if (typeof value === 'string' && value.length > 100_000) {
      sendError(res, 400, 'invalid_input', `field "${name}" exceeds 100000 characters`)
      return false
    }
    if (Array.isArray(value) && value.length > 200) {
      sendError(res, 400, 'invalid_input', `field "${name}" lists more than 200 entries`)
      return false
    }
  }
  return true
}

async function createItemRoute(session: ZoteroSession, res: RouteResponse, body: Record<string, unknown>): Promise<void> {
  const library = requireString(body, 'library', res, 32)
  if (library === undefined) return
  const itemType = requireString(body, 'itemType', res, 64)
  if (itemType === undefined) return
  let fields: Record<string, unknown> = {}
  if (body.fields !== undefined) {
    if (typeof body.fields !== 'object' || body.fields === null || Array.isArray(body.fields)) {
      return sendError(res, 400, 'invalid_input', 'fields must be a JSON object')
    }
    fields = body.fields as Record<string, unknown>
    if (!validateFields(res, fields)) return
  }
  const [key] = await session.writes.create(library, 'items', [{ itemType, ...fields }])
  sendJson(res, 200, { key })
}

async function createCollectionRoute(session: ZoteroSession, res: RouteResponse, body: Record<string, unknown>): Promise<void> {
  const library = requireString(body, 'library', res, 32)
  if (library === undefined) return
  const name = requireString(body, 'name', res, 500)
  if (name === undefined) return
  let parentKey: string | false = false
  if (body.parentKey !== undefined && body.parentKey !== null) {
    if (typeof body.parentKey !== 'string') return sendError(res, 400, 'invalid_input', 'parentKey must be a collection key')
    parentKey = parseItemKey(body.parentKey, 'parentKey')
  }
  const [key] = await session.writes.create(library, 'collections', [{ name, parentCollection: parentKey }])
  sendJson(res, 200, { key })
}

async function updateItemRoute(session: ZoteroSession, res: RouteResponse, key: string, body: Record<string, unknown>): Promise<void> {
  const library = requireString(body, 'library', res, 32)
  if (library === undefined) return
  if (typeof body.fields !== 'object' || body.fields === null || Array.isArray(body.fields)) {
    return sendError(res, 400, 'invalid_input', 'fields must be a JSON object')
  }
  const fields = body.fields as Record<string, unknown>
  if (!validateFields(res, fields)) return
  const result = await session.writes.patchItem(library, key, () => (Object.keys(fields).length > 0 ? fields : null))
  sendJson(res, 200, { changed: result.changed, item: summarize(result.item) })
}

async function addNoteRoute(session: ZoteroSession, res: RouteResponse, parentKey: string, body: Record<string, unknown>): Promise<void> {
  const library = requireString(body, 'library', res, 32)
  if (library === undefined) return
  const html = requireString(body, 'html', res, 100_000)
  if (html === undefined) return
  let tags: { tag: string }[] | undefined
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      return sendError(res, 400, 'invalid_input', 'tags must be an array of strings')
    }
    tags = (body.tags as string[]).map((tag) => ({ tag }))
  }
  const [key] = await session.writes.create(library, 'items', [
    { itemType: 'note', parentItem: parentKey, note: html, ...(tags !== undefined ? { tags } : {}) },
  ])
  sendJson(res, 200, { key })
}

/**
 * Pure attachment-bytes gate: decode base64, enforce the 100 MiB ceiling and
 * (for PDFs) the `%PDF-` magic number. `maxBytes` is a test seam; production
 * always uses `MAX_ATTACHMENT_BYTES`.
 */
export function decodeAttachment(
  encoded: unknown,
  contentType: string,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): { ok: true; bytes: Buffer } | { ok: false; status: number; code: 'invalid_input' | 'payload_too_large' | 'not_pdf'; message: string } {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return { ok: false, status: 400, code: 'invalid_input', message: 'bytesBase64 must be a non-empty base64 string' }
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    return { ok: false, status: 400, code: 'invalid_input', message: 'bytesBase64 is not valid base64' }
  }
  if (bytes.length === 0 || bytes.length > maxBytes) {
    return { ok: false, status: 413, code: 'payload_too_large', message: `attachment bytes must be between 1 and ${maxBytes} bytes` }
  }
  if (contentType === 'application/pdf' && !bytes.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    return { ok: false, status: 400, code: 'invalid_input', message: 'application/pdf attachments must start with the %PDF- magic number' }
  }
  return { ok: true, bytes }
}

/** Attachment constraints, checked against the decoded bytes. */
async function attachRoute(session: ZoteroSession, res: RouteResponse, parentKey: string, body: Record<string, unknown>): Promise<void> {
  const library = requireString(body, 'library', res, 32)
  if (library === undefined) return
  const filename = requireString(body, 'filename', res, 255)
  if (filename === undefined) return
  if (/[/\\]/.test(filename) || filename.includes('..')) {
    return sendError(res, 400, 'invalid_input', 'filename must be a bare file name')
  }
  const contentType = requireString(body, 'contentType', res, 128)
  if (contentType === undefined) return
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
    return sendError(res, 400, 'invalid_input', 'contentType must be a MIME type like application/pdf')
  }
  const title = requireString(body, 'title', res, 500)
  if (title === undefined) return
  const decoded = decodeAttachment(body.bytesBase64, contentType)
  if (!decoded.ok) {
    return sendError(res, decoded.status, decoded.code, decoded.message)
  }
  const key = await session.writes.attachFile(library, parentKey, { bytes: new Uint8Array(decoded.bytes), filename, contentType, title })
  sendJson(res, 200, { key })
}

// ---------------------------------------------------------------------------
// SSE /events
// ---------------------------------------------------------------------------

/** One SSE frame: `id` for Last-Event-ID resume, `event: view`, JSON data. */
function formatSseFrame(event: ViewEvent): string {
  return `id: ${event.seq}\nevent: view\ndata: ${JSON.stringify(event)}\n\n`
}

function openEventStream(
  req: RouteRequest,
  res: ServerResponse,
  session: ZoteroSession,
  slots: { count: number },
): void {
  if (slots.count >= MAX_EVENT_CLIENTS) {
    sendError(res, 503, 'service_unavailable', `Too many event streams (max ${MAX_EVENT_CLIENTS}).`)
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  res.write('retry: 3000\n\n')
  slots.count += 1
  const lastEventId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10)
  const hub = session.events
  for (const event of hub.replaySince(Number.isNaN(lastEventId) ? 0 : lastEventId)) {
    res.write(formatSseFrame(event))
  }
  const unsubscribe = hub.subscribe((event) => {
    if (!res.writableEnded) res.write(formatSseFrame(event))
  })
  const cleanup = () => {
    unsubscribe()
    slots.count -= 1
  }
  res.once('close', cleanup)
}
