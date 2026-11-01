/**
 * Agent tool tests: registration shape, argument validation, the read/view
 * tools against a fake Zotero, and the write tools' three approval paths
 * (allowed → executed, denied → not executed, Zotero denial → terminated
 * without retry) per ADR 0003.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REGISTERED_TOOL_NAMES, DEFERRED_TOOL_NAMES, buildToolDefinitions, registerTools, type ToolDeps } from '../src/tools/index.ts'
import { requestWriteApproval } from '../src/tools/approval.ts'
import type { ToolDefinition } from '../src/tools/define-tool.ts'
import type { ApprovalFace } from '../src/host/services.ts'
import { ZoteroSession } from '../src/host/session.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'

/** Fake approval seam recording every ask. */
function fakeApproval(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'throw'): ApprovalFace & { asks: { toolName: string; agent?: unknown; reason?: string }[] } {
  const asks: { toolName: string; agent?: unknown; reason?: string }[] = []
  return {
    get asks() {
      return asks
    },
    async request(req) {
      asks.push({ toolName: req.toolName, ...(req.agent !== undefined ? { agent: req.agent } : {}), ...(req.reason !== undefined ? { reason: req.reason } : {}) })
      if (outcome === 'throw') throw new Error('approval seam exploded')
      return outcome
    },
  }
}

const AGENT = { kind: 'agent', id: 'test-agent' } as unknown

describe('registration shape', () => {
  it('declares no deferred or destructive tools', () => {
    const names: readonly string[] = REGISTERED_TOOL_NAMES
    for (const deferred of DEFERRED_TOOL_NAMES as readonly string[]) {
      expect(names).not.toContain(deferred)
    }
    expect(names).not.toContain('delete_items')
    expect(names).not.toContain('deleteItems')
  })
})

