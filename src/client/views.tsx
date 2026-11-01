/**
 * Tab views: Setup/connection, Library (list + search + scope + sort +
 * selection), Agent items, Item detail, and the explicit reader boundary
 * (implementation spec §6; UI logic adapted from the reference
 * implementation's `Library.tsx` / `ItemView.tsx` / `Setup.tsx` with
 * attribution in THIRD_PARTY_NOTICES.md — data flow reworked onto this
 * plugin's own `/dsh-zotero` HTTP/SSE client).
 *
 * All rendered rows/buttons carry accessible names; menus close on Escape and
 * outside clicks; rows open on Enter through real buttons.
 *
 * @module @hanxu131/dsh-zotero/client/views
 */

import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  downloadExport,
  getAnnotations,
  getCollections,
  getItem,
  getItems,
  getLibraries,
  getStatus,
  launchZotero,
  showInZotero,
  type ItemsQueryParams,
} from './api.ts'
import { addToChat, ask, itemsDraftText, type ChatFace } from './chat-draft.ts'
import { Icon } from './icons.tsx'
import type { Translate } from './ui.tsx'
import { AskBox, Empty, IconButton, errorText, viewErrorText, useDismiss, useDebouncedQuery, useViewData, type Notify } from './ui.tsx'
import {
  libraryRoute,
  viewKeyFor,
  type LibraryId,
  type Route,
  type SearchMode,
  type SortDirection,
  type SortField,
  type ZoteroStore,
} from './store.ts'
import type {
  AnnotationWire,
  CollectionsResponse,
  ItemDetailWire,
  ItemSummaryWire,
  LibrariesResponse,
  StatusResponse,
} from '../shared/protocol.ts'

/** Localized item-type label (falls back to the raw Zotero type id). */
function itemTypeLabel(t: Translate, type: string): string {
  const label = t(`itemType.${type}`)
  return label.startsWith('itemType.') ? type : label
}

/** Chat face + session availability, extracted defensively at the entry. */
export interface ChatInfo {
  face: ChatFace | null
  /** Live session bound to this tab (`sessionId` prop present). */
  hasSession: boolean
  /** Input phase busy (`adjudicating`/`submitting`) — actions wait. */
  busy: boolean
}

type ViewProps = { store: ZoteroStore; t: Translate; notify: Notify; chat: ChatInfo }

// ---------------------------------------------------------------------------
// Setup / connection
// ---------------------------------------------------------------------------

