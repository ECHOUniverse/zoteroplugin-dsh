/**
 * `ZoteroLocalClient` — the single owner of the Zotero Local API connection:
 * probing, reads, and user-authorized writes over `http://127.0.0.1:23119/api/`.
 *
 * Design rules (implementation spec §4.1, ADR 0001):
 * - Loopback-only base URLs; anything else is rejected before any I/O.
 * - Every request carries `Zotero-API-Version: 3`; timeouts map to errors.
 * - `GET /api/` probes and records `X-Zotero-Version` / `Zotero-Server-ID`;
 *   a Zotero major version below 10 is reported as `unsupported` (writes are
 *   a Zotero 10+ capability per the official local API docs).
 * - Read paths never run the write-capability probe; it is explicit
 *   (`probeWrites`) or lazy at the first write.
 * - A `Zotero-Server-ID` change drops the in-memory key (another instance
 *   took over the port); remembered keys are stored per server id via
 *   `KeyStore`.
 * - Errors always surface as `ZoteroError`; callers never re-parse HTTP.
 *
 * Attribution: state machine, probe/authorize/write flows and the HTTP error
 * mapping are adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/zotero/client.ts` (repo LICENSE: Apache-2.0). Modifications for this
 * project: injectable `fetch`/`now`/`sleep` instead of module-singleton
 * behavior, pluggable `KeyStore` (reference hardcodes a key file), explicit
 * `probeWrites` decoupled from `probe` (reference probes writes during every
 * probe), the `unsupported` state / `unsupported_version` error for the
 * Zotero 10+ floor, strict loopback URL validation, and hard failure on
 * unreadable probe timeouts. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/zotero/client
 */

import { LIMITS, MIN_ZOTERO_MAJOR, ZoteroError, type ConnectionStatus, type ConnectionState, type WriteAuth, type WriteSupport } from '../domain/model.ts'
import { isValidApiKey, MemoryKeyStore, type KeyStore } from './auth.ts'

/** Injectable transport; Node's global `fetch` satisfies this. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ZoteroResponse {
  status: number
  headers: Headers
  text: string
  /** Parsed body when the response was JSON; otherwise undefined. */
  json?: unknown
}

export interface ZoteroLocalClientOptions {
  /** Local API root; default `http://127.0.0.1:23119`. Loopback only. */
  baseUrl?: string
  /** Transport override for tests. */
  fetch?: FetchLike
  /** Clock override for tests (freshness windows, `checkedAt`). */
  now?: () => number
  /** Sleep override for future backoff needs; unused by M1 flows. */
  sleep?: (ms: number) => Promise<void>
  /** Application name shown in Zotero's authorization dialog. */
  appName?: string
  /** Remembered-key storage; defaults to in-memory only. */
  keyStore?: KeyStore
  /** Notified when any status field changes. */
  onChange?: () => void
  /** Timeout overrides (ms); default to `LIMITS`. */
  probeTimeoutMs?: number
  readTimeoutMs?: number
  writeTimeoutMs?: number
  authorizeTimeoutMs?: number
}

export interface GetOptions {
  headers?: Record<string, string>
  /** Additional status codes to accept besides 2xx/304. */
  allow?: number[]
  signal?: AbortSignal
}

