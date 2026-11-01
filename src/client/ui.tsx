/**
 * Shared UI atoms and data hooks for the tab (adapted from the reference
 * implementation's `common.tsx` patterns, with attribution in
 * THIRD_PARTY_NOTICES.md; data flow reworked onto the plugin's own HTTP/SSE
 * client instead of the reference's host bridge).
 *
 * @module @hanxu131/dsh-zotero/client/ui
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError } from './api.ts'
import { Icon, type IconName } from './icons.tsx'
import { SEARCH_DEBOUNCE_MS, ZoteroStore, currentRoute, type ViewState } from './store.ts'

/** Translate function bound to the plugin locale namespace (host-provided). */
export type Translate = (key: string, params?: Record<string, string | number>) => string

export type Notify = (message: string, tone?: 'info' | 'error') => void

/** Friendly message for an error value (ApiError code first, fallback raw). */
export function errorText(t: Translate, error: unknown): string {
  if (error instanceof ApiError) {
    const friendly = t(`error.${error.code}`)
    return friendly.startsWith('error.') ? `${t('error.fallback')}: ${error.message}` : friendly
  }
  return error instanceof Error ? error.message : String(error)
}

/** Friendly message for a stored view error `{ code, message }`. */
export function viewErrorText(t: Translate, error: { code: string; message: string }): string {
  const friendly = t(`error.${error.code}`)
  return friendly.startsWith('error.') ? `${t('error.fallback')}: ${error.message}` : friendly
}

/** Icon-only ghost button with an accessible name. */
export function IconButton(props: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; active?: boolean; size?: number }): JSX.Element {
  return (
    <button
      type="button"
      className={`dshZotBtn dshZotGhost dshZotIconOnly${props.active ? ' dshZotActive' : ''}`}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={props.size} />
    </button>
  )
}

/** Centered empty / loading / error placeholder. */
export function Empty(props: { children: React.ReactNode }): JSX.Element {
  return <div className="dshZotEmpty">{props.children}</div>
}

/** Bottom transient toast. */
export function Toast(props: { message: string; tone?: 'info' | 'error'; onDismiss: () => void }): JSX.Element {
  const { onDismiss } = props
  useEffect(() => {
    const timer = setTimeout(onDismiss, props.tone === 'error' ? 8000 : 3500)
    return () => clearTimeout(timer)
  }, [props.message, props.tone, onDismiss])
  return (
    <div className={`dshZotToast ${props.tone ?? 'info'}`} role="status" onClick={onDismiss}>
      {props.tone === 'error' && <Icon name="alert" size={14} />}
      <span>{props.message}</span>
    </div>
  )
}

/**
 * Ask box: type a question, Enter sends, Shift+Enter newline, Esc closes.
 * The parent decides what "send" means (chat draft submit in queue mode).
 */
export function AskBox(props: { placeholder: string; sendLabel: string; closeLabel: string; onSend: (text: string) => void; onClose: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const submit = (): void => {
    if (text.trim() === '') return
    props.onSend(text)
    props.onClose()
  }
  return (
    <div className="dshZotAskBox">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            props.onClose()
          }
        }}
      />
      <div className="dshZotAskActions">
        <IconButton icon="x" label={props.closeLabel} onClick={props.onClose} />
        <button type="button" className="dshZotBtn dshZotPrimary" disabled={text.trim() === ''} onClick={submit}>
          <Icon name="message" size={14} />
          {props.sendLabel}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data hooks over the store
// ---------------------------------------------------------------------------

/** Snapshot of one view's data plus reload affordance. */
export interface UseViewResult<T> {
  data: T | undefined
  error: { code: string; message: string } | undefined
  loading: boolean
  reload: () => void
}

/**
 * Bind one view key to a loader. Triggers on mount and whenever the key
 * changes; results are dispatched through the store with generation tokens so
 * stale responses never overwrite newer ones.
 */
export function useViewData<T>(store: ZoteroStore, key: string | null, load: (signal: AbortSignal) => Promise<T>): UseViewResult<T> {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const [nonce, setNonce] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (key === null) return
    const existing = store.get().views[key]
    if (existing !== undefined && existing.phase === 'ready') return // cached until reload()
    const token = store.nextToken()
    const controller = new AbortController()
    controllerRef.current = controller
    store.dispatch({ type: 'viewLoad', key, token })
    let settled = false
    void loadRef
      .current(controller.signal)
      .then((data) => {
        if (settled || controller.signal.aborted) return
        settled = true
        store.dispatch({ type: 'viewData', key, token, data })
      })
      .catch((error: unknown) => {
        if (settled || controller.signal.aborted) return
        settled = true
        const code = error instanceof ApiError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        store.dispatch({ type: 'viewFail', key, token, code, message })
      })
    return () => {
      settled = true
      controller.abort()
    }
  }, [store, key, nonce])

  const reload = useCallback((): void => {
    controllerRef.current?.abort()
    setNonce((value) => value + 1)
  }, [])

  const view: ViewState | undefined = key === null ? undefined : state.views[key]
  return {
    data: view?.phase === 'ready' ? (view.data as T) : undefined,
    error: view?.phase === 'error' ? { code: view.code, message: view.message } : undefined,
    loading: view?.phase === 'loading',
    reload,
  }
}

/**
 * 300 ms search debounce: keeps the route's `draft` in sync while typing and
 * commits into `q` once typing pauses (spec: query replacement never enters
 * the history per-keystroke).
 */
export function useDebouncedQuery(store: ZoteroStore, text: string): void {
  useEffect(() => {
    const top = currentRoute(store.get())
    if (top.view !== 'library') return
    const trimmed = text.trim()
    if (top.q === (trimmed === '' ? undefined : trimmed)) return
    const timer = setTimeout(() => {
      store.dispatch({ type: 'queryCommit' })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [store, text])
}

/** Close-on-outside-click + Escape helper for inline menus. */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [ref, onClose])
}