describe('read and view tools (fake Zotero)', () => {
  let fake: FakeZotero
  beforeAll(async () => {
    fake = await startFakeZotero()
  })
  afterAll(async () => {
    await fake.close()
  })

  it('covers listing, search, detail, annotations, cite and export end-to-end', async () => {
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    const tools = new Map(buildToolDefinitions({ session }).map((definition) => [definition.name, definition]))
    // Registration shape: the registered names equal the declared contract.
    expect([...tools.keys()].sort()).toEqual([...REGISTERED_TOOL_NAMES].slice().sort())

    const collections = (await tools.get('list_collections')!.execute({}, exec())) as { collections: { key: string; name: string }[]; searches: { key: string }[] }
    expect(collections.collections.some((collection) => collection.name === 'Type Systems')).toBe(true)
    expect(collections.searches).toHaveLength(1)
    expect(tools.get('list_collections')!.output.render({}, collections)[0]).toMatchObject({ type: 'text' })

    const search = (await tools.get('search_library')!.execute({ q: 'types', limit: 5 }, exec())) as { total: number; items: { key: string; pdfKey: string | null }[] }
    expect(search.total).toBeGreaterThanOrEqual(2)
    expect(search.items.some((item) => item.key === 'TAPLBKAA')).toBe(true)

    const fulltext = (await tools.get('search_library')!.execute({ q: 'storage modes', mode: 'everything' }, exec())) as { total: number }
    expect(fulltext.total).toBeGreaterThanOrEqual(1)

    const detail = (await tools.get('get_item')!.execute({ key: 'PAPERAAA' }, exec())) as { title: string; creators: string[]; pdfKey: string | null; itemVersion: number }
    expect(detail.title).toContain('Second-Class Values')
    expect(detail.creators).toHaveLength(3)
    expect(detail.pdfKey).toBe('PDFATTAA')
    expect(detail.itemVersion).toBeGreaterThan(0)

    const annotations = (await tools.get('search_annotations')!.execute({ item: 'PAPERAAA', query: 'STORAGE' }, exec())) as { attachment: string | null; total: number; annotations: { text: string }[] }
    expect(annotations.attachment).toBe('PDFATTAA')
    expect(annotations.total).toBe(1)
    expect(annotations.annotations[0]?.text).toContain('storage modes')

    const tagged = (await tools.get('search_annotations')!.execute({ item: 'PAPERAAA', tag: 'important' }, exec())) as { total: number }
    expect(tagged.total).toBe(1)
    const noTag = (await tools.get('search_annotations')!.execute({ item: 'PAPERAAA', tag: 'other' }, exec())) as { total: number }
    expect(noTag.total).toBe(0)
    const noPdf = (await tools.get('search_annotations')!.execute({ item: 'TAPLBKAA' }, exec())) as { attachment: string | null; total: number }
    expect(noPdf).toEqual({ item: 'TAPLBKAA', attachment: null, total: 0, annotations: [] })

    const apa = (await tools.get('cite')!.execute({ key: 'PAPERAAA' }, exec())) as { format: string; citation: string }
    expect(apa.format).toBe('apa')
    expect(apa.citation).toContain('Lovelace, A.')
    expect(apa.citation).toContain('(2022)')
    expect(apa.citation).toContain('https://doi.org/10.1234/stack.2022.15')
    const bibtex = (await tools.get('cite')!.execute({ key: 'PAPERAAA', format: 'bibtex' }, exec())) as { citation: string }
    expect(bibtex.citation).toMatch(/^@article\{PAPERAAA,/)
    expect(bibtex.citation).toContain('Lovelace, Ada and Turing, Alan')

    const exported = (await tools.get('export_bib')!.execute({ keys: ['PAPERAAA'] }, exec())) as { format: string; text: string }
    expect(exported.format).toBe('bibtex')
    expect(exported.text).toContain('@article{PAPERAAA')
    expect(exported.text).not.toContain('/storage/')

    // open_item / show_items publish into the event hub with growing seq.
    const open = (await tools.get('open_item')!.execute({ key: 'PAPERAAA', page: 2 }, exec())) as { delivered: boolean; seq: number; page: number | null }
    expect(open.delivered).toBe(true)
    expect(open.page).toBe(2)
    const show = (await tools.get('show_items')!.execute({ keys: ['PAPERAAA', 'PREPRAAA'], title: 'Matches' }, exec())) as { delivered: boolean; seq: number }
    expect(show.seq).toBe(open.seq + 1)
    const events = session.events.replaySince(0)
    expect(events).toHaveLength(2)
    expect(events[0]?.intent).toEqual({ kind: 'open_item', library: 'user', key: 'PAPERAAA', attachmentKey: 'PDFATTAA', page: 2 })

    await session.dispose()
  })

  it('validates arguments before the body runs (ToolArgsError)', async () => {
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    const definitions = buildToolDefinitions({ session })
    const tools = new Map(definitions.map((definition) => [definition.name, definition]))
    await expect(tools.get('search_annotations')!.execute({}, exec())).rejects.toMatchObject({ name: 'ToolArgsError' })
    await expect(tools.get('get_item')!.execute({}, exec())).rejects.toMatchObject({ name: 'ToolArgsError' })
    await expect(tools.get('search_library')!.execute({ mode: 'bananas' }, exec())).rejects.toMatchObject({ name: 'ToolArgsError' })
    // A string key of the wrong shape passes the schema and is rejected by the
    // data layer's own key grammar (ZoteroError, not ToolArgsError).
    await expect(tools.get('get_item')!.execute({ key: 'short' }, exec())).rejects.toMatchObject({ name: 'ZoteroError' })
    await session.dispose()
  })

  it('declares concurrency: reads safe, writes exclusive', () => {
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    for (const definition of buildToolDefinitions({ session })) {
      const write = ['add_item', 'update_item', 'add_note', 'create_collection', 'authorize_writes', 'attach_pdf', 'highlight', 'save_highlights'].includes(definition.name)
      if (write) {
        expect(definition.isConcurrencySafe?.({}), `${definition.name} must not be concurrency-safe`).toBe(false)
      } else {
        expect(definition.isConcurrencySafe?.({}), `${definition.name} may be concurrency-safe`).toBe(true)
      }
    }
    void session.dispose()
  })
})

describe('PDF tools (M4: full text, find, highlight, save approvals)', () => {
  let fake: FakeZotero
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
  })
  afterAll(async () => {
    await fake.close()
  })

  async function pdfTools(approval?: ApprovalFace) {
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    const tools = new Map(buildToolDefinitions({ session, ...(approval !== undefined ? { approval } : {}) }).map((definition) => [definition.name, definition]))
    return { session, tools }
  }

  it('read_fulltext returns page markers, printed labels and the scanned hint', async () => {
    const { session, tools } = await pdfTools()
    const full = (await tools.get('read_fulltext')!.execute({ key: 'PAPERAAA' }, exec())) as { text: string; pageCount: number; lastPage: number }
    expect(full.text).toContain('"Second-Class Values Revisited" [PAPERAAA], PDF PDFATTAA, 3 pages.')
    expect(full.text).toContain('--- page 1 (printed i) ---')
    // Physical page 2 carries printed label "1" (front matter is roman).
    expect(full.text).toContain('--- page 2 (printed 1) ---')
    expect(full.text).toContain('type system that tracks storage modes')
    expect(full.lastPage).toBe(3)
    expect(full.text).not.toContain('scanned')
    await session.dispose()
  }, 30_000)

  it('read_fulltext honors page ranges, budgets and the continuation hint', async () => {
    const { session, tools } = await pdfTools()
    const ranged = (await tools.get('read_fulltext')!.execute({ key: 'PAPERAAA', pages: '3' }, exec())) as { text: string }
    expect(ranged.text).toContain('--- page 3 (printed 2) ---')
    expect(ranged.text).toContain('Evaluation')
    expect(ranged.text).not.toContain('page 1')
    const budget = (await tools.get('read_fulltext')!.execute({ key: 'PAPERAAA', pages: '2-3', maxChars: 1000 }, exec())) as { text: string }
    if (budget.lastPage < 3) expect(budget.text).toMatch(/Continue with pages: "3-3"/)
    const scanned = (await tools.get('read_fulltext')!.execute({ key: 'SCNPDAAA' }, exec())) as { text: string }
    expect(scanned.text).toContain('no text on this page')
    expect(scanned.text).toContain('This PDF has no text layer (scanned)')
    await expect(tools.get('read_fulltext')!.execute({ key: 'PAPERAAA', pages: 'banana' }, exec())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(tools.get('read_fulltext')!.execute({ key: 'TAPLBKAA' }, exec())).rejects.toMatchObject({ code: 'not_pdf' })
    await session.dispose()
  }, 60_000)

  it('find_in_pdf locates phrases with pages and snippets; open_item quote targeting', async () => {
    const { session, tools } = await pdfTools()
    const found = (await tools.get('find_in_pdf')!.execute({ key: 'PAPERAAA', query: 'delayed popping' }, exec())) as { matches: { page: number; label: string; snippet: string }[] }
    expect(found.matches).toHaveLength(1)
    expect(found.matches[0]!.page).toBe(2)
    expect(found.matches[0]!.label).toBe('1')
    expect(found.matches[0]!.snippet).toContain('«')
    const none = (await tools.get('find_in_pdf')!.execute({ key: 'PAPERAAA', query: 'quantum chromodynamics' }, exec())) as { matches: unknown[] }
    expect(none.matches).toHaveLength(0)
    await expect(tools.get('find_in_pdf')!.execute({ key: 'PAPERAAA', query: 'x' }, exec())).rejects.toMatchObject({ code: 'invalid_input' })

    const seqBefore = session.events.currentSeq
    const opened = (await tools.get('open_item')!.execute({ key: 'PAPERAAA', quote: 'delayed popping' }, exec())) as { page: number; seq: number }
    expect(opened.page).toBe(2)
    const events = session.events.replaySince(seqBefore)
    expect(events[0]?.intent).toEqual({ kind: 'open_item', library: 'user', key: 'PAPERAAA', attachmentKey: 'PDFATTAA', page: 2 })
    await expect(tools.get('open_item')!.execute({ key: 'PAPERAAA', quote: 'quantum chromodynamics' }, exec())).rejects.toMatchObject({ code: 'quote_not_found' })
    await expect(tools.get('open_item')!.execute({ key: 'PAPERAAA', page: 99 }, exec())).rejects.toMatchObject({ code: 'invalid_input' })
    await session.dispose()
  }, 60_000)

  it('highlight creates a session highlight with rects; quote_not_found otherwise', async () => {
    const { session, tools } = await pdfTools()
    const seqBefore = session.events.currentSeq
    const created = (await tools.get('highlight')!.execute({ key: 'PAPERAAA', quote: 'delayed popping' }, exec())) as {
      highlight: { id: string; page: number; pageLabel: string; attachmentKey: string; savedAs: string | null }
      exact: string
    }
    expect(created.highlight.id).toBe('h1')
    expect(created.highlight.page).toBe(2)
    expect(created.highlight.pageLabel).toBe('1')
    expect(created.highlight.savedAs).toBeNull()
    expect(created.exact).toContain('delayed popping')
    // open (default) pushed an open_item intent to the reader at the highlight page.
    const events = session.events.replaySince(seqBefore)
    expect(events.at(-1)?.intent).toMatchObject({ kind: 'open_item', attachmentKey: 'PDFATTAA', page: 2 })
    // Session state visible through find/clear.
    const found = session.findHighlights(undefined, 'PDFATTAA')
    expect(found).toHaveLength(1)
    expect(found[0]!.rects.length).toBeGreaterThan(0)
    const cleared = (await tools.get('clear_highlights')!.execute({ ids: ['h1'] }, exec())) as { removed: number }
    expect(cleared.removed).toBe(1)
    expect(session.highlights.all()).toHaveLength(0)
    await expect(tools.get('highlight')!.execute({ key: 'PAPERAAA', quote: 'quantum chromodynamics' }, exec())).rejects.toMatchObject({ code: 'quote_not_found' })
    await expect(tools.get('clear_highlights')!.execute({ ids: ['h1'] }, exec())).rejects.toMatchObject({ code: 'not_found' })
    await session.dispose()
  }, 60_000)

  it('save_highlights approval paths: allowed → annotation written; denied → nothing; Zotero denial → terminates', async () => {
    // Allowed: highlight created without approval (session state), saved with approval.
    const approval = fakeApproval('allowed-once')
    const { session, tools } = await pdfTools(approval)
    await tools.get('highlight')!.execute({ key: 'PAPERAAA', quote: 'type system', open: false }, exec())
    const before = fake.state.items.size
    const saved = (await tools.get('save_highlights')!.execute({}, exec())) as { saved: { id: string; key: string }[] }
    expect(saved.saved).toHaveLength(1)
    expect(fake.state.items.size).toBe(before + 1)
    const annotation = fake.state.items.get(saved.saved[0]!.key)!.data
    expect(annotation.annotationType).toBe('highlight')
    expect(approval.asks.map((ask) => ask.toolName)).toEqual(['save_highlights'])
    await session.dispose()

    // Denied: the highlight stays session-only, no Zotero write.
    const denied = fakeApproval('rejected')
    const session2 = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    const tools2 = new Map(buildToolDefinitions({ session: session2, approval: denied }).map((definition) => [definition.name, definition]))
    await tools2.get('highlight')!.execute({ key: 'PAPERAAA', quote: 'storage modes', open: false }, exec())
    const before2 = fake.state.items.size
    await expect(tools2.get('save_highlights')!.execute({}, exec())).rejects.toThrowError(/not approved/)
    expect(fake.state.items.size).toBe(before2)
    await session2.dispose()

    // Zotero denial after an approved ask: write_denied, no retry.
    fake.setAuthorizeMode('deny')
    const session3 = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    const tools3 = new Map(buildToolDefinitions({ session: session3, approval: fakeApproval('allowed-once') }).map((definition) => [definition.name, definition]))
    await tools3.get('highlight')!.execute({ key: 'PAPERAAA', quote: 'stack frame', open: false }, exec())
    await expect(tools3.get('save_highlights')!.execute({}, exec())).rejects.toMatchObject({ code: 'write_denied' })
    fake.setAuthorizeMode('always')
    await session3.dispose()
  }, 90_000)

  it('highlight save:true asks once and writes the annotation (approved)', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = await pdfTools(approval)
    const result = (await tools.get('highlight')!.execute({ key: 'PAPERAAA', quote: 'GC pressure', save: true, open: false }, exec())) as {
      highlight: { savedAs: string | null }
    }
    expect(result.highlight.savedAs).toBeTruthy()
    expect(approval.asks.map((ask) => ask.toolName)).toEqual(['highlight'])
    await session.dispose()
  }, 60_000)
})

