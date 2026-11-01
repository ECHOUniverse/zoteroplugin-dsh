/**
 * Browser half of `@hanxu131/dsh-zotero`.
 *
 * M2/M3/M4/M8 milestone: the right-sidebar tab is the single-tab app shell.
 * It:
 *
 * 1. registers the right-sidebar page-type tab (`sidebarRightTabs`, kind
 *    `zotero`) plus its keyed body on `sidebar.right.pane.tab` — page tabs
 *    dedupe per pane, realizing the "single tab" decision (ADR 0002);
 * 2. renders the internal navigation stack from `client/store.ts`
 *    (Library → Item detail → PDF Reader → Agent items → Connection);
 * 3. talks to the host half only through same-origin relative fetches on the
 *    shared `ROUTES` (`client/api.ts`) — no Zotero key, no direct Zotero
 *    connection;
 * 4. subscribes to the host's SSE view events and applies Agent navigation
 *    intents (`open_item` / `show_items`, plus `highlights` refresh nudges)
 *    with `seq` dedupe;
 * 5. writes chat drafts and submits asks through the OFFICIAL session-scoped
 *    `inputActions` standard prop of this slot (DSH `sidebar.right.pane.tab`
 *    contract; see `client/chat-draft.ts` for the evidence). The face is used
 *    defensively: when no session scope is live the buttons are disabled —
 *    there is no clipboard fallback and no silent send.
 *
 * The PDF reader ships in a separate lazy chunk (`client.pdf.js`, built from
 * `src/client-pdf.tsx`): opening a reader route loads it through the
 * official package-local chunk contract (`require.async('./client.pdf.js')`,
 * dsh-client-modules `ClientBundleRequire.async`), so browsing a plain
 * library never downloads pdf.js.
 *
 * The slot props shape (`hooks.tabInfo`, `sessionId`, `inputActions`) is read
 * defensively until verified on a real host (verification point V-1).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { PLUGIN_NAME, PLUGIN_VERSION, type ViewEvent } from './shared/protocol.ts'
import { connectViewEvents, getStatus, type ViewStreamHandle } from './client/api.ts'
import { chatFaceFrom, type ChatFace } from './client/chat-draft.ts'
import { DICTIONARIES } from './client/i18n.ts'
import { Icon } from './client/icons.tsx'
import { CSS } from './client/styles.ts'
import { ZoteroStore, currentRoute, type Route } from './client/store.ts'
import { Toast, useViewData, type Notify, type Translate } from './client/ui.tsx'
import { AgentItemsView, ItemDetailView, LibraryView, SetupView, type ChatInfo } from './client/views.tsx'

/** Locale namespace of this bundle. */
export const NAMESPACE = 'zotero'

/** Tab-type implementation identity: unique across the tab system; the package name is the natural value. */
export const TAB_DEFINITION_ID = PLUGIN_NAME

/** Tab-type discriminator: what `openTab` names for this page. */
export const TAB_KIND = 'zotero'

