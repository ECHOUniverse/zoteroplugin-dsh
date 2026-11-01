/**
 * Minimal fake of the Zotero Local API for tests — an independent mock written
 * against the documented behaviour (https://www.zotero.org/support/dev/web_api/v3/local_api),
 * not a copy of any implementation:
 *
 * - GET is unauthenticated; the base probe is `GET /api/`.
 * - 403 + "Local API is not enabled" when the API is switched off.
 * - Writes (Zotero 10+): without `Zotero-Server-ID` → 428; mismatched → 412;
 *   without/with unknown `Zotero-API-Key` → 401; one-time keys expire on use.
 * - `POST /api/local/authorize` issues keys (`{key, remember}`), honours
 *   always/once/deny/hang modes, requires the server id.
 * - Three-step file upload: POST form → `/api/local/uploads/<uploadKey>` → register.
 *
 * All seed data is invented for tests; nothing is copied from a real library.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleScanned, sampleTwoPage } from './make-pdf.ts'

const KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'

const ITEM_FIELDS: Record<string, string[]> = {
  journalArticle: ['title', 'abstractNote', 'publicationTitle', 'volume', 'issue', 'pages', 'date', 'language', 'DOI', 'ISSN', 'url', 'accessDate', 'extra'],
  book: ['title', 'abstractNote', 'publisher', 'place', 'date', 'ISBN', 'url', 'accessDate', 'extra'],
  preprint: ['title', 'abstractNote', 'repository', 'archiveID', 'date', 'DOI', 'url', 'accessDate', 'extra'],
}
const CHILD_FIELDS: Record<string, string[]> = {
  attachment: ['title', 'accessDate', 'url', 'linkMode', 'contentType', 'charset', 'filename', 'path', 'parentItem'],
  note: ['note', 'parentItem'],
  annotation: ['parentItem', 'annotationType', 'annotationText', 'annotationComment', 'annotationColor', 'annotationPageLabel', 'annotationSortIndex', 'annotationPosition', 'annotationAuthorName'],
}

export interface FakeZoteroOptions {
  writes?: boolean
  authorize?: 'always' | 'once' | 'deny' | 'hang'
  apiEnabled?: boolean
  /** false emulates a Zotero without any local API (404 on /api/). */
  localApiPresent?: boolean
  version?: string
  serverId?: string
  groups?: { id: number; name: string; libraryEditing?: string }[]
}

export interface FakeItem {
  key: string
  version: number
  deleted?: boolean
  data: Record<string, unknown>
}

export interface FakeZotero {
  url: string
  /** Raw counters and stores the tests assert against. */
  state: {
    serverId: string
    version: string
    items: Map<string, FakeItem>
    collections: Map<string, FakeItem>
    searches: Map<string, FakeItem>
    files: Map<string, string>
    fulltext: Map<string, string>
    keys: Map<string, { remember: boolean; appName: string }>
    authorizeRequests: number
    /** `METHOD path?search` for every request that reached the server. */
    requests: string[]
  }
  storage: string
  /** Simulate the user editing in Zotero (bumps versions). */
  touch(key: string, patch: Record<string, unknown>): void
  /** Change the reported instance identity (another Zotero takes over). */
  rotateServerId(next: string): void
  setAuthorizeMode(mode: 'always' | 'once' | 'deny' | 'hang'): void
  close(): Promise<void>
}