describe('write tools: the three approval paths (ADR 0003)', () => {
  let fake: FakeZotero
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
  })
  afterAll(async () => {
    await fake.close()
  })

  async function mountedTools(approval?: ApprovalFace) {
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    return { session, tools: new Map(buildToolDefinitions({ session, ...(approval !== undefined ? { approval } : {}) }).map((definition) => [definition.name, definition])) }
  }

  it('allowed-once → the write executes and the ask was audited with the agent', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = await mountedTools(approval)
    const before = fake.state.items.size
    const result = (await tools.get('add_item')!.execute({ itemType: 'journalArticle', fields: { title: 'Approved Item' } }, exec())) as { key: string }
    expect(result.key).toBeTruthy()
    expect(fake.state.items.size).toBe(before + 1)
    expect(approval.asks).toHaveLength(1)
    expect(approval.asks[0]?.toolName).toBe('add_item')
    expect(approval.asks[0]?.agent).toBe(AGENT)
    await session.dispose()
  })

  it('rejected → the tool body never runs and nothing is written', async () => {
    const approval = fakeApproval('rejected')
    const { session, tools } = await mountedTools(approval)
    const before = fake.state.items.size
    const requestsBefore = fake.state.requests.length
    await expect(tools.get('add_item')!.execute({ itemType: 'journalArticle', fields: { title: 'Denied Item' } }, exec())).rejects.toThrowError(/not approved.*rejected/)
    expect(fake.state.items.size).toBe(before)
    // No Zotero write traffic at all (only probe reads may appear).
    expect(fake.state.requests.slice(requestsBefore).some((entry) => entry.startsWith('POST /api/users/0/items') || entry.startsWith('PATCH'))).toBe(false)
    await session.dispose()
  })

  it('cancelled and unavailable outcomes also fail closed', async () => {
    for (const outcome of ['cancelled', 'unavailable'] as const) {
      const approval = fakeApproval(outcome)
      const { session, tools } = await mountedTools(approval)
      await expect(tools.get('create_collection')!.execute({ name: 'Never' }, exec())).rejects.toThrowError(new RegExp(outcome))
      expect(fake.state.collections.size).toBeLessThan(999)
      await session.dispose()
    }
  })

  it('no approval seam → fail closed (unavailable)', async () => {
    const { session, tools } = await mountedTools(undefined)
    await expect(tools.get('add_note')!.execute({ item: 'PAPERAAA', html: '<p>x</p>' }, exec())).rejects.toThrowError(/unavailable/)
    await session.dispose()
  })

  it('no agent on the execution → fail closed (official agent-less degrade)', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = await mountedTools(approval)
    // Valid args (pure shape validation passes) so the failure comes from the
    // approval gate itself: without an agent the official approval service
    // answers `unavailable` and the tool fails closed before any network.
    await expect(tools.get('add_item')!.execute({ itemType: 'journalArticle', fields: { title: 'X' } }, { callId: 'c1' })).rejects.toThrowError(/unavailable/)
    expect(approval.asks).toHaveLength(0)
    await session.dispose()
  })

  it('approval seam throwing → fail closed', async () => {
    const approval = fakeApproval('throw')
    const { session, tools } = await mountedTools(approval)
    await expect(tools.get('update_item')!.execute({ key: 'PAPERAAA', fields: { title: 'X' } }, exec())).rejects.toThrowError(/unavailable/)
    await session.dispose()
  })

  it('Zotero denial after an approved ask → terminates with write_denied and does not retry', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = await mountedTools(approval)
    fake.setAuthorizeMode('deny')
    const asksBefore = approval.asks.length
    const authorizeRequestsBefore = fake.state.authorizeRequests
    await expect(tools.get('authorize_writes')!.execute({}, exec())).rejects.toThrowError(/denied/)
    expect(fake.state.authorizeRequests).toBe(authorizeRequestsBefore + 1) // exactly one dialog, no retry
    expect(approval.asks.length).toBe(asksBefore + 1)
    fake.setAuthorizeMode('always')
    await session.dispose()
  })

  it('attach_pdf: inline bytes work, path mode reads only after the approved ask', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = await mountedTools(approval)
    const bytes = Buffer.from('%PDF-1.4 attach fixture')
    const result = (await tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', bytesBase64: bytes.toString('base64'), filename: 'fixture.pdf' }, exec())) as { key: string }
    expect(result.key).toBeTruthy()
    expect(fake.state.items.get(result.key)?.data.filename).toBe('fixture.pdf')

    // Pure argument-shape errors fail fast BEFORE the approval ask (a
    // malformed call never bothers the user); everything that touches the
    // network, the filesystem or the bytes happens after the approved ask.
    const requestsBefore = fake.state.requests.length
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA' }, exec())).rejects.toThrowError(/exactly one/)
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', bytesBase64: Buffer.from('nope').toString('base64') }, exec())).rejects.toThrowError(/%PDF-/)
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', path: '/definitely/not/here.pdf' }, exec())).rejects.toThrowError(/No readable file/)
    expect(approval.asks.filter((ask) => ask.toolName === 'attach_pdf').length).toBe(3)
    // The rejected 'nope'/'missing path' calls wrote nothing to Zotero.
    expect(fake.state.requests.slice(requestsBefore).filter((entry) => entry.startsWith('POST /api/store/items')).length).toBe(0)
    await session.dispose()
  })
})

