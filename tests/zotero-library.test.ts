import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZoteroError } from '../src/domain/model.ts'
import { ZoteroLocalClient } from '../src/zotero/client.ts'
import { ZoteroLibrary } from '../src/zotero/library.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'

let fake: FakeZotero
let client: ZoteroLocalClient
let library: ZoteroLibrary

beforeEach(async () => {
  fake = await startFakeZotero()
  client = new ZoteroLocalClient({ baseUrl: fake.url })
  library = new ZoteroLibrary(client)
})

afterEach(async () => {
  await fake.close()
})

function lastRequest(): string {
  return fake.state.requests[fake.state.requests.length - 1]!
}

/** Recorded request line minus the HTTP method prefix. */
function lastPath(): string {
  return lastRequest().replace(/^[A-Z]+ /, '')
}

function errorOf(promise: Promise<unknown>): Promise<ZoteroError> {
  return promise.then(
    (value) => {
      throw new Error(`expected rejection, got ${JSON.stringify(value)}`)
    },
    (error: ZoteroError) => error,
  )
}

describe('libraries', () => {
  it('lists the personal library first, then groups with editability', async () => {
    const libraries = await library.libraries()
    expect(libraries[0]).toMatchObject({ id: 'user', name: 'My Library', type: 'user', editable: true })
    expect(libraries[1]).toMatchObject({ id: 'g88', name: 'Lab Group', type: 'group', editable: true })
    expect(libraries[2]).toMatchObject({ id: 'g99', name: 'Announcements', type: 'group', editable: false })
  })
})

describe('collections', () => {
  it('builds the tree with counts and saved searches', async () => {
    const doc = await library.collections('user')
    expect(doc.library).toBe('user')
    expect(doc.version).toBeGreaterThan(0)
    const types = doc.collections.find((node) => node.key === 'CLTYAAAA')
    expect(types).toMatchObject({ name: 'Type Systems', parent: 'CLPLAAAA' })
    expect(types!.numItems).toBe(2) // paper + preprint
    const empty = doc.collections.find((node) => node.key === 'CLEMAAAA')
    expect(empty!.numItems).toBe(0)
    expect(doc.searches).toEqual([{ key: 'SRCHAAAA', name: 'Stack papers' }])
  })

  it('caches the doc per library version (second call issues no HTTP)', async () => {
    await library.collections('user')
    const readsBefore = fake.state.requests.filter((line) => line.includes('/collections')).length
    await library.collections('user')
    expect(fake.state.requests.filter((line) => line.includes('/collections')).length).toBe(readsBefore)
  })

  it('revalidates after the library changes (304 path, then re-read)', async () => {
    await library.collections('user')
    const readsBefore = fake.state.requests.filter((line) => line.includes('GET /api/users/0/collections')).length
    // Simulate the user editing in Zotero: version bumps, 304 no longer matches.
    fake.touch('PAPERAAA', { title: 'Second-Class Values Revisited (v2)' })
    const doc = await library.collections('user')
    expect(fake.state.requests.filter((line) => line.includes('GET /api/users/0/collections')).length).toBe(readsBefore + 1)
    expect(doc.version).toBeGreaterThanOrEqual(1)
    expect(doc.collections.find((node) => node.key === 'CLTYAAAA')!.numItems).toBe(2)
  })
})