export async function startFakeZotero(options: FakeZoteroOptions = {}): Promise<FakeZotero> {
  const state = {
    serverId: options.serverId ?? 'FAKESERVER01',
    version: options.version ?? '10.0.2-test',
    writes: options.writes ?? true,
    apiEnabled: options.apiEnabled ?? true,
    localApiPresent: options.localApiPresent ?? true,
    authorizeMode: options.authorize ?? ('always' as 'always' | 'once' | 'deny' | 'hang'),
    groups: options.groups ?? [
      { id: 88, name: 'Lab Group', libraryEditing: 'members' },
      { id: 99, name: 'Announcements', libraryEditing: 'admins' },
    ],
    items: new Map<string, FakeItem>(),
    collections: new Map<string, FakeItem>(),
    searches: new Map<string, FakeItem>(),
    files: new Map<string, string>(),
    fulltext: new Map<string, string>(),
    keys: new Map<string, { remember: boolean; appName: string }>(),
    uploads: new Map<string, { itemKey: string; md5: string; filename: string; bytes?: Buffer }>(),
    authorizeRequests: 0,
    requests: [] as string[],
    keySeq: 0,
    objectSeq: 0,
  }
  const storage = await mkdtemp(join(tmpdir(), 'fake-zotero-'))

  const newKey = () => {
    let key = ''
    let seq = ++state.keySeq
    while (key.length < 32) {
      key += KEY_CHARS[seq % KEY_CHARS.length]
      seq = Math.floor(seq / KEY_CHARS.length) + 7
    }
    return key
  }
  const newObjectKey = () => {
    let key = ''
    let seq = ++state.objectSeq + 11
    for (let index = 0; index < 8; index++) {
      key += KEY_CHARS[seq % KEY_CHARS.length]
      seq = Math.floor(seq / KEY_CHARS.length) + 3
    }
    return key
  }
  const now = () => new Date('2026-01-15T12:00:00Z').toISOString().replace(/\.\d+Z$/, 'Z')
  let libraryVersion = 100

  const addCollection = (name: string, parent: string | false, key: string) => {
    state.collections.set(key, { key, version: libraryVersion, data: { key, name, parentCollection: parent } })
    return key
  }
  const addItem = (data: Record<string, unknown>, key?: string) => {
    libraryVersion += 1
    const finalKey = key ?? newObjectKey()
    const item: FakeItem = {
      key: finalKey,
      version: libraryVersion,
      data: { key: finalKey, version: libraryVersion, tags: [], collections: [], relations: {}, dateAdded: now(), dateModified: now(), ...data },
    }
    if (item.data.parentItem || item.data.itemType === 'annotation') delete item.data.collections
    state.items.set(finalKey, item)
    return finalKey
  }

  // Seed: generic invented items.
  addCollection('PL', false, 'CLPLAAAA')
  const typesKey = addCollection('Type Systems', 'CLPLAAAA', 'CLTYAAAA')
  addCollection('Empty', false, 'CLEMAAAA')
  addCollection('Empty', false) // duplicate name → name references are ambiguous
  state.searches.set('SRCHAAAA', { key: 'SRCHAAAA', version: libraryVersion, data: { key: 'SRCHAAAA', name: 'Stack papers' } })
  const paperKey = addItem({
    itemType: 'journalArticle',
    title: 'Second-Class Values Revisited',
    creators: [
      { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
      { creatorType: 'author', firstName: 'Alan', lastName: 'Turing' },
      { creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' },
    ],
    abstractNote: 'We design a type system that tracks storage modes.',
    publicationTitle: 'Journal of Stack Studies',
    date: '2022-06-01',
    DOI: '10.1234/stack.2022.15',
    collections: [typesKey],
    tags: [{ tag: 'stack' }, { tag: 'types' }],
  }, 'PAPERAAA')
  const pdfPath = join(storage, 'PDFATTAA', 'paper.pdf')
  await mkdir(join(storage, 'PDFATTAA'), { recursive: true })
  // A real two-page PDF (invented text) so M4 extraction/highlight flows run
  // end-to-end against the fake; see tests/helpers/make-pdf.ts.
  await writeFile(pdfPath, sampleTwoPage())
  addItem({ itemType: 'attachment', parentItem: paperKey, linkMode: 'imported_file', title: 'Full Text PDF', contentType: 'application/pdf', filename: 'paper.pdf' }, 'PDFATTAA')
  state.files.set('PDFATTAA', pdfPath)
  state.fulltext.set('PDFATTAA', 'Second-Class Values Revisited. We design a type system that tracks storage modes.')
  addItem({ itemType: 'note', parentItem: paperKey, note: '<p><strong>Reading note</strong>: compare with region inference.</p>', tags: [{ tag: 'stack' }] }, 'NTEAAAAA')
  addItem({ itemType: 'attachment', parentItem: paperKey, linkMode: 'imported_file', title: 'Snapshot', contentType: 'text/html', filename: 'snapshot.html' }, 'SNAPAACC')
  // A scanned (text-free) PDF attachment for the scanned-PDF tool paths.
  const scannedPath = join(storage, 'SCNPDAAA', 'scan.pdf')
  await mkdir(join(storage, 'SCNPDAAA'), { recursive: true })
  await writeFile(scannedPath, sampleScanned())
  addItem({ itemType: 'attachment', parentItem: paperKey, linkMode: 'imported_file', title: 'Scanned Copy', contentType: 'application/pdf', filename: 'scan.pdf' }, 'SCNPDAAA')
  state.files.set('SCNPDAAA', scannedPath)
  // A stored PDF whose file was never synced/downloaded (no entry in files).
  addItem({ itemType: 'attachment', parentItem: paperKey, linkMode: 'imported_file', title: 'Ghost PDF', contentType: 'application/pdf', filename: 'ghost.pdf' }, 'GHSSTAAB')
  addItem({
    itemType: 'annotation',
    parentItem: 'PDFATTAA',
    annotationType: 'highlight',
    annotationText: 'We design a type system that tracks storage modes.',
    annotationComment: 'Key contribution',
    annotationColor: '#ffd400',
    annotationPageLabel: '1',
    annotationSortIndex: '00001|000010|00072',
    annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[72, 692, 380, 703]] }),
    tags: [{ tag: 'important' }],
  }, 'ANNTAAAA')
  addItem({
    itemType: 'preprint',
    title: 'Capturing Types in Practice',
    creators: [{ creatorType: 'author', firstName: 'Martin', lastName: 'Odersky' }],
    repository: 'arXiv',
    archiveID: 'arXiv:2207.03402',
    date: '2022',
    collections: [typesKey],
    tags: [{ tag: 'capture checking' }],
  }, 'PREPRAAA')
  addItem({ itemType: 'book', title: 'Types and Programming Languages', creators: [{ creatorType: 'author', firstName: 'Benjamin', lastName: 'Pierce' }], publisher: 'MIT Press', date: '2002' }, 'TAPLBKAA')

  const live = () => [...state.items.values()].filter((item) => !item.deleted)
  const childrenOf = (key: string) => live().filter((item) => item.data.parentItem === key)
  const isTop = (item: FakeItem) => !item.data.parentItem

  const summary = (item: FakeItem) => {
    const creators = (item.data.creators ?? []) as { firstName?: string; lastName?: string; name?: string }[]
    const last = (creator: { firstName?: string; lastName?: string; name?: string }) => creator.lastName ?? creator.name ?? ''
    const creatorSummary =
      creators.length === 0 ? '' : creators.length === 1 ? last(creators[0]!) : creators.length === 2 ? `${last(creators[0]!)} and ${last(creators[1]!)}` : `${last(creators[0]!)} et al.`
    const pdf = childrenOf(item.key).find((child) => child.data.itemType === 'attachment' && child.data.contentType === 'application/pdf')
    return {
      key: item.key,
      version: item.version,
      library: { type: 'user', id: 0, name: 'My Library' },
      links: {
        self: { href: `http://127.0.0.1:23119/api/users/0/items/${item.key}`, type: 'application/json' },
        ...(pdf ? { attachment: { href: `http://127.0.0.1:23119/api/users/0/items/${pdf.key}`, type: 'application/json', attachmentType: 'application/pdf', attachmentSize: 1000 } } : {}),
      },
      meta: {
        creatorSummary,
        parsedDate: String(item.data.date ?? ''),
        numChildren: childrenOf(item.key).filter((child) => child.data.itemType !== 'annotation').length,
      },
      data: item.data,
    }
  }

  const matches = (item: FakeItem, q: string, mode: string | null) => {
    const needle = q.toLowerCase()
    const creators = ((item.data.creators ?? []) as { firstName?: string; lastName?: string; name?: string }[])
      .map((creator) => `${creator.firstName ?? ''} ${creator.lastName ?? ''} ${creator.name ?? ''}`)
      .join(' ')
    const base = `${item.data.title ?? ''} ${creators} ${item.data.date ?? ''}`.toLowerCase()
    if (base.includes(needle)) return true
    if (mode !== 'everything') return false
    const text = (data: Record<string, unknown>) => JSON.stringify(data).replace(/<[^>]+>/g, '').toLowerCase()
    if (text(item.data).includes(needle)) return true
    return childrenOf(item.key).some((child) => text(child.data).includes(needle) || (state.fulltext.get(child.key) ?? '').toLowerCase().includes(needle))
  }

  const list = (response: ServerResponse, items: FakeItem[], url: URL, extraHeaders: Record<string, string> = {}) => {
    const params = url.searchParams
    let result = items
    const q = params.get('q')
    if (q) result = result.filter((item) => matches(item, q, params.get('qmode')))
    for (const tag of params.getAll('tag')) {
      result = result.filter((item) => (item.data.tags ?? []).some((entry) => (entry as { tag: string }).tag === tag))
    }
    const sort = params.get('sort') ?? 'dateModified'
    const direction = params.get('direction') ?? 'desc'
    result = [...result].sort((a, b) => {
      const value = (item: FakeItem) =>
        sort === 'title' ? String(item.data.title ?? '') : sort === 'dateAdded' ? String(item.data.dateAdded) : sort === 'date' ? String(item.data.date ?? '') : String(item.version).padStart(8, '0')
      return value(a).localeCompare(value(b)) * (direction === 'asc' ? 1 : -1)
    })
    const total = result.length
    const start = Number(params.get('start') ?? 0)
    const limit = params.has('limit') ? Number(params.get('limit')) : total
    result = result.slice(start, start + limit)
    const headers: Record<string, string> = { 'Total-Results': String(total), 'Last-Modified-Version': String(libraryVersion), ...extraHeaders }
    const format = params.get('format')
    if (format === 'keys') return send(response, 200, result.map((item) => item.key).join('\n') + '\n', headers)
    if (format === 'bibtex') return send(response, 200, result.map(fakeBibtex).join('\n\n'), headers)
    if (format === 'ris') return send(response, 200, result.map(fakeRis).join('\n'), headers)
    return send(response, 200, result.map(summary), headers)
  }

  /** Invented export text (local paths included on purpose, to test stripping). */
  const fakeBibtex = (item: FakeItem): string => {
    const title = String(item.data.title ?? 'Untitled')
    const hasFile = childrenOf(item.key).some((child) => child.data.itemType === 'attachment')
    return [
      `@article{${item.key},`,
      `  title = {${title}}`,
      `  year = {${String(item.data.date ?? '').slice(0, 4) || 'n.d.'}}`,
      ...(hasFile ? [`  file = {Attachment:/storage/${item.key}/fake.pdf:application/pdf}`] : []),
      '}',
    ].join(',\n')
  }

  const fakeRis = (item: FakeItem): string => {
    const hasFile = childrenOf(item.key).some((child) => child.data.itemType === 'attachment')
    return [
      'TY  - JOUR',
      `TI  - ${String(item.data.title ?? 'Untitled')}`,
      ...(hasFile ? [`L1  - file:///storage/${item.key}/fake.pdf`] : []),
      'ER  - ',
      '',
    ].join('\n')
  }

  const validate = (data: Record<string, unknown>): string | null => {
    const type = String(data.itemType ?? '')
    const allowed = ITEM_FIELDS[type] ?? CHILD_FIELDS[type]
    if (!allowed) return `'${type}' is not a valid itemType`
    for (const field of Object.keys(data)) {
      if (!['itemType', 'creators', 'tags', 'collections', 'relations', 'key', 'version', 'dateAdded', 'dateModified'].includes(field) && !allowed.includes(field)) {
        return `'${field}' is not a valid field for type '${type}'`
      }
    }
    if (type === 'annotation') {
      const parent = state.items.get(String(data.parentItem ?? ''))
      if (!parent || parent.data.contentType !== 'application/pdf') return 'Parent item of annotation must be a PDF attachment'
      if (!data.annotationPosition || !data.annotationSortIndex) return 'annotationPosition and annotationSortIndex are required'
    }
    if (data.parentItem && !state.items.get(String(data.parentItem))) return `Parent item ${String(data.parentItem)} not found`
    return null
  }

  const checkWrite = (request: IncomingMessage, response: ServerResponse): boolean => {
    const serverId = request.headers['zotero-server-id']
    if (!serverId) return send(response, 428, 'Zotero-Server-ID not provided'), false
    if (serverId !== state.serverId) return send(response, 412, 'Zotero-Server-ID does not match this server'), false
    const key = request.headers['zotero-api-key']
    if (!key) return send(response, 401, 'API key required -- POST /api/local/authorize to obtain one', { 'WWW-Authenticate': 'Zotero-API-Key realm="Zotero Local API"' }), false
    const entry = state.keys.get(String(key))
    if (!entry) return send(response, 401, 'Invalid or expired API key'), false
    if (!entry.remember) state.keys.delete(String(key))
    return true
  }

  const body = async (request: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  function send(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
    const isJson = payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)
    response.writeHead(status, {
      'X-Zotero-Version': state.version,
      'Zotero-API-Version': '3',
      'Zotero-Server-ID': state.serverId,
      'Content-Type': isJson ? 'application/json' : 'text/plain',
      ...headers,
    })
    response.end(isJson ? JSON.stringify(payload) : String(payload ?? ''))
  }

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests.push(`${request.method} ${url.pathname}${url.search}`)
    // Normalize every library prefix (/api/users/0, /api/users/1, /api/groups/<id>) to /api/store.
    const path = url.pathname.replace(/^\/api\/(users\/\d+|groups\/\d+)\//, '/api/store/')
    try {
      if (!state.localApiPresent && url.pathname === '/api/') return send(response, 404, 'Not found')
      if (!state.apiEnabled && url.pathname.startsWith('/api/')) return send(response, 403, 'Local API is not enabled')
      if (request.method === 'GET' && url.pathname === '/api/') return send(response, 200, 'Nothing to see here.')
      // Schema endpoint (Web API v3 shape: [{field, localized}]); the import
      // flow uses it to drop fields Zotero would reject before writing.
      if (request.method === 'GET' && url.pathname === '/api/itemTypeFields') {
        const type = url.searchParams.get('itemType') ?? ''
        const fields = ITEM_FIELDS[type] ?? CHILD_FIELDS[type]
        if (!fields) return send(response, 400, `'${type}' is not a valid itemType`)
        return send(response, 200, fields.map((field) => ({ field, localized: field })))
      }
      if (request.method === 'POST' && url.pathname === '/api/local/authorize') {
        const serverId = request.headers['zotero-server-id']
        if (!serverId) return send(response, 428, 'Zotero-Server-ID not provided')
        if (serverId !== state.serverId) return send(response, 412, 'Zotero-Server-ID does not match this server')
        state.authorizeRequests += 1
        const data = JSON.parse(String(await body(request)) || '{}') as { appName?: string }
        if (!data.appName) return send(response, 400, 'appName is required')
        if (state.authorizeMode === 'hang') return // never answers; caller times out
        if (state.authorizeMode === 'deny') return send(response, 403, { denied: true })
        const key = newKey()
        const remember = state.authorizeMode === 'always'
        state.keys.set(key, { remember, appName: String(data.appName) })
        return send(response, 200, { key, remember })
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/local/uploads/')) {
        const upload = state.uploads.get(url.pathname.split('/').pop() ?? '')
        if (!upload) return send(response, 404, 'Unknown or expired upload key')
        const bytes = await body(request)
        const md5 = createHash('md5').update(bytes).digest('hex')
        if (md5 !== upload.md5) return send(response, 400, `File MD5 does not match expected (got ${md5}, expected ${upload.md5})`)
        upload.bytes = bytes
        return send(response, 201, '')
      }
      // Read-only Zotero builds answer 400 for any non-GET request method.
      if (request.method !== 'GET' && !state.writes) return send(response, 400, 'Endpoint does not support method')

      if (request.method === 'GET' && path === '/api/store/groups') {
        return send(response, 200, state.groups.map((group) => ({ id: group.id, version: 1, meta: { numItems: 0 }, data: { name: group.name, libraryEditing: group.libraryEditing ?? 'members' } })))
      }
      const since = request.headers['if-modified-since-version']
      if (request.method === 'GET' && since && Number(since) >= libraryVersion && /\/items/.test(path)) {
        return send(response, 304, '', { 'Last-Modified-Version': String(libraryVersion) })
      }

      let match: RegExpExecArray | null
      if (request.method === 'GET' && path === '/api/store/collections') {
        const collections = [...state.collections.values()].filter((collection) => !collection.deleted)
        return send(
          response,
          200,
          collections.map((collection) => ({
            ...collection,
            meta: {
              numItems: live().filter((item) => ((item.data.collections as string[] | undefined) ?? []).includes(collection.key)).length,
              numCollections: [...state.collections.values()].filter((other) => other.data.parentCollection === collection.key).length,
            },
          })),
          { 'Last-Modified-Version': String(libraryVersion) },
        )
      }
      if (request.method === 'GET' && path === '/api/store/searches') return send(response, 200, [...state.searches.values()], { 'Last-Modified-Version': String(libraryVersion) })
      if (request.method === 'GET' && (match = /^\/api\/store\/searches\/([A-Z0-9]+)\/items$/.exec(path))) {
        // Saved search "Stack papers": everything tagged stack (may include children).
        return list(response, live().filter((item) => ((item.data.tags ?? []) as { tag: string }[]).some((entry) => entry.tag === 'stack')), url)
      }
      if (request.method === 'GET' && (match = /^\/api\/store\/collections\/([A-Z0-9]+)\/items\/top$/.exec(path))) {
        if (!state.collections.has(match[1]!)) return send(response, 404, 'Collection not found')
        return list(response, live().filter((item) => isTop(item) && ((item.data.collections as string[] | undefined) ?? []).includes(match[1]!)), url)
      }
      if (request.method === 'GET' && path === '/api/store/items/top') return list(response, live().filter(isTop), url)
      if (request.method === 'GET' && path === '/api/store/items') {
        let items = live()
        const keys = url.searchParams.get('itemKey')
        if (keys) items = keys.split(',').map((key) => state.items.get(key)).filter((item): item is FakeItem => !!item && !item.deleted)
        const type = url.searchParams.get('itemType')
        if (type) items = items.filter((item) => item.data.itemType === type)
        else if (!keys) items = items.filter((item) => item.data.itemType !== 'annotation')
        return list(response, items, url)
      }
      if (request.method === 'GET' && (match = /^\/api\/store\/items\/([A-Z0-9]+)\/children$/.exec(path))) {
        const type = url.searchParams.get('itemType')
        // Real Zotero omits annotations unless itemType=annotation is given.
        const children = childrenOf(match[1]!).filter((item) => (type ? item.data.itemType === type : item.data.itemType !== 'annotation'))
        return list(response, children, url)
      }
      if (request.method === 'GET' && (match = /^\/api\/store\/items\/([A-Z0-9]+)\/file\/view\/url$/.exec(path))) {
        const item = state.items.get(match[1]!)
        if (!item) return send(response, 404, 'Not found')
        if (item.data.itemType !== 'attachment') return send(response, 400, `Not a file attachment: ${match[1]}`)
        const file = state.files.get(match[1]!)
        return send(response, 200, file ? `file://${file}` : '')
      }
      if (request.method === 'GET' && (match = /^\/api\/store\/items\/([A-Z0-9]+)\/fulltext$/.exec(path))) {
        const text = state.fulltext.get(match[1]!)
        return text ? send(response, 200, { content: text, indexedPages: 1, totalPages: 1 }) : send(response, 404, 'Not found')
      }
      if (request.method === 'GET' && (match = /^\/api\/store\/items\/([A-Z0-9]+)$/.exec(path))) {
        const item = state.items.get(match[1]!)
        if (!item || item.deleted) return send(response, 404, 'Not found')
        return send(response, 200, summary(item), { 'Last-Modified-Version': String(item.version) })
      }

      // ------------------------------------------------------------ writes
      if (request.method === 'POST' && (path === '/api/store/items' || path === '/api/store/collections')) {
        if (!checkWrite(request, response)) return
        const objects = JSON.parse(String(await body(request))) as Record<string, unknown>[]
        const result: { successful: Record<string, { key: string; version: number }>; success: Record<string, string>; unchanged: Record<string, string>; failed: Record<string, { code: number; message: string }> } = { successful: {}, success: {}, unchanged: {}, failed: {} }
        objects.forEach((data, index) => {
          if (path.endsWith('collections')) {
            libraryVersion += 1
            const key = newObjectKey()
            state.collections.set(key, { key, version: libraryVersion, data: { key, name: String(data.name ?? ''), parentCollection: (data.parentCollection as string | false) ?? false } })
            result.successful[String(index)] = { key, version: libraryVersion }
            result.success[String(index)] = key
            return
          }
          const error = validate(data)
          if (error) {
            result.failed[String(index)] = { code: 400, message: error }
            return
          }
          const key = addItem(data)
          result.successful[String(index)] = { key, version: libraryVersion }
          result.success[String(index)] = key
        })
        return send(response, 200, result, { 'Last-Modified-Version': String(libraryVersion) })
      }
      if (request.method === 'PATCH' && (match = /^\/api\/store\/items\/([A-Z0-9]+)$/.exec(path))) {
        if (!checkWrite(request, response)) return
        const item = state.items.get(match[1]!)
        if (!item || item.deleted) return send(response, 404, 'Not found')
        const expected = request.headers['if-unmodified-since-version']
        if (expected && Number(expected) !== item.version) {
          return send(response, 412, `Item has been modified since specified version (expected ${expected}, found ${item.version})`)
        }
        const patch = JSON.parse(String(await body(request))) as Record<string, unknown>
        const error = validate({ ...item.data, ...patch })
        if (error) return send(response, 400, error)
        libraryVersion += 1
        Object.assign(item.data, patch, { version: libraryVersion, dateModified: now() })
        item.version = libraryVersion
        return send(response, 204, '', { 'Last-Modified-Version': String(libraryVersion) })
      }
      if (request.method === 'DELETE' && (path === '/api/store/items' || path === '/api/store/collections')) {
        if (!checkWrite(request, response)) return
        const param = path.endsWith('items') ? 'itemKey' : 'collectionKey'
        for (const key of (url.searchParams.get(param) ?? '').split(',')) {
          const target = (path.endsWith('items') ? state.items : state.collections).get(key)
          if (target) target.deleted = true
          for (const child of childrenOf(key)) child.deleted = true
        }
        libraryVersion += 1
        return send(response, 204, '', { 'Last-Modified-Version': String(libraryVersion) })
      }
      if (request.method === 'POST' && (match = /^\/api\/store\/items\/([A-Z0-9]+)\/file$/.exec(path))) {
        if (!checkWrite(request, response)) return
        const item = state.items.get(match[1]!)
        if (!item) return send(response, 404, 'Not found')
        if (!request.headers['if-none-match'] && !request.headers['if-match']) return send(response, 428, 'If-Match/If-None-Match header not provided')
        const form = new URLSearchParams(String(await body(request)))
        const uploadKey = form.get('upload')
        if (uploadKey) {
          const upload = state.uploads.get(uploadKey)
          if (!upload || upload.itemKey !== match[1]) return send(response, 400, 'Invalid or expired upload key')
          if (!upload.bytes) return send(response, 400, 'File contents were not uploaded')
          const file = join(storage, match[1]!, upload.filename)
          await mkdir(join(storage, match[1]!), { recursive: true })
          await writeFile(file, upload.bytes)
          state.files.set(match[1]!, file)
          item.data.filename = upload.filename
          state.uploads.delete(uploadKey)
          libraryVersion += 1
          return send(response, 204, '', { 'Last-Modified-Version': String(libraryVersion) })
        }
        const md5 = form.get('md5')
        const filename = form.get('filename')
        if (!md5 || !filename || !form.get('filesize')) return send(response, 400, 'MD5 hash not provided')
        const mtime = Number(form.get('mtime') ?? 0)
        if (mtime > 0 && mtime < 10_000_000_000) return send(response, 400, 'mtime must be provided in milliseconds, not seconds')
        const grantKey = createHash('sha256').update(`${Math.random()}`).digest('hex').slice(0, 32)
        state.uploads.set(grantKey, { itemKey: match[1]!, md5, filename })
        return send(response, 200, { url: `http://${request.headers.host}/api/local/uploads/${grantKey}`, uploadKey: grantKey, contentType: form.get('contentType'), prefix: '', suffix: '' })
      }
      return send(response, 404, 'No endpoint found')
    } catch (error) {
      return send(response, 500, String((error as Error)?.stack ?? error))
    }
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    storage,
    touch(key, patch) {
      const item = state.items.get(key)
      if (!item) throw new Error(`fake: no item ${key}`)
      libraryVersion += 1
      Object.assign(item.data, patch)
      item.version = libraryVersion
    },
    rotateServerId(next) {
      state.serverId = next
    },
    setAuthorizeMode(mode) {
      state.authorizeMode = mode
    },
    close: () => new Promise((done) => server.close(() => done())),
  }
}