describe('M7 network writes: approval order and SSRF guard at the tool seam', () => {
  let fake: FakeZotero
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
  })
  afterAll(async () => {
    await fake.close()
  })

  /** Public documentation address the fake DNS hands out for allowlist hosts. */
  const PUBLIC_A = '93.184.216.34'
  const fakeDns = async (hostname: string) => {
    if (['public.example', 'papers.example'].includes(hostname)) return [{ address: PUBLIC_A, family: 4 }]
    throw new Error(`NXDOMAIN ${hostname}`)
  }
  const PDF = Buffer.from('%PDF-1.4 url attach fixture\n')
  const pdfResponse = () => new Response(PDF as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf' } })

  function mountedSession(approval: ApprovalFace, fetchImpl: (url: string) => Promise<Response>) {
    const metadataRequests: string[] = []
    const session = new ZoteroSession({
      baseUrl: { get: () => fake.url },
      metadataFetch: async (url: string) => {
        metadataRequests.push(url)
        return fetchImpl(url)
      },
      metadataLookup: fakeDns,
    })
    const tools = new Map(buildToolDefinitions({ session, approval }).map((definition) => [definition.name, definition]))
    return { session, tools, metadataRequests }
  }

  it('add_item with an identifier asks BEFORE any external network: a rejection means zero requests anywhere', async () => {
    const approval = fakeApproval('rejected')
    const { session, tools, metadataRequests } = mountedSession(approval, async () => {
      throw new Error('external network must never be reached')
    })
    const requestsBefore = fake.state.requests.length
    const before = fake.state.items.size
    await expect(
      tools.get('add_item')!.execute({ identifier: '10.9999/fake.2021.031', collections: ['CLTYAAAA'], tags: ['x'] }, exec()),
    ).rejects.toThrowError(/not approved/)
    // The DOI metadata fetch, DNS resolution and any Zotero write all stay
    // untouched when the user declines the DSH approval card.
    expect(metadataRequests).toEqual([])
    expect(fake.state.items.size).toBe(before)
    expect(fake.state.requests.slice(requestsBefore).some((entry) => entry.startsWith('POST'))).toBe(false)
    await session.dispose()
  })

  it('attach_pdf url mode: the loopback Zotero API itself is refused as a non-public host', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools, metadataRequests } = mountedSession(approval, async () => pdfResponse())
    const before = fake.state.items.size
    // The fake Zotero's own loopback URL — the canonical SSRF target.
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', url: `${fake.url}/api/users/0/items` }, exec())).rejects.toMatchObject({
      code: 'download_failed',
    })
    expect(metadataRequests).toEqual([]) // guard refuses before any fetch
    expect(fake.state.items.size).toBe(before)
    await session.dispose()
  })

  it('attach_pdf url mode: a redirect to a private address is refused without connecting (per-hop re-validation)', async () => {
    const approval = fakeApproval('allowed-once')
    const hops: string[] = []
    const { session, tools } = mountedSession(approval, async (url) => {
      hops.push(url)
      if (url === 'https://public.example/redirect') return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      return pdfResponse()
    })
    const before = fake.state.items.size
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', url: 'https://public.example/redirect' }, exec())).rejects.toThrowError(/non-public/)
    expect(hops).toEqual(['https://public.example/redirect'])
    expect(fake.state.items.size).toBe(before)
    await session.dispose()
  })

  it('attach_pdf url mode: a public PDF downloads through the guard and is attached', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools, metadataRequests } = mountedSession(approval, async () => pdfResponse())
    const result = (await tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', url: 'https://papers.example/doc.pdf', title: 'Fetched PDF' }, exec())) as { key: string }
    expect(result.key).toBeTruthy()
    const attachment = fake.state.items.get(result.key)
    expect(attachment?.data.contentType).toBe('application/pdf')
    expect(attachment?.data.title).toBe('Fetched PDF')
    expect(metadataRequests).toEqual(['https://papers.example/doc.pdf'])
    await session.dispose()
  })

  it('attach_pdf url mode: a declined approval downloads nothing', async () => {
    const approval = fakeApproval('rejected')
    const { session, tools, metadataRequests } = mountedSession(approval, async () => pdfResponse())
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', url: 'https://papers.example/doc.pdf' }, exec())).rejects.toThrowError(/not approved/)
    expect(metadataRequests).toEqual([])
    await session.dispose()
  })
})

