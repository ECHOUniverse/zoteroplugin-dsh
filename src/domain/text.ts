/**
 * Quote matching and highlight-rectangle geometry over extracted PDF page
 * text — the pure core of the M4 reading pipeline. No I/O; `pdf/extract.ts`
 * produces the `PageText` inputs and the tools/reader consume the outputs.
 *
 * Pipeline per page: text items are stitched into page text with per-item
 * geometry (`buildPage`); quotes are matched after normalization (NFKC,
 * unified quotes/dashes, de-hyphenation across line breaks, whitespace
 * folding, lowercase — falling back to whitespace-free matching, and
 * "start … end" spans); the matched character range maps back to PDF
 * user-space rectangles by per-character width interpolation (`rectsFor`),
 * plus Zotero's `sortIndex` key.
 *
 * Attribution: ported from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/domain/text.ts` (repo LICENSE: Apache-2.0). Modifications: `Rect`
 * comes from this project's `domain/model.ts` (no `#z/contract.ts` import);
 * added `pageIndexFor` (moved from the reference's `app/session.ts` so page
 * resolution is testable without the session); documentation restructured;
 * logic of buildPage/normalize/findInPage/findQuote/rectsFor/sortIndex/
 * parsePages/searchPages kept equivalent. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/domain/text
 */

import type { Rect } from './model.ts'

/** A pdf.js `getTextContent()` text item (only the fields we use). */
export interface TextItem {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

/** Geometry of one text item within the page-text string. */
export interface Span {
  /** [start, end) character range in `PageText.text`. */
  start: number
  end: number
  /** Left edge of the item (pt, user space). */
  x: number
  /** Baseline y. */
  y: number
  width: number
  /** Approximate line height (font size). */
  size: number
}

export interface PageText {
  /** 0-based physical page index. */
  index: number
  /** Printed page label ("iv", "12"; falls back to the physical number). */
  label: string
  /** Page viewBox size (pt). */
  width: number
  height: number
  /** viewBox origin (0, 0 for most PDFs). */
  originX: number
  originY: number
  text: string
  spans: Span[]
}

/** Stitch one page's text items into page text: line breaks at new lines or EOL, a space at visible gaps. */
export function buildPage(
  items: TextItem[],
  page: { index: number; label: string; width: number; height: number; originX?: number; originY?: number },
): PageText {
  let text = ''
  const spans: Span[] = []
  let previous: { x2: number; y: number; size: number } | null = null
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform
    const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 10
    if (previous !== null && item.str !== '') {
      const sameLine = Math.abs(f - previous.y) < size * 0.5
      const last = text.at(-1) ?? '\n'
      if (!sameLine && !/\s/.test(last)) text += '\n'
      else if (sameLine && e - previous.x2 > size * 0.15 && !/\s/.test(last) && !/^\s/.test(item.str)) text += ' '
    }
    if (item.str !== '') {
      const start = text.length
      text += item.str
      spans.push({ start, end: text.length, x: e, y: f, width: item.width, size })
      previous = { x2: e + item.width, y: f, size }
    }
    if (item.hasEOL === true && !text.endsWith('\n')) {
      text += '\n'
    }
  }
  return {
    index: page.index,
    label: page.label,
    width: page.width,
    height: page.height,
    originX: page.originX ?? 0,
    originY: page.originY ?? 0,
    text,
    spans,
  }
}

/** Model-facing page text: merge de-hyphenated line breaks, squeeze excess whitespace. */
export function readableText(text: string): string {
  return text
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Normalization and matching
// ---------------------------------------------------------------------------

const FOLD: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '″': '"',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '­': '',
  '​': '',
  '…': '...',
}

/**
 * Normalize text while recording which original index each output character
 * came from: NFKC (ﬁ → fi), unified quotes/dashes, line-break de-hyphenation,
 * whitespace folded to single spaces, lowercase. `compact` drops all
 * whitespace (tolerates missing/extra spaces in the PDF text).
 */
