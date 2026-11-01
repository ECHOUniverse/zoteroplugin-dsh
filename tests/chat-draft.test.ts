/**
 * `src/client/chat-draft.ts` tests: the fixed-format text projections and the
 * defensive access to the official DSH chat face (`inputActions`,
 * verification point V-6 resolved — see the module comment for the evidence).
 */
import { describe, expect, it, vi } from 'vitest'
import { addToChat, ask, askText, chatFaceFrom, itemRef, itemsDraftText, type ChatFace } from '../src/client/chat-draft.ts'
import type { ItemSummaryWire } from '../src/shared/protocol.ts'

const summary = (overrides: Partial<ItemSummaryWire> = {}): ItemSummaryWire => ({
  key: 'ABCD2345',
  itemType: 'journalArticle',
  title: 'Deep Learning for Schema Matching',
  creatorSummary: 'Smith, J.; Wang, L.',
  year: '2024',
  venue: 'Nature Methods',
  tags: [],
  numChildren: 2,
  pdf: { key: 'PDFK2345' },
  dateAdded: '2024-01-01T00:00:00Z',
  dateModified: '2024-01-02T00:00:00Z',
  ...overrides,
})

describe('text projections', () => {
  it('itemRef carries key, title, creators, year and PDF key markers', () => {
    expect(itemRef(summary())).toBe('[ABCD2345] Deep Learning for Schema Matching — Smith, J.; Wang, L. (2024) · PDF PDFK2345')
  })

  it('itemRef omits empty creator/year/pdf parts', () => {
    expect(itemRef(summary({ creatorSummary: '', year: '', pdf: null }))).toBe('[ABCD2345] Deep Learning for Schema Matching')
  })

  it('itemsDraftText writes the selection header without a library note for user', () => {
    expect(itemsDraftText([summary()], 'user')).toBe(
      'The user selected 1 Zotero item in the Zotero panel:\n- [ABCD2345] Deep Learning for Schema Matching — Smith, J.; Wang, L. (2024) · PDF PDFK2345',
    )
  })

  it('itemsDraftText notes group libraries and counts multiple items', () => {
    const text = itemsDraftText([summary(), summary({ key: 'BCDE3456', title: 'Second', pdf: null })], 'g42')
    expect(text).toContain('The user selected 2 Zotero items in library g42 in the Zotero panel:')
    expect(text).toContain('- [ABCD2345] Deep Learning for Schema Matching — Smith, J.; Wang, L. (2024) · PDF PDFK2345')
    expect(text).toContain('- [BCDE3456] Second')
    expect(text.split('\n')).toHaveLength(3)
  })

  it('askText combines the trimmed question with the structured item block', () => {
    expect(askText('  Compare methods  ', [summary()], 'user')).toBe(
      'Compare methods\n\nZotero items:\n- [ABCD2345] Deep Learning for Schema Matching — Smith, J.; Wang, L. (2024) · PDF PDFK2345',
    )
    expect(askText('q', [summary()], 'g7')).toContain('Zotero items in library g7:')
  })
})

describe('chatFaceFrom (defensive access to the official face)', () => {
  it('accepts a session-scoped inputActions prop with setDraft and submit', () => {
    const face = chatFaceFrom({ inputActions: { setDraft: () => {}, submit: () => {} }, sessionId: 's1' })
    expect(face).not.toBeNull()
    expect(typeof face?.setDraft).toBe('function')
    expect(typeof face?.submit).toBe('function')
  })

  it('returns null when the prop is missing, malformed, or incomplete', () => {
    expect(chatFaceFrom(undefined)).toBeNull()
    expect(chatFaceFrom(null)).toBeNull()
    expect(chatFaceFrom({})).toBeNull()
    expect(chatFaceFrom({ inputActions: 'not-an-object' })).toBeNull()
    expect(chatFaceFrom({ inputActions: { setDraft: 'x', submit: () => {} } })).toBeNull()
    expect(chatFaceFrom({ inputActions: { submit: () => {} } })).toBeNull()
  })

  it('binds optional captureInsertion/insertText when present', () => {
    const face = chatFaceFrom({
      inputActions: {
        setDraft: () => {},
        submit: () => {},
        captureInsertion: () => ({ draftRev: 3 }),
        insertText: () => true,
      },
    })
    expect(face?.captureInsertion?.()).toEqual({ draftRev: 3 })
    expect(face?.insertText?.('x', { draftRev: 3 })).toBe(true)
  })
})

