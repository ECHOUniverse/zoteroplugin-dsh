/**
 * Pure navigation/data store for the right-sidebar tab
 * (`docs/implementation-spec.md` §6 UI 信息架构, §8 client-store seam).
 *
 * The reducer is framework-free so vitest drives it directly
 * (`tests/client-store.test.ts`); `src/client.tsx` binds it to React through
 * a tiny observable wrapper. Host state never enters here: the client half
 * only stores what its own views need (routes, view fetch states, the last
 * applied view-event sequence). No Zotero key or server id appears in any
 * shape below.
 *
 * Route semantics (adapted from the reference implementation's stack, with
 * attribution in THIRD_PARTY_NOTICES.md):
 * - `push` grows the stack; navigating to the same route replaces the top
 *   entry so returning never walks back through duplicates.
 * - Search typing updates the top route's `draft` in place and `queryCommit`
 *   folds it into `q` — keystrokes never become history entries.
 * - `viewEvent` applies Agent navigation intents (SSE `open_item` /
 *   `show_items`) with `seq` dedupe; stale or repeated sequences are no-ops.
 * - The stack is capped at 30 entries (oldest dropped).
 *
 * @module @hanxu131/dsh-zotero/client/store
 */

import type { ViewIntent } from '../shared/protocol.ts'

/** How long typing pauses before the draft commits into the route query. */
export const SEARCH_DEBOUNCE_MS = 300

/** Maximum navigation-stack depth (reference implementation uses the same bound). */
export const STACK_LIMIT = 30

/** Library id as used on the wire (`user` or `g<id>`); validated host-side. */
export type LibraryId = string

/** Search scope of the panel list. */
export type SearchMode = 'titleCreatorYear' | 'everything'

/** Sort keys the host items route accepts. */
export type SortField = 'dateModified' | 'dateAdded' | 'title' | 'creator' | 'date'

/** Sort direction. */
export type SortDirection = 'asc' | 'desc'

/**
 * One tab-internal location. `reader` renders the lazily-loaded PDF chunk
 * (M4): page navigation replaces the top entry in place, so paging never
 * floods the history stack.
 */
export type Route =
  | {
      view: 'library'
      library: LibraryId
      /** Collection scope, when the list is narrowed to one collection. */
      collection?: string
      /** Saved-search scope, when the list runs a saved search. */
      search?: string
      /** Committed search text (`undefined` = unfiltered). */
      q?: string
      /** In-editor search text; committed into `q` by `queryCommit`. */
      draft: string
      mode: SearchMode
      sort: SortField
      direction: SortDirection
      /** Pages already folded into the list request (`limit = pages * 50 ≤ 500`). */
      pages: number
    }
  | { view: 'items'; library: LibraryId; title: string; keys: string[] }
  | { view: 'item'; library: LibraryId; key: string }
  | {
      view: 'reader'
      library: LibraryId
      itemKey: string
      attachmentKey: string
      /** 1-based target page (0 means unset until the reader measures). */
      page?: number
      /** Session highlight to focus/scroll to. */
      highlightId?: string
      /** Navigation nonce: re-targeting the same document re-runs the jump. */
      nonce?: number
    }
  | { view: 'settings' }

/** Fetch/render state of one data view, keyed by `viewKey`. */
export type ViewState =
  | { phase: 'idle' }
  | { phase: 'loading'; token: number }
  | { phase: 'ready'; token: number; data: unknown }
  | { phase: 'error'; token: number; code: string; message: string }

/** Whole client store state. */
export interface ClientState {
  stack: Route[]
  /** Last applied view-event sequence (`viewSeq` dedupe). */
  seenSeq: number
  views: Record<string, ViewState>
  /**
   * Last `highlights` nudge (session highlights changed). Readers watch it to
   * refresh their highlight layer; `null` until the first nudge arrives.
   */
  lastHighlight: { seq: number; library: LibraryId; attachmentKey: string } | null
}

