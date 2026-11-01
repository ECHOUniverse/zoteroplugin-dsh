/**
 * Host route-table tests: the exact handlers the host half registers on the
 * DSH webServer, exercised as plain `(req, res)` calls against a fake Zotero
 * Local API (spec §8 seam).
 *
 * Security cases use a stand-in for the official `ctx.connection` trust
 * fence implementing its documented contract: loopback Host, `sec-fetch-site:
 * cross-site` refusal, same-authority `Origin`, authenticated Peer required.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { ROUTES, ROUTE_BASE, ROUTES_HIGHLIGHT_WRITES, ROUTES_PDF } from '../src/shared/protocol.ts'
import { decodeAttachment } from '../src/host/routes.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'
import { mountRoutes, mockRequest, MockResponse, type MountedRoutes } from './helpers/host-harness.ts'

describe('health (the one minimal-public route)', () => {
  it('answers without the fence and without library data', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.health)
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('application/json')
    const body = res.json() as { ok: boolean; plugin: string; version: string }
    expect(body.ok).toBe(true)
    expect(body.plugin).toBe('@hanxu131/dsh-zotero')
    expect(body.version.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain('server')
    await mounted.close()
    await fake.close()
  })

  it('rejects non-GET with 405 + Allow', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.health, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    await mounted.close()
    await fake.close()
  })
})

describe('official trust fence on protected routes', () => {
  it('refuses unauthenticated requests with 401 before any data access', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake, { authenticated: false })
    const res = await mounted.call(ROUTES.status)
    expect(res.status).toBe(401)
    expect(res.writableEnded).toBe(true)
    await mounted.close()
    await fake.close()
  })

  it('refuses cross-site fetch metadata with 403', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.status, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
    await mounted.close()
    await fake.close()
  })

  it('refuses cross-origin Origin headers with 403', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.items, { headers: { origin: 'http://evil.example:3080' } })
    expect(res.status).toBe(403)
    await mounted.close()
    await fake.close()
  })

  it('keeps same-origin requests reachable', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.items, { headers: { origin: 'http://127.0.0.1:3080' } })
    expect(res.status).toBe(200)
    await mounted.close()
    await fake.close()
  })

  it('serves no protected route at all when the connection service is absent', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake, { withConnection: false })
    const res = await mounted.call(ROUTES.status)
    expect(res.status).toBe(503)
    const body = res.json() as { error: { code: string } }
    expect(body.error.code).toBe('service_unavailable')
    // health stays minimal-public even without the fence.
    const health = await mounted.call(ROUTES.health)
    expect(health.status).toBe(200)
    await mounted.close()
    await fake.close()
  })
})

describe('status (real probe)', () => {
  it('reports ready with the Zotero version when the local API answers', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.status)
    expect(res.status).toBe(200)
    const body = res.json() as { plugin: string; state: string; baseUrl: string; zoteroVersion?: string; writes?: string; auth?: string; checkedAt: number }
    expect(body.state).toBe('ready')
    expect(body.state).not.toBe('unknown')
    expect(body.zoteroVersion).toBe('10.0.2-test')
    expect(body.checkedAt).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toMatch(/key/i)
    await mounted.close()
    await fake.close()
  })

  it('reports the configured loopback Local API address (credential-free, display-only)', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const res = await mounted.call(ROUTES.status)
    const body = res.json() as { baseUrl: string }
    expect(body.baseUrl).toBe(fake.url)
    expect(body.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await mounted.close()
    await fake.close()
  })

  it('reports not_running when nothing listens on the configured address', async () => {
    const dead = createServer()
    const port = await new Promise<number>((done) => {
      dead.listen(0, '127.0.0.1', () => done((dead.address() as { port: number }).port))
    })
    await new Promise<void>((done) => dead.close(() => done()))
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake, { baseUrl: `http://127.0.0.1:${port}` })
    const res = await mounted.call(ROUTES.status)
    const body = res.json() as { state: string }
    expect(body.state).toBe('not_running')
    await mounted.close()
    await fake.close()
  })
})

describe('read routes', () => {
  let fake: FakeZotero
  let mounted: MountedRoutes
  beforeAll(async () => {
    fake = await startFakeZotero()
    mounted = await mountRoutes(fake)
  })
  afterAll(async () => {
    await mounted.close()
    await fake.close()
  })

  it('lists the personal library and groups with editable flags', async () => {
    const res = await mounted.call(ROUTES.libraries)
    expect(res.status).toBe(200)
    const body = res.json() as { libraries: { id: string; editable: boolean }[] }
    expect(body.libraries.map((library) => library.id)).toEqual(['user', 'g88', 'g99'])
    expect(body.libraries.find((library) => library.id === 'g99')?.editable).toBe(false)
  })

  it('serves the collection tree and saved searches', async () => {
    const res = await mounted.call(`${ROUTES.collections}?library=user`)
    expect(res.status).toBe(200)
    const body = res.json() as { library: string; collections: { key: string; name: string }[]; searches: { key: string }[] }
    expect(body.library).toBe('user')
    expect(body.collections.some((collection) => collection.name === 'Type Systems')).toBe(true)
    expect(body.searches.some((search) => search.key === 'SRCHAAAA')).toBe(true)
  })

  it('serves item search with q/mode/tag/sort/paging and totals', async () => {
    const res = await mounted.call(`${ROUTES.items}?q=type&sort=title&direction=asc&start=0&limit=1`)
    expect(res.status).toBe(200)
    const body = res.json() as { total: number; start: number; limit: number; items: { key: string }[] }
    expect(body.total).toBeGreaterThan(1)
    expect(body.limit).toBe(1)
    expect(body.items).toHaveLength(1)
  })

  it('serves full-text mode and collection filters', async () => {
    const fulltext = await mounted.call(`${ROUTES.items}?q=storage%20modes&mode=everything`)
    expect((fulltext.json() as { total: number }).total).toBeGreaterThan(0)
    const inCollection = await mounted.call(`${ROUTES.items}?collection=CLTYAAAA`)
    const body = inCollection.json() as { total: number; items: { key: string }[] }
    expect(body.total).toBe(2)
    expect(body.items.map((item) => item.key).sort()).toEqual(['PAPERAAA', 'PREPRAAA'])
  })

  it('serves explicit key lists', async () => {
    const res = await mounted.call(`${ROUTES.items}?keys=PAPERAAA,TAPLBKAA`)
    const body = res.json() as { items: { key: string }[] }
    expect(body.items.map((item) => item.key)).toEqual(['PAPERAAA', 'TAPLBKAA'])
  })

  it('maps invalid query parameters to 400 + envelope', async () => {
    const res = await mounted.call(`${ROUTES.items}?sort=banana`)
    expect(res.status).toBe(400)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.message).toContain('sort')
  })

  it('maps unknown library ids to 400', async () => {
    const res = await mounted.call(`${ROUTES.items}?library=nope`)
    expect(res.status).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_input')
  })

  it('serves item details with creators, attachments and notes', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/items/PAPERAAA`)
    expect(res.status).toBe(200)
    const body = res.json() as { key: string; title: string; creators: unknown[]; pdf: { key: string } | null; notes: { key: string }[]; itemVersion: number }
    expect(body.key).toBe('PAPERAAA')
    expect(body.title).toContain('Second-Class Values')
    expect(body.creators).toHaveLength(3)
    expect(body.pdf?.key).toBe('PDFATTAA')
    expect(body.notes.map((note) => note.key)).toContain('NTEAAAAA')
  })

  it('maps missing items to 404 + envelope', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/items/ZZZZZZZZ`)
    expect(res.status).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('serves children split into attachments and notes', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/items/PAPERAAA/children`)
    expect(res.status).toBe(200)
    const body = res.json() as { item: string; attachments: { key: string; isPdf: boolean }[]; notes: { key: string }[] }
    expect(body.item).toBe('PAPERAAA')
    // Zotero does not guarantee child order; assert as a set.
    expect([...body.attachments.map((attachment) => attachment.key)].sort()).toEqual(['GHSSTAAB', 'PDFATTAA', 'SCNPDAAA', 'SNAPAACC'])
    const pdf = body.attachments.find((attachment) => attachment.key === 'PDFATTAA')
    expect(pdf?.isPdf).toBe(true)
    expect(body.notes.map((note) => note.key)).toEqual(['NTEAAAAA'])
  })

  it('serves annotations of the best PDF attachment', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/items/PAPERAAA/annotations`)
    expect(res.status).toBe(200)
    const body = res.json() as { item: string; attachment: string | null; annotations: { key: string; rects: number[][] }[] }
    expect(body.attachment).toBe('PDFATTAA')
    expect(body.annotations).toHaveLength(1)
    expect(body.annotations[0]?.rects[0]).toEqual([72, 692, 380, 703])
  })

  it('answers an empty annotation list for items without a PDF', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/items/TAPLBKAA/annotations`)
    const body = res.json() as { attachment: string | null; annotations: unknown[] }
    expect(body.attachment).toBeNull()
    expect(body.annotations).toEqual([])
  })

  it('serves BibTeX export with local paths stripped', async () => {
    const res = await mounted.call(`${ROUTES.export}?format=bib&keys=PAPERAAA`)
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/plain')
    expect(res.body).toContain('@article{PAPERAAA')
    expect(res.body).not.toContain('/storage/')
    expect(res.body).not.toMatch(/^  file =/m)
  })

  it('serves RIS export with L1 lines stripped', async () => {
    const res = await mounted.call(`${ROUTES.export}?format=ris&keys=PAPERAAA`)
    expect(res.body).toContain('TY  - JOUR')
    expect(res.body).not.toContain('L1  -')
  })

  it('rejects unknown export formats', async () => {
    const res = await mounted.call(`${ROUTES.export}?format=json`)
    expect(res.status).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_input')
  })

  it('answers 404 + envelope for unknown paths (PDF subtree has no fake routes either)', async () => {
    for (const path of [`${ROUTE_BASE}/pdf`, `${ROUTE_BASE}/pdf/PAPERAAA`, `${ROUTE_BASE}/pdf/PAPERAAA/PDFATTAA/text`, `${ROUTE_BASE}/pdfjs/evil/../../secret.txt`]) {
      const res = await mounted.call(path)
      expect(res.status).toBe(404)
      expect((res.json() as { error: { code: string } }).error.code).toBe('not_found')
    }
  })

  it('gates every read route to GET', async () => {
    const res = await mounted.call(ROUTES.items, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })
})

describe('write routes (same Zotero authorization as every other write)', () => {
  let fake: FakeZotero
  let mounted: MountedRoutes
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
    mounted = await mountRoutes(fake)
  })
  afterAll(async () => {
    await mounted.close()
    await fake.close()
  })

  it('authorizes writes and never returns the key', async () => {
    const res = await mounted.call(ROUTES.writesAuthorize, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    const body = res.json() as { authorized: boolean; remembered: boolean }
    expect(body.authorized).toBe(true)
    expect(body.remembered).toBe(true)
    expect(res.body.toLowerCase()).not.toContain('"key"')
  })

  it('maps Zotero denial to 403 write_denied', async () => {
    fake.setAuthorizeMode('deny')
    const res = await mounted.call(ROUTES.writesAuthorize, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('write_denied')
    fake.setAuthorizeMode('always')
  })

  it('creates a structured item', async () => {
    const res = await mounted.call(ROUTES.writesItems, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', itemType: 'journalArticle', fields: { title: 'Route Created Item' } }),
    })
    expect(res.status).toBe(200)
    const body = res.json() as { key: string }
    expect(fake.state.items.get(body.key)?.data.title).toBe('Route Created Item')
  })

  it('rejects Zotero-owned fields', async () => {
    const res = await mounted.call(ROUTES.writesItems, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', itemType: 'journalArticle', fields: { version: 3 } }),
    })
    expect(res.status).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_input')
  })

  it('enforces the JSON media type (415)', async () => {
    const res = await mounted.call(ROUTES.writesItems, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    expect(res.status).toBe(415)
    expect((res.json() as { error: { code: string } }).error.code).toBe('unsupported_media_type')
  })

  it('enforces the JSON body ceiling (413)', async () => {
    const res = await mounted.call(ROUTES.writesItems, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', itemType: 'journalArticle', fields: { title: 'x'.repeat(1024 * 1024 + 10) } }),
    })
    expect(res.status).toBe(413)
    expect((res.json() as { error: { code: string } }).error.code).toBe('payload_too_large')
  })

  it('rejects malformed JSON bodies (400)', async () => {
    const res = await mounted.call(ROUTES.writesItems, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(res.status).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_input')
  })

  it('updates item fields (PATCH)', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', fields: { title: 'Second-Class Values Revisited (updated)' } }),
    })
    expect(res.status).toBe(200)
    const body = res.json() as { changed: boolean; item: { key: string; title: string } }
    expect(body.changed).toBe(true)
    expect(body.item.title).toContain('updated')
    expect(fake.state.items.get('PAPERAAA')?.data.title).toContain('updated')
  })

  it('adds a child note', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', html: '<p>route note</p>' }),
    })
    expect(res.status).toBe(200)
    const body = res.json() as { key: string }
    expect(fake.state.items.get(body.key)?.data.parentItem).toBe('PAPERAAA')
  })

  it('creates a collection', async () => {
    const res = await mounted.call(ROUTES.writesCollections, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', name: 'Route Collection' }),
    })
    expect(res.status).toBe(200)
    const body = res.json() as { key: string }
    expect(fake.state.collections.get(body.key)?.data.name).toBe('Route Collection')
  })

  it('rejects malformed parent keys', async () => {
    const res = await mounted.call(ROUTES.writesCollections, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', name: 'X', parentKey: '../escape' }),
    })
    expect(res.status).toBe(400)
  })

  it('uploads an attachment through the three-step Local API flow', async () => {
    const bytes = Buffer.from('%PDF-1.4 route fixture')
    const res = await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA/attachment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', filename: 'route.pdf', contentType: 'application/pdf', title: 'Route PDF', bytesBase64: bytes.toString('base64') }),
    })
    expect(res.status).toBe(200)
    const body = res.json() as { key: string }
    expect(fake.state.uploads.size).toBe(0) // upload completed and deregistered
    expect(fake.state.items.get(body.key)?.data.filename).toBe('route.pdf')
  })

  it('rejects non-PDF bytes for application/pdf attachments', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA/attachment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', filename: 'a.pdf', contentType: 'application/pdf', title: 'X', bytesBase64: Buffer.from('hello').toString('base64') }),
    })
    expect(res.status).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_input')
  })

  it('rejects path separators in filenames', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA/attachment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', filename: '../escape.pdf', contentType: 'application/pdf', title: 'X', bytesBase64: Buffer.from('%PDF-1.4 x').toString('base64') }),
    })
    expect(res.status).toBe(400)
  })

  it('never exposes a deletion route', async () => {
    const res = await mounted.call(`${ROUTE_BASE}/writes/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
    const direct = await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA`, { method: 'DELETE' })
    expect(direct.status).toBe(405)
    expect(direct.headers.get('allow')).toBe('PATCH')
  })

  it('gates write routes to their methods', async () => {
    expect((await mounted.call(ROUTES.writesItems, { method: 'GET' })).status).toBe(405)
    expect((await mounted.call(ROUTES.writesCollections, { method: 'PATCH' })).status).toBe(405)
    expect((await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA/note`, { method: 'PUT' })).status).toBe(405)
    expect((await mounted.call(`${ROUTE_BASE}/writes/items/PAPERAAA/attachment`, { method: 'GET' })).status).toBe(405)
  })
})

describe('SSE /events (view intents, viewSeq state)', () => {
  it('refuses unauthenticated event streams', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake, { authenticated: false })
    const res = await mounted.call(ROUTES.events)
    expect(res.status).toBe(401)
    await mounted.close()
    await fake.close()
  })

  it('streams live intents with monotonic ids and JSON payloads', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const handler = mounted.webServer.routes[0]!.handler as (req: unknown, res: unknown) => Promise<void>
    const res = new MockResponse()
    await handler(mockRequest({ url: ROUTES.events }), res)
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/event-stream')
    expect(res.chunks[0]).toBe('retry: 3000\n\n')
    // The handler returned without ending the response (stream stays open).
    expect(res.writableEnded).toBe(false)
    mounted.session.events.publish({ kind: 'open_item', library: 'user', key: 'PAPERAAA' })
    mounted.session.events.publish({ kind: 'show_items', library: 'user', keys: ['PAPERAAA'], title: 'T' })
    const stream = res.body
    expect(stream).toContain('id: 1')
    expect(stream).toContain('id: 2')
    expect(stream).toContain('event: view')
    expect(stream).toContain('"kind":"open_item"')
    // no credentials may ride on the stream
    expect(stream).not.toMatch(/api[-_]?key|server-?id/i)
    res.emitClose()
    await mounted.close()
    await fake.close()
  })

  it('replays history after Last-Event-ID and dedupes by seq', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    mounted.session.events.publish({ kind: 'open_item', library: 'user', key: 'PAPERAAA' })
    mounted.session.events.publish({ kind: 'open_item', library: 'user', key: 'PDFATTAA' })
    const handler = mounted.webServer.routes[0]!.handler as (req: unknown, res: unknown) => Promise<void>
    const res = new MockResponse()
    await handler(mockRequest({ url: ROUTES.events, headers: { 'last-event-id': '1' } }), res)
    const stream = res.body
    expect(stream).not.toContain('id: 1\n')
    expect(stream).toContain('id: 2')
    res.emitClose()
    await mounted.close()
    await fake.close()
  })

  it('caps concurrent streams and frees the slot on close', async () => {
    const fake = await startFakeZotero()
    const mounted = await mountRoutes(fake)
    const handler = mounted.webServer.routes[0]!.handler as (req: unknown, res: unknown) => Promise<void>
    const open: MockResponse[] = []
    for (let index = 0; index < 16; index++) {
      const res = new MockResponse()
      await handler(mockRequest({ url: ROUTES.events }), res)
      open.push(res)
    }
    const overflow = await mounted.call(ROUTES.events)
    expect(overflow.status).toBe(503)
    expect((overflow.json() as { error: { code: string } }).error.code).toBe('service_unavailable')
    // Closing every stream frees capacity again.
    for (const res of open) res.emitClose()
    const again = await mounted.call(ROUTES.events)
    expect(again.status).toBe(200)
    again.emitClose()
    await mounted.close()
    await fake.close()
  })
})

describe('decodeAttachment (pure gate)', () => {
  it('decodes base64 and enforces the PDF magic', () => {
    expect(decodeAttachment(Buffer.from('%PDF-1.4').toString('base64'), 'application/pdf').ok).toBe(true)
    const bad = decodeAttachment(Buffer.from('not a pdf').toString('base64'), 'application/pdf')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('invalid_input')
  })

  it('rejects empty and oversized payloads (limit injectable for tests)', () => {
    expect(decodeAttachment('', 'application/pdf').ok).toBe(false)
    const oversized = decodeAttachment(Buffer.from('%PDF-1.4xxx').toString('base64'), 'application/pdf', 4)
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) {
      expect(oversized.status).toBe(413)
      expect(oversized.code).toBe('payload_too_large')
    }
  })

  it('keeps the production ceiling at 100 MiB', async () => {
    const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BODY_BYTES } = await import('../src/shared/protocol.ts')
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024)
    // base64 inflates by 4/3; the request ceiling leaves JSON-wrapper headroom.
    expect(MAX_ATTACHMENT_BODY_BYTES).toBeGreaterThan((MAX_ATTACHMENT_BYTES * 4) / 3)
    expect(MAX_ATTACHMENT_BODY_BYTES).toBeLessThan(MAX_ATTACHMENT_BYTES + 48 * 1024 * 1024)
  })
})
