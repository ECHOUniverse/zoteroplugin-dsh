/**
 * Component tests driven by user-visible behavior only: views render from a
 * prepared store state, and the assertions read like a user's screen (titles,
 * placeholder text, buttons), never private internals.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ItemDetailView, LibraryView, SetupView } from '../src/client/views.tsx'
import { ZoteroStore, initialState, libraryRoute, viewKeyFor, type ClientState } from '../src/client/store.ts'
import { zh } from '../src/client/i18n.ts'
import type { ItemDetailWire, ItemSummaryWire, StatusResponse } from '../src/shared/protocol.ts'

/** zh string table straight from the dictionary the tab registers. */
const t = (key: string, params?: Record<string, string | number>): string => {
  let value = zh[key] ?? key
  if (params !== undefined) for (const [name, fill] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(fill))
  return value
}

const notify = (): void => {}
const chat = { face: null, hasSession: false, busy: false }

const summary = (overrides: Partial<ItemSummaryWire> = {}): ItemSummaryWire => ({
  key: 'ABCD2345',
  itemType: 'journalArticle',
  title: 'Deep Learning for Schema Matching',
  creatorSummary: 'Smith, J.',
  year: '2024',
  venue: 'Nature Methods',
  tags: [],
  numChildren: 1,
  pdf: { key: 'PDFK2345' },
  dateAdded: '2024-01-01T00:00:00Z',
  dateModified: '2024-01-02T00:00:00Z',
  ...overrides,
})

const detail = (overrides: Partial<ItemDetailWire> = {}): ItemDetailWire => ({
  ...summary(),
  library: 'user',
  version: 1,
  itemVersion: 3,
  creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Smith' }],
  fields: { DOI: '10.1000/x', publicationTitle: 'Nature Methods' },
  abstract: 'A long abstract.'.repeat(40),
  collections: [{ key: 'COLL1234', name: 'Reviews' }],
  attachments: [{ key: 'PDFK2345', title: 'Full text', contentType: 'application/pdf', linkMode: 'imported_file', isPdf: true, parent: null }],
  notes: [{ key: 'NOTE1234', html: '<p>Read this</p>', excerpt: '', dateModified: '2024-01-02T00:00:00Z' }],
  parent: null,
  ...overrides,
})

/** Store preloaded with one ready status and optional extra data. */
function preparedStore(entries: { key: string; data: unknown }[]): ZoteroStore {
  const base = initialState()
  const state: ClientState = {
    ...base,
    views: Object.fromEntries(entries.map((entry, index) => [entry.key, { phase: 'ready', token: index + 1, data: entry.data }])),
  }
  return new ZoteroStore(state)
}

