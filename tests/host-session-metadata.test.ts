/**
 * M7 session-level import tests: `ZoteroSession.addItem` with a DOI/arXiv
 * identifier (metadata resolved through the injectable metadata fetch), the
 * DOI duplicate check (existing item reported, nothing created), the arXiv
 * open-access PDF auto-attach (three-step upload against the fake Zotero),
 * the degrade-to-warning path when the PDF download fails, and the
 * invalid-identifier zero-network guarantee. All external traffic is fake;
 * the Zotero side is the local fake server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZoteroSession } from '../src/host/session.ts'
import { ZoteroError } from '../src/domain/model.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'
import { ATOM_ENTRY, CSL_JOURNAL, PDF_BYTES } from './helpers/metadata-fixtures.ts'

/** Public documentation addresses the fake DNS resolves allowlist hosts to. */
const PUBLIC_A = '93.184.216.34'

const fakeDns = async (hostname: string) => {
  if (['doi.org', 'arxiv.org', 'export.arxiv.org', 'papers.example', 'public.example'].includes(hostname)) {
    return [{ address: PUBLIC_A, family: 4 }]
  }
  throw new Error(`NXDOMAIN ${hostname}`)
}

/**
 * Metadata fetch fake over invented fixtures:
 * - `https://doi.org/<doi>` → CSL_JOURNAL (content negotiation answered),
 * - `https://export.arxiv.org/api/query?...` → ATOM_ENTRY,
 * - arXiv/open-access PDF links → `%PDF-` bytes,
 * - everything else (counted) → 404 so failures are observable.
 */
