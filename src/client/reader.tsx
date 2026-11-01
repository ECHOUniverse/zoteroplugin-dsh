/**
 * PDF Reader view (M4, ships inside the lazy `client.pdf.js` chunk): pdf.js
 * canvas + text layer, page navigation (in-place route replacement), zoom /
 * fit-width, printed page labels, the user-annotation sidebar, the Agent
 * highlight overlay (purple), selection toolbar (Add to chat / Ask) and the
 * mark popover with save-to-Zotero / remove-session actions.
 *
 * Attribution: view structure and interaction model adapted from
 * zai-org/zcode-plugins `ui-plugins/zotero` `ui/Reader.tsx` (repo LICENSE:
 * Apache-2.0). Modifications: data flows through this plugin's `/dsh-zotero`
 * HTTP client (no host bridge); save/remove use the UI write routes
 * (`writes/highlights/*` — explicit UI actions, no DSH approval); highlight
 * refresh rides the SSE `highlights` nudge through the store; Show-in-Zotero
 * asks the host to open the server-built `zotero://open-pdf` deep link;
 * copy reuses this plugin's i18n dictionaries. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/client/reader
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clearSessionHighlights, getAnnotations, getItem, saveHighlights, showInZotero } from './api.ts'
import { addQuoteToChat, askQuote, type ChatFace, type QuoteRef } from './chat-draft.ts'
import { loadPdf, TextLayer, toViewport, type LoadedPdf, type PDFDocumentProxy } from './pdf.ts'
import type { HighlightWire, ItemDetailWire, AnnotationsResponse } from '../shared/protocol.ts'
import type { AnnotationWire, RectWire } from '../shared/protocol.ts'
import { Icon } from './icons.tsx'
import type { Route, ZoteroStore } from './store.ts'
import { AskBox, Empty, IconButton, errorText, viewErrorText, type Notify, type Translate } from './ui.tsx'

type ReaderRoute = Extract<Route, { view: 'reader' }>

interface PageSize {
  width: number
  height: number
}

const GAP = 12
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4

/** Page sizes at scale 1, measured up-front; unread pages reuse page one. */
async function pageSizes(doc: PDFDocumentProxy): Promise<PageSize[]> {
  const sizes: PageSize[] = []
  for (let index = 1; index <= doc.numPages; index++) {
    const page = await doc.getPage(index)
    const viewport = page.getViewport({ scale: 1 })
    sizes.push({ width: viewport.width, height: viewport.height })
  }
  return sizes
}

type Mark =
  | { kind: 'annotation'; annotation: AnnotationWire }
  | { kind: 'highlight'; highlight: HighlightWire }

const markId = (mark: Mark): string => (mark.kind === 'annotation' ? mark.annotation.key : mark.highlight.id)