describe('SetupView', () => {
  it('shows the connection card and guidance while Zotero is not running', () => {
    const store = preparedStore([{ key: 'status', data: { plugin: 'p', state: 'not_running', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse }])
    const html = renderToStaticMarkup(React.createElement(SetupView, { store, t, notify, chat }))
    expect(html).toContain('Zotero 未运行')
    expect(html).toContain('启动 Zotero 桌面版')
    expect(html).toContain('再次检查')
  })

  it('reports the local-API-disabled steps and the unsupported state distinctly', () => {
    const store = preparedStore([{ key: 'status', data: { plugin: 'p', state: 'api_disabled', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse }])
    expect(renderToStaticMarkup(React.createElement(SetupView, { store, t, notify, chat }))).toContain('请开启 Zotero 的本地 API')
    const old = preparedStore([{ key: 'status', data: { plugin: 'p', state: 'unsupported', zoteroVersion: '7.0.6', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse }])
    const html = renderToStaticMarkup(React.createElement(SetupView, { store: old, t, notify, chat }))
    expect(html).toContain('Zotero 版本过低')
    expect(html).toContain('7.0.6')
    expect(html).toContain('10')
  })

  it('shows the configured Local API address and points edits to the DSH settings form', () => {
    const store = preparedStore([
      { key: 'status', data: { plugin: 'p', state: 'ready', zoteroVersion: '10.1.0', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse },
    ])
    const html = renderToStaticMarkup(React.createElement(SetupView, { store, t, notify, chat }))
    expect(html).toContain('本地 API 地址')
    expect(html).toContain('http://127.0.0.1:23119')
    // Editing is guided to the official DSH plugin settings form — the panel
    // exposes no URL-write route of its own.
    expect(html).toContain('localApiBaseUrl')
    expect(html).toContain('DSH 插件设置')
  })
})

describe('LibraryView', () => {
  const route = libraryRoute('user')
  const itemsKey = viewKeyFor(route) ?? 'items'
  const store = () =>
    preparedStore([
      { key: 'status', data: { plugin: 'p', state: 'ready', zoteroVersion: '10.1.0', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse },
      {
        key: itemsKey,
        data: {
          library: 'user',
          version: 1,
          total: 51,
          start: 0,
          limit: 50,
          items: [summary(), summary({ key: 'BCDE3456', title: 'Second Paper', itemType: 'book', pdf: null })],
        },
      },
    ])

  it('renders rows with title, localized type, creator·year·venue and a PDF badge', () => {
    const html = renderToStaticMarkup(React.createElement(LibraryView, { store: store(), t, notify, chat, route }))
    expect(html).toContain('Deep Learning for Schema Matching')
    expect(html).toContain('Second Paper')
    expect(html).toContain('期刊文章')
    expect(html).toContain('书籍')
    expect(html).toContain('Smith, J. · 2024 · Nature Methods')
    expect(html).toContain('PDF')
  })

  it('renders the search box with the everything toggle and total count', () => {
    const html = renderToStaticMarkup(React.createElement(LibraryView, { store: store(), t, notify, chat, route }))
    expect(html).toContain('type="search"')
    expect(html).toContain('检索元数据')
    expect(html).toContain('全文')
    expect(html).toContain('51 条')
  })

  it('offers Load more when more results remain, capped at 500', () => {
    expect(renderToStaticMarkup(React.createElement(LibraryView, { store: store(), t, notify, chat, route }))).toContain('加载更多')
    const atCapRoute = { ...route, pages: 10 }
    const capStore = preparedStore([
      {
        key: viewKeyFor(atCapRoute) ?? 'items',
        data: { library: 'user', version: 1, total: 900, start: 0, limit: 500, items: [summary()] },
      },
    ])
    const html = renderToStaticMarkup(React.createElement(LibraryView, { store: capStore, t, notify, chat, route: atCapRoute }))
    expect(html).not.toContain('加载更多')
    expect(html).toContain('最多显示 500 条')
  })

  it('shows the empty state when no items match', () => {
    const emptyStore = preparedStore([
      { key: 'status', data: { plugin: 'p', state: 'ready', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse },
      { key: itemsKey, data: { library: 'user', version: 1, total: 0, start: 0, limit: 50, items: [] } },
    ])
    expect(renderToStaticMarkup(React.createElement(LibraryView, { store: emptyStore, t, notify, chat, route }))).toContain('此范围内没有条目')
  })

  it('shows error plus Retry on a failed list', () => {
    const base = initialState()
    const state: ClientState = {
      ...base,
      views: {
        status: { phase: 'ready', token: 1, data: { plugin: 'p', state: 'ready', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } },
        [itemsKey]: { phase: 'error', token: 2, code: 'zotero_not_running', message: 'ECONNREFUSED' },
      },
    }
    const html = renderToStaticMarkup(React.createElement(LibraryView, { store: new ZoteroStore(state), t, notify, chat, route }))
    expect(html).toContain('Zotero 未运行')
    expect(html).toContain('重试')
  })
})

describe('ItemDetailView', () => {
  const route = { view: 'item', library: 'user', key: 'ABCD2345' } as const
  const key = viewKeyFor(route) ?? 'item'
  const store = () =>
    preparedStore([
      { key: 'status', data: { plugin: 'p', state: 'ready', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse },
      { key, data: detail() },
      { key: `annotations:user/ABCD2345`, data: { item: 'ABCD2345', attachment: 'PDFK2345', annotations: [] } },
    ])

  it('renders title, creators, fields table, tags and note sections', () => {
    const html = renderToStaticMarkup(React.createElement(ItemDetailView, { store: store(), t, notify, chat, route, onBack: () => {} }))
    expect(html).toContain('Deep Learning for Schema Matching')
    expect(html).toContain('Jane Smith')
    expect(html).toContain('DOI')
    expect(html).toContain('10.1000/x')
    expect(html).toContain('信息')
    expect(html).toContain('笔记')
    expect(html).toContain('Read this')
    expect(html).toContain('Reviews')
    expect(html).toContain('导出 BibTeX')
  })

  it('wires Show in Zotero as an enabled action; the client never renders a deep link', () => {
    const html = renderToStaticMarkup(React.createElement(ItemDetailView, { store: store(), t, notify, chat, route, onBack: () => {} }))
    expect(html).toContain('在 Zotero 中显示')
    // The action is real now: enabled in the static render (no revealing
    // flag), and the zotero:// URL is built server-side — it must never
    // appear in client markup.
    expect(html).not.toContain('zotero://select')
    expect(html).not.toContain('后续里程碑')
  })

  it('disables chat buttons without a session face and names the reason', () => {
    const html = renderToStaticMarkup(React.createElement(ItemDetailView, { store: store(), t, notify, chat, route, onBack: () => {} }))
    expect(html).toContain('disabled')
    expect(html).toContain('当前没有进行中的会话')
  })

  it('never lets script tags or javascript: URLs reach the note markup', () => {
    const dirty = preparedStore([
      { key: 'status', data: { plugin: 'p', state: 'ready', baseUrl: 'http://127.0.0.1:23119', checkedAt: 1 } satisfies StatusResponse },
      { key, data: detail({ notes: [{ key: 'NOTE1234', html: '<p>ok</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>', excerpt: '', dateModified: '' }] }) },
      { key: 'annotations:user/ABCD2345', data: { item: 'ABCD2345', attachment: null, annotations: [] } },
    ])
    const html = renderToStaticMarkup(React.createElement(ItemDetailView, { store: dirty, t, notify, chat, route, onBack: () => {} }))
    // In this DOM-less environment the view falls back to a plain-text note
    // projection; the built browser bundle sanitizes through DOMPurify
    // (scripts/smoke.mjs asserts the sanitizer ships). Either way no script
    // tag or dangerous URL may appear in the markup.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('ok')
  })
})

describe('Reader (lazy chunk)', () => {
  it('renders the real reader: page controls, highlight UI strings and accessible names', async () => {
    // The chunk entry imports pdf.js (heavy but import-safe in Node); SSR
    // stops before any effect runs, so this asserts the public render
    // surface only — the previous "M4 boundary" placeholder is gone.
    const { Reader } = await import('../src/client-pdf.tsx')
    const route = { view: 'reader', library: 'user', itemKey: 'ABCD2345', attachmentKey: 'PDFK2345', page: 2 } as const
    const store = preparedStore([])
    const html = renderToStaticMarkup(
      React.createElement(Reader, { route, store, t, notify, chat, onBack: () => {} }),
    )
    expect(html).toContain('PDF 阅读')
    // Pre-document render: zoom controls, sidebar toggle, progress state.
    expect(html).toContain('注释列表')
    expect(html).toContain('适应宽度')
    expect(html).toContain('正在加载 PDF')
    expect(html).toContain('dshZotPages')
    expect(html).toContain('aria-label')
  })
})