/** Translate function bound to the plugin's locale namespace. */
type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/** Minimal ClientContext face this half touches (runtime values come from Cordis). */
interface ClientContext {
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): TranslateFn
  }
  slots: {
    inject(slot: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  sidebarRightTabs: {
    register(definition: {
      readonly id: string
      readonly kind: string
      readonly title: (address: string) => string
      readonly guide?: readonly {
        readonly id: string
        readonly order: number
        readonly title: () => string
        readonly description?: () => string
      }[]
    }): () => void
  }
  effect(callback: () => void | (() => void), label?: string): () => void
}

/** Defensive shape of the slot-injected tab-info hook (verified on a real host later). */
interface TabInfoStub {
  readonly tab?: { readonly address?: string }
}

/**
 * Standard props the framework may inject into a `sidebar.right.pane.tab`
 * component when a session scope is live (`scope: "session"`): `sessionId`
 * and the chat `inputActions` face. All optional — the tab keeps working for
 * plain library browsing without them.
 */
interface ZoteroTabProps {
  /** Locale translate bound at apply time (passed through registration). */
  t: TranslateFn
  hooks?: { tabInfo?: () => TabInfoStub }
  sessionId?: string
  inputActions?: unknown
  useInput?: (selector: (state: { phase: string }) => unknown) => unknown
}

/** Module-level store singleton (page tabs dedupe per pane; see store.ts). */
const store = new ZoteroStore()

/** Chat context shared by all views of this tab instance. */
const ChatContext = createContext<ChatInfo>({ face: null, hasSession: false, busy: false })

/** Install the stylesheet once; returns its removal cleanup. */
function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = 'style[data-plugin-css="zotero-tab"]'
  if (document.querySelector(selector) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_NAME
  tag.dataset.pluginCss = 'zotero-tab'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** The lazy chunk's exports (Reader + pdf helpers), once loaded. */
interface PdfChunk {
  Reader: (props: {
    route: Extract<Route, { view: 'reader' }>
    store: ZoteroStore
    t: TranslateFn
    notify: Notify
    chat: ChatInfo
    onBack: () => void
  }) => ReactNode
}

/**
 * Package-local chunk loader over the official contract: the factory's
 * `require.async('./client.pdf.js')` fetches/registers/materializes the
 * sibling chunk (dsh-client-modules `importChunk`). The `require` symbol
 * below is the one the module-loader envelope passes to this factory.
 */
type ChunkRequire = { async(specifier: string): Promise<unknown> }
declare const require: ChunkRequire

let pdfChunkPromise: Promise<PdfChunk> | null = null
function loadPdfChunk(): Promise<PdfChunk> {
  pdfChunkPromise ??= require.async('./client.pdf.js') as Promise<PdfChunk>
  return pdfChunkPromise
}

function ReaderSlot(props: { route: Extract<Route, { view: 'reader' }>; t: TranslateFn; notify: Notify; onBack: () => void }): JSX.Element {
  const { route, t, notify, onBack } = props
  const chat = useContext(ChatContext)
  const [chunk, setChunk] = useState<PdfChunk | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    loadPdfChunk()
      .then((loaded) => {
        if (!cancelled) setChunk(loaded)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (chunk !== null) return <chunk.Reader route={route} store={store} t={t} notify={notify} chat={chat} onBack={onBack} />
  return (
    <div className="dshZot">
      <header className="dshZotBar">
        <button type="button" className="dshZotBack" onClick={onBack} aria-label={t('common.back')}>
          <Icon name="back" size={15} />
        </button>
        <span className="dshZotBarTitle dshZotStrong">{t('reader.title')}</span>
      </header>
      <div className="dshZotReader">{failed ? <div className="dshZotErrorBox">{t('reader.chunkFailed')}</div> : <div className="dshZotReaderNote">{t('common.loading')}</div>}</div>
    </div>
  )
}

/** Route → view switch (pure structure; data flows through the store). */
function RouteView(props: { route: Route; t: TranslateFn; notify: Notify; onBack: () => void }): JSX.Element {
  const { route, t, notify, onBack } = props
  const chat = useContext(ChatContext)
  switch (route.view) {
    case 'library':
      return <LibraryView store={store} t={t} notify={notify} chat={chat} route={route} />
    case 'items':
      return <AgentItemsView store={store} t={t} notify={notify} chat={chat} route={route} onBack={onBack} />
    case 'item':
      return <ItemDetailView store={store} t={t} notify={notify} chat={chat} route={route} onBack={onBack} />
    case 'reader':
      return <ReaderSlot route={route} t={t} notify={notify} onBack={onBack} />
    case 'settings':
      return <SetupView store={store} t={t} notify={notify} chat={chat} />
  }
}

/** Full app: connection gate, route views, toasts. */
function ZoteroApp(props: { t: TranslateFn }): JSX.Element {
  const { t } = props
  const chat = useContext(ChatContext)
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const [toast, setToast] = useState<{ message: string; tone?: 'info' | 'error' } | null>(null)
  const dismiss = useCallback(() => setToast(null), [])
  const notify = useMemo<Notify>(() => (message, tone) => setToast({ message, tone }), [])

  const status = useViewData(store, 'status', (signal) => getStatus({ signal }))
  const route = currentRoute(state)
  const statusData = status.data
  const ready = statusData?.state === 'ready'

  if (route.view === 'settings' || !ready) {
    // Settings route, first probe, and every not-ready state show the
    // connection card (guidance is per state).
    return (
      <div className="dshZotRoot">
        <SetupView store={store} t={t} notify={notify} chat={chat} showDetail />
        {toast !== null && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
      </div>
    )
  }

  return (
    <div className="dshZotRoot">
      <div className="dshZot">
        <RouteView route={route} t={t} notify={notify} onBack={() => store.dispatch({ type: 'back' })} />
      </div>
      {toast !== null && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  )
}

/**
 * The tab body. Standard session-scope props (`sessionId`, `inputActions`,
 * `useInput`) are read defensively; the chat context they feed powers the
 * Add-to-chat / Ask actions everywhere in the tab.
 */
function ZoteroTab(props: ZoteroTabProps): JSX.Element {
  const t = props.t
  // Live input phase (queued submission in flight); read defensively — the
  // prop only exists while the session scope provides the input store.
  const inputPhase = (() => {
    try {
      if (typeof props.useInput !== 'function') return undefined
      return props.useInput((state: { phase?: string }) => state.phase) as string | undefined
    } catch {
      return undefined
    }
  })()
  const chat = useMemo<ChatInfo>(() => {
    const face = chatFaceFrom(props)
    const busy = inputPhase === 'adjudicating' || inputPhase === 'submitting'
    return { face, hasSession: typeof props.sessionId === 'string' && props.sessionId !== '', busy }
  }, [props.inputActions, props.sessionId, inputPhase])

  // SSE view events drive navigation; dedupe happens in api + reducer.
  useEffect(() => {
    const handle: ViewStreamHandle = connectViewEvents({
      fromSeq: store.get().seenSeq,
      onEvent: (event: ViewEvent) => {
        store.dispatch({ type: 'viewEvent', seq: event.seq, intent: event.intent })
      },
    })
    return () => {
      handle.close()
    }
  }, [])

  return (
    <ChatContext.Provider value={chat}>
      <ZoteroApp t={t} />
    </ChatContext.Provider>
  )
}

/** Required browser services: the slot registry, copy, and the right-sidebar tab registry. */
export const inject = ['slots', 'locale', 'sidebarRightTabs'] as const

/**
 * Mount the browser half: dictionaries, styles, the tab-type registration and
 * the keyed tab-body registration.
 *
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NAMESPACE)

  ctx.effect(() => ctx.locale.register(NAMESPACE, { ...DICTIONARIES }), 'zotero: dictionaries')
  ctx.effect(() => installStyles(), 'zotero: styles')

  // Stage one: what the tab type IS. A page type (no patterns), opened by kind,
  // one per pane — pages always deduplicate within the target pane.
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_DEFINITION_ID,
        kind: TAB_KIND,
        title: () => t('tab.title'),
        guide: [
          {
            id: 'zotero-library',
            order: 100,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          },
        ],
      }),
    'zotero: tab type',
  )

  // Stage two: the body under the same definition id, dispatched for every tab
  // of this kind in every pane. Standard session-scope props (sessionId,
  // inputActions, useInput) arrive here when a chat session is live.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_DEFINITION_ID, locale: NAMESPACE },
          function ZoteroTabBody(tabProps: ZoteroTabProps) {
            return <ZoteroTab {...tabProps} t={t} />
          },
        ),
      ),
    'zotero: tab body',
  )
}