/** Connection-state lamp + guidance per state (ready/not_installed/not_running/api_disabled/unsupported/error). */
export function SetupView({ store, t, notify, showDetail = true }: ViewProps & { showDetail?: boolean }): JSX.Element {
  const status = useViewData<StatusResponse>(store, 'status', (signal) => getStatus({ signal }))
  const data = status.data
  const state = data?.state ?? 'unknown'
  const refreshing = status.loading
  const install = data?.install
  // "Not installed" and "installed but not started" get different guidance.
  const notInstalled = state === 'not_running' && install !== undefined && install.state === 'missing'

  // Open Zotero: an explicit user click on an explicit button; failures show
  // an error message (the button recovers — the host reports spawn failures).
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const openZotero = (): void => {
    if (opening) return
    setOpening(true)
    setOpenError(null)
    void launchZotero()
      .then(() => {
        notify(t('setup.installedHint', { version: install?.version ?? '' }))
        status.reload()
      })
      .catch((error: unknown) => {
        setOpenError(errorText(t, error))
      })
      .finally(() => setOpening(false))
  }

  const title = (() => {
    if (status.error !== undefined) return t('setup.hostUnreachable')
    if (data === undefined) return t('setup.connecting')
    if (notInstalled) return t('setup.notInstalledTitle')
    switch (state) {
      case 'ready':
        return t('setup.readyTitle')
      case 'not_running':
        return t('setup.notRunningTitle')
      case 'api_disabled':
        return t('setup.apiDisabledTitle')
      case 'unsupported':
        return t('setup.unsupportedTitle')
      default:
        return t('setup.errorTitle')
    }
  })()

  const lamp = status.error !== undefined ? 'bad' : data === undefined ? '' : state === 'ready' ? 'ok' : state === 'error' ? 'bad' : 'warn'

  return (
    <div className="dshZotSetup">
      <div className="dshZotSetupHead">
        <span className="dshZotSetupIcon">
          <Icon name="plugged" size={18} />
        </span>
        <div className="dshZotGrow">
          <div className="dshZotSetupTitle">{title}</div>
          <div className="dshZotBarTitle">
            <span className={`dshZotLamp ${lamp}`} aria-hidden="true" /> {t('setup.statusLabel')}
            {data !== undefined && data.zoteroVersion !== undefined ? ` · Zotero ${data.zoteroVersion}` : ''}
            {install !== undefined && install.state === 'found' && install.version !== undefined ? ` · ${t('setup.installedHint', { version: install.version })}` : ''}
            {refreshing ? ` · ${t('common.loading')}` : ''}
          </div>
        </div>
        <IconButton icon="refresh" label={t('setup.checkAgain')} onClick={status.reload} disabled={refreshing} />
      </div>

      {status.error !== undefined ? (
        <>
          <p className="dshZotSetupLead">{t('setup.hostUnreachable')}</p>
          <pre className="dshZotErrorBox">{status.error.message}</pre>
        </>
      ) : data === undefined ? (
        <p className="dshZotSetupLead">{t('setup.connecting')}</p>
      ) : (
        <>
          {/* The configured Local API address, shown in every state. Editing
              stays in the DSH plugin settings form (localApiBaseUrl); the
              panel deliberately exposes no URL-write route. */}
          <p className="dshZotSetupMeta">
            {t('setup.localApiAddress')}: <code>{data.baseUrl}</code> · {t('setup.localApiAddressEdit')}
          </p>
          {notInstalled && (
            <>
              <p className="dshZotSetupLead">{t('setup.notInstalledBody')}</p>
              {install.searched !== undefined && install.searched.length > 0 && (
                <p className="dshZotSetupMeta">{install.searched.join(' · ')}</p>
              )}
            </>
          )}
          {state === 'ready' && (
            <>
              <p className="dshZotSetupLead">{t('setup.readyBody', { version: data.zoteroVersion ?? '10+' })}</p>
              {showDetail && <p className="dshZotSetupMeta">{t('setup.writeHint')}</p>}
            </>
          )}
          {state === 'not_running' && !notInstalled && (
            <>
              <p className="dshZotSetupLead">{t('setup.notRunningBody')}</p>
              <div className="dshZotActions">
                <button type="button" className="dshZotBtn dshZotPrimary" disabled={opening} onClick={openZotero}>
                  <Icon name="power" size={13} />
                  {opening ? t('setup.opening') : t('setup.openZotero')}
                </button>
              </div>
              {openError !== null && <pre className="dshZotErrorBox">{openError}</pre>}
              <div className="dshZotSetupCard">
                <ol className="dshZotSteps">
                  <li>{t('setup.apiDisabledStep1')}</li>
                </ol>
              </div>
            </>
          )}
          {state === 'api_disabled' && (
            <>
              <p className="dshZotSetupLead">{t('setup.apiDisabledBody')}</p>
              <div className="dshZotSetupCard">
                <ol className="dshZotSteps">
                  <li>{t('setup.apiDisabledStep1')}</li>
                  <li>{t('setup.apiDisabledStep2')}</li>
                  <li>{t('setup.apiDisabledStep3')}</li>
                </ol>
              </div>
            </>
          )}
          {state === 'unsupported' && (
            <p className="dshZotSetupLead">{t('setup.unsupportedBody', { version: data.zoteroVersion ?? '?' })}</p>
          )}
          {state === 'error' && (
            <>
              <p className="dshZotSetupLead">{t('setup.errorTitle')}</p>
              {data.error !== undefined && <pre className="dshZotErrorBox">{data.error}</pre>}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item list + selection (shared by library and agent views)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50
const PANEL_MAX = 500

/** One list row: checkbox, main button, PDF chip. */
function ItemRow(props: {
  item: ItemSummaryWire
  selected: boolean
  onToggle: (event: React.MouseEvent | React.KeyboardEvent) => void
  onOpen: () => void
  onOpenPdf: () => void
  t: Translate
}): JSX.Element {
  const { t, item } = props
  const meta = [item.creatorSummary, item.year, item.venue].filter(Boolean).join(' · ')
  return (
    <li className={`dshZotRow${props.selected ? ' selected' : ''}`} data-key={item.key}>
      <button
        type="button"
        role="checkbox"
        aria-checked={props.selected}
        aria-label={item.title}
        className="dshZotCheck"
        onClick={(event) => props.onToggle(event)}
      >
        {props.selected && <Icon name="check" size={12} />}
      </button>
      <button
        type="button"
        className="dshZotRowMain"
        onClick={(event) => (event.metaKey || event.ctrlKey || event.shiftKey ? props.onToggle(event) : props.onOpen())}
      >
        <span className="dshZotRowTitle">{item.title}</span>
        <span className="dshZotRowMeta">
          <span className="dshZotRowType">{itemTypeLabel(t, item.itemType)}</span>
          {meta !== '' && <span className="dshZotRowMetaText">{meta}</span>}
        </span>
      </button>
      {item.pdf !== null && (
        <button type="button" className="dshZotPdfChip" title={t('reader.title')} aria-label={`${t('reader.title')}: ${item.title}`} onClick={props.onOpenPdf}>
          <Icon name="file" size={10} />
          PDF
        </button>
      )}
    </li>
  )
}

/** Multi-select list with the Add to chat / Ask / Clear bottom bar. */
function ItemListView(props: ViewProps & { library: LibraryId; list: ItemSummaryWire[] }): JSX.Element {
  const { store, t, notify, chat, library, list } = props
  const [selected, setSelected] = useState<string[]>([])
  const [asking, setAsking] = useState(false)
  const anchor = useRef<number | null>(null)
  const byKey = useMemo(() => new Map(list.map((item) => [item.key, item])), [list])
  const chosen = selected.map((key) => byKey.get(key)).filter((item): item is ItemSummaryWire => item !== undefined)

  const toggle = (index: number, event: React.MouseEvent | React.KeyboardEvent): void => {
    const key = list[index]?.key
    if (key === undefined) return
    if (event.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)]
      const range = list.slice(from, to + 1).map((item) => item.key)
      setSelected((current) => [...new Set([...current, ...range])])
    } else {
      setSelected((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]))
    }
    anchor.current = index
  }

  // Add to chat is async now: guard against double clicks / overlapping
  // writes with a ref (synchronous) plus state (drives the disabled attr);
  // on any failure the draft is left untouched and the user is told so.
  const [writing, setWriting] = useState(false)
  const writingRef = useRef(false)
  const writeDraft = (): void => {
    if (writingRef.current) return
    writingRef.current = true
    setWriting(true)
    void (async () => {
      try {
        const outcome = await addToChat(chat.face, itemsDraftText(chosen, library))
        if (outcome === 'unavailable') {
          notify(chat.face === null ? t('chat.unavailable') : t('chat.addFailed'), 'error')
          return
        }
        notify(t('chat.addedToChat'))
      } finally {
        writingRef.current = false
        setWriting(false)
      }
    })()
  }

  const disabled = chat.face === null || chat.busy

  return (
    <>
      <ul className="dshZotList" aria-multiselectable="true">
        {list.map((item, index) => (
          <ItemRow
            key={item.key}
            item={item}
            t={t}
            selected={selected.includes(item.key)}
            onToggle={(event) => toggle(index, event)}
            onOpen={() => store.dispatch({ type: 'push', route: { view: 'item', library, key: item.key } })}
            onOpenPdf={() =>
              item.pdf !== null &&
              store.dispatch({ type: 'push', route: { view: 'reader', library, itemKey: item.key, attachmentKey: item.pdf.key } })
            }
          />
        ))}
      </ul>
      {chosen.length > 0 && (
        <div className="dshZotSelectionBar">
          {asking ? (
            <AskBox
              placeholder={chosen.length === 1 ? t('chat.askPlaceholderOne') : t('chat.askPlaceholder', { n: chosen.length })}
              sendLabel={t('common.send')}
              closeLabel={t('common.close')}
              onClose={() => setAsking(false)}
              onSend={(question) => {
                const outcome = ask(chat.face, question, chosen, library)
                if (outcome === 'unavailable') {
                  notify(t('chat.unavailable'), 'error')
                  return
                }
                setSelected([])
              }}
            />
          ) : (
            <div className="dshZotSelectionRow">
              <span className="dshZotCount">{t('chat.selected', { n: chosen.length })}</span>
              <span className="dshZotGrow" />
              <button type="button" className="dshZotBtn dshZotGhost" disabled={disabled || writing} title={chat.face === null ? t('chat.unavailable') : undefined} onClick={writeDraft}>
                <Icon name="plus" size={13} />
                {t('chat.addToChat')}
              </button>
              <button type="button" className="dshZotBtn dshZotPrimary" disabled={disabled} title={chat.face === null ? t('chat.unavailable') : undefined} onClick={() => setAsking(true)}>
                <Icon name="message" size={13} />
                {t('chat.ask')}
              </button>
              <IconButton icon="x" label={t('chat.clearSelection')} onClick={() => setSelected([])} />
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** Loading / empty / error(+retry) wrapper for data views. */
function DataGate(props: { t: Translate; loading: boolean; error?: { code: string; message: string }; hasData: boolean; empty: ReactNode; onRetry: () => void; children: ReactNode }): JSX.Element {
  const { t, loading, error, hasData, empty, onRetry } = props
  if (error !== undefined && !hasData) {
    return (
      <Empty>
        <p className="dshZotErrorBox">{viewErrorText(t, error)}</p>
        <button type="button" className="dshZotBtn" onClick={onRetry}>
          {t('common.retry')}
        </button>
      </Empty>
    )
  }
  if (loading && !hasData) return <Empty>{t('common.loading')}</Empty>
  if (!hasData) return <Empty>{empty}</Empty>
  return <>{props.children}</>
}

// ---------------------------------------------------------------------------
// Scope menu (libraries / collections tree / saved searches) and sort menu
// ---------------------------------------------------------------------------

const SORTS: readonly SortField[] = ['dateModified', 'dateAdded', 'title', 'creator', 'date']

function ScopeMenu(props: {
  library: LibraryId
  libraries: LibrariesResponse | undefined
  doc: CollectionsResponse | undefined
  route: Extract<Route, { view: 'library' }>
  t: Translate
  onPick: (route: Route) => void
  onClose: () => void
}): JSX.Element {
  const { t, route, doc, libraries, onPick, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<Set<string>>(() => {
    const expanded = new Set<string>()
    let current = doc?.collections.find((node) => node.key === route.collection)
    while (current !== undefined && current.parent !== null && current.parent !== undefined) {
      expanded.add(current.parent)
      const parent = current.parent
      current = doc?.collections.find((node) => node.key === parent)
    }
    return expanded
  })
  useDismiss(ref, onClose)

  const children = (parent: string | null) => doc?.collections.filter((node) => node.parent === parent) ?? []
  const row = (node: CollectionsResponse['collections'][number], depth: number): ReactNode => {
    const kids = children(node.key)
    const expanded = open.has(node.key)
    return (
      <div key={node.key}>
        <div className={`dshZotMenuRow${route.collection === node.key ? ' current' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {kids.length > 0 ? (
            <button
              type="button"
              className="dshZotTwisty"
              aria-label={node.name}
              aria-expanded={expanded}
              onClick={() =>
                setOpen((current) => {
                  const next = new Set(current)
                  if (next.has(node.key)) next.delete(node.key)
                  else next.add(node.key)
                  return next
                })
              }
            >
              <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
            </button>
          ) : (
            <span className="dshZotTwisty" />
          )}
          <button type="button" className="dshZotMenuPick" onClick={() => onPick({ ...libraryRoute(route.library), collection: node.key, draft: route.draft })}>
            <Icon name="folder" size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
            <span className="dshZotMenuCount dshZotCount">{node.numItems > 0 ? node.numItems : ''}</span>
          </button>
        </div>
        {expanded && kids.map((kid) => row(kid, depth + 1))}
      </div>
    )
  }

  return (
    <div className="dshZotMenu" ref={ref} role="menu" aria-label={t('library.scopePick')}>
      {libraries !== undefined && libraries.libraries.length > 1 && (
        <>
          <div className="dshZotMenuLabel">{t('library.libraries')}</div>
          {libraries.libraries.map((entry) => (
            <div
              key={entry.id}
              className={`dshZotMenuRow${entry.id === route.library && route.collection === undefined && route.search === undefined ? ' current' : ''}`}
            >
              <span className="dshZotTwisty" />
              <button type="button" className="dshZotMenuPick" onClick={() => onPick(libraryRoute(entry.id))}>
                <Icon name="library" size={14} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.type === 'user' ? t('library.myLibrary') : entry.name}
                </span>
              </button>
            </div>
          ))}
          <div className="dshZotMenuSep" />
        </>
      )}
      <div className={`dshZotMenuRow${route.collection === undefined && route.search === undefined ? ' current' : ''}`}>
        <span className="dshZotTwisty" />
        <button type="button" className="dshZotMenuPick" onClick={() => onPick(libraryRoute(route.library))}>
          <Icon name="library" size={14} />
          {t('library.allItems')}
        </button>
      </div>
      {doc !== undefined && doc.collections.length > 0 && <div className="dshZotMenuLabel">{t('library.collections')}</div>}
      {children(null).map((node) => row(node, 0))}
      {doc !== undefined && doc.searches.length > 0 && (
        <>
          <div className="dshZotMenuLabel">{t('library.savedSearches')}</div>
          {doc.searches.map((search) => (
            <div key={search.key} className={`dshZotMenuRow${route.search === search.key ? ' current' : ''}`}>
              <span className="dshZotTwisty" />
              <button type="button" className="dshZotMenuPick" onClick={() => onPick({ ...libraryRoute(route.library), search: search.key, draft: route.draft })}>
                <Icon name="savedSearch" size={14} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{search.name}</span>
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function SortMenu(props: { route: Extract<Route, { view: 'library' }>; t: Translate; onPick: (patch: { sort?: SortField; direction?: SortDirection }) => void; onClose: () => void }): JSX.Element {
  const { t, route, onPick, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose)
  return (
    <div className="dshZotMenu right" ref={ref} role="menu" aria-label={t('library.sort')}>
      {SORTS.map((sort) => (
        <div key={sort} className={`dshZotMenuRow${route.sort === sort ? ' current' : ''}`}>
          <button type="button" role="menuitemradio" aria-checked={route.sort === sort} className="dshZotMenuPick" onClick={() => onPick({ sort })}>
            <span style={{ width: 14, display: 'inline-flex' }}>{route.sort === sort && <Icon name="check" size={13} />}</span>
            {t(`library.sort.${sort}`)}
          </button>
        </div>
      ))}
      <div className="dshZotMenuSep" />
      <div className="dshZotMenuRow">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={route.direction === 'desc'}
          className="dshZotMenuPick"
          onClick={() => onPick({ direction: route.direction === 'desc' ? 'asc' : 'desc' })}
        >
          <span style={{ width: 14, display: 'inline-flex' }} aria-hidden="true">
            {route.direction === 'desc' ? '↓' : '↑'}
          </span>
          {route.direction === 'desc' ? 'desc' : 'asc'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Library view
// ---------------------------------------------------------------------------

/** Library list + scope + search + sort + pagination. */
export function LibraryView(props: ViewProps & { route: Extract<Route, { view: 'library' }> }): JSX.Element {
  const { store, t, notify } = props
  const route = props.route
  const [text, setText] = useState(route.q ?? route.draft)
  const [menu, setMenu] = useState<null | 'scope' | 'sort'>(null)

  // Re-sync the editor when the scope or the committed query changes
  // (library switch, collection pick, external navigation).
  useEffect(() => {
    setText(route.q ?? route.draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.library, route.collection, route.search, route.q])

  const libraries = useViewData<LibrariesResponse>(store, 'libraries', (signal) => getLibraries({ signal }))
  const collections = useViewData<CollectionsResponse>(store, `collections:${route.library}`, (signal) =>
    getCollections(route.library, { signal }),
  )
  const limit = Math.min(route.pages * PAGE_SIZE, PANEL_MAX)
  const listQuery: ItemsQueryParams = {
    library: route.library,
    ...(route.q !== undefined ? { q: route.q } : {}),
    ...(route.mode === 'everything' ? { mode: 'everything' } : {}),
    ...(route.collection !== undefined ? { collection: route.collection } : {}),
    ...(route.search !== undefined ? { search: route.search } : {}),
    sort: route.sort,
    direction: route.direction,
    start: 0,
    limit,
  }
  const key = viewKeyFor(route) ?? 'items'
  const list = useViewData(store, key, (signal) => getItems(listQuery, { signal }))
  useDebouncedQuery(store, text)

  const data = list.data
  const everything = route.mode === 'everything'

  const scopeName = (() => {
    if (route.collection !== undefined) return collections.data?.collections.find((node) => node.key === route.collection)?.name ?? '…'
    if (route.search !== undefined) return collections.data?.searches.find((search) => search.key === route.search)?.name ?? '…'
    const lib = libraries.data?.libraries.find((entry) => entry.id === route.library)
    return lib === undefined || lib.type === 'user' ? t('library.myLibrary') : lib.name
  })()

  const update = (next: Route): void => {
    setMenu(null)
    store.dispatch({ type: 'replace', route: next })
  }

  const setQuery = (patch: Partial<Extract<Route, { view: 'library' }>>): void => {
    update({ ...route, ...patch })
  }

  return (
    <div className="dshZot">
      <header className="dshZotBar">
        <div className="dshZotMenuAnchor">
          <button
            type="button"
            className="dshZotBtn dshZotGhost dshZotScopeBtn"
            aria-haspopup="menu"
            aria-expanded={menu === 'scope'}
            onClick={() => setMenu(menu === 'scope' ? null : 'scope')}
          >
            <Icon name={route.collection !== undefined ? 'folder' : route.search !== undefined ? 'savedSearch' : 'library'} size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scopeName}</span>
            <Icon name="chevronDown" size={13} />
          </button>
          {menu === 'scope' && (
            <ScopeMenu
              library={route.library}
              libraries={libraries.data}
              doc={collections.data}
              route={route}
              t={t}
              onPick={update}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
        <span className="dshZotGrow" />
        {data !== undefined && <span className="dshZotCount">{t('library.items', { n: data.total })}</span>}
        <div className="dshZotMenuAnchor">
          <IconButton icon="sort" label={t('library.sort')} active={menu === 'sort'} onClick={() => setMenu(menu === 'sort' ? null : 'sort')} />
          {menu === 'sort' && <SortMenu route={route} t={t} onPick={(patch) => setQuery(patch)} onClose={() => setMenu(null)} />}
        </div>
      </header>

      <div className="dshZotSearch">
        <Icon name="search" size={15} />
        <input
          type="search"
          value={text}
          placeholder={everything ? t('library.everythingPlaceholder') : t('library.searchPlaceholder')}
          aria-label={t('library.search')}
          onChange={(event) => {
            setText(event.target.value)
            store.dispatch({ type: 'queryDraft', text: event.target.value })
          }}
        />
        <label className="dshZotToggle" title={t('library.searchEverything')}>
          <input
            type="checkbox"
            checked={everything}
            onChange={(event) => setQuery({ mode: (event.target.checked ? 'everything' : 'titleCreatorYear') as SearchMode })}
          />
          <span>{t('library.searchEverything')}</span>
        </label>
      </div>

      <div className="dshZotScroll">
        <DataGate
          t={t}
          loading={list.loading}
          error={list.error}
          hasData={data !== undefined && data.items.length > 0}
          empty={route.q !== undefined ? t('library.noResults') : t('library.noItems')}
          onRetry={list.reload}
        >
          <ItemListView store={store} t={t} notify={notify} chat={props.chat} library={route.library} list={data?.items ?? []} />
          {data !== undefined && data.total > data.items.length && limit < PANEL_MAX && (
            <div className="dshZotMore">
              <button type="button" className="dshZotBtn" onClick={() => store.dispatch({ type: 'loadMore' })}>
                {t('library.loadMore')}
              </button>
            </div>
          )}
          {data !== undefined && data.total > data.items.length && limit >= PANEL_MAX && (
            <div className="dshZotMore">
              <span className="dshZotCount">{t('library.loadedMax')}</span>
            </div>
          )}
        </DataGate>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent items view
// ---------------------------------------------------------------------------

/** Items listed by an Agent `show_items` intent. */
export function AgentItemsView(props: ViewProps & { route: Extract<Route, { view: 'items' }>; onBack: () => void }): JSX.Element {
  const { store, t, route } = props
  const key = viewKeyFor(route) ?? 'items'
  const list = useViewData(store, key, (signal) => getItems({ library: route.library, keys: route.keys }, { signal }))
  return (
    <div className="dshZot">
      <header className="dshZotBar">
        <button type="button" className="dshZotBack" onClick={props.onBack} aria-label={t('common.back')}>
          <Icon name="back" size={15} />
        </button>
        <span className="dshZotBarTitle dshZotStrong" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {route.title !== '' ? route.title : t('library.allItems')}
        </span>
        <span className="dshZotGrow" />
        <span className="dshZotCount">{t('library.items', { n: route.keys.length })}</span>
      </header>
      <div className="dshZotScroll">
        <DataGate t={t} loading={list.loading} error={list.error} hasData={list.data !== undefined} empty={t('library.noItems')} onRetry={list.reload}>
          <ItemListView store={store} t={t} notify={props.notify} chat={props.chat} library={route.library} list={list.data?.items ?? []} />
        </DataGate>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item detail
// ---------------------------------------------------------------------------

const FIELD_ORDER = [
  'publicationTitle',
  'proceedingsTitle',
  'conferenceName',
  'bookTitle',
  'repository',
  'archiveID',
  'publisher',
  'university',
  'institution',
  'date',
  'volume',
  'issue',
  'pages',
  'DOI',
  'ISBN',
  'ISSN',
  'url',
  'language',
  'extra',
] as const

/**
 * Sanitized note HTML (DOMPurify; scripts and dangerous URLs removed). When
 * the sanitizer is unavailable (DOM-less test/SSR environment) the note is
 * degraded to a plain-text projection — raw HTML is never emitted unsanitized.
 */
function SafeNote(props: { html: string }): JSX.Element {
  const clean = useMemo(() => {
    const sanitize = (DOMPurify as { sanitize?: (dirty: string, config?: Record<string, unknown>) => string }).sanitize
    if (typeof sanitize !== 'function') return null
    return sanitize(props.html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'img'], FORBID_ATTR: ['style'] })
  }, [props.html])
  if (clean === null) {
    return <div className="dshZotNoteBody">{props.html.replace(/<[^>]*>/g, ' ')}</div>
  }
  return <div className="dshZotNoteBody" dangerouslySetInnerHTML={{ __html: clean }} />
}

function NoteBlock(props: { html: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`dshZotNote${open ? '' : ' clamped'}`}>
      <SafeNote html={props.html} />
      <button type="button" className="dshZotLink" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '−' : '+'}
      </button>
    </div>
  )
}

function Section(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="dshZotSection">
      <h3 className="dshZotSectionHead">{props.label}</h3>
      {props.children}
    </section>
  )
}

function AnnotationList(props: { annotations: AnnotationWire[]; t: Translate; onOpen: (annotation: AnnotationWire) => void }): JSX.Element | null {
  const { t } = props
  if (props.annotations.length === 0) return null
  return (
    <Section label={t('detail.annotations')}>
      <ul className="dshZotAnnotations">
        {props.annotations.map((annotation) => (
          <li key={annotation.key}>
            <button type="button" className="dshZotAnnotation" onClick={() => props.onOpen(annotation)}>
              <span className="dshZotSwatch" style={{ background: annotation.color }} aria-hidden="true" />
              <span className="dshZotAnnotationBody">
                {annotation.text !== '' && <span className="dshZotAnnotationQuote">{annotation.text}</span>}
                {annotation.comment !== '' && <span className="dshZotAnnotationComment">{annotation.comment}</span>}
                <span className="dshZotAnnotationPage">
                  <Icon name="file" size={10} /> {t('detail.page', { page: annotation.pageLabel })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Item detail: creators, fields, abstract, notes, collections, tags, attachments, annotations, export, chat actions. */
export function ItemDetailView(props: ViewProps & { route: Extract<Route, { view: 'item' }>; onBack: () => void }): JSX.Element {
  const { store, t, notify, chat, route } = props
  const [asking, setAsking] = useState(false)
  const [abstractOpen, setAbstractOpen] = useState(false)
  const key = viewKeyFor(route) ?? `item:${route.library}/${route.key}`
  const detail = useViewData<ItemDetailWire>(store, key, (signal) => getItem(route.library, route.key, { signal }))
  const annotations = useViewData(store, `annotations:${route.library}/${route.key}`, (signal) =>
    getAnnotations(route.library, route.key, { signal }),
  )
  const item = detail.data
  const [exporting, setExporting] = useState(false)
  // Add-to-chat write in flight (ref guards synchronously, state drives the
  // disabled attr) — see writeDraft below.
  const [writing, setWriting] = useState(false)
  const writingRef = useRef(false)
  // Show in Zotero: opens the server-built zotero://select deep link.
  const [revealing, setRevealing] = useState(false)
  const showInZoteroNow = (): void => {
    if (revealing) return
    setRevealing(true)
    void showInZotero({ library: route.library, key: route.key, target: 'select' })
      .then(() => notify(t('detail.showInZoteroDone')))
      .catch((error: unknown) => notify(t('detail.showInZoteroFailed', { message: errorText(t, error) }), 'error'))
      .finally(() => setRevealing(false))
  }

  const doExport = async (format: 'bib' | 'ris'): Promise<void> => {
    if (item === undefined) return
    setExporting(true)
    try {
      await downloadExport(route.library, format, { keys: [item.key] })
      notify(t('detail.exportDone', { format: format.toUpperCase() }))
    } catch (error) {
      notify(errorText(t, error), 'error')
    } finally {
      setExporting(false)
    }
  }

  if (item === undefined) {
    return (
      <div className="dshZot">
        <header className="dshZotBar">
          <button type="button" className="dshZotBack" onClick={props.onBack} aria-label={t('common.back')}>
            <Icon name="back" size={15} />
          </button>
        </header>
        <div className="dshZotScroll">
          {detail.error !== undefined ? (
            <Empty>
              <p className="dshZotErrorBox">{viewErrorText(t, detail.error)}</p>
              <button type="button" className="dshZotBtn" onClick={detail.reload}>
                {t('common.retry')}
              </button>
            </Empty>
          ) : (
            <Empty>{t('common.loading')}</Empty>
          )}
        </div>
      </div>
    )
  }

  const pdfs = item.attachments.filter((attachment) => attachment.isPdf)
  const firstPdf = pdfs[0]
  const fields = FIELD_ORDER.filter((field) => item.fields[field] !== undefined).map((field) => [field, item.fields[field]] as const)
  const disabled = chat.face === null || chat.busy

  const openPdf = (attachmentKey: string): void => {
    store.dispatch({ type: 'push', route: { view: 'reader', library: route.library, itemKey: item.key, attachmentKey } })
  }

  // Add to chat is async now: the ref+state guard prevents double clicks; on
  // any failure the draft is left untouched and the user is told so.
  const writeDraft = (): void => {
    if (writingRef.current) return
    writingRef.current = true
    setWriting(true)
    void (async () => {
      try {
        const outcome = await addToChat(chat.face, itemsDraftText([item], route.library))
        if (outcome === 'unavailable') {
          notify(chat.face === null ? t('chat.unavailable') : t('chat.addFailed'), 'error')
          return
        }
        notify(t('chat.addedToChat'))
      } finally {
        writingRef.current = false
        setWriting(false)
      }
    })()
  }

  return (
    <div className="dshZot">
      <header className="dshZotBar">
        <button type="button" className="dshZotBack" onClick={props.onBack} aria-label={t('common.back')}>
          <Icon name="back" size={15} />
        </button>
        <span className="dshZotBarTitle dshZotGrow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {itemTypeLabel(t, item.itemType)}
        </span>
        <button type="button" className="dshZotBtn dshZotGhost" disabled={revealing} title={t('detail.showInZotero')} onClick={showInZoteroNow}>
          <Icon name="library" size={13} />
          {t('detail.showInZotero')}
        </button>
      </header>
      <div className="dshZotScroll">
        <div className="dshZotDetail">
          <h2 className="dshZotDetailTitle">{item.title}</h2>
          {item.creators.length > 0 && (
            <p className="dshZotCreators">
              {item.creators
                .map((creator) => creator.name ?? [creator.firstName, creator.lastName].filter(Boolean).join(' '))
                .filter(Boolean)
                .join(', ')}
            </p>
          )}
          <p className="dshZotCreators">{[item.venue, item.year].filter(Boolean).join(' · ')}</p>

          <div className="dshZotActions">
            {firstPdf !== undefined && (
              <button type="button" className="dshZotBtn dshZotGhost" onClick={() => openPdf(firstPdf.key)}>
                <Icon name="file" size={13} />
                PDF
              </button>
            )}
            <button type="button" className="dshZotBtn dshZotPrimary" disabled={disabled} title={chat.face === null ? t('chat.unavailable') : undefined} onClick={() => setAsking(!asking)}>
              <Icon name="message" size={13} />
              {t('chat.ask')}
            </button>
            <button type="button" className="dshZotBtn dshZotGhost" disabled={disabled || writing} title={chat.face === null ? t('chat.unavailable') : undefined} onClick={writeDraft}>
              <Icon name="plus" size={13} />
              {t('chat.addToChat')}
            </button>
          </div>
          {asking && (
            <AskBox
              placeholder={t('chat.askPlaceholderOne')}
              sendLabel={t('common.send')}
              closeLabel={t('common.close')}
              onClose={() => setAsking(false)}
              onSend={(question) => {
                const outcome = ask(chat.face, question, [item], route.library)
                if (outcome === 'unavailable') notify(t('chat.unavailable'), 'error')
              }}
            />
          )}

          {item.abstract !== '' && (
            <Section label={t('detail.abstract')}>
              <p className={`dshZotAbstract${abstractOpen ? '' : ' clamped'}`}>{item.abstract}</p>
              {item.abstract.length > 360 && (
                <button type="button" className="dshZotLink" aria-expanded={abstractOpen} onClick={() => setAbstractOpen(!abstractOpen)}>
                  {abstractOpen ? t('detail.showLess') : t('detail.showMore')}
                </button>
              )}
            </Section>
          )}

          {annotations.data !== undefined && annotations.data.annotations.length > 0 && (
            <AnnotationList
              annotations={annotations.data.annotations}
              t={t}
              onOpen={(annotation) => {
                const attachmentKey = annotations.data?.attachment
                if (attachmentKey !== null && attachmentKey !== undefined) {
                  store.dispatch({
                    type: 'push',
                    route: {
                      view: 'reader',
                      library: route.library,
                      itemKey: item.key,
                      attachmentKey,
                      page: annotation.pageIndex + 1,
                      nonce: Date.now(),
                    },
                  })
                }
              }}
            />
          )}

          {item.notes.length > 0 && (
            <Section label={`${t('detail.notes')} (${item.notes.length})`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {item.notes.map((note) => (
                  <NoteBlock key={note.key} html={note.html} />
                ))}
              </div>
            </Section>
          )}

          {fields.length > 0 && (
            <Section label={t('detail.info')}>
              <dl className="dshZotFields">
                {fields.map(([field, value]) => (
                  <div key={field} className="dshZotFieldRow">
                    <dt>{field}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {item.collections.length > 0 && (
            <Section label={t('detail.collections')}>
              <div className="dshZotChips">
                {item.collections.map((collection) => (
                  <button
                    type="button"
                    key={collection.key}
                    className="dshZotChip"
                    onClick={() =>
                      store.dispatch({ type: 'push', route: { ...libraryRoute(route.library), collection: collection.key } })
                    }
                  >
                    <Icon name="folder" size={12} />
                    {collection.name}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {item.tags.length > 0 && (
            <Section label={t('detail.tags')}>
              <div className="dshZotChips">
                {item.tags.map((tag) => (
                  <span key={tag} className="dshZotChip">
                    <Icon name="tag" size={12} />
                    {tag}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {item.attachments.length > 0 && (
            <Section label={t('detail.attachments')}>
              <ul className="dshZotAttachments">
                {item.attachments.map((attachment) => (
                  <li key={attachment.key}>
                    <button
                      type="button"
                      className="dshZotAttachment"
                      disabled={!attachment.isPdf}
                      onClick={() => attachment.isPdf && openPdf(attachment.key)}
                    >
                      <Icon name="file" size={14} />
                      <span className="dshZotAttachmentTitle">{attachment.title}</span>
                      <span className="dshZotAttachmentKind">{attachment.isPdf ? 'PDF' : attachment.contentType || attachment.linkMode}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="dshZotActions">
            <button type="button" className="dshZotBtn" disabled={exporting} onClick={() => void doExport('bib')}>
              {t('detail.exportBib')}
            </button>
            <button type="button" className="dshZotBtn" disabled={exporting} onClick={() => void doExport('ris')}>
              {t('detail.exportRis')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reader (lazy chunk)
// ---------------------------------------------------------------------------

// The PDF reader itself lives in the lazy `client.pdf.js` chunk
// (`src/client/reader.tsx`, loaded by src/client.tsx through the official
// package-local chunk contract); this module only opens reader routes.
// The former M4 boundary is gone: routes render the real reader.
