/**
 * Chat Draft / Ask projection for the current DSH conversation
 * (implementation spec §6, §8; milestone M8, verification point V-6 —
 * resolved: the official public interface is the session-scoped
 * `inputActions` standard prop of the `sidebar.right.pane.tab` slot).
 *
 * Official evidence (DSH 0.2.1-rc.x installed app, `dsh-cordis-client-runner`
 * CLIENT_SLOT_API catalog and the `dsh-client-ui-conversation` /
 * `dsh-client-ui-session` shipped sources):
 *
 * - `sidebar.right.pane.tab` is declared `scope: "session"`; its
 *   standardProps include `inputActions: InputActions` and
 *   `sessionId: SessionId` (source: packages/client/ui-sidebar-right
 *   `contract/slots.ts:59`, catalog entry "sidebar.right.pane.tab").
 * - `dsh-client-ui-session` provides `sessionId` (BUILTIN_SOURCE
 *   `props: ["sessionId"]`) and `dsh-client-ui-conversation` provides
 *   `inputActions` via `ctx.uiSession.provide({ props: ["inputActions"], … })`.
 * - The `InputActions` face (`SessionInputShell.actions`) exposes:
 *   `captureInsertion()`, `insertText(text, span)`, `setDraft(text)`,
 *   `persistDraft()`, `addAttachments(ids)`, `removeAttachment(id)`,
 *   `pruneAttachments(ids)`, `submit()`.
 *   - `setDraft(text)`: "Replace the whole draft (persisted-draft seed and
 *     programmatic writes). … Merged into history so a seed is not an
 *     undoable step of its own." — it does NOT send.
 *   - `submit()`: submits the resident draft with mode `"queue"` — the
 *     queue, never steer/interrupt.
 *
 * Therefore `addToChat` writes the fixed-format Zotero item text into the
 * editable draft without sending — additively, through the non-destructive
 * `captureInsertion` + `insertText` path only (text the user already typed is
 * preserved). When that path is unavailable (no face, no insertion window) or
 * fails (`insertText` returns `false` or rejects), the draft is left exactly
 * as it was and the helper reports `'unavailable'` — there is no `setDraft`
 * replace fallback. `ask` composes question + items and submits in queue mode.
 * Neither helper ever falls back to the clipboard or to a silent send.
 *
 * @module @hanxu131/dsh-zotero/client/chat-draft
 */

import type { ItemSummaryWire } from '../shared/protocol.ts'

/** Library id used inside chat markers (`user` or `g<id>`). */
export type ChatLibrary = string

/**
 * One structured chat face as published to tab components. Fields are
 * `unknown`-typed on purpose: the browser half treats the host surface
 * defensively and never imports DSH internals.
 */
export interface ChatFace {
  setDraft(text: string): void
  submit(): void
  captureInsertion?(): { draftRev: number } | undefined
  insertText?(text: string, span: { draftRev: number }): boolean | Promise<boolean>
}

/** Extract the official chat face from the tab component's props. */
export function chatFaceFrom(props: unknown): ChatFace | null {
  const actions = (props as { inputActions?: unknown } | null | undefined)?.inputActions
  if (typeof actions !== 'object' || actions === null) return null
  const candidate = actions as Record<string, unknown>
  if (typeof candidate.setDraft !== 'function' || typeof candidate.submit !== 'function') return null
  const face: ChatFace = {
    setDraft: candidate.setDraft.bind(candidate) as (text: string) => void,
    submit: candidate.submit.bind(candidate) as () => void,
  }
  if (typeof candidate.captureInsertion === 'function') {
    face.captureInsertion = candidate.captureInsertion.bind(candidate) as () => { draftRev: number } | undefined
  }
  if (typeof candidate.insertText === 'function') {
    face.insertText = candidate.insertText.bind(candidate) as ChatFace['insertText']
  }
  return face
}

// ---------------------------------------------------------------------------
// Text projections (pure; unit-tested without any host)
// ---------------------------------------------------------------------------

/** One structured reference line, shared by Add-to-chat and Ask. */
export function itemRef(item: Pick<ItemSummaryWire, 'key' | 'title' | 'creatorSummary' | 'year' | 'pdf'>): string {
  const who = [item.creatorSummary, item.year !== '' ? `(${item.year})` : ''].filter(Boolean).join(' ')
  const parts = [`[${item.key}] ${item.title}`]
  if (who !== '') parts.push(`— ${who}`)
  if (item.pdf !== null) parts.push(`· PDF ${item.pdf.key}`)
  return parts.join(' ')
}

/** Library qualifier appended to the header for non-personal libraries. */
const libraryNote = (library: ChatLibrary): string => (library === 'user' ? '' : ` in library ${library}`)

