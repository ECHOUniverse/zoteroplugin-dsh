/**
 * Test harness for the host half: mock `(req, res)` pair, a stand-in for the
 * official `ctx.connection` trust fence, a stub webServer that captures the
 * registered route, and a wiring helper that mounts the real route table
 * against a fake Zotero server.
 *
 * The fake fence mirrors the documented contract of
 * `@deepseek-ai/dsh-client-connection` (`HostConnectionHandle.requestRejection`):
 * loopback Host required, `sec-fetch-site: cross-site` refused, same-authority
 * `Origin` required, then an authenticated-peer check (here: presence of a
 * test cookie header).
 */
import type { ConnectionFace, WebServerFace } from '../../src/host/services.ts'
import { registerRoutes } from '../../src/host/routes.ts'
import { ZoteroSession } from '../../src/host/session.ts'
import type { startFakeZotero } from './fake-zotero.ts'

/** node:http-like response sink capturing everything the handlers touch. */
export class MockResponse {
  statusCode = 200
  headers = new Map<string, string | string[]>()
  chunks: (string | Buffer)[] = []
  writableEnded = false
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  setHeader(name: string, value: string | string[]): void {
    this.headers.set(String(name).toLowerCase(), value)
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(String(name).toLowerCase())
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(body?: string | Buffer): void {
    if (body !== undefined) this.chunks.push(body)
    this.writableEnded = true
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  /** Simulate the peer closing the connection (SSE cleanup path). */
  emitClose(): void {
    for (const listener of this.listeners.get('close') ?? []) listener()
  }

  get body(): string {
    return Buffer.concat(this.chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8')
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown
  }

  get contentType(): string {
    return String(this.headers.get('content-type') ?? '')
  }

  get status(): number {
    return this.statusCode
  }
}

/** node:http-like request stub: async-iterable body, headers, url, method. */
export interface MockRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
}

export function mockRequest(options: MockRequestOptions): AsyncIterable<Buffer> & MockRequestOptions & { headers: Record<string, string>; resume(): void } {
  const chunks = options.body !== undefined ? [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)] : []
  const request = {
    url: options.url,
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:3080', ...options.headers },
    resume(): void {},
    async *[Symbol.asyncIterator](): Generator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  }
  return request
}

/** Stand-in for the official connection trust fence (documented contract). */
export function fakeConnection(options: { authenticated?: boolean } = {}): ConnectionFace & { requests: number } {
  const state = { requests: 0 }
  return {
    get requests() {
      return state.requests
    },
    requestRejection(request: { headers: Record<string, string | string[] | undefined> }): 401 | 403 | undefined {
      state.requests += 1
      const headers = request.headers
      const host = headers.host
      if (typeof host !== 'string') return 403
      const hostname = host.split(':')[0] ?? ''
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
      if (!loopback) return 403
      if (String(headers['sec-fetch-site'] ?? '') === 'cross-site') return 403
      const origin = headers.origin
      if (origin !== undefined) {
        try {
          if (new URL(String(origin)).host !== host) return 403
        } catch {
          return 403
        }
      }
      return (options.authenticated ?? true) ? undefined : 401
    },
  }
}

/** webServer stub capturing the registered route. */
export interface StubWebServer extends WebServerFace {
  routes: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }[]
}

export function stubWebServer(): StubWebServer {
  const routes: StubWebServer['routes'] = []
  return {
    routes,
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
      routes.push(route)
      // Mirror the real webServer: the disposer removes the route (a duplicate
      // (kind, path) registration would throw on the official implementation).
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

export interface MountedRoutes {
  webServer: StubWebServer
  session: ZoteroSession
  connection: ConnectionFace & { requests: number }
  /** Dispatch one request through the prefix handler. */
  call(url: string, options?: Omit<MockRequestOptions, 'url'>): Promise<MockResponse>
  close(): Promise<void>
}

/** Mount the real route table against a fake Zotero + authenticated fake fence. */
export async function mountRoutes(
  zotero: Awaited<ReturnType<typeof startFakeZotero>>,
  options: {
    authenticated?: boolean
    withConnection?: boolean
    baseUrl?: string
    /** Extra ZoteroSession options (desktop/metadata/fs seams for tests). */
    session?: Omit<ConstructorParameters<typeof ZoteroSession>[0], 'baseUrl'>
  } = {},
): Promise<MountedRoutes> {
  let currentBase = options.baseUrl ?? zotero.url
  const session = new ZoteroSession({ baseUrl: { get: () => currentBase }, ...options.session })
  const webServer = stubWebServer()
  const connection = fakeConnection({ authenticated: options.authenticated ?? true })
  registerRoutes(webServer, { session, ...(options.withConnection === false ? {} : { connection }) })
  const handler = webServer.routes[0]!.handler as (req: unknown, res: unknown) => Promise<void>
  return {
    webServer,
    session,
    connection,
    async call(url, callOptions = {}) {
      const res = new MockResponse()
      await handler(mockRequest({ url, ...callOptions }), res)
      return res
    },
    close: async () => {
      session.dispose()
      currentBase = ''
    },
  }
}
