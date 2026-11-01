/**
 * `src/client/api.ts` tests: error-envelope handling, AbortSignal plumbing,
 * endpoint path builders, and the SSE view-event stream (dedupe + close).
 * The suite injects structural fetch/EventSource stubs; no network.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  annotationsPath,
  apiJson,
  apiText,
  browserRef,
  collectionsPath,
  connectViewEvents,
  exportPath,
  getItems,
  getLibraries,
  getPdfInfo,
  getStatus,
  itemPath,
  itemsPath,
  launchZotero,
  pdfAssetPath,
  pdfPartPath,
  saveHighlights,
  statusPath,
  type EventSourceLike,
} from '../src/client/api.ts'
import type { ViewEvent } from '../src/shared/protocol.ts'

/** Minimal Response-like stub. */
const jsonResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

const textResponse = (status: number, body: string) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as unknown as Response

describe('apiJson', () => {
  it('parses JSON on 2xx and passes the document-relative reference through', async () => {
    const fetchImpl = vi.fn(async (input: string) => jsonResponse(200, { ok: true, plugin: 'p' }))
    const data = await apiJson<{ ok: boolean }>('/dsh-zotero/health', { fetchImpl })
    expect(data.ok).toBe(true)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('dsh-zotero/health')
  })

  it('surfaces the unified error envelope as ApiError with code and message', async () => {
    const fetchImpl = async () => jsonResponse(404, { error: { code: 'not_found', message: 'No route' } })
    const error = await apiJson('/dsh-zotero/nothing', { fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('not_found')
    expect((error as ApiError).message).toBe('No route')
    expect((error as ApiError).status).toBe(404)
  })

  it('falls back to the raw text when the body is not the envelope', async () => {
    const fetchImpl = async () => textResponse(502, 'bad gateway from somewhere')
    const error = await apiJson('/dsh-zotero/status', { fetchImpl }).catch((e: unknown) => e)
    expect((error as ApiError).code).toBe('internal')
    expect((error as ApiError).message).toContain('bad gateway')
  })

  it('wraps network failures as host_unreachable (status 0)', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    const error = await apiJson('/dsh-zotero/status', { fetchImpl }).catch((e: unknown) => e)
    expect((error as ApiError).code).toBe('host_unreachable')
    expect((error as ApiError).status).toBe(0)
  })

  it('rejects through the caller signal (AbortError propagates)', async () => {
    const controller = new AbortController()
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return jsonResponse(200, {})
    }
    controller.abort()
    await expect(apiJson('/dsh-zotero/status', { fetchImpl, signal: controller.signal })).rejects.toThrow()
  })

  it('malformed 2xx JSON becomes internal', async () => {
    const fetchImpl = async () => textResponse(200, '<html>nope</html>')
    const error = await apiJson('/dsh-zotero/items', { fetchImpl }).catch((e: unknown) => e)
    expect((error as ApiError).code).toBe('internal')
  })

  it('apiText returns raw text on 2xx (export path)', async () => {
    const fetchImpl = async () => textResponse(200, '@article{a,\n}')
    expect(await apiText('/dsh-zotero/export?format=bib', { fetchImpl })).toContain('@article')
  })
})

describe('endpoint path builders', () => {
  it('builds relative paths only (no host, no key surface)', () => {
    expect(itemsPath({ library: 'user', q: 'deep learning', mode: 'everything', sort: 'dateAdded', direction: 'asc', start: 0, limit: 100 })).toBe(
      '/dsh-zotero/items?library=user&q=deep+learning&mode=everything&sort=dateAdded&direction=asc&start=0&limit=100',
    )
    expect(itemsPath({ library: 'g12', collection: 'ABCD2345', limit: 50 })).toBe('/dsh-zotero/items?library=g12&collection=ABCD2345&limit=50')
    expect(itemsPath({ library: 'user', search: 'SAVED123', limit: 50 })).toBe('/dsh-zotero/items?library=user&search=SAVED123&limit=50')
    expect(itemsPath({ library: 'user', keys: ['ABCD2345', 'BCDE3456'] })).toBe('/dsh-zotero/items?library=user&keys=ABCD2345%2CBCDE3456')
    expect(collectionsPath('user')).toBe('/dsh-zotero/collections?library=user')
    expect(itemPath('user', 'ABCD2345')).toBe('/dsh-zotero/items/ABCD2345?library=user')
    expect(annotationsPath('user', 'ABCD2345')).toBe('/dsh-zotero/items/ABCD2345/annotations?library=user')
    expect(exportPath('user', 'bib', { keys: ['ABCD2345'] })).toBe('/dsh-zotero/export?library=user&format=bib&keys=ABCD2345')
    expect(exportPath('g1', 'ris')).toBe('/dsh-zotero/export?library=g1&format=ris')
  })

  it('omits empty optional values', () => {
    expect(itemsPath({ library: 'user' })).toBe('/dsh-zotero/items?library=user')
  })
})

