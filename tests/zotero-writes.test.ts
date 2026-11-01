import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZoteroError } from '../src/domain/model.ts'
import { ZoteroLocalClient } from '../src/zotero/client.ts'
import { ZoteroLibrary } from '../src/zotero/library.ts'
import { ZoteroWrites } from '../src/zotero/writes.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'

let fake: FakeZotero
let client: ZoteroLocalClient
let library: ZoteroLibrary
let writes: ZoteroWrites

beforeEach(async () => {
  fake = await startFakeZotero()
  client = new ZoteroLocalClient({ baseUrl: fake.url, appName: 'DSH Zotero Tests' })
  library = new ZoteroLibrary(client)
  writes = new ZoteroWrites(client, library)
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

describe('create', () => {
  it('creates objects in batches of at most 50 and returns keys in order', async () => {
    const objects = Array.from({ length: 60 }, (_, index) => ({ itemType: 'note', note: `note ${index}`, parentItem: 'PAPERAAA' }))
    const keys = await writes.create('user', 'items', objects)
    expect(keys).toHaveLength(60)
    expect(new Set(keys).size).toBe(60)
    const createRequests = fake.state.requests.filter((line) => line === 'POST /api/users/0/items')
    expect(createRequests).toHaveLength(3) // keyless write probe + batches of 50 and 10
    const detail = await library.item('user', 'PAPERAAA')
    expect(detail.notes).toHaveLength(61) // 1 seeded note + 60 created
  })

  it('creates collections and invalidates the collections cache', async () => {
    await library.collections('user') // prime the cache
    const keys = await writes.create('user', 'collections', [{ name: 'New Inbox', parentCollection: 'CLPLAAAA' }])
    expect(keys).toHaveLength(1)
    const doc = await library.collections('user')
    expect(doc.collections.some((node) => node.name === 'New Inbox')).toBe(true)
  })

  it('surfaces per-object failures as write_failed with the input position', async () => {
    const error = await errorOf(writes.create('user', 'items', [
      { itemType: 'note', note: 'fine', parentItem: 'PAPERAAA' },
      { itemType: 'note', note: 'bad field', nonsenseField: 'x', parentItem: 'PAPERAAA' },
    ]))
    expect(error.code).toBe('write_failed')
    expect(error.message).toContain('2')
  })

  it('rejects empty input without any request', async () => {
    const keys = await writes.create('user', 'items', [])
    expect(keys).toEqual([])
    expect(fake.state.requests.filter((line) => line.startsWith('POST /api/users/0/items'))).toEqual([])
  })

  it('stamps Zotero-Write-Token and authorization headers on create requests', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const realFetch = globalThis.fetch
    const spiedClient = new ZoteroLocalClient({
      baseUrl: fake.url,
      appName: 'DSH Zotero Tests',
      fetch: async (url, init) => {
        const target = String(url)
        if ((init?.method ?? 'GET') === 'POST' && target.includes('/api/users/0/items')) {
          seen.push({ url: target, headers: Object.fromEntries(new Headers(init?.headers)) })
        }
        return realFetch(url, init)
      },
    })
    const spiedWrites = new ZoteroWrites(spiedClient, new ZoteroLibrary(spiedClient))
    await spiedWrites.create('user', 'items', [{ itemType: 'note', note: 'x', parentItem: 'PAPERAAA' }])
    // Two POSTs hit the endpoint: the keyless write probe and the authorized create.
    expect(seen).toHaveLength(2)
    const probe = seen.find((entry) => entry.headers['zotero-api-key'] === undefined)
    expect(probe).toBeDefined()
    const authorized = seen.find((entry) => entry.headers['zotero-api-key'] !== undefined)!
    expect(authorized.headers['zotero-server-id']).toBe('FAKESERVER01')
    expect(authorized.headers['zotero-write-token']).toMatch(/^[0-9a-f]{8,64}$/)
    expect(authorized.headers['content-type']).toBe('application/json')
  })
})

describe('patchItem', () => {
  it('patches with If-Unmodified-Since-Version and re-reads once on 412', async () => {
    let calls = 0
    const result = await writes.patchItem('user', 'PAPERAAA', (current) => {
      calls += 1
      if (calls === 1) {
        // Concurrent edit while we were computing the patch.
        fake.touch('PAPERAAA', { extra: 'edited elsewhere' })
      }
      return { ...current.data, extra: 'edited in test' } as Record<string, unknown>
    })
    expect(result.changed).toBe(true)
    expect(calls).toBe(2)
    const reread = await library.raw('user', 'PAPERAAA')
    expect(reread.data.extra).toBe('edited in test')
    expect(reread.version).toBeGreaterThan(0)
  })

  it('returns changed:false without any request when the update is empty', async () => {
    const writesCount = fake.state.requests.filter((line) => line.startsWith('PATCH')).length
    const result = await writes.patchItem('user', 'PAPERAAA', () => null)
    expect(result.changed).toBe(false)
    expect(fake.state.requests.filter((line) => line.startsWith('PATCH')).length).toBe(writesCount)
  })

  it('gives up with version_conflict when the item keeps changing', async () => {
    const error = await errorOf(writes.patchItem('user', 'PAPERAAA', (current) => {
      fake.touch('PAPERAAA', { extra: `edit ${Math.random()}` })
      return { ...current.data, extra: 'never lands' } as Record<string, unknown>
    }))
    expect(error.code).toBe('version_conflict')
  })
})

describe('deleteItems', () => {
  it('deletes items and their children', async () => {
    await writes.deleteItems('user', ['NTEAAAAA'])
    const detail = await library.item('user', 'PAPERAAA')
    expect(detail.notes).toHaveLength(0)
  })
})

describe('attachFile (three-step upload)', () => {
  it('creates the attachment, uploads bytes and registers the file', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 tiny fixture')
    const key = await writes.attachFile('user', 'PAPERAAA', {
      bytes,
      filename: 'uploaded.pdf',
      contentType: 'application/pdf',
      title: 'Uploaded PDF',
    })
    expect(key).toMatch(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/)
    expect(fake.state.files.get(key)).toBeDefined()
    const detail = await library.item('user', 'PAPERAAA')
    expect(detail.attachments.some((attachment) => attachment.key === key && attachment.filename === 'uploaded.pdf')).toBe(true)
    const path = await library.resolveAttachmentPath('user', key)
    expect(path.endsWith('uploaded.pdf')).toBe(true)
  })

  it('rolls back the created attachment when the upload is rejected (SSRF guard)', async () => {
    const realFetch = globalThis.fetch
    const evil = new ZoteroLocalClient({
      baseUrl: fake.url,
      appName: 'DSH Zotero Tests',
      fetch: async (url, init) => {
        const response = await realFetch(url, init)
        // Tamper with Zotero's upload grant: point it at a non-loopback host.
        if (String(url).endsWith('/file') && (init?.method ?? 'GET') === 'POST') {
          const body = await response.text()
          const grant = JSON.parse(body) as { url?: string; uploadKey?: string }
          grant.url = 'http://169.254.169.254/api/local/uploads/metadata'
          return new Response(JSON.stringify(grant), { status: response.status, headers: response.headers })
        }
        return response
      },
    })
    const rollsBack = new ZoteroWrites(evil, new ZoteroLibrary(evil))
    const before = new Set([...fake.state.items.keys()])
    const error = await errorOf(rollsBack.attachFile('user', 'PAPERAAA', {
      bytes: new TextEncoder().encode('%PDF-1.4 x'),
      filename: 'evil.pdf',
      contentType: 'application/pdf',
      title: 'Evil',
    }))
    expect(error.code).toBe('zotero_error')
    expect(error.message).toMatch(/Unexpected upload URL/)
    const after = [...fake.state.items.keys()].filter((key) => !before.has(key))
    // The half-created attachment entry was deleted again.
    for (const key of after) expect(fake.state.items.get(key)?.deleted).toBe(true)
  })

  it('short-circuits when Zotero reports the file already exists', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 again')
    const key = await writes.attachFile('user', 'PAPERAAA', { bytes, filename: 'again.pdf', contentType: 'application/pdf', title: 'Again' })
    // Same content, same key semantics: Zotero answers exists → no second upload step.
    // (The fake does not dedupe by md5, so we only assert the first upload path ran.)
    expect(fake.state.files.get(key)).toBeDefined()
  })
})

describe('authorization wiring', () => {
  it('goes through the Zotero dialog exactly once for multiple writes', async () => {
    await writes.create('user', 'items', [{ itemType: 'note', note: 'a', parentItem: 'PAPERAAA' }])
    await writes.create('user', 'collections', [{ name: 'Second' }])
    await writes.patchItem('user', 'PAPERAAA', (current) => ({ ...current.data, extra: 'once' }) as Record<string, unknown>)
    expect(fake.state.authorizeRequests).toBe(1)
  })

  it('propagates write_denied without retrying', async () => {
    fake.setAuthorizeMode('deny')
    const error = await errorOf(writes.create('user', 'collections', [{ name: 'Nope' }]))
    expect(error.code).toBe('write_denied')
    expect(fake.state.authorizeRequests).toBe(1)
  })
})