describe('items: URL contract', () => {
  it('maps a metadata search onto /items/top with q/qmode/sort/start/limit', async () => {
    await library.items('user', { q: 'stack modes', sort: 'title', direction: 'asc', start: 25, limit: 10 })
    expect(lastPath()).toBe('/api/users/0/items/top?q=stack+modes&qmode=titleCreatorYear&sort=title&direction=asc&start=25&limit=10')
  })

  it('emits qmode=everything for full-text search', async () => {
    await library.items('user', { q: 'storage modes', mode: 'everything' })
    expect(lastPath()).toBe('/api/users/0/items/top?q=storage+modes&qmode=everything&sort=dateModified&direction=desc&start=0&limit=50')
  })

  it('sends one tag parameter per tag (AND semantics)', async () => {
    await library.items('user', { tag: ['stack', 'types'] })
    const request = lastPath()
    expect(request).toContain('tag=stack')
    expect(request).toContain('tag=types')
    expect(request.startsWith('/api/users/0/items/top?')).toBe(true)
  })

  it('routes collection filters through /collections/<key>/items/top', async () => {
    const result = await library.items('user', { collection: 'CLTYAAAA', tag: 'types' })
    expect(lastPath()).toBe('/api/users/0/collections/CLTYAAAA/items/top?tag=types&sort=dateModified&direction=desc&start=0&limit=50')
    // Only the paper carries the "types" tag; the preprint is in the collection but untagged.
    expect(result.items.map((item) => item.key)).toEqual(['PAPERAAA'])
    expect(result.total).toBe(1)
  })

  it('resolves collection name references (case-insensitive, parent/child paths) before building the URL', async () => {
    await library.items('user', { collection: 'type systems' })
    expect(lastPath()).toBe('/api/users/0/collections/CLTYAAAA/items/top?sort=dateModified&direction=desc&start=0&limit=50')
    await library.items('user', { collection: 'PL/Type Systems' })
    expect(lastPath()).toContain('/api/users/0/collections/CLTYAAAA/items/top')
  })

  it('rejects ambiguous or unknown collection references without HTTP', async () => {
    const ambiguous = await errorOf(library.items('user', { collection: 'Empty' }))
    expect(ambiguous.code).toBe('invalid_input')
    const missing = await errorOf(library.items('user', { collection: 'Nope' }))
    expect(missing.code).toBe('not_found')
  })

  it('routes saved searches through /searches/<key>/items and filters child items', async () => {
    const result = await library.items('user', { search: 'SRCHAAAA' })
    expect(lastPath()).toBe('/api/users/0/searches/SRCHAAAA/items?sort=dateModified&direction=desc&start=0&limit=50')
    // The fake's saved search matches paper (top) and its note (child) — only the top item is listed.
    expect(result.items.map((item) => item.key)).toEqual(['PAPERAAA'])
    expect(result.total).toBe(2)
  })

  it('fetches explicit keys via itemKey batches and preserves order', async () => {
    const result = await library.items('user', { keys: ['PREPRAAA', 'PAPERAAA'] })
    expect(lastPath()).toContain('/api/users/0/items?itemKey=PREPRAAA,PAPERAAA')
    expect(result.items.map((item) => item.key)).toEqual(['PREPRAAA', 'PAPERAAA'])
  })

  it('caps the query at the panel limit and reports totals from Total-Results', async () => {
    const result = await library.items('user', { limit: 2, sort: 'dateAdded', direction: 'asc' })
    expect(lastPath()).toContain('limit=2')
    expect(result.total).toBeGreaterThanOrEqual(2)
    expect(result.items).toHaveLength(2)
  })

  it('works against group libraries via the /api/groups/<id> prefix', async () => {
    const result = await library.items('g88', { q: 'types' })
    expect(lastPath()).toContain('/api/groups/88/items/top?')
    expect(result.library).toBe('g88')
  })

  it('rejects invalid queries before any HTTP', async () => {
    const error = await errorOf(library.items('user', { sort: 'evil' as never }))
    expect(error.code).toBe('invalid_input')
    expect(fake.state.requests.filter((line) => line.includes('items/top')).length).toBe(0)
  })
})