describe('approval wrapper (pure seam)', () => {
  it('maps outcomes exactly and forwards agent/tool/callId/reason/signal', async () => {
    const seen: unknown[] = []
    const approval: ApprovalFace = {
      async request(req) {
        seen.push(req)
        return 'allowed-once'
      },
    }
    const signal = new AbortController().signal
    const ok = await requestWriteApproval(approval, { agent: AGENT, toolName: 'add_item', callId: 'call-1', reason: 'because', signal })
    expect(ok).toEqual({ approved: true, outcome: 'allowed-once' })
    expect(seen[0]).toMatchObject({ agent: AGENT, toolName: 'add_item', callId: 'call-1', reason: 'because', signal })

    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      const result = await requestWriteApproval({ request: () => Promise.resolve(outcome) }, { agent: AGENT, toolName: 'x', reason: 'r' })
      expect(result).toEqual({ approved: false, outcome })
    }
    expect(await requestWriteApproval(undefined, { agent: AGENT, toolName: 'x', reason: 'r' })).toEqual({ approved: false, outcome: 'unavailable' })
    expect(await requestWriteApproval(approval, { toolName: 'x', reason: 'r' })).toEqual({ approved: false, outcome: 'unavailable' })
  })
})

describe('registerTools on the runtime seam', () => {
  it('registers every definition and the disposer removes them', async () => {
    const session = new ZoteroSession({ baseUrl: { get: () => 'http://127.0.0.1:23119' } })
    const registered: string[] = []
    const tools = {
      register(definition: Record<string, unknown>) {
        registered.push(String(definition.name))
        return () => {
          registered.splice(registered.indexOf(String(definition.name)), 1)
        }
      },
    }
    const dispose = registerTools(tools, { session })
    expect(registered.sort()).toEqual([...REGISTERED_TOOL_NAMES].slice().sort())
    dispose()
    expect(registered).toEqual([])
    session.dispose()
  })
})

/** Execution identity standing in for the registry's ToolRunContext. */
function exec() {
  return { agent: AGENT, callId: `call-${Math.random().toString(16).slice(2)}`, signal: undefined }
}