export function normalize(text: string, compact = false): { value: string; map: number[] } {
  let value = ''
  const map: number[] = []
  let pendingSpace = -1
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    // End-of-line de-hyphenation: lowercase letter, hyphen, newline, lowercase letter.
    if (char === '-' && text[index + 1] === '\n' && /\p{Ll}/u.test(text[index - 1] ?? '') && /\p{Ll}/u.test(text[index + 2] ?? '')) {
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      if (!compact && pendingSpace < 0 && value.length > 0) pendingSpace = index
      continue
    }
    const folded = (FOLD[char] ?? char).normalize('NFKC').toLowerCase()
    if (folded === '') continue
    if (pendingSpace >= 0) {
      value += ' '
      map.push(pendingSpace)
      pendingSpace = -1
    }
    for (const part of folded) {
      value += part
      map.push(index)
    }
  }
  return { value, map }
}

export interface Match {
  pageIndex: number
  /** Character range [start, end) in the original page text. */
  start: number
  end: number
}

/** Find a quote in one page: spaced matching first, then whitespace-free; "start … end" quotes match in two parts. */
export function findInPage(page: PageText, quote: string, from = 0): Match | null {
  for (const compact of [false, true]) {
    const haystack = normalize(page.text, compact)
    const needle = normalize(quote, compact).value.trim()
    if (needle === '') return null
    const startAt = haystack.map.findIndex((original) => original >= from)
    if (startAt < 0) continue
    const position = haystack.value.indexOf(needle, startAt)
    if (position >= 0) {
      return {
        pageIndex: page.index,
        start: haystack.map[position]!,
        end: haystack.map[position + needle.length - 1]! + 1,
      }
    }
  }
  // "start … end": both parts on this page, in order, within a bounded span.
  const parts = quote
    .split(/\s*(?:\.\.\.|…|\[\s*\.\.\.\s*\])\s*/)
    .filter((part) => part.trim().length >= 8)
  if (parts.length >= 2) {
    const first = findInPage(page, parts[0]!, from)
    if (first !== null) {
      const last = findInPage(page, parts[parts.length - 1]!, first.end)
      if (last !== null && last.end - first.start < 3_000) return { pageIndex: page.index, start: first.start, end: last.end }
    }
  }
  return null
}

/** Find a quote across pages; `preferredPage` first, then page order. */
export function findQuote(pages: PageText[], quote: string, preferredPage?: number): Match | null {
  const order =
    preferredPage !== undefined && pages[preferredPage] !== undefined
      ? [pages[preferredPage]!, ...pages.filter((page) => page.index !== preferredPage)]
      : pages
  for (const page of order) {
    const match = findInPage(page, quote)
    if (match !== null) return match
  }
  // Cross-page quote: join adjacent pairs; report the part on the first page.
  for (let index = 0; index + 1 < pages.length; index++) {
    const a = pages[index]!
    const b = pages[index + 1]!
    const joined = { ...a, text: `${a.text}\n${b.text}` }
    const match = findInPage(joined, quote)
    if (match !== null && match.start < a.text.length && match.end > a.text.length) {
      return { pageIndex: a.index, start: match.start, end: a.text.length }
    }
  }
  return null
}

// Helvetica's ASCII widths (1/1000 em, AFM). Text items carry no per-character
// geometry, so widths interpolate by proportion, not by character count:
// proportional fonts have similar relative widths, far better than even splits.
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584,
  584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667,
  611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500,
  722, 500, 500, 500, 334, 260, 334, 584,
]

export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 32
  if (code >= 32 && code < 127) return ASCII_WIDTHS[code - 32]!
  // CJK ideographs and fullwidth forms occupy a full em.
  if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) return 1000
  return 556
}

/** Width fraction of [0, offset) inside a text item. */
function fraction(text: string, offset: number): number {
  let before = 0
  let total = 0
  let index = 0
  for (const char of text) {
    const width = charWidth(char)
    if (index < offset) before += width
    total += width
    index += char.length
  }
  return total > 0 ? before / total : 0
}

