import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryKeyStore, type KeyStore } from '../src/zotero/auth.ts'
import { assertLoopbackBaseUrl, majorVersion, ZoteroLocalClient } from '../src/zotero/client.ts'
import { ZoteroError } from '../src/domain/model.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'

/** Recording KeyStore for authorization assertions. */
function recordingKeyStore(): KeyStore & { saved: [string, string][]; removed: string[] } {
  const inner = new MemoryKeyStore()
  const saved: [string, string][] = []
  const removed: string[] = []
  return {
    async load(serverId) {
      return inner.load(serverId)
    },
    async save(serverId, key) {
      saved.push([serverId, key])
      await inner.save(serverId, key)
    },
    async remove(serverId) {
      removed.push(serverId)
      await inner.remove(serverId)
    },
    saved,
    removed,
  }
}

let fake: FakeZotero

beforeEach(async () => {
  fake = await startFakeZotero()
})

afterEach(async () => {
  await fake.close()
})

function errorOf(promise: Promise<unknown>): Promise<ZoteroError> {
  return promise.then(
    (value) => {
      throw new Error(`expected rejection, got ${JSON.stringify(value)}`)
    },
    (error: ZoteroError) => error,
  )
}

describe('base URL validation', () => {
  it('accepts loopback forms only', () => {
    expect(assertLoopbackBaseUrl('http://127.0.0.1:23119/')).toBe('http://127.0.0.1:23119')
    expect(assertLoopbackBaseUrl('http://localhost:23119')).toBe('http://localhost:23119')
    expect(assertLoopbackBaseUrl('http://[::1]:23119')).toBe('http://[::1]:23119')
  })

  it('rejects non-loopback hosts before any I/O', () => {
    for (const bad of ['http://zotero.example.com:23119', 'http://169.254.169.254/', 'https://api.zotero.org', 'ftp://127.0.0.1:23119', 'not a url', 'http://user:pass@127.0.0.1:23119']) {
      expect(() => new ZoteroLocalClient({ baseUrl: bad })).toThrowError(ZoteroError)
      try {
        assertLoopbackBaseUrl(bad)
        expect.unreachable()
      } catch (error) {
        expect((error as ZoteroError).code).toBe('invalid_input')
      }
    }
  })
})

describe('probe', () => {
  it('reports ready with version and server id, sending the API version header', async () => {
    const seenHeaders: Record<string, string>[] = []
    const realFetch = globalThis.fetch
    const client = new ZoteroLocalClient({
      baseUrl: fake.url,
      appName: 'DSH Zotero Tests',
      fetch: async (url, init) => {
        seenHeaders.push(Object.fromEntries(new Headers(init?.headers)))
        return realFetch(url, init)
      },
    })
    const probe = await client.probe()
    expect(probe.state).toBe('ready')
    expect(probe.version).toBe('10.0.2-test')
    expect(probe.serverId).toBe('FAKESERVER01')
    expect(probe.writes).toBe('unknown')
    expect(probe.auth).toBe('none')
    expect(seenHeaders[0]?.['zotero-api-version']).toBe('3')
  })

  it('never runs the write probe on read paths', async () => {
    const client = new ZoteroLocalClient({ baseUrl: fake.url })
    await client.probe()
    const writeProbes = fake.state.requests.filter((line) => line.startsWith('POST /api/users/0/items'))
    expect(writeProbes).toEqual([])
    expect(fake.state.requests.filter((line) => line === 'GET /api/')).toHaveLength(1)
  })

  it('maps a closed port to not_running', async () => {
    const dead = await startFakeZotero()
    const url = dead.url
    await dead.close()
    const client = new ZoteroLocalClient({ baseUrl: url })
    const status = await client.probe()
    expect(status.state).toBe('not_running')
    const error = await errorOf(client.get('/api/users/0/items/top'))
    expect(error.code).toBe('zotero_not_running')
  })

  it('maps 403 with the not-enabled text to api_disabled', async () => {
    const disabled = await startFakeZotero({ apiEnabled: false })
    try {
      const client = new ZoteroLocalClient({ baseUrl: disabled.url })
      const status = await client.probe()
      expect(status.state).toBe('api_disabled')
      const error = await errorOf(client.get('/api/users/0/items/top'))
      expect(error.code).toBe('local_api_disabled')
    } finally {
      await disabled.close()
    }
  })

  it('maps 404 on /api/ to api_disabled (no local API at all)', async () => {
    const ancient = await startFakeZotero({ localApiPresent: false })
    try {
      const client = new ZoteroLocalClient({ baseUrl: ancient.url })
      const status = await client.probe()
      expect(status.state).toBe('api_disabled')
    } finally {
      await ancient.close()
    }
  })

  it('marks Zotero below 10 as unsupported and rejects data calls', async () => {
    const old = await startFakeZotero({ version: '9.0.3' })
    try {
      const client = new ZoteroLocalClient({ baseUrl: old.url })
      const status = await client.probe()
      expect(status.state).toBe('unsupported')
      const error = await errorOf(client.get('/api/users/0/items/top'))
      expect(error.code).toBe('unsupported_version')
      expect(error.message).toMatch(/10/)
    } finally {
      await old.close()
    }
  })

  it('maps a hanging transport to zotero_error (timeout)', async () => {
    const client = new ZoteroLocalClient({
      baseUrl: 'http://127.0.0.1:23119',
      probeTimeoutMs: 100,
      fetch: ((url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }
          // Never resolves otherwise: the client must time out on its own.
        })) as unknown as typeof globalThis.fetch,
    })
    // probe() never throws: a timeout is reported as an error status…
    const status = await client.probe()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/within \d+ ms/)
    // …while data calls surface it as a ZoteroError.
    const error = await errorOf(client.get('/api/users/0/items/top'))
    expect(error.code).toBe('zotero_error')
  })

  it('re-probes when the freshness window lapses (injectable clock)', async () => {
    let now = 1_000_000
    const client = new ZoteroLocalClient({ baseUrl: fake.url, now: () => now })
    await client.probe()
    now += 10
    await client.ensureReady() // fresh: no new request
    expect(fake.state.requests.filter((line) => line === 'GET /api/')).toHaveLength(1)
    now += 5000
    await client.ensureReady() // stale: probes again
    expect(fake.state.requests.filter((line) => line === 'GET /api/')).toHaveLength(2)
  })
})