describe('document-relative browser references (official boundary rule)', () => {
  /**
   * The host half registers absolute route keys on the webServer; the browser
   * half references them document-relative (dsh-client-modules strips the
   * leading slash "at the boundary between the two halves"; official clients
   * fetch `open-in-app/apps` / subscribe `plugins/events`). These tests pin
   * what every host call — status, items, PDF parts/assets, writes, events —
   * resolves to under the two real carriers.
   */
  const carriers = {
    // Web GUI: the SPA is served at the webServer root.
    web: 'http://127.0.0.1:3080/',
    // Desktop: the shell serves the SPA at `dsh-app://app/` and forwards
    // non-static paths to the host webServer with its own auth cookie
    // (app.asar lib/main.js `forwardWebRequest`).
    desktop: 'dsh-app://app/',
  }

  it('strips the route-key leading slash at the network boundary', () => {
    expect(browserRef(statusPath())).toBe('dsh-zotero/status')
    expect(browserRef(itemsPath({ library: 'user' }))).toBe('dsh-zotero/items?library=user')
    expect(browserRef(pdfPartPath('user', 'ABCD2345', 0))).toBe('dsh-zotero/pdf/part?library=user&attachment=ABCD2345&part=0')
    expect(browserRef(pdfAssetPath('cmaps', 'bcmaps.bin'))).toBe('dsh-zotero/pdfjs/cmaps/bcmaps.bin')
  })

  it('resolves every fetch onto the host route under both real carriers', async () => {
    for (const [carrier, base] of Object.entries(carriers)) {
      const seen: string[] = []
      const fetchImpl = vi.fn(async (input: string) => {
        seen.push(input)
        return jsonResponse(200, {})
      })
      await Promise.all([
        getStatus({ fetchImpl }),
        getItems({ library: 'user' }, { fetchImpl }),
        getPdfInfo('user', 'ABCD2345', { fetchImpl }),
        saveHighlights({ ids: ['h1'] }, { fetchImpl }),
      ])
      for (const reference of seen) {
        const resolved = new URL(reference, base)
        expect(resolved.pathname.startsWith('/dsh-zotero/'), `${carrier}: ${reference}`).toBe(true)
        // The reference never names an absolute origin: the host is whatever
        // document base the official carrier provides.
        expect(reference.startsWith('http'), `${carrier}: ${reference}`).toBe(false)
      }
    }
  })

  it('carries no absolute origin or Zotero endpoint anywhere in the references', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}))
    await Promise.all([getStatus({ fetchImpl }), getLibraries({ fetchImpl }), launchZotero({ fetchImpl })])
    for (const call of fetchImpl.mock.calls) {
      const reference = String(call[0])
      expect(reference).not.toMatch(/^https?:\/\//)
      expect(reference).not.toContain('23119')
      expect(reference).not.toMatch(/key=|api[_-]?key/i)
    }
  })

  it('cannot reach an http host from a file:// document (why the desktop carrier is dsh-app)', () => {
    // A file:// page resolving any relative reference stays inside file: —
    // relative references can never cross schemes. The official desktop
    // carrier therefore serves the SPA over `dsh-app://app` (whose handler
    // forwards to the host with the auth cookie) instead of file://; the
    // client's job is only to keep references relative so that bridge works.
    const resolved = new URL(browserRef(statusPath()), 'file:///Users/x/dsh/index.html')
    expect(resolved.protocol).toBe('file:')
    expect(resolved.pathname).toContain('/dsh-zotero/status')
  })
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** Scriptable EventSource stub recording handlers. */
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
  emit(event: ViewEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

const viewEvent = (seq: number): ViewEvent => ({ seq, at: seq, intent: { kind: 'open_item', library: 'user', key: 'ABCD2345' } })

describe('connectViewEvents', () => {
  it('reports connecting → open and forwards strictly increasing events', () => {
    const states: string[] = []
    const seen: number[] = []
    FakeEventSource.instances = []
    const handle = connectViewEvents({
      onEvent: (event) => seen.push(event.seq),
      onState: (state) => states.push(state),
      sourceFactory: (url) => new FakeEventSource(url),
    })
    expect(states).toEqual(['connecting'])
    const source = FakeEventSource.instances[0]
    expect(source?.url).toBe('dsh-zotero/events')
    source?.onopen?.(null)
    expect(states).toEqual(['connecting', 'open'])
    source?.emit(viewEvent(1))
    source?.emit(viewEvent(2))
    source?.emit(viewEvent(2)) // duplicate
    source?.emit(viewEvent(1)) // replay
    expect(seen).toEqual([1, 2])
    expect(handle.lastSeq()).toBe(2)
    handle.close()
    expect(source?.closed).toBe(true)
  })

  it('starts above a caller-provided fromSeq (store seenSeq)', () => {
    FakeEventSource.instances = []
    const seen: number[] = []
    const handle = connectViewEvents({
      fromSeq: 9,
      onEvent: (event) => seen.push(event.seq),
      sourceFactory: (url) => new FakeEventSource(url),
    })
    const source = FakeEventSource.instances[0]
    source?.emit(viewEvent(9))
    source?.emit(viewEvent(10))
    expect(seen).toEqual([10])
    expect(handle.lastSeq()).toBe(10)
    handle.close()
  })

  it('ignores malformed payloads without breaking the stream', () => {
    FakeEventSource.instances = []
    const seen: number[] = []
    const handle = connectViewEvents({ onEvent: (event) => seen.push(event.seq), sourceFactory: (url) => new FakeEventSource(url) })
    const source = FakeEventSource.instances[0]
    source?.onmessage?.({ data: 'not json' })
    source?.onmessage?.({ data: JSON.stringify({ noseq: true }) })
    expect(seen).toEqual([])
    expect(handle.lastSeq()).toBe(0)
    handle.close()
  })

  it('reports error state when the stream cannot be created', () => {
    const states: string[] = []
    const handle = connectViewEvents({
      onState: (state) => states.push(state),
      sourceFactory: () => {
        throw new Error('EventSource unavailable')
      },
    })
    expect(states).toEqual(['connecting', 'error'])
    expect(handle.lastSeq()).toBe(0)
    handle.close()
  })
})