function PageView(props: {
  doc: PDFDocumentProxy
  index: number
  size: PageSize
  scale: number
  visible: boolean
  marks: Mark[]
  focused: string | null
  onMark: (mark: Mark, element: HTMLElement) => void
}): JSX.Element {
  const { doc, index, size, scale, visible, marks, focused, onMark } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number; convertToViewportPoint: (x: number, y: number) => number[] } | null>(null)
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    if (!visible) {
      setRendered(false)
      const canvas = canvasRef.current
      if (canvas !== null) {
        canvas.width = 0
        canvas.height = 0
      }
      if (textRef.current !== null) textRef.current.replaceChildren()
      return
    }
    let cancelled = false
    let task: { cancel: () => void } | null = null
    let layer: { cancel: () => void } | null = null
    void (async () => {
      const page = await doc.getPage(index + 1)
      if (cancelled) return
      const view = page.getViewport({ scale })
      setViewport(view as unknown as { width: number; height: number; convertToViewportPoint: (x: number, y: number) => number[] })
      const canvas = canvasRef.current
      if (canvas === null) return
      const ratio = Math.min(window.devicePixelRatio || 1, 3)
      canvas.width = Math.floor(view.width * ratio)
      canvas.height = Math.floor(view.height * ratio)
      canvas.style.width = `${view.width}px`
      canvas.style.height = `${view.height}px`
      const context = canvas.getContext('2d')
      if (context === null) return
      const renderTask = page.render({ canvasContext: context, viewport: view, ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}) } as never)
      task = renderTask
      try {
        await renderTask.promise
      } catch {
        return // cancelled (zoomed or scrolled out of view)
      }
      if (cancelled) return
      setRendered(true)
      const container = textRef.current
      if (container === null) return
      container.replaceChildren()
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container,
        viewport: view,
      })
      layer = textLayer
      await textLayer.render().catch(() => undefined)
    })()
    return () => {
      cancelled = true
      task?.cancel()
      layer?.cancel()
    }
  }, [doc, index, scale, visible])

  const width = size.width * scale
  const height = size.height * scale
  // The text layer sits above the marks (so text stays selectable); clicks
  // hit marks by coordinates, and a live text selection never counts as one.
  const hit = (event: React.MouseEvent<HTMLDivElement>): HTMLElement | undefined => {
    const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('.dshZotMark')]
    return elements.findLast((element) => {
      const box = element.getBoundingClientRect()
      return event.clientX >= box.left - 1 && event.clientX <= box.right + 1 && event.clientY >= box.top - 1 && event.clientY <= box.bottom + 1
    })
  }
  return (
    <div
      className="dshZotPage"
      data-page={index}
      style={{ width, height, ['--scale-factor' as string]: scale, ['--total-scale-factor' as string]: scale }}
      onClick={(event) => {
        if ((window.getSelection()?.toString() ?? '').trim() !== '') return
        const element = hit(event)
        const mark = element !== undefined ? marks.find((entry) => markId(entry) === element.dataset.mark) : undefined
        if (element !== undefined && mark !== undefined) onMark(mark, element)
      }}
      onMouseMove={(event) => event.currentTarget.classList.toggle('dshZotOverMark', hit(event) !== undefined)}
    >
      <canvas ref={canvasRef} className={rendered ? '' : 'dshZotPending'} />
      <div ref={textRef} className="dshZotTextLayer" />
      {viewport !== null && (
        <div className="dshZotMarks">
          {marks.map((mark) => {
            const id = markId(mark)
            const rects = mark.kind === 'annotation' ? mark.annotation.rects : mark.highlight.rects
            const color = mark.kind === 'annotation' ? mark.annotation.color : mark.highlight.color
            const type = mark.kind === 'annotation' ? mark.annotation.type : 'agent'
            if (type === 'ink') return null
            return rects.map((rect: RectWire, part: number) => {
              const box = toViewport(viewport, rect)
              const style =
                type === 'note'
                  ? { left: box.left, top: box.top, width: Math.max(box.width, 16), height: Math.max(box.height, 16), ['--mark' as string]: color }
                  : { left: box.left, top: box.top, width: box.width, height: box.height, ['--mark' as string]: color }
              return (
                <button
                  type="button"
                  key={`${id}-${part}`}
                  className={`dshZotMark dshZotMark_${type}${focused === id ? ' dshZotMarkFocused' : ''}`}
                  data-mark={id}
                  style={style}
                  aria-label={mark.kind === 'annotation' ? mark.annotation.comment || mark.annotation.text || type : mark.highlight.comment || mark.highlight.quote}
                  onClick={(event) => {
                    // Only keyboard (Enter/Space) lands on the button directly;
                    // mouse clicks are resolved by the coordinate hit above.
                    event.stopPropagation()
                    onMark(mark, event.currentTarget)
                  }}
                >
                  {part === 0 && mark.kind === 'highlight' && <span className="dshZotMarkBadge">✦</span>}
                </button>
              )
            })
          })}
        </div>
      )}
    </div>
  )
}