export interface WriteOptions {
  body?: string | Uint8Array
  contentType?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const UPLOAD_PATH_PATTERN = /^\/api\/local\/uploads\/[A-Za-z0-9]+$/

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function assertLoopbackBaseUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ZoteroError('invalid_input', `localApiBaseUrl is not a valid URL: ${JSON.stringify(rawUrl)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ZoteroError('invalid_input', `localApiBaseUrl must use http (loopback only): ${url.protocol}`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ZoteroError('invalid_input', `localApiBaseUrl must be loopback (localhost/127.0.0.1/[::1]), got ${JSON.stringify(url.hostname)}`)
  }
  if (url.username || url.password) {
    throw new ZoteroError('invalid_input', 'localApiBaseUrl must not contain credentials.')
  }
  return rawUrl.replace(/\/+$/, '')
}

/** Major version from an `X-Zotero-Version` value like "10.0.2" or "11.0-beta.1". */
export function majorVersion(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version)
  return match ? Number(match[1]) : undefined
}

export class ZoteroLocalClient {
  readonly baseUrl: string
  readonly appName: string
  private readonly fetchImpl: FetchLike
  private readonly nowImpl: () => number
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly keyStore: KeyStore
  private readonly onChange: () => void
  private readonly readTimeoutMs: number

  private key: { value: string; remember: boolean } | null = null
  private keyLoaded = false
  private authorizing: Promise<string> | null = null
  private statusValue: ConnectionStatus
  private readonly probeTimeoutMs: number
  private readonly writeTimeoutMs: number
  private readonly authorizeTimeoutMs: number

  constructor(options: ZoteroLocalClientOptions = {}) {
    this.baseUrl = assertLoopbackBaseUrl(options.baseUrl ?? 'http://127.0.0.1:23119')
    this.appName = options.appName ?? 'DSH Zotero'
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.nowImpl = options.now ?? Date.now
    this.sleepImpl = options.sleep ?? defaultSleep
    this.keyStore = options.keyStore ?? new MemoryKeyStore()
    this.onChange = options.onChange ?? (() => undefined)
    this.readTimeoutMs = options.readTimeoutMs ?? LIMITS.readTimeoutMs
    this.probeTimeoutMs = options.probeTimeoutMs ?? LIMITS.probeTimeoutMs
    this.writeTimeoutMs = options.writeTimeoutMs ?? LIMITS.writeTimeoutMs
    this.authorizeTimeoutMs = options.authorizeTimeoutMs ?? LIMITS.authorizeTimeoutMs
    this.statusValue = { state: 'unknown', writes: 'unknown', auth: 'none', checkedAt: this.nowImpl() }
  }

  /** Void alias so callers can hand `sleep` around without triggering no-await warnings. */
  get sleep(): (ms: number) => Promise<void> {
    return this.sleepImpl
  }

  get status(): ConnectionStatus {
    return this.statusValue
  }

  private setStatus(patch: Partial<ConnectionStatus>): void {
    const next: ConnectionStatus = { ...this.statusValue, ...patch, checkedAt: this.nowImpl() }
    const changed =
      next.state !== this.statusValue.state ||
      next.version !== this.statusValue.version ||
      next.serverId !== this.statusValue.serverId ||
      next.writes !== this.statusValue.writes ||
      next.auth !== this.statusValue.auth ||
      next.error !== this.statusValue.error
    this.statusValue = next
    if (changed) this.onChange()
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async send(method: string, path: string, init: { body?: string | Uint8Array; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ZoteroResponse> {
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.baseUrl}${path}`
    const timeoutMs = init.timeoutMs ?? this.readTimeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onExternalAbort = () => controller.abort()
    init.signal?.addEventListener('abort', onExternalAbort)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { 'Zotero-API-Version': '3', ...init.headers },
        body: init.body as BodyInit | undefined,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      if (init.signal?.aborted) throw error instanceof Error ? error : new Error(String(error))
      const cause = (error as { cause?: { code?: string } }).cause
      if (timedOut) {
        throw new ZoteroError('zotero_error', `Zotero did not answer ${method} ${path} within ${timeoutMs} ms.`)
      }
      if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET' || cause?.code === 'EPIPE') {
        this.setStatus({ state: 'not_running', error: undefined })
        throw new ZoteroError('zotero_not_running', 'Zotero is not running. Start the Zotero desktop app (version 10 or later), then try again.')
      }
      throw new ZoteroError('zotero_error', `Could not reach Zotero at ${this.baseUrl}: ${String(cause?.code ?? error)}`)
    } finally {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', onExternalAbort)
    }
    const text = await response.text()
    let json: unknown
    if ((response.headers.get('content-type') ?? '').includes('json') && text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    const version = response.headers.get('x-zotero-version') ?? undefined
    const serverId = response.headers.get('zotero-server-id') ?? undefined
    if (response.status === 403 && /local api is not enabled/i.test(text)) {
      this.setStatus({ state: 'api_disabled', version, error: undefined })
      throw new ZoteroError('local_api_disabled', 'Zotero is running, but its local API is turned off. Enable "Allow other applications on this computer to communicate with Zotero" in Zotero Settings → Advanced, then try again.')
    }
    if (this.statusValue.state !== 'ready' || (serverId !== undefined && serverId !== this.statusValue.serverId) || (version !== undefined && version !== this.statusValue.version)) {
      if (serverId && this.statusValue.serverId && serverId !== this.statusValue.serverId) {
        // Another Zotero instance answered: keys issued for the old one are void.
        this.key = null
        this.keyLoaded = false
        this.setStatus({ state: 'ready', auth: 'none', ...(version ? { version } : {}), ...(serverId ? { serverId } : {}), error: undefined })
      } else {
        this.setStatus({ state: 'ready', ...(version ? { version } : {}), ...(serverId ? { serverId } : {}), error: undefined })
      }
    }
    return { status: response.status, headers: response.headers, text, json }
  }

  /** GET a Local API path. Readiness gate first (`not_running`/`api_disabled`/`unsupported` map to errors); anything besides 2xx/304/`allow` throws `ZoteroError`. */
  async get(path: string, options: GetOptions = {}): Promise<ZoteroResponse> {
    await this.ensureReady()
    const response = await this.send('GET', path, { headers: options.headers, signal: options.signal })
    if ((response.status >= 200 && response.status < 300) || response.status === 304 || options.allow?.includes(response.status)) {
      return response
    }
    throw httpError(response, `GET ${path}`)
  }

  async getJson<T>(path: string, options: GetOptions = {}): Promise<{ data: T; response: ZoteroResponse }> {
    const response = await this.get(path, options)
    if (response.json === undefined) throw new ZoteroError('zotero_error', `GET ${path} did not return JSON.`)
    return { data: response.json as T, response }
  }

  // -------------------------------------------------------------------------
  // Probe
  // -------------------------------------------------------------------------

  /** Probe the connection (`GET /api/` only — never touches write endpoints). */
  async probe(): Promise<ConnectionStatus> {
    try {
      const response = await this.send('GET', '/api/', { timeoutMs: this.probeTimeoutMs })
      if (response.status === 404) {
        this.setStatus({ state: 'api_disabled', error: 'This Zotero version exposes no local API; Zotero 10 or later is required.' })
        return this.status
      }
      const version = this.statusValue.version
      const major = version !== undefined ? majorVersion(version) : undefined
      if (major !== undefined && major < MIN_ZOTERO_MAJOR) {
        this.setStatus({ state: 'unsupported', error: `Zotero ${version} was detected; this plugin requires Zotero ${MIN_ZOTERO_MAJOR} or later.` })
        return this.status
      }
      if (!this.keyLoaded && this.statusValue.serverId) await this.loadKey()
    } catch (error) {
      if (error instanceof ZoteroError && (error.code === 'zotero_not_running' || error.code === 'local_api_disabled')) return this.status
      this.setStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    return this.status
  }

  /**
   * Write-capability probe: an empty `POST /api/users/0/items` **without**
   * key or `Zotero-Server-ID`. Write-capable Zotero builds answer 428/401/412;
   * read-only builds answer another 4xx. No key → no side effects. This never
   * runs on read paths; it is called lazily before the first write or
   * explicitly (setup UI).
   */
  async probeWrites(): Promise<WriteSupport> {
    if (this.statusValue.writes !== 'unknown') return this.statusValue.writes
    await this.ensureReady()
    const response = await this.send('POST', '/api/users/0/items', {
      body: '[]',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: this.probeTimeoutMs,
    })
    const writes: WriteSupport = response.status === 428 || response.status === 401 || response.status === 412 ? 'available' : 'unsupported'
    this.setStatus({ writes })
    return writes
  }

  /** Ensure the connection is ready for data calls; throws the mapped error otherwise. */
  async ensureReady(): Promise<void> {
    if (this.statusValue.state === 'ready' && this.nowImpl() - this.statusValue.checkedAt < LIMITS.probeFreshMs) return
    const status = await this.probe()
    if (status.state === 'not_running') {
      throw new ZoteroError('zotero_not_running', 'Zotero is not running. Start the Zotero desktop app (version 10 or later), then try again.')
    }
    if (status.state === 'api_disabled') {
      throw new ZoteroError('local_api_disabled', status.error ?? 'Zotero is running, but its local API is turned off. Enable "Allow other applications on this computer to communicate with Zotero" in Zotero Settings → Advanced.')
    }
    if (status.state === 'unsupported') {
      throw new ZoteroError('unsupported_version', status.error ?? `Zotero ${MIN_ZOTERO_MAJOR} or later is required.`)
    }
    if (status.state !== 'ready') {
      throw new ZoteroError('zotero_error', status.error ?? 'Zotero did not respond as expected.')
    }
  }

  // -------------------------------------------------------------------------
  // Write authorization
  // -------------------------------------------------------------------------

  private async loadKey(): Promise<void> {
    this.keyLoaded = true
    const serverId = this.statusValue.serverId
    if (!serverId) return
    try {
      const stored = await this.keyStore.load(serverId)
      if (isValidApiKey(stored)) {
        this.key = { value: stored, remember: true }
        this.setStatus({ auth: 'remembered' })
      }
    } catch {
      // Unreadable store behaves like "no stored key".
    }
  }

  /**
   * Open Zotero's authorization dialog (`POST /api/local/authorize`, which
   * itself requires `Zotero-Server-ID`) and resolve with the issued key.
   * Concurrent callers share one dialog. Remembered keys go to the `KeyStore`.
   */
  authorize(): Promise<string> {
    this.authorizing ??= (async () => {
      this.setStatus({ auth: 'pending' })
      try {
        if (!this.statusValue.serverId) await this.probe()
        let response: ZoteroResponse
        try {
          response = await this.send('POST', '/api/local/authorize', {
            body: JSON.stringify({ appName: this.appName }),
            headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': this.statusValue.serverId ?? '' },
            timeoutMs: this.authorizeTimeoutMs,
          })
        } catch (error) {
          if (error instanceof ZoteroError && /within \d+ ms/.test(error.message)) {
            throw new ZoteroError('write_denied', 'Nobody answered the Zotero permission dialog in time. Approve the request in Zotero, then try again.')
          }
          throw error
        }
        if (response.status === 403) {
          this.setStatus({ auth: 'denied' })
          throw new ZoteroError('write_denied', 'The user denied write access in Zotero. Do not retry unless the user asks.')
        }
        if (response.status === 429) {
          const wait = response.headers.get('retry-after') ?? '60'
          throw new ZoteroError('authorize_rate_limited', `Zotero is rate-limiting permission requests; try again in ${wait} s.`, { retryAfterSeconds: Number(wait) || undefined })
        }
        if (response.status === 404 || response.status === 405) {
          throw new ZoteroError('writes_unsupported', `This Zotero version cannot write through its local API; Zotero ${MIN_ZOTERO_MAJOR} or later is required.`)
        }
        const bodyJson = response.json as { key?: unknown; remember?: boolean } | undefined
        if (response.status !== 200 || !isValidApiKey(bodyJson?.key)) throw httpError(response, 'POST /api/local/authorize')
        const key = bodyJson!.key as string
        const remember = !!bodyJson!.remember
        this.key = { value: key, remember }
        this.setStatus({ auth: remember ? 'remembered' : 'none', writes: 'available' })
        if (remember && this.statusValue.serverId) await this.keyStore.save(this.statusValue.serverId, key)
        return key
      } finally {
        this.authorizing = null
        this.onChange()
      }
    })()
    return this.authorizing
  }

  /** Forget the current key (e.g. the user revoked it inside Zotero). */
  async forgetKey(): Promise<void> {
    this.key = null
    const serverId = this.statusValue.serverId
    if (serverId) await this.keyStore.remove(serverId).catch(() => undefined)
    this.setStatus({ auth: 'none' })
  }

  /**
   * Authorized write. Authorizes on demand; a rejected key (401: a one-time
   * key was consumed or revoked) triggers one re-authorization. A 412 that
   * blames `Zotero-Server-ID` means another instance answered: re-probe and
   * surface a retryable `zotero_error`. Everything else is returned for the
   * caller to interpret.
   */
  async write(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: WriteOptions = {}): Promise<ZoteroResponse> {
    await this.ensureReady()
    if (this.statusValue.writes === 'unknown') await this.probeWrites()
    if (this.statusValue.writes === 'unsupported') {
      const seen = this.statusValue.version ? `Zotero ${this.statusValue.version} allows only reads through its local API` : 'This Zotero build allows only reads through its local API'
      throw new ZoteroError('writes_unsupported', `${seen}; writing requires Zotero ${MIN_ZOTERO_MAJOR} or later.`)
    }
    if (!this.keyLoaded) await this.loadKey()
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = this.key?.value ?? (await this.authorize())
      const single = this.key !== null && !this.key.remember
      if (single) this.key = null // One-time keys expire on first verification.
      const response = await this.send(method, path, {
        body: options.body,
        timeoutMs: options.timeoutMs ?? this.writeTimeoutMs,
        signal: options.signal,
        headers: {
          ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
          ...options.headers,
          'Zotero-API-Key': key,
          'Zotero-Server-ID': this.statusValue.serverId ?? '',
        },
      })
      if (response.status === 401 && attempt === 0) {
        if (!single) await this.forgetKey()
        continue
      }
      if (response.status === 412 && /Zotero-Server-ID/i.test(response.text)) {
        // Another Zotero instance answered than during the probe: refresh
        // identity and retry once with the new server id; fail if it flips again.
        if (attempt === 0) {
          this.setStatus({ serverId: undefined })
          await this.probe()
          continue
        }
        throw new ZoteroError('zotero_error', 'The Zotero instance answering on the loopback port keeps changing. Retry later.')
      }
      if (response.status === 403 && /write access|denied/i.test(response.text)) {
        this.setStatus({ auth: 'denied' })
        throw new ZoteroError('write_denied', response.text || 'Zotero denied the write.')
      }
      return response
    }
    throw new ZoteroError('write_denied', 'Zotero did not accept the write key.')
  }

  /**
   * Upload bytes to Zotero's local upload endpoint. Only URLs Zotero itself
   * returned are accepted: same loopback origin, path exactly
   * `/api/local/uploads/<token>` — anything else is an SSRF attempt and is
   * rejected before any I/O. No key or server id needed.
   */
  async upload(url: string, bytes: Uint8Array, contentType: string): Promise<ZoteroResponse> {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new ZoteroError('zotero_error', `Unexpected upload URL from Zotero: ${JSON.stringify(url)}`)
    }
    const base = new URL(this.baseUrl)
    const defaultPort = (protocol: string) => (protocol === 'https:' ? '443' : '80')
    const effectivePort = (parsed: URL) => parsed.port || defaultPort(parsed.protocol)
    if (
      target.protocol !== base.protocol ||
      target.hostname.toLowerCase() !== base.hostname.toLowerCase() ||
      effectivePort(target) !== effectivePort(base) ||
      !UPLOAD_PATH_PATTERN.test(target.pathname) ||
      target.search || target.hash || target.username || target.password
    ) {
      throw new ZoteroError('zotero_error', `Unexpected upload URL from Zotero: ${url}`)
    }
    return this.send('POST', target.pathname, {
      body: bytes,
      headers: { 'Content-Type': contentType },
      timeoutMs: LIMITS.writeTimeoutMs,
    })
  }
}

/** Map a non-2xx read response to the error taxonomy. */
export function httpError(response: ZoteroResponse, what: string): ZoteroError {
  const text = response.text.trim().slice(0, 500)
  if (response.status === 404) return new ZoteroError('not_found', `${what}: not found${text && text !== 'Not found' ? ` (${text})` : ''}.`)
  if (response.status === 412) return new ZoteroError('version_conflict', `${what}: the object changed in Zotero meanwhile.`)
  if (response.status === 400) return new ZoteroError('invalid_input', `${what}: ${text || 'bad request'}`)
  return new ZoteroError('zotero_error', `${what} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`)
}
