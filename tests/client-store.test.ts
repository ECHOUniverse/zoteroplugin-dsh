/**
 * `src/client/store.ts` pure reducer tests: navigation stack, viewSeq dedupe,
 * query draft/commit (debounce logic without timers), view fetch states, and
 * the stack bound (implementation spec §8 client-store seam).
 */
import { describe, expect, it } from 'vitest'
import {
  STACK_LIMIT,
  currentRoute,
  initialState,
  libraryRoute,
  reducer,
  routeForIntent,
  sameRoute,
  viewKeyFor,
  ZoteroStore,
  withCommittedQuery,
  type ClientState,
  type Route,
} from '../src/client/store.ts'

const item = (key: string): Route => ({ view: 'item', library: 'user', key })

describe('navigation stack', () => {
  it('starts at the personal library route', () => {
    const state = initialState()
    expect(state.stack).toHaveLength(1)
    expect(state.stack[0]?.view).toBe('library')
    expect(currentRoute(state).view).toBe('library')
  })

  it('push grows the stack and back pops it', () => {
    let state = initialState()
    state = reducer(state, { type: 'push', route: item('ABCD2345') })
    state = reducer(state, { type: 'push', route: { view: 'settings' } })
    expect(state.stack.map((route) => route.view)).toEqual(['library', 'item', 'settings'])
    state = reducer(state, { type: 'back' })
    expect(currentRoute(state)).toEqual(item('ABCD2345'))
    state = reducer(state, { type: 'back' })
    expect(state.stack).toHaveLength(1)
    // The stack never empties.
    state = reducer(state, { type: 'back' })
    expect(state.stack).toHaveLength(1)
  })

  it('pushing the identical route replaces the top instead of stacking', () => {
    let state = initialState()
    state = reducer(state, { type: 'push', route: item('ABCD2345') })
    state = reducer(state, { type: 'push', route: item('ABCD2345') })
    expect(state.stack).toHaveLength(2)
    expect(sameRoute(item('ABCD2345'), item('ABCD2345'))).toBe(true)
    expect(sameRoute(item('ABCD2345'), item('BCDE3456'))).toBe(false)
  })

  it('caps the stack at 30 entries, dropping the oldest', () => {
    let state = initialState()
    for (let index = 0; index < STACK_LIMIT + 5; index += 1) {
      state = reducer(state, { type: 'push', route: item(`ABCD234${index % 10}`.slice(0, 8)) })
    }
    expect(state.stack).toHaveLength(STACK_LIMIT)
  })

  it('replace swaps the top without changing depth', () => {
    let state = initialState()
    state = reducer(state, { type: 'push', route: item('ABCD2345') })
    state = reducer(state, { type: 'replace', route: { view: 'settings' } })
    expect(state.stack).toHaveLength(2)
    expect(currentRoute(state).view).toBe('settings')
  })

  it('home resets to a single library route', () => {
    let state = initialState()
    state = reducer(state, { type: 'push', route: item('ABCD2345') })
    state = reducer(state, { type: 'home', library: 'g12345' })
    expect(state.stack).toHaveLength(1)
    expect(currentRoute(state)).toMatchObject({ view: 'library', library: 'g12345' })
  })
})

describe('view events (Agent open_item / show_items)', () => {
  it('open_item without attachment pushes an item route', () => {
    const state = reducer(initialState(), {
      type: 'viewEvent',
      seq: 1,
      intent: { kind: 'open_item', library: 'user', key: 'ABCD2345' },
    })
    expect(state.seenSeq).toBe(1)
    expect(currentRoute(state)).toEqual({ view: 'item', library: 'user', key: 'ABCD2345' })
  })

  it('open_item with attachment opens the reader route (M4 reader)', () => {
    const state = reducer(initialState(), {
      type: 'viewEvent',
      seq: 4,
      intent: { kind: 'open_item', library: 'user', key: 'ABCD2345', attachmentKey: 'PDFK2345', page: 3 },
    })
    expect(currentRoute(state)).toEqual({ view: 'reader', library: 'user', itemKey: 'ABCD2345', attachmentKey: 'PDFK2345', page: 3, nonce: 4 })
  })

  it('show_items pushes an agent items route with keys and title', () => {
    const state = reducer(initialState(), {
      type: 'viewEvent',
      seq: 2,
      intent: { kind: 'show_items', library: 'g9', keys: ['ABCD2345', 'BCDE3456'], title: 'Dataset' },
    })
    expect(currentRoute(state)).toEqual({ view: 'items', library: 'g9', title: 'Dataset', keys: ['ABCD2345', 'BCDE3456'] })
  })

  it('highlights nudge is state-only: no navigation, lastHighlight recorded', () => {
    const state = reducer(initialState(), {
      type: 'viewEvent',
      seq: 7,
      intent: { kind: 'highlights', library: 'user', attachmentKey: 'PDFK2345' },
    })
    expect(currentRoute(state).view).toBe('library')
    expect(state.seenSeq).toBe(7)
    expect(state.lastHighlight).toEqual({ seq: 7, library: 'user', attachmentKey: 'PDFK2345' })
    // An older nudge never overwrites a newer one.
    const older = reducer(state, { type: 'viewEvent', seq: 3, intent: { kind: 'highlights', library: 'user', attachmentKey: 'OTHERAAA' } })
    expect(older.lastHighlight).toEqual({ seq: 7, library: 'user', attachmentKey: 'PDFK2345' })
  })

  it('page changes replace in place instead of stacking reader entries', () => {
    const first = reducer(initialState(), {
      type: 'viewEvent',
      seq: 1,
      intent: { kind: 'open_item', library: 'user', key: 'ABCD2345', attachmentKey: 'PDFK2345', page: 1 },
    })
    const depth = first.stack.length
    const second = reducer(first, { type: 'replace', route: { ...currentRoute(first), page: 5, nonce: 99 } as Route })
    expect(second.stack).toHaveLength(depth)
    expect(currentRoute(second)).toMatchObject({ view: 'reader', page: 5 })
  })

  it('dedupes by seq: repeated or older events never re-navigate', () => {
    const base = reducer(initialState(), { type: 'viewEvent', seq: 5, intent: { kind: 'open_item', library: 'user', key: 'ABCD2345' } })
    const replay = reducer(base, { type: 'viewEvent', seq: 5, intent: { kind: 'open_item', library: 'user', key: 'ABCD2345' } })
    expect(replay).toBe(base)
    const older = reducer(base, { type: 'viewEvent', seq: 2, intent: { kind: 'open_item', library: 'user', key: 'ZZZZ9999' } })
    expect(older).toBe(base)
  })

  it('routeForIntent is exported pure for tests', () => {
    expect(routeForIntent({ kind: 'open_item', library: 'user', key: 'ABCD2345' }, 9)).toEqual(item('ABCD2345'))
    expect(routeForIntent({ kind: 'highlights', library: 'user', attachmentKey: 'PDFK2345' }, 10)).toBeNull()
  })
})