/**
 * Fixed-format text Add to chat writes into the draft: a selection header +
 * one structured line per item (`[key] title — creators (year) · PDF key`).
 * Reference-compatible with the ZCode Zotero panel's context format.
 */
export function itemsDraftText(
  items: readonly Pick<ItemSummaryWire, 'key' | 'title' | 'creatorSummary' | 'year' | 'pdf'>[],
  library: ChatLibrary,
): string {
  const count = items.length === 1 ? '1 Zotero item' : `${items.length} Zotero items`
  const lines = [`The user selected ${count}${libraryNote(library)} in the Zotero panel:`]
  for (const item of items) lines.push(`- ${itemRef(item)}`)
  return lines.join('\n')
}

/** Ask payload: the user's question plus the structured item block. */
export function askText(
  question: string,
  items: readonly Pick<ItemSummaryWire, 'key' | 'title' | 'creatorSummary' | 'year' | 'pdf'>[],
  library: ChatLibrary,
): string {
  const refs = items.map((item) => `- ${itemRef(item)}`).join('\n')
  return `${question.trim()}\n\nZotero items${libraryNote(library)}:\n${refs}`
}

// ---------------------------------------------------------------------------
// PDF quote projections (M4 reader selection)
// ---------------------------------------------------------------------------

/** One PDF passage the user selected in the reader. */
export interface QuoteRef {
  library: ChatLibrary
  itemKey: string
  attachmentKey: string
  /** Item title. */
  title: string
  /** 0-based physical page index. */
  pageIndex: number
  /** Printed page label (falls back to the physical number). */
  pageLabel: string
  text: string
}

/** Fixed-format text for a selected PDF passage (Add to chat / Ask). */
export function quoteDraftText(quote: QuoteRef): string {
  const printed = quote.pageLabel !== String(quote.pageIndex + 1) ? ` (printed ${quote.pageLabel})` : ''
  const lines = ['The user selected a PDF passage in the Zotero panel:']
  lines.push(`- [${quote.itemKey}] ${quote.title} — PDF ${quote.attachmentKey}, page ${quote.pageIndex + 1}${printed}`)
  for (const line of quote.text.split('\n')) lines.push(`> ${line}`)
  return lines.join('\n')
}

/** Add the selected passage to the editable draft without sending. */
export const addQuoteToChat = (face: ChatFace | null, quote: QuoteRef): Promise<DraftWrite> => addToChat(face, quoteDraftText(quote))

/** Ask payload: the user's question plus the selected passage. */
export function askQuoteText(question: string, quote: QuoteRef): string {
  return `${question.trim()}\n\n${quoteDraftText(quote)}`
}

/** Ask about the selected passage: compose question + quote, submit in queue mode. */
export function askQuote(face: ChatFace | null, question: string, quote: QuoteRef): AskSend {
  if (face === null) return 'unavailable'
  face.setDraft(askQuoteText(question, quote))
  face.submit()
  return 'submitted'
}

// ---------------------------------------------------------------------------
// Face operations
// ---------------------------------------------------------------------------

/** Outcome of a draft write attempt. */
export type DraftWrite = 'written' | 'unavailable'

/**
 * Write the text into the editable draft WITHOUT sending — additively, never
 * replacing.
 *
 * Only the non-destructive path (`captureInsertion` + `insertText` at the
 * caret, which keeps text the user already typed) ever writes, and `'written'`
 * is reported only after the real `insertText` result resolves to `true`.
 * When the insertion surface is missing, `insertText` resolves `false`, or
 * its promise rejects, the draft is left exactly as it was and `'unavailable'`
 * is reported — there is no `setDraft` replace fallback (a replace could wipe
 * text the user has typed), no clipboard fallback, and no silent send.
 */
export async function addToChat(face: ChatFace | null, text: string): Promise<DraftWrite> {
  if (face === null || text === '') return 'unavailable'
  const span = face.captureInsertion?.()
  if (span === undefined || span === null || face.insertText === undefined) return 'unavailable'
  let inserted: boolean
  try {
    inserted = await face.insertText(text, span)
  } catch {
    return 'unavailable'
  }
  return inserted === true ? 'written' : 'unavailable'
}

/** Outcome of an Ask attempt. */
export type AskSend = 'submitted' | 'unavailable'

/**
 * Ask: compose question + items and submit the draft in queue mode (the
 * official `submit()` — never steer). Returns `'unavailable'` when no face
 * exists; callers disable the control in that case.
 */
export function ask(face: ChatFace | null, question: string, items: readonly Pick<ItemSummaryWire, 'key' | 'title' | 'creatorSummary' | 'year' | 'pdf'>[], library: ChatLibrary): AskSend {
  if (face === null) return 'unavailable'
  const payload = askText(question, items, library)
  face.setDraft(payload)
  face.submit()
  return 'submitted'
}
