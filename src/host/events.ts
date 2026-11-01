/**
 * `ViewEventHub` — the host-side publisher of view navigation intents and
 * the state behind the SSE `/events` channel.
 *
 * - `publish` stamps a process-monotonic `seq` on every intent and keeps a
 *   bounded history (`MAX_EVENT_HISTORY`) so a reconnecting client can
 *   replay via `Last-Event-ID`.
 * - Events carry navigation data only (library/key/page); the hub has no
 *   access to credentials, so none can leak into the channel.
 * - Subscription is explicit; `unsubscribe` (or disposing the hub) detaches
 *   every listener — the SSE route relies on this on connection close.
 *
 * @module @hanxu131/dsh-zotero/host/events
 */

import { MAX_EVENT_HISTORY, type ViewEvent, type ViewIntent } from '../shared/protocol.ts'

export interface ViewEventHub {
  /** Stamp `seq`/`at`, retain, and fan out; returns the stored event. */
  publish(intent: ViewIntent): ViewEvent
  /** Subscribe to future events; returns the unsubscribe function. */
  subscribe(listener: (event: ViewEvent) => void): () => void
  /** Retained events with `seq > lastSeq`, oldest first (bounded). */
  replaySince(lastSeq: number): ViewEvent[]
  /** Monotonic sequence cursor (last published seq, 0 initially). */
  readonly currentSeq: number
  /** Detach every subscriber; publishing after dispose is a no-op. */
  dispose(): void
}

export function createViewEventHub(): ViewEventHub {
  let seq = 0
  let disposed = false
  const history: ViewEvent[] = []
  const listeners = new Set<(event: ViewEvent) => void>()

  return {
    get currentSeq() {
      return seq
    },
    publish(intent: ViewIntent): ViewEvent {
      if (disposed) throw new Error('view event hub is disposed')
      seq += 1
      const event: ViewEvent = { seq, at: Date.now(), intent }
      history.push(event)
      if (history.length > MAX_EVENT_HISTORY) history.splice(0, history.length - MAX_EVENT_HISTORY)
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // A broken subscriber must not break publishing.
        }
      }
      return event
    },
    subscribe(listener: (event: ViewEvent) => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    replaySince(lastSeq: number): ViewEvent[] {
      return history.filter((event) => event.seq > lastSeq)
    },
    dispose(): void {
      disposed = true
      listeners.clear()
    },
  }
}