describe('search query draft and commit (debounce-friendly)', () => {
  const typing = (state: ClientState, text: string): ClientState => reducer(state, { type: 'queryDraft', text })

  it('typing updates the top route draft without touching the stack depth', () => {
    let state = initialState()
    const depth = state.stack.length
    state = typing(state, 'deep')
    expect(state.stack).toHaveLength(depth)
    expect(currentRoute(state)).toMatchObject({ view: 'library', draft: 'deep' })
  })

  it('commit folds the trimmed draft into q and resets pages', () => {
    let route = { ...libraryRoute('user'), draft: '  deep learning  ', pages: 4 }
    route = withCommittedQuery(route) as typeof route
    expect(route.q).toBe('deep learning')
    expect(route.pages).toBe(1)
  })

  it('commit with blank text clears q', () => {
    let state = initialState()
    state = reducer(state, { type: 'queryDraft', text: '   ' })
    state = reducer(state, { type: 'queryCommit' })
    expect(currentRoute(state).q).toBeUndefined()
  })

  it('commit is idempotent: same q twice returns the same state', () => {
    let state = initialState()
    state = typing(state, 'deep')
    const committed = reducer(state, { type: 'queryCommit' })
    const again = reducer(committed, { type: 'queryCommit' })
    expect(again).toBe(committed)
  })

  it('loadMore bumps pages up to the 500-item panel cap', () => {
    let state = initialState()
    for (let index = 0; index < 20; index += 1) state = reducer(state, { type: 'loadMore' })
    expect(currentRoute(state)).toMatchObject({ pages: 10 })
    expect(viewKeyFor(currentRoute(state))).toContain('500')
  })
})

describe('view data states', () => {
  it('loading → ready stores data under the view key', () => {
    let state = initialState()
    state = reducer(state, { type: 'viewLoad', key: 'items:user:all:|titleCreatorYear|dateModified|desc|50', token: 1 })
    expect(state.views['items:user:all:|titleCreatorYear|dateModified|desc|50']).toMatchObject({ phase: 'loading', token: 1 })
    state = reducer(state, { type: 'viewData', key: 'items:user:all:|titleCreatorYear|dateModified|desc|50', token: 1, data: { total: 0 } })
    expect(state.views['items:user:all:|titleCreatorYear|dateModified|desc|50']).toMatchObject({ phase: 'ready', data: { total: 0 } })
  })

  it('stale tokens never overwrite newer view generations', () => {
    const key = 'item:user/ABCD2345'
    let state = initialState()
    state = reducer(state, { type: 'viewLoad', key, token: 5 })
    state = reducer(state, { type: 'viewData', key, token: 2, data: 'stale' })
    expect(state.views[key]).toMatchObject({ phase: 'loading', token: 5 })
    state = reducer(state, { type: 'viewFail', key, token: 5, code: 'not_found', message: 'gone' })
    expect(state.views[key]).toMatchObject({ phase: 'error', code: 'not_found' })
  })

  it('viewKeyFor is stable per request shape', () => {
    const a = viewKeyFor({ ...libraryRoute('user'), q: 'x', pages: 2 })
    const b = viewKeyFor({ ...libraryRoute('user'), q: 'x', pages: 2 })
    expect(a).toBe(b)
    expect(viewKeyFor({ ...libraryRoute('user'), q: 'x', pages: 3 })).not.toBe(a)
    expect(viewKeyFor({ view: 'settings' })).toBe('status')
    expect(viewKeyFor({ view: 'items', library: 'user', title: 't', keys: ['B', 'A'] })).toBe('items:user:keys:A,B')
  })
})

describe('ZoteroStore observable wrapper', () => {
  it('notifies subscribers on change and not on no-op actions', () => {
    const store = new ZoteroStore()
    let runs = 0
    const off = store.subscribe(() => {
      runs += 1
    })
    store.dispatch({ type: 'push', route: item('ABCD2345') })
    expect(runs).toBe(1)
    store.dispatch({ type: 'back' })
    expect(runs).toBe(2)
    // back at the root is a no-op → no notification
    store.dispatch({ type: 'back' })
    expect(runs).toBe(2)
    off()
    store.dispatch({ type: 'push', route: item('BCDE3456') })
    expect(runs).toBe(2)
    expect(store.get().stack).toHaveLength(2)
  })

  it('nextToken hands out strictly increasing tokens', () => {
    const store = new ZoteroStore()
    expect(store.nextToken()).toBe(1)
    expect(store.nextToken()).toBe(2)
  })
})
