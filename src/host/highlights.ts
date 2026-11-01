/**
 * In-session Agent highlight store. Highlights live only in host memory —
 * never in Zotero until `save_highlights` (Agent, DSH-approved) or the UI
 * save route turns one into a real highlight annotation. There is no delete
 * of Zotero annotations anywhere: clearing removes session entries only.
 *
 * The store is a plain mutable object guarded by the single-threaded event
 * loop; every mutation returns enough information for the caller to publish
 * an SSE `highlights` nudge so open readers refresh.
 *
 * @module @hanxu131/dsh-zotero/host/highlights
 */

import { ZoteroError, type AgentHighlight, type LibraryId } from '../domain/model.ts'

export class HighlightStore {
  private entries: AgentHighlight[] = []
  private seq = 0

  /** Append one highlight; assigns the session-unique id. */
  add(highlight: Omit<AgentHighlight, 'id'>): AgentHighlight {
    const stored: AgentHighlight = { ...highlight, id: `h${++this.seq}` }
    this.entries.push(stored)
    return stored
  }

  all(): AgentHighlight[] {
    return [...this.entries]
  }

  /**
   * Look highlights up: by explicit ids (must all exist — `not_found`
   * otherwise, mirroring the reference's tool contract), by item/attachment
   * key, or everything.
   */
  find(ids?: string[], key?: string): AgentHighlight[] {
    if (ids !== undefined && ids.length > 0) {
      const missing = ids.filter((id) => !this.entries.some((entry) => entry.id === id))
      if (missing.length > 0) throw new ZoteroError('not_found', `No highlight ${missing.join(', ')} in this session.`)
      return this.entries.filter((entry) => ids.includes(entry.id))
    }
    if (key !== undefined) {
      return this.entries.filter((entry) => entry.itemKey === key || entry.attachmentKey === key)
    }
    return this.all()
  }

  /** Remove by ids / key / all; returns how many went away (session state only). */
  remove(ids?: string[], key?: string): number {
    const doomed = new Set(this.find(ids, key).map((entry) => entry.id))
    if (doomed.size === 0) return 0
    this.entries = this.entries.filter((entry) => !doomed.has(entry.id))
    return doomed.size
  }

  /** Mark highlights saved as Zotero annotations (id → annotation key). */
  markSaved(saved: { id: string; key: string }[]): void {
    for (const { id, key } of saved) {
      const entry = this.entries.find((candidate) => candidate.id === id)
      if (entry !== undefined) entry.savedAs = key
    }
  }

  /** Highlights for one library + attachment (reader drawing set). */
  forAttachment(library: LibraryId, attachmentKey: string): AgentHighlight[] {
    return this.entries.filter((entry) => entry.library === library && entry.attachmentKey === attachmentKey)
  }
}