describe('addToChat / ask operations', () => {
  const minimalFace = (): { face: ChatFace; setDraft: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> } => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    return { face: { setDraft, submit }, setDraft, submit }
  }

  /** Face whose insertText resolves/returns/throws per the given behavior. */
  const insertionFace = (impl: () => boolean | Promise<boolean>, draftRev = 7) => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    const insertText = vi.fn(impl)
    const face: ChatFace = { setDraft, submit, captureInsertion: () => ({ draftRev }), insertText }
    return { face, setDraft, submit, insertText }
  }

  it('addToChat writes via the caret path when insertText returns true (sync)', async () => {
    const { face, setDraft, submit, insertText } = insertionFace(() => true)
    await expect(addToChat(face, 'Zotero block')).resolves.toBe('written')
    expect(insertText).toHaveBeenCalledWith('Zotero block', { draftRev: 7 })
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('addToChat awaits a real boolean when insertText resolves true (async)', async () => {
    const { face, setDraft, submit, insertText } = insertionFace(async () => true)
    await expect(addToChat(face, 'Zotero block')).resolves.toBe('written')
    expect(insertText).toHaveBeenCalledWith('Zotero block', { draftRev: 7 })
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('addToChat leaves the draft untouched when insertText returns false (sync)', async () => {
    const { face, setDraft, submit } = insertionFace(() => false)
    await expect(addToChat(face, 'Zotero block')).resolves.toBe('unavailable')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('addToChat leaves the draft untouched when insertText resolves false (async)', async () => {
    const { face, setDraft, submit } = insertionFace(async () => false)
    await expect(addToChat(face, 'Zotero block')).resolves.toBe('unavailable')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('addToChat leaves the draft untouched when insertText rejects or throws', async () => {
    const rejected = insertionFace(async () => {
      throw new Error('insertion window closed')
    })
    await expect(addToChat(rejected.face, 'Zotero block')).resolves.toBe('unavailable')
    expect(rejected.setDraft).not.toHaveBeenCalled()
    expect(rejected.submit).not.toHaveBeenCalled()

    const thrown = insertionFace(() => {
      throw new Error('sync failure')
    })
    await expect(addToChat(thrown.face, 'Zotero block')).resolves.toBe('unavailable')
    expect(thrown.setDraft).not.toHaveBeenCalled()
    expect(thrown.submit).not.toHaveBeenCalled()
  })

  it('addToChat refuses to write (no setDraft replace fallback) when the insertion surface is missing', async () => {
    const { face, setDraft, submit } = minimalFace()
    await expect(addToChat(face, 'hello')).resolves.toBe('unavailable')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()

    // captureInsertion without insertText, and insertText without a span: still no write.
    const setDraftOnlyInsert = vi.fn(() => true)
    const captureOnly: ChatFace = { setDraft: vi.fn(), submit: vi.fn(), captureInsertion: () => ({ draftRev: 1 }) }
    await expect(addToChat(captureOnly, 'hello')).resolves.toBe('unavailable')
    const insertOnly: ChatFace = { setDraft: vi.fn(), submit: vi.fn(), insertText: setDraftOnlyInsert }
    await expect(addToChat(insertOnly, 'hello')).resolves.toBe('unavailable')
    expect(setDraftOnlyInsert).not.toHaveBeenCalled()
  })

  it('addToChat reports unavailable when the face is lost mid-flight (captureInsertion → undefined)', async () => {
    const insertText = vi.fn(() => true)
    const setDraft = vi.fn()
    const face: ChatFace = { setDraft, submit: vi.fn(), captureInsertion: () => undefined, insertText }
    await expect(addToChat(face, 'Zotero block')).resolves.toBe('unavailable')
    expect(insertText).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('addToChat returns unavailable when there is no face or nothing to write', async () => {
    await expect(addToChat(null, 'text')).resolves.toBe('unavailable')
    await expect(addToChat(minimalFace().face, '')).resolves.toBe('unavailable')
  })

  it('ask composes and submits in queue mode (submit only, no steer surface)', () => {
    const { face, setDraft, submit } = minimalFace()
    expect(ask(face, 'Why?', [summary()], 'user')).toBe('submitted')
    expect(setDraft).toHaveBeenCalledWith(askText('Why?', [summary()], 'user'))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('ask returns unavailable when there is no face', () => {
    expect(ask(null, 'q', [summary()], 'user')).toBe('unavailable')
  })
})