/** All store mutations. */
export type Action =
  | { type: 'push'; route: Route }
  | { type: 'replace'; route: Route }
  | { type: 'back' }
  | { type: 'home'; library: LibraryId }
  | { type: 'viewEvent'; seq: number; intent: ViewIntent }
  | { type: 'queryDraft'; text: string }
  | { type: 'queryCommit' }
  | { type: 'loadMore' }
  | { type: 'viewLoad'; key: string; token: number }
  | { type: 'viewData'; key: string; token: number; data: unknown }
  | { type: 'viewFail'; key: string; token: number; code: string; message: string }
  | { type: 'reset' }

/** Fresh state: one library route at the personal library, nothing loaded. */
export function initialState(): ClientState {
  return {
    stack: [libraryRoute('user')],
    seenSeq: 0,
    views: {},
    lastHighlight: null,
  }
}

/** A library list route with defaults (`draft` empty, newest-first). */
export function libraryRoute(library: LibraryId): Extract<Route, { view: 'library' }> {
  return { view: 'library', library, draft: '', mode: 'titleCreatorYear', sort: 'dateModified', direction: 'desc', pages: 1 }
}

/**
 * Map one Agent view intent to the route it opens (pure; tested directly).
 * `highlights` nudges are state-only: they return `null` (no navigation).
 * `seq` becomes the reader route's nonce so a new open_item targeting the
 * same page re-runs the scroll.
 */
export function routeForIntent(intent: ViewIntent, seq: number): Route | null {
  switch (intent.kind) {
    case 'open_item':
      return intent.attachmentKey !== undefined
        ? {
            view: 'reader',
            library: intent.library,
            itemKey: intent.key,
            attachmentKey: intent.attachmentKey,
            ...(intent.page !== undefined ? { page: intent.page } : {}),
            nonce: seq,
          }
        : { view: 'item', library: intent.library, key: intent.key }
    case 'show_items':
      return { view: 'items', library: intent.library, title: intent.title ?? '', keys: [...intent.keys] }
    case 'highlights':
      return null
  }
}

/** Whether two routes render the same page (used to coalesce pushes). */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false
  switch (a.view) {
    case 'library':
      return (
        b.view === 'library' &&
        a.library === b.library &&
        a.collection === b.collection &&
        a.search === b.search &&
        a.q === b.q &&
        a.mode === b.mode &&
        a.sort === b.sort &&
        a.direction === b.direction &&
        a.pages === b.pages
      )
    case 'items':
      return b.view === 'items' && a.library === b.library && a.title === b.title && a.keys.join(',') === b.keys.join(',')
    case 'item':
      return b.view === 'item' && a.library === b.library && a.key === b.key
    case 'reader':
      // Identity is the document, not the page: page/highlight changes are
      // in-place replacements (paging never stacks history entries).
      return b.view === 'reader' && a.library === b.library && a.itemKey === b.itemKey && a.attachmentKey === b.attachmentKey
    case 'settings':
      return true
  }
}

/**
 * Canonical request descriptor for one view's data; identical keys share one
 * cached fetch state.
 */
export function viewKeyFor(route: Route): string | null {
  switch (route.view) {
    case 'library': {
      const limit = Math.min(route.pages * 50, 500)
      const scope = route.collection !== undefined ? `collection=${route.collection}` : route.search !== undefined ? `search=${route.search}` : 'all'
      const query = [route.q ?? '', route.mode, route.sort, route.direction, String(limit)].join('|')
      return `items:${route.library}:${scope}:${query}`
    }
    case 'items': {
      const keys = [...route.keys].sort().join(',')
      return `items:${route.library}:keys:${keys}`
    }
    case 'item':
      return `item:${route.library}/${route.key}`
    case 'reader':
      return `annotations:${route.library}/${route.attachmentKey}`
    case 'settings':
      return 'status'
  }
}

/** Fold a committed query change into a library route (pure helper). */
export function withCommittedQuery(route: Extract<Route, { view: 'library' }>): Route {
  const q = route.draft.trim()
  return { ...route, ...(q !== '' ? { q } : { q: undefined }), pages: 1 }
}