function MarkPopover(props: {
  mark: Mark
  anchor: { left: number; top: number }
  s: Translate
  notify: Notify
  onClose: () => void
}): JSX.Element {
  const { mark, anchor, s, notify, onClose } = props
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('.dshZotMark')) onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])
  const isAgent = mark.kind === 'highlight'
  const text = isAgent ? mark.highlight.quote : mark.annotation.text
  const comment = isAgent ? mark.highlight.comment : mark.annotation.comment
  const pageLabel = isAgent ? mark.highlight.pageLabel : mark.annotation.pageLabel
  return (
    <div className="dshZotPopover" ref={ref} style={{ left: anchor.left, top: anchor.top }} role="dialog">
      <div className="dshZotPopoverHead">
        {isAgent ? (
          <span className="dshZotWho dshZotWhoAgent">
            <Icon name="sparkles" size={12} />
            {s('reader.agent')}
          </span>
        ) : (
          <span className="dshZotWho">
            <span className="dshZotSwatch" style={{ background: mark.annotation.color }} />
            {s('reader.you')}
          </span>
        )}
        <span className="dshZotMuted dshZotSmall">
          {s('reader.page')} {pageLabel}
        </span>
        <span className="dshZotGrow" />
        <IconButton icon="x" label={s('common.close')} size={14} onClick={onClose} />
      </div>
      {text !== '' && <p className="dshZotPopoverQuote">{text}</p>}
      {comment !== '' && <p className="dshZotPopoverComment">{comment}</p>}
      {isAgent && (
        <div className="dshZotPopoverActions">
          {mark.highlight.savedAs !== undefined ? (
            <span className="dshZotMuted dshZotSmall">
              <Icon name="check" size={12} /> {s('reader.saved')}
            </span>
          ) : (
            <button
              type="button"
              className="dshZotBtn dshZotPrimary dshZotSmall"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void saveHighlights({ ids: [mark.highlight.id] })
                  .then(() => notify(s('reader.saved')))
                  .catch((error) => notify(errorText(s, error), 'error'))
                  .finally(() => setBusy(false))
              }}
            >
              <Icon name="save" size={14} />
              {busy ? s('reader.saving') : s('reader.saveToZotero')}
            </button>
          )}
          <button
            type="button"
            className="dshZotBtn dshZotGhost dshZotSmall"
            onClick={() => {
              void clearSessionHighlights({ ids: [mark.highlight.id] }).catch((error) => notify(errorText(s, error), 'error'))
              onClose()
            }}
          >
            <Icon name="trash" size={14} />
            {s('reader.remove')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Public surface of the lazy chunk: the Reader view. */
export function Reader(props: {
  route: ReaderRoute
  store: ZoteroStore
  t: Translate
  notify: Notify
  chat: { face: ChatFace | null; busy: boolean; hasSession: boolean }
  onBack: () => void
}): JSX.Element {
  const { route, store, t, notify, chat, onBack } = props
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [sizes, setSizes] = useState<PageSize[] | null>(null)
  const [progress, setProgress] = useState<[number, number]>([0, 1])
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [visible, setVisible] = useState<Set<number>>(new Set([0]))
  const [current, setCurrent] = useState(0)
  const [pageInput, setPageInput] = useState('1')
  const [sidebar, setSidebar] = useState(false)
  const [selection, setSelection] = useState<{ quote: QuoteRef; left: number; top: number } | null>(null)
  const [asking, setAsking] = useState(false)
  const [popover, setPopover] = useState<{ mark: Mark; left: number; top: number } | null>(null)
  const [focused, setFocused] = useState<string | null>(route.highlightId ?? null)
  const [highlightTick, setHighlightTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const annotationsKey = `annotations:${route.library}/${route.attachmentKey}`
  const detailKey = `item:${route.library}/${route.itemKey}`
  // Load + subscribe manually (useViewData lives in the main bundle; a local
  // minimal hook keeps the chunk self-contained).
  const [annotationsState, setAnnotationsState] = useState<{ data?: AnnotationsResponse; error?: { code: string; message: string }; loading: boolean }>({
    loading: true,
  })
  const [detailState, setDetailState] = useState<{ data?: ItemDetailWire; error?: { code: string; message: string } }>({})
  const reloadAnnotations = useCallback(
    (signal?: AbortSignal) => {
      setAnnotationsState((previous) => ({ ...previous, loading: true }))
      getAnnotations(route.library, route.itemKey, { signal })
        .then((data) => setAnnotationsState({ data, loading: false }))
        .catch((cause: unknown) => {
          if ((signal as AbortSignal | undefined)?.aborted === true) return
          const code = (cause as { code?: string }).code ?? 'internal'
          setAnnotationsState({ error: { code, message: cause instanceof Error ? cause.message : String(cause) }, loading: false })
        })
    },
    [route.library, route.itemKey],
  )
  useEffect(() => {
    const controller = new AbortController()
    reloadAnnotations(controller.signal)
    getItem(route.library, route.itemKey, { signal: controller.signal })
      .then((data) => setDetailState({ data }))
      .catch(() => setDetailState({}))
    return () => controller.abort()
  }, [reloadAnnotations, route.itemKey, annotationsKey, detailKey, highlightTick])

  // The main bundle bumps `lastHighlight` on SSE `highlights` nudges; watch
  // the store and refetch so new/cleared highlights appear live.
  useEffect(() => {
    return store.subscribe(() => {
      const last = store.get().lastHighlight
      if (last !== null && last.library === route.library && last.attachmentKey === route.attachmentKey) {
        setHighlightTick(last.seq)
      }
    })
  }, [store, route.library, route.attachmentKey])

  const title = detailState.data?.title ?? pdf?.info.title ?? ''
  const labels = pdf?.labels

  // Open the document.
  useEffect(() => {
    let cancelled = false
    setPdf(null)
    setSizes(null)
    setError(null)
    setScanned(false)
    loadPdf(route.library, route.attachmentKey, (done, total) => {
      if (!cancelled) setProgress([done, total])
    })
      .then(async (loaded) => {
        const measured = await pageSizes(loaded.doc)
        // Scanned-PDF hint: the first page carrying no text items.
        const first = await loaded.doc.getPage(1).then((page) => page.getTextContent()).catch(() => null)
        if (cancelled) return
        setPdf(loaded)
        setSizes(measured)
        setScanned(first !== null && first.items.length === 0)
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(t, reason))
      })
    return () => {
      cancelled = true
    }
  }, [route.library, route.attachmentKey, t])

  // Container width (drives fit-width zoom).
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [pdf])

  const maxWidth = sizes !== null ? Math.max(...sizes.map((size) => size.width)) : 612
  const fitScale = width > 0 ? Math.max(0.3, (width - 2 * GAP) / maxWidth) : 1
  const scale = zoom === 'fit' ? fitScale : zoom

  // Visible pages from scroll position (plus one screen of pre-render).
  const offsets = useMemo(() => {
    if (sizes === null) return []
    const result: number[] = []
    let y = GAP
    for (const size of sizes) {
      result.push(y)
      y += size.height * scale + GAP
    }
    return result
  }, [sizes, scale])

  const updateVisible = useCallback(() => {
    const element = scrollRef.current
    if (element === null || sizes === null) return
    const top = element.scrollTop
    const bottom = top + element.clientHeight
    const margin = element.clientHeight
    const next = new Set<number>()
    let middlePage = 0
    for (let index = 0; index < sizes.length; index++) {
      const start = offsets[index] ?? 0
      const end = start + (sizes[index]?.height ?? 0) * scale
      if (end >= top - margin && start <= bottom + margin) next.add(index)
      if (start <= top + element.clientHeight / 3) middlePage = index
    }
    setVisible((previous) => (previous.size === next.size && [...next].every((index) => previous.has(index)) ? previous : next))
    setCurrent(middlePage)
  }, [sizes, offsets, scale])

  useEffect(() => {
    updateVisible()
  }, [updateVisible])
  useEffect(() => setPageInput(String(current + 1)), [current])

  const scrollToPage = useCallback(
    (pageIndex: number, rectTop?: number) => {
      const element = scrollRef.current
      if (element === null || sizes === null || pageIndex < 0 || pageIndex >= sizes.length) return
      element.scrollTo({
        top: Math.max(0, (offsets[pageIndex] ?? 0) + (rectTop ?? 0) - (rectTop !== undefined ? element.clientHeight / 3 : GAP)),
      })
    },
    [sizes, offsets],
  )

  // Jump: the Agent-specified page or highlight (nonce replays the jump).
  useEffect(() => {
    if (sizes === null || pdf === null) return
    const highlight = route.highlightId !== undefined ? annotationsState.data?.highlights.find((entry) => entry.id === route.highlightId) : undefined
    if (highlight !== undefined) {
      void pdf.doc
        .getPage(highlight.pageIndex + 1)
        .then((page) => {
          const view = page.getViewport({ scale })
          const top = Math.min(...highlight.rects.map((rect) => toViewport(view as never, rect).top))
          scrollToPage(highlight.pageIndex, Number.isFinite(top) ? top : 0)
          setFocused(highlight.id)
        })
        .catch(() => scrollToPage(highlight.pageIndex))
    } else if (route.page !== undefined) {
      scrollToPage(route.page - 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.nonce, route.highlightId, route.page, sizes, pdf])

  const replaceRoute = (patch: Partial<ReaderRoute>): void => {
    store.dispatch({ type: 'replace', route: { ...route, ...patch } as ReaderRoute })
  }

  // Zoom keeps the current page anchored.
  const setZoomKeeping = (next: number | 'fit'): void => {
    const page = current
    setZoom(next)
    requestAnimationFrame(() => scrollToPage(page))
  }

  // Marks per page: user annotations + session highlights (already-saved
  // highlights render through their Zotero annotation, not twice).
  const marksByPage = useMemo(() => {
    const map = new Map<number, Mark[]>()
    const add = (page: number, mark: Mark): void => {
      map.set(page, [...(map.get(page) ?? []), mark])
    }
    const saved = new Set<string>()
    for (const annotation of annotationsState.data?.annotations ?? []) {
      add(annotation.pageIndex, { kind: 'annotation', annotation })
      saved.add(annotation.key)
    }
    for (const highlight of annotationsState.data?.highlights ?? []) {
      if (highlight.savedAs === undefined || !saved.has(highlight.savedAs)) add(highlight.pageIndex, { kind: 'highlight', highlight })
    }
    return map
  }, [annotationsState.data])

  // Selection toolbar.
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const onUp = (): void => {
      setTimeout(() => {
        const selected = window.getSelection()
        const text = selected?.toString().trim() ?? ''
        if (selected === null || text === '' || selected.rangeCount === 0) {
          if (!asking) setSelection(null)
          return
        }
        const node = selected.anchorNode instanceof Element ? selected.anchorNode : selected.anchorNode?.parentElement
        const pageElement = node?.closest<HTMLElement>('.dshZotPage')
        if (pageElement === null || pageElement === undefined || !element.contains(pageElement)) return
        const pageIndex = Number(pageElement.dataset.page)
        const range = selected.getRangeAt(0).getBoundingClientRect()
        const box = element.getBoundingClientRect()
        setAsking(false)
        setSelection({
          quote: {
            library: route.library,
            itemKey: route.itemKey,
            attachmentKey: route.attachmentKey,
            title,
            pageIndex,
            pageLabel: labels?.[pageIndex] || String(pageIndex + 1),
            text,
          },
          left: Math.min(Math.max(range.left - box.left + element.scrollLeft + range.width / 2, 120), element.clientWidth - 120),
          top: range.bottom - box.top + element.scrollTop + 8,
        })
      }, 0)
    }
    element.addEventListener('mouseup', onUp)
    element.addEventListener('keyup', onUp)
    return () => {
      element.removeEventListener('mouseup', onUp)
      element.removeEventListener('keyup', onUp)
    }
  }, [route.library, route.itemKey, route.attachmentKey, title, asking, labels])

  const openMark = (mark: Mark, target: HTMLElement): void => {
    const element = scrollRef.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    setSelection(null)
    setFocused(markId(mark))
    setPopover({
      mark,
      left: Math.min(Math.max(rect.left - box.left + element.scrollLeft, 8), element.clientWidth - 288),
      top: rect.bottom - box.top + element.scrollTop + 6,
    })
  }

  const goTo = (value: string): void => {
    const page = Number(value)
    if (Number.isInteger(page) && page >= 1 && sizes !== null && page <= sizes.length) {
      scrollToPage(page - 1)
      replaceRoute({ page, highlightId: undefined, nonce: Date.now() })
    } else {
      setPageInput(String(current + 1))
    }
  }

  const count = sizes?.length ?? 0
  const list = [...marksByPage.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, marks]) => marks)

  // Show in Zotero: opens Zotero's own reader on this attachment at the
  // current page (server-built zotero://open-pdf deep link, whitelisted
  // spawn); failures surface as an error toast.
  const [revealing, setRevealing] = useState(false)
  const showInZoteroNow = (): void => {
    if (revealing) return
    setRevealing(true)
    void showInZotero({ library: route.library, key: route.attachmentKey, target: 'open-pdf', page: current + 1 })
      .catch((error: unknown) => notify(t('reader.showInZoteroFailed', { message: errorText(t, error) }), 'error'))
      .finally(() => setRevealing(false))
  }
  // A live popover for a removed highlight closes itself.
  const livePopover = (() => {
    if (popover === null) return null
    const mark = popover.mark
    if (mark.kind === 'annotation') return popover
    const stillLive = annotationsState.data?.highlights.some((entry) => entry.id === mark.highlight.id) ?? false
    return stillLive ? popover : null
  })()

  return (
    <div className="dshZot dshZotReaderFull">
      <header className="dshZotBar">
        <button type="button" className="dshZotBack" onClick={onBack} aria-label={t('common.back')}>
          <Icon name="back" size={15} />
        </button>
        <span className="dshZotBarTitle dshZotStrong dshZotGrow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>
          {title !== '' ? title : t('reader.title')}
        </span>
        {count > 0 && (
          <span className="dshZotPager">
            <input
              aria-label={t('reader.page')}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && goTo(pageInput)}
              onBlur={() => goTo(pageInput)}
            />
            <span className="dshZotMuted">/ {count}</span>
          </span>
        )}
        <IconButton icon="minus" label={t('reader.zoomOut')} disabled={pdf === null} onClick={() => setZoomKeeping(Math.max(MIN_ZOOM, Math.round((scale / 1.2) * 100) / 100))} />
        <button
          type="button"
          className={`dshZotBtn dshZotGhost dshZotSmall dshZotZoom${zoom === 'fit' ? ' dshZotActive' : ''}`}
          title={t('reader.fitWidth')}
          disabled={pdf === null}
          onClick={() => setZoomKeeping('fit')}
        >
          {Math.round(scale * 100)}%
        </button>
        <IconButton icon="plus" label={t('reader.zoomIn')} disabled={pdf === null} onClick={() => setZoomKeeping(Math.min(MAX_ZOOM, Math.round(scale * 1.2 * 100) / 100))} />
        <IconButton icon="library" label={t('reader.showInZotero')} disabled={revealing} onClick={showInZoteroNow} />
        <IconButton icon="highlighter" label={t('reader.sidebar')} active={sidebar} onClick={() => setSidebar(!sidebar)} />
      </header>
      <div className="dshZotReaderBody">
        <div className="dshZotPages dshZotScroll" ref={scrollRef} onScroll={updateVisible}>
          {error !== null ? (
            <Empty>
              <Icon name="alert" size={20} />
              <p className="dshZotStrong">{t('reader.pdfError')}</p>
              <p className="dshZotErrorBox">{error}</p>
              <button type="button" className="dshZotBtn" onClick={() => store.dispatch({ type: 'back' })}>
                {t('common.back')}
              </button>
            </Empty>
          ) : pdf === null || sizes === null ? (
            <Empty>
              <div className="dshZotProgress">
                <div style={{ width: `${Math.round((progress[0] / Math.max(progress[1], 1)) * 100)}%` }} />
              </div>
              {t('reader.loadingPdf', { done: progress[0], total: progress[1] })}
            </Empty>
          ) : (
            <div className="dshZotPageStack" style={{ paddingTop: GAP, paddingBottom: GAP }}>
              {sizes.map((size, index) => (
                <PageView
                  key={index}
                  doc={pdf.doc}
                  index={index}
                  size={size}
                  scale={scale}
                  visible={visible.has(index)}
                  marks={marksByPage.get(index) ?? []}
                  focused={focused}
                  onMark={openMark}
                />
              ))}
            </div>
          )}
          {selection !== null && (
            <div className="dshZotFloatTools" style={{ left: selection.left, top: selection.top }} onMouseDown={(event) => event.preventDefault()}>
              {asking ? (
                <AskBox
                  placeholder={t('reader.askPlaceholder')}
                  sendLabel={t('common.send')}
                  closeLabel={t('common.close')}
                  onClose={() => {
                    setAsking(false)
                    setSelection(null)
                  }}
                  onSend={(question) => {
                    const outcome = askQuote(chat.face, question, selection.quote)
                    if (outcome === 'unavailable') notify(t('chat.unavailable'), 'error')
                    else notify(t('chat.sent'))
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="dshZotBtn dshZotGhost dshZotSmall"
                    onClick={() => {
                      void addQuoteToChat(chat.face, selection.quote).then((outcome) => {
                        if (outcome === 'unavailable') notify(chat.face === null ? t('chat.unavailable') : t('chat.addFailed'), 'error')
                        else notify(t('chat.addedToChat'))
                      })
                      setSelection(null)
                    }}
                  >
                    <Icon name="quote" size={14} />
                    {t('reader.addToChat')}
                  </button>
                  <button type="button" className="dshZotBtn dshZotGhost dshZotSmall" disabled={chat.face === null} onClick={() => setAsking(true)}>
                    <Icon name="message" size={14} />
                    {t('chat.ask')}
                  </button>
                </>
              )}
            </div>
          )}
          {livePopover !== null && <MarkPopover mark={livePopover.mark} anchor={livePopover} s={t} notify={notify} onClose={() => { setPopover(null); setFocused(null) }} />}
        </div>
        {sidebar && (
          <aside className="dshZotReaderSidebar">
            <div className="dshZotReaderSidebarHead">{t('reader.annotations')}</div>
            {annotationsState.error !== undefined && annotationsState.data === undefined ? (
              <p className="dshZotErrorBox dshZotPad">{viewErrorText(t, annotationsState.error)}</p>
            ) : list.length === 0 ? (
              <p className="dshZotMuted dshZotSmall dshZotPad">{t('reader.noAnnotations')}</p>
            ) : (
              <ul className="dshZotAnnotationList">
                {list.map((mark) => {
                  const id = markId(mark)
                  const pageIndex = mark.kind === 'annotation' ? mark.annotation.pageIndex : mark.highlight.pageIndex
                  return (
                    <li key={`${id}`}>
                      <button
                        type="button"
                        className={`dshZotAnnotationRow${mark.kind === 'highlight' ? ' dshZotAnnotationAgent' : ''}${focused === id ? ' dshZotAnnotationFocused' : ''}`}
                        onClick={() => {
                          setFocused(id)
                          if (mark.kind === 'highlight') replaceRoute({ highlightId: id, page: pageIndex + 1, nonce: Date.now() })
                          else scrollToPage(pageIndex, toTop(mark.annotation.rects, sizes?.[pageIndex], scale))
                        }}
                      >
                        <span className="dshZotSwatch" style={{ background: mark.kind === 'annotation' ? mark.annotation.color : mark.highlight.color }} />
                        <span className="dshZotAnnotationBody">
                          <span className="dshZotAnnotationQuote">
                            {mark.kind === 'annotation' ? mark.annotation.text || mark.annotation.comment : mark.highlight.quote}
                          </span>
                          {mark.kind === 'annotation' && mark.annotation.text !== '' && mark.annotation.comment !== '' && (
                            <span className="dshZotAnnotationComment">{mark.annotation.comment}</span>
                          )}
                          {mark.kind === 'highlight' && mark.highlight.comment !== '' && <span className="dshZotAnnotationComment">{mark.highlight.comment}</span>}
                          <span className="dshZotMuted dshZotSmall">
                            {mark.kind === 'highlight' && (
                              <>
                                <Icon name="sparkles" size={11} /> {t('reader.agent')} ·{' '}
                              </>
                            )}
                            {t('reader.page')} {mark.kind === 'annotation' ? mark.annotation.pageLabel : mark.highlight.pageLabel}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>
        )}
      </div>
      {scanned && (
        <div className="dshZotBanner dshZotBannerWarn" role="status">
          {t('reader.scanned')}
        </div>
      )}
      {annotationsState.loading && annotationsState.data === undefined && (
        <div className="dshZotBanner" role="status">
          {t('common.loading')}
        </div>
      )}
    </div>
  )
}

/** Top of a rect set inside the page (CSS px at the given scale). */
function toTop(rects: RectWire[], size: PageSize | undefined, scale: number): number | undefined {
  if (rects.length === 0 || size === undefined) return undefined
  return (size.height - Math.max(...rects.map((rect) => rect[3]))) * scale
}