describe('item details', () => {
  it('projects a regular item with fields, collections, attachments and notes', async () => {
    const detail = await library.item('user', 'PAPERAAA')
    expect(detail.title).toBe('Second-Class Values Revisited')
    expect(detail.itemVersion).toBeGreaterThan(0)
    expect(detail.fields.DOI).toBe('10.1234/stack.2022.15')
    expect(detail.fields.publicationTitle).toBe('Journal of Stack Studies')
    expect(detail.creators.map((creator) => creator.lastName)).toEqual(['Lovelace', 'Turing', 'Hopper'])
    expect(detail.collections).toEqual([{ key: 'CLTYAAAA', name: 'Type Systems' }])
    expect(detail.attachments.map((attachment) => attachment.key).sort()).toEqual(['GHSSTAAB', 'PDFATTAA', 'SCNPDAAA', 'SNAPAACC'])
    expect(detail.attachments.find((attachment) => attachment.key === 'PDFATTAA')!.isPdf).toBe(true)
    expect(detail.notes.map((note) => note.key)).toEqual(['NTEAAAAA'])
    expect(detail.notes[0]!.excerpt).toContain('Reading note')
    expect(detail.pdf).toEqual({ key: 'PDFATTAA', size: 1000 })
    expect(detail.parent).toBeNull()
  })

  it('treats an attachment item as its own attachment without a children call', async () => {
    const detail = await library.item('user', 'PDFATTAA')
    expect(detail.attachments.map((attachment) => attachment.key)).toEqual(['PDFATTAA'])
    expect(detail.parent).toBe('PAPERAAA')
    expect(fake.state.requests.some((line) => line === '/api/users/0/items/PDFATTAA/children')).toBe(false)
  })

  it('maps unknown keys to not_found', async () => {
    const error = await errorOf(library.item('user', 'MISSXXXX'))
    expect(error.code).toBe('not_found')
  })
})

describe('children and annotations', () => {
  it('returns children without annotations by default', async () => {
    const children = await library.children('user', 'PAPERAAA')
    expect(children.map((child) => child.key).sort()).toEqual(['GHSSTAAB', 'NTEAAAAA', 'PDFATTAA', 'SCNPDAAA', 'SNAPAACC'])
  })

  it('parses annotations sorted by sortIndex', async () => {
    const annotations = await library.annotations('user', 'PDFATTAA')
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({ key: 'ANNTAAAA', type: 'highlight', text: 'We design a type system that tracks storage modes.', pageIndex: 0, pageLabel: '1' })
    expect(annotations[0]!.rects).toEqual([[72, 692, 380, 703]])
    expect(annotations[0]!.comment).toBe('Key contribution')
  })
})

describe('attachment path abstraction', () => {
  it('resolves file:// URLs from Zotero into local paths', async () => {
    const path = await library.resolveAttachmentPath('user', 'PDFATTAA')
    expect(path).toBe(fake.state.files.get('PDFATTAA'))
  })

  it('rejects non-attachment keys with not_pdf', async () => {
    const error = await errorOf(library.resolveAttachmentPath('user', 'PAPERAAA'))
    expect(error.code).toBe('not_pdf')
  })

  it('reports file_missing when Zotero has no local file for an attachment', async () => {
    const error = await errorOf(library.resolveAttachmentPath('user', 'SNAPAACC'))
    expect(error.code).toBe('file_missing')
  })

  it('never claims a path field on attachment summaries', async () => {
    const detail = await library.item('user', 'PAPERAAA')
    for (const attachment of detail.attachments) {
      expect(Object.keys(attachment)).not.toContain('path')
    }
  })
})

describe('version tracking', () => {
  it('records library versions from Last-Modified-Version and detects changes', async () => {
    const before = await library.checkVersion('user')
    expect(before.changed).toBe(true)
    const version = library.versionOf('user')
    expect(version).toBeGreaterThan(0)
    const after = await library.checkVersion('user')
    expect(after.changed).toBe(false)
    expect(after.version).toBe(version)
    expect(lastPath()).toContain('/api/users/0/items/top?limit=1&format=keys')
    expect(lastPath()).toBe('/api/users/0/items/top?limit=1&format=keys') // If-Modified-Since-Version travels as a header
  })

  it('invalidates caches on demand', async () => {
    await library.collections('user')
    library.invalidate('user')
    const readsBefore = fake.state.requests.filter((line) => line.includes('GET /api/users/0/collections')).length
    await library.collections('user')
    expect(fake.state.requests.filter((line) => line.includes('GET /api/users/0/collections')).length).toBe(readsBefore + 1)
  })
})