/** Apply one action; always returns a new state object for changed parts. */
export function reducer(state: ClientState, action: Action): ClientState {
  switch (action.type) {
    case 'push': {
      // Same page (e.g. the same item re-opened): replace in place instead of
      // stacking, so Back doesn't walk through duplicates (shared pushRoute).
      return { ...state, stack: pushRoute(state.stack, action.route) }
    }
    case 'replace':
      return replaceTop(state, action.route)
    case 'back':
      return state.stack.length <= 1 ? state : { ...state, stack: state.stack.slice(0, -1) }
    case 'home':
      return { ...state, stack: [libraryRoute(action.library)] }
    case 'viewEvent': {
      // viewSeq dedupe: replayed/older events never re-navigate.
      if (action.seq <= state.seenSeq) return state
      const route = routeForIntent(action.intent, action.seq)
      if (route === null) {
        // State-only nudge (session highlights changed): record it for the
        // open reader, no navigation.
        return action.intent.kind === 'highlights'
          ? { ...state, seenSeq: action.seq, lastHighlight: { seq: action.seq, library: action.intent.library, attachmentKey: action.intent.attachmentKey } }
          : { ...state, seenSeq: action.seq }
      }
      return { ...state, seenSeq: action.seq, stack: pushRoute(state.stack, route) }
    }
    case 'queryDraft': {
      const top = state.stack[state.stack.length - 1]
      if (top === undefined || top.view !== 'library' || top.draft === action.text) return state
      return replaceTop(state, { ...top, draft: action.text })
    }
    case 'queryCommit': {
      const top = state.stack[state.stack.length - 1]
      if (top === undefined || top.view !== 'library') return state
      const next = withCommittedQuery(top)
      return sameRoute(top, next) ? state : replaceTop(state, next)
    }
    case 'loadMore': {
      const top = state.stack[state.stack.length - 1]
      if (top === undefined || top.view !== 'library') return state
      const pages = Math.min(top.pages + 1, 10) // 10 pages × 50 = panel cap 500
      if (pages === top.pages) return state
      return replaceTop(state, { ...top, pages })
    }
    case 'viewLoad': {
      const current = state.views[action.key]
      if (current !== undefined && current.phase !== 'idle' && current.phase !== 'error' && current.token > action.token) {
        return state // stale load request for a newer view generation
      }
      return { ...state, views: { ...state.views, [action.key]: { phase: 'loading', token: action.token } } }
    }
    case 'viewData': {
      const current = state.views[action.key]
      if (current !== undefined && current.phase !== 'idle' && action.token < current.token) return state
      return { ...state, views: { ...state.views, [action.key]: { phase: 'ready', token: action.token, data: action.data } } }
    }
    case 'viewFail': {
      const current = state.views[action.key]
      if (current !== undefined && current.phase !== 'idle' && action.token < current.token) return state
      return { ...state, views: { ...state.views, [action.key]: { phase: 'error', token: action.token, code: action.code, message: action.message } } }
    }
    case 'reset':
      return initialState()
  }
}

function pushRoute(stack: Route[], route: Route): Route[] {
  const current = stack[stack.length - 1]
  if (current !== undefined && sameRoute(current, route)) {
    const next = [...stack]
    next[next.length - 1] = route
    return next
  }
  const grown = [...stack, route]
  if (grown.length > STACK_LIMIT) grown.splice(0, grown.length - STACK_LIMIT)
  return grown
}

function replaceTop(state: ClientState, route: Route): ClientState {
  const stack = [...state.stack]
  stack[stack.length - 1] = route
  return { ...state, stack }
}

/**
 * Observable store binding the pure reducer for React
 * (`useSyncExternalStore`). One instance per module: page-type tabs dedupe
 * within a pane, and two panes intentionally share one navigation state
 * (same choice as the reference implementation).
 */
export class ZoteroStore {
  private state: ClientState
  /** Fetch-token source, kept out of the reactive snapshot (bookkeeping only). */
  private tokenCounter = 0
  private readonly listeners = new Set<() => void>()

  constructor(initial: ClientState = initialState()) {
    this.state = initial
  }

  get = (): ClientState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Advance the token counter and return the fresh value for one fetch. */
  nextToken(): number {
    this.tokenCounter += 1
    return this.tokenCounter
  }

  dispatch = (action: Action): void => {
    const next = reducer(this.state, action)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/** Current top route (always defined: the stack never empties). */
export function currentRoute(state: ClientState): Route {
  return state.stack[state.stack.length - 1] ?? libraryRoute('user')
}
