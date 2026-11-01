/**
 * HTTP plumbing shared by every host route: the official trust-fence gate,
 * uniform JSON responses, the error-envelope mapping from `ZoteroError`, and
 * bounded request-body reading with media-type validation.
 *
 * The handler shape and helpers mirror the official custom-route example
 * `@deepseek-ai/dsh-host-open-in-app` (`sendJson`, `sendMethodNotAllowed`,
 * `readBoundedBody`, reject-first handler prologue) so this plugin's route
 * table follows the same request-trust contract:
 *
 * 1. `connection.requestRejection(req)` first — the fence defeats DNS
 *    rebinding and cross-site browser calls (Host check, `sec-fetch-site:
 *    cross-site` refusal, same-authority `Origin`) and requires an
 *    authenticated browser or API Peer cookie; 403 untrusted / 401
 *    unauthenticated.
 * 2. Method gate — anything but the declared method is `405` + `Allow`.
 * 3. `Content-Type: application/json` gate for bodies — `415` otherwise.
 * 4. Bounded body read — `413` past the ceiling (stream drained).
 * 5. JSON parse + field validation — `400` with the error envelope.
 *
 * @module @hanxu131/dsh-zotero/host/respond
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { ZoteroError, type ZoteroErrorCode } from '../domain/model.ts'
import type { ErrorCode, ErrorResponse } from '../shared/protocol.ts'
import type { ConnectionFace } from './services.ts'

/** Structurally minimal request the handlers need (node:http IncomingMessage). */
export type RouteRequest = IncomingMessage

/** Structurally minimal response (node:http ServerResponse). */
export type RouteResponse = ServerResponse

/** JSON response with the no-store policy (availability/outcomes are live facts). */
export function sendJson(res: RouteResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** `405` with the route's supported methods. */
export function sendMethodNotAllowed(res: RouteResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** Uniform error envelope. */
export function sendError(res: RouteResponse, status: number, code: ErrorCode, message: string, details?: Record<string, unknown>): void {
  const error: ErrorResponse['error'] = { code, message }
  if (details !== undefined) error.details = details
  const body: ErrorResponse = { error }
  sendJson(res, status, body)
}

/** HTTP status per error code; `undefined` codes fall back to 502. */
const ERROR_STATUS: Record<ZoteroErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  not_pdf: 400,
  file_missing: 404,
  metadata_not_found: 404,
  quote_not_found: 404,
  version_conflict: 409,
  write_denied: 403,
  authorize_rate_limited: 429,
  writes_unsupported: 501,
  unsupported_version: 501,
  zotero_not_running: 502,
  local_api_disabled: 502,
  zotero_not_installed: 502,
  zotero_error: 502,
  write_failed: 502,
  download_failed: 502,
  path_outside_workspace: 400,
  internal: 500,
}

/** Map a `ZoteroError` onto the uniform envelope + status. */
export function sendZoteroError(res: RouteResponse, error: ZoteroError): void {
  const status = ERROR_STATUS[error.code] ?? 502
  sendError(res, status, error.code as ErrorCode, error.message, error.details as Record<string, unknown> | undefined)
}

/** Map any thrown value onto the envelope; never echoes unknown internals. */
export function sendUnknownError(res: RouteResponse, error: unknown): void {
  if (error instanceof ZoteroError) return sendZoteroError(res, error)
  const message = error instanceof Error ? error.message : String(error)
  sendError(res, 500, 'internal', message)
}

/**
 * Apply the official trust fence. Resolves `true` when the request was
 * rejected (and answered); `false` means the request is trusted and
 * authenticated and the handler may proceed.
 */
export function rejectUntrusted(req: RouteRequest, res: RouteResponse, connection: ConnectionFace | undefined): boolean {
  if (connection === undefined) {
    // Defensive: handlers must not even be reachable without the fence. A
    // missing connection service means no protected surface at all.
    sendError(res, 503, 'service_unavailable', 'The DSH connection service is not available; this route is disabled.')
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** Media type of a `Content-Type` header, lowercased, parameters stripped. */
export function mediaTypeOf(req: RouteRequest): string {
  return String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase()
}

/**
 * Collect a bounded request body; `null` once the ceiling is crossed (the
 * stream is drained so the socket can be reused cleanly).
 */
export async function readBoundedBody(req: RouteRequest, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > maxBytes) {
      req.resume()
      return null
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks, size)
}

/** Parse a JSON object body after the media-type gate; responds and returns null on failure. */
export async function readJsonObject(req: RouteRequest, res: RouteResponse, maxBytes: number): Promise<Record<string, unknown> | null> {
  if (mediaTypeOf(req) !== 'application/json') {
    sendError(res, 415, 'unsupported_media_type', 'content-type must be application/json')
    return null
  }
  let text: string
  try {
    const bytes = await readBoundedBody(req, maxBytes)
    if (bytes === null) {
      sendError(res, 413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`)
      return null
    }
    text = bytes.toString('utf8')
  } catch {
    sendError(res, 400, 'invalid_input', 'request body unreadable')
    return null
  }
  let parsed: unknown
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    sendError(res, 400, 'invalid_input', 'request body must be valid JSON')
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendError(res, 400, 'invalid_input', 'request body must be a JSON object')
    return null
  }
  return parsed as Record<string, unknown>
}

/** Read a string field; responds `400` and returns undefined when absent/wrong type. */
export function requireString(body: Record<string, unknown>, field: string, res: RouteResponse, maxLength = 500): string | undefined {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    sendError(res, 400, 'invalid_input', `${field} must be a non-empty string`)
    return undefined
  }
  if (value.length > maxLength) {
    sendError(res, 400, 'invalid_input', `${field} must not exceed ${maxLength} characters`)
    return undefined
  }
  return value
}