function metadataFetchSpy() {
  const seen: string[] = []
  const fetchImpl = async (url: string): Promise<Response> => {
    seen.push(url)
    if (url.startsWith('https://doi.org/10.9999/')) {
      return new Response(JSON.stringify(CSL_JOURNAL), { status: 200, headers: { 'content-type': 'application/vnd.citationstyles.csl+json' } })
    }
    if (url.startsWith('https://export.arxiv.org/api/query?')) return new Response(ATOM_ENTRY, { status: 200 })
    if (url.startsWith('https://arxiv.org/pdf/')) return new Response(PDF_BYTES() as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf' } })
    return new Response('no such fake host', { status: 404 })
  }
  return { seen, fetchImpl }
}

describe('ZoteroSession.addItem (M7 identifier import)', () => {
  let fake: FakeZotero
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
  })
  afterAll(async () => {
    await fake.close()
  })

  it('imports a DOI: CSL-JSON → item with tags/collections merged and the panel intent published', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    const before = fake.state.items.size
    const result = await session.addItem('user', {
      identifier: '10.9999/fake.2021.031',
      collections: ['CLTYAAAA'],
      tags: ['imported'],
    })
    expect(result.source).toBe('doi.org (10.9999/fake.2021.031)')
    expect(result.warnings).toEqual([])
    const created = fake.state.items.get(result.key)
    expect(created).toBeDefined()
    expect(created?.data.itemType).toBe('journalArticle')
    expect(created?.data.title).toBe('Containment Hierarchies for Test Fixtures')
    expect(created?.data.DOI).toBe('10.9999/fake.2021.031')
    expect(created?.data.publicationTitle).toBe('Journal of Imaginary Systems')
    expect(created?.data.date).toBe('2021-03-14')
    expect(created?.data.collections).toEqual(['CLTYAAAA'])
    expect((created?.data.tags as { tag: string }[]).map((entry) => entry.tag)).toEqual(['imported'])
    expect(fake.state.items.size).toBe(before + 1)
    // The metadata came from the fake doi.org and nothing else was contacted.
    expect(net.seen).toEqual(['https://doi.org/10.9999/fake.2021.031'])
    // The panel was told to open the fresh item.
    const events = session.events.replaySince(0)
    expect(events.at(-1)?.intent).toMatchObject({ kind: 'open_item', library: 'user', key: result.key })
    await session.dispose()
  })

  it('reports a duplicate DOI instead of creating a second copy', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    // The DOI from the previous test is now in the fake library.
    const before = fake.state.items.size
    const result = await session.addItem('user', { identifier: '10.9999/fake.2021.031' })
    expect(result.duplicate).toBeTruthy()
    expect(result.warnings[0]).toContain(`Already in the library as ${result.duplicate}`)
    expect(fake.state.items.size).toBe(before)
    // The DOI dedup query is read-only: no item POST happened.
    const writes = fake.state.requests.filter((entry) => entry.startsWith('POST /api/store/items')).length
    await session.addItem('user', { identifier: '10.9999/fake.2021.031' })
    expect(fake.state.requests.filter((entry) => entry.startsWith('POST /api/store/items')).length).toBe(writes)
    await session.dispose()
  })

  it('reports a duplicate DOI even when a mere mention sorts before it', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    // Fresh DOI so nothing else in the library carries it yet (the shared CSL
    // fixture always answers the same DOI, so it is overridden explicitly).
    const created = await session.addItem('user', {
      identifier: '10.9999/fake.2019.777',
      metadata: { DOI: '10.9999/fake.2019.777' },
    })
    expect(created.duplicate).toBeUndefined()
    // A decoy that only MENTIONS the DOI in its title: it matches the dedup
    // query but has no DOI/extra hit. Touching bumps its dateModified so it
    // sorts BEFORE the real DOI holder — the old first-candidate-only check
    // would have missed the duplicate and created a second item.
    fake.touch('TAPLBKAA', { title: 'Commentary on 10.9999/fake.2019.777' })
    const before = fake.state.items.size
    const result = await session.addItem('user', {
      identifier: '10.9999/fake.2019.777',
      metadata: { DOI: '10.9999/fake.2019.777' },
    })
    expect(result.duplicate).toBe(created.key)
    expect(result.key).toBe(created.key)
    expect(result.warnings[0]).toContain(`Already in the library as ${created.key}`)
    expect(fake.state.items.size).toBe(before)
    await session.dispose()
  })

  it('imports an arXiv id with the open-access PDF auto-attached', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    const before = fake.state.items.size
    const result = await session.addItem('user', { identifier: '2401.01234' })
    expect(result.source).toBe('arXiv 2401.01234')
    expect(result.attachmentKey).toBeTruthy()
    const item = fake.state.items.get(result.key)
    expect(item?.data.itemType).toBe('preprint')
    expect(item?.data.archiveID).toBe('arXiv:2401.01234')
    // Attachment exists as a stored PDF child.
    const attachment = fake.state.items.get(result.attachmentKey!)
    expect(attachment?.data.itemType).toBe('attachment')
    expect(attachment?.data.contentType).toBe('application/pdf')
    expect(attachment?.data.parentItem).toBe(result.key)
    expect(fake.state.items.size).toBe(before + 2)
    // Exactly the two allowlist requests: Atom metadata + PDF download.
    expect(net.seen).toEqual(['https://export.arxiv.org/api/query?id_list=2401.01234', 'https://arxiv.org/pdf/2401.01234v2'])
    await session.dispose()
  })

  it('degrades a failed PDF download to a warning and still creates the item', async () => {
    // Metadata answers normally, but the PDF link serves an HTML landing page
    // (login wall) instead of PDF bytes.
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith('https://export.arxiv.org/api/query?')) return new Response(ATOM_ENTRY, { status: 200 })
      return new Response('<html>log in to download</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: fetchImpl, metadataLookup: fakeDns })
    const before = fake.state.items.size
    // A fresh arXiv id so the DOI duplicate check does not short-circuit.
    const result = await session.addItem('user', { identifier: '2401.05678', attachPdf: true })
    expect(result.attachmentKey).toBeUndefined()
    expect(result.warnings.join('\n')).toMatch(/PDF was not attached/)
    expect(fake.state.items.size).toBe(before + 1)
    expect([...fake.state.items.values()].some((item) => item.data.parentItem === result.key && item.data.itemType === 'attachment')).toBe(false)
    await session.dispose()
  })

  it('refuses unparseable identifiers with zero network and zero writes', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    const before = fake.state.items.size
    const requestsBefore = fake.state.requests.length
    await expect(session.addItem('user', { identifier: 'not an identifier' })).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<ZoteroError>)
    expect(net.seen).toEqual([])
    expect(fake.state.items.size).toBe(before)
    expect(fake.state.requests.slice(requestsBefore).some((entry) => entry.startsWith('POST'))).toBe(false)
    await session.dispose()
  })

  it('maps a malformed percent-encoded DOI to invalid_input, never a raw URIError', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    // `10.9999/fake%zz` matches the DOI grammar but cannot be percent-decoded:
    // the session must answer the domain error (routes map it to 400), not
    // leak a URIError (which would surface as 500 internal).
    await expect(session.addItem('user', { identifier: '10.9999/fake%zz' })).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<ZoteroError>)
    expect(net.seen).toEqual([])
    await session.dispose()
  })

  it('structured fields override fetched metadata when both are given', async () => {
    const net = metadataFetchSpy()
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url }, metadataFetch: net.fetchImpl, metadataLookup: fakeDns })
    // A DOI not already in the library, so the duplicate check does not
    // short-circuit this call into an existing item.
    const result = await session.addItem('user', {
      identifier: '10.9999/fake.2021.031',
      metadata: { title: 'Overridden Title', DOI: '10.9999/override.2024.1' },
    })
    expect(result.duplicate).toBeUndefined()
    expect(fake.state.items.get(result.key)?.data.title).toBe('Overridden Title')
    expect(fake.state.items.get(result.key)?.data.DOI).toBe('10.9999/override.2024.1')
    await session.dispose()
  })
})