describe('majorVersion', () => {
  it('parses the major segment', () => {
    expect(majorVersion('10.0.2')).toBe(10)
    expect(majorVersion('11.0-beta.1')).toBe(11)
    expect(majorVersion('7.0.15')).toBe(7)
    expect(majorVersion('beta')).toBeUndefined()
  })
})

describe('write authorization', () => {
  it('authorizes once and reuses remembered keys for later writes', async () => {
    const store = recordingKeyStore()
    const client = new ZoteroLocalClient({ baseUrl: fake.url, appName: 'DSH Zotero Tests', keyStore: store })
    const first = await client.write('POST', '/api/users/0/items', { body: JSON.stringify([{ itemType: 'note', note: 'p', parentItem: 'PAPERAAA' }]), contentType: 'application/json' })
    expect(first.status).toBe(200)
    expect(client.status.writes).toBe('available')
    expect(client.status.auth).toBe('remembered')
    expect(store.saved).toEqual([['FAKESERVER01', store.saved[0]?.[1]]])
    expect(store.saved[0]?.[0]).toBe('FAKESERVER01')
    expect(fake.state.authorizeRequests).toBe(1)
    const second = await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'From Tests' }]), contentType: 'application/json' })
    expect(second.status).toBe(200)
    expect(fake.state.authorizeRequests).toBe(1)
  })

  it('sends key and server id headers on write requests', async () => {
    const seen: Record<string, string>[] = []
    const realFetch = globalThis.fetch
    const client = new ZoteroLocalClient({
      baseUrl: fake.url,
      fetch: async (url, init) => {
        seen.push(Object.fromEntries(new Headers(init?.headers)))
        return realFetch(url, init)
      },
    })
    await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'Headers' }]), contentType: 'application/json' })
    const writeRequest = seen.find((headers) => headers['zotero-api-key'] !== undefined)
    expect(writeRequest).toBeDefined()
    expect(writeRequest!['zotero-server-id']).toBe('FAKESERVER01')
    // The write token is the Writer's concern (writes.ts), not the client's.
    expect(writeRequest!['zotero-write-token']).toBeUndefined()
  })

  it('consumes one-time keys and re-authorizes for the next write', async () => {
    fake.setAuthorizeMode('once')
    const store = recordingKeyStore()
    const client = new ZoteroLocalClient({ baseUrl: fake.url, keyStore: store })
    await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'One' }]), contentType: 'application/json' })
    expect(store.saved).toEqual([])
    expect(fake.state.authorizeRequests).toBe(1)
    await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'Two' }]), contentType: 'application/json' })
    expect(fake.state.authorizeRequests).toBe(2)
  })

  it('re-authorizes once when a remembered key is rejected with 401', async () => {
    const store = recordingKeyStore()
    const client = new ZoteroLocalClient({ baseUrl: fake.url, keyStore: store })
    await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'First' }]), contentType: 'application/json' })
    // User revokes the key inside Zotero.
    fake.state.keys.clear()
    const response = await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'Second' }]), contentType: 'application/json' })
    expect(response.status).toBe(200)
    expect(fake.state.authorizeRequests).toBe(2)
  })

  it('maps a denied dialog to write_denied and stops', async () => {
    fake.setAuthorizeMode('deny')
    const client = new ZoteroLocalClient({ baseUrl: fake.url })
    const error = await errorOf(client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'X' }]), contentType: 'application/json' }))
    expect(error.code).toBe('write_denied')
    expect(client.status.auth).toBe('denied')
  })

  it('shares one authorization dialog across concurrent callers', async () => {
    const client = new ZoteroLocalClient({ baseUrl: fake.url })
    const [a, b] = await Promise.all([
      client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'A' }]), contentType: 'application/json' }),
      client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'B' }]), contentType: 'application/json' }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(fake.state.authorizeRequests).toBe(1)
  })

  it('classifies read-only builds via probeWrites and refuses to write', async () => {
    const readonly = await startFakeZotero({ writes: false })
    try {
      const client = new ZoteroLocalClient({ baseUrl: readonly.url })
      expect(await client.probeWrites()).toBe('unsupported')
      const error = await errorOf(client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'X' }]), contentType: 'application/json' }))
      expect(error.code).toBe('writes_unsupported')
      expect(error.message).toMatch(/Zotero 10/)
      // The refusal happened before any authorize attempt.
      expect(readonly.state.authorizeRequests).toBe(0)
    } finally {
      await readonly.close()
    }
  })

  it('invalidates remembered keys when the server id changes', async () => {
    const store = recordingKeyStore()
    const client = new ZoteroLocalClient({ baseUrl: fake.url, keyStore: store })
    await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'Before' }]), contentType: 'application/json' })
    const firstKeyId = store.saved[0]?.[1]
    expect(firstKeyId).toBeDefined()
    fake.rotateServerId('OTHERSERVER9')
    await client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'After' }]), contentType: 'application/json' })
    expect(fake.state.authorizeRequests).toBe(2)
    expect(client.status.serverId).toBe('OTHERSERVER9')
    // A new key was stored under the new server id; the old one was never re-sent after the change.
    expect(store.saved.map(([serverId]) => serverId)).toEqual(['FAKESERVER01', 'OTHERSERVER9'])
  })

  it('surfaces 429 rate limiting from the authorization endpoint', async () => {
    const realFetch = globalThis.fetch
    const client = new ZoteroLocalClient({
      baseUrl: fake.url,
      fetch: async (url, init) => {
        if (String(url).endsWith('/api/local/authorize')) {
          return new Response('too many authorization requests', { status: 429, headers: { 'Retry-After': '30' } })
        }
        return realFetch(url, init)
      },
    })
    const error = await errorOf(client.write('POST', '/api/users/0/collections', { body: JSON.stringify([{ name: 'X' }]), contentType: 'application/json' }))
    expect(error.code).toBe('authorize_rate_limited')
    expect(error.details?.retryAfterSeconds).toBe(30)
  })
})

describe('upload URL validation (SSRF guard)', () => {
  it('accepts only same-origin /api/local/uploads/<token> URLs', async () => {
    const client = new ZoteroLocalClient({ baseUrl: fake.url })
    const bytes = new TextEncoder().encode('%PDF-1.4 test')
    for (const bad of [
      'http://169.254.169.254/api/local/uploads/abc',
      `${fake.url}/api/local/other/abc`,
      `${fake.url}/api/local/uploads/`, // no token
      `${fake.url}/api/local/uploads/../items`,
      `${fake.url}/api/local/uploads/abc?next=http://evil`,
      'ftp://127.0.0.1:1/api/local/uploads/abc',
    ]) {
      const error = await errorOf(client.upload(bad, bytes, 'application/pdf'))
      expect(error.code, bad).toBe('zotero_error')
      expect(error.message).toMatch(/Unexpected upload URL/)
      // Nothing reached the network for rejected URLs.
    }
    // And the happy path reaches the fake upload endpoint (404: unknown token, but same-origin rules passed).
    const response = await client.upload(`${fake.url}/api/local/uploads/unknownToken1`, bytes, 'application/pdf')
    expect(response.status).toBe(404)
  })
})