/** Character range → rectangles (PDF user space); adjacent same-line rects merge. */
export function rectsFor(page: PageText, start: number, end: number): Rect[] {
  const rects: Rect[] = []
  for (const span of page.spans) {
    if (span.end <= start || span.start >= end) continue
    const text = page.text.slice(span.start, span.end)
    const from = Math.max(start, span.start) - span.start
    const to = Math.min(end, span.end) - span.start
    const x1 = span.x + span.width * fraction(text, from)
    const x2 = span.x + span.width * fraction(text, to)
    const rect: Rect = [x1, span.y - span.size * 0.25, x2, span.y + span.size * 0.75]
    const last = rects.at(-1)
    if (last !== undefined && Math.abs(last[1] - rect[1]) < span.size * 0.3 && rect[0] - last[2] < span.size * 1.5 && rect[0] >= last[0] - 1) {
      last[2] = Math.max(last[2], rect[2])
      last[1] = Math.min(last[1], rect[1])
      last[3] = Math.max(last[3], rect[3])
    } else {
      rects.push(rect)
    }
  }
  return rects.map((rect) => rect.map((value) => Math.round(value * 1000) / 1000) as Rect)
}

/** Zotero's annotation sort key: page(5)|offset(6)|distance-from-top(5). */
export function sortIndex(page: PageText, offset: number, rects: Rect[]): string {
  const top =
    rects.length > 0 ? Math.max(0, Math.floor(page.originY + page.height - Math.max(...rects.map((rect) => rect[3])))) : 0
  const pad = (value: number, width: number) => String(Math.min(Math.max(Math.floor(value), 0), 10 ** width - 1)).padStart(width, '0')
  return `${pad(page.index, 5)}|${pad(offset, 6)}|${pad(top, 5)}`
}

/** The text actually written in the PDF for a matched range. */
export function textAt(page: PageText, start: number, end: number): string {
  return readableText(page.text.slice(start, end)).replace(/\s+/g, ' ')
}

/** Page ranges: "3", "2-5", "1,4-6", "10-"; 1-based input, 0-based page indexes out. */
export function parsePages(spec: string, pageCount: number): number[] {
  const result = new Set<number>()
  for (const part of spec.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    const match = /^(\d+)?\s*(?:-\s*(\d+)?)?$/.exec(part)
    if (match === null || (match[1] === undefined && match[2] === undefined)) {
      throw new Error(`Invalid page range "${part}". Use e.g. "3", "2-5" or "1,4-6".`)
    }
    const isRange = part.includes('-')
    const from = match[1] !== undefined ? Number(match[1]) : 1
    const to = isRange ? (match[2] !== undefined ? Number(match[2]) : pageCount) : from
    for (let page = Math.max(from, 1); page <= Math.min(to, pageCount); page++) result.add(page - 1)
  }
  return [...result].sort((a, b) => a - b)
}

/** Keyword occurrences with context (`find_in_pdf`). */
export function searchPages(pages: PageText[], query: string, maxResults: number) {
  const results: { pageIndex: number; label: string; snippet: string; start: number; end: number }[] = []
  for (const page of pages) {
    let from = 0
    while (results.length < maxResults) {
      const match = findInPage(page, query, from)
      if (match === null) break
      const before = page.text.slice(Math.max(0, match.start - 160), match.start)
      const hit = page.text.slice(match.start, match.end)
      const after = page.text.slice(match.end, match.end + 160)
      results.push({
        pageIndex: page.index,
        label: page.label,
        snippet: readableText(`…${before}«${hit}»${after}…`).replace(/\s+/g, ' '),
        start: match.start,
        end: match.end,
      })
      from = match.end
    }
    if (results.length >= maxResults) break
  }
  return results
}

/** 1-based physical page number (as printed by `read_fulltext`) → 0-based index, or undefined when out of range. */
export function pageIndexFor(pages: PageText[], page: number): number | undefined {
  const number = Number(page)
  if (Number.isInteger(number) && number >= 1 && number <= pages.length) return number - 1
  return undefined
}
