/**
 * Pure quote-matching and rectangle-geometry tests (M4 core): NFKC + quote /
 * dash folding, end-of-line de-hyphenation, whitespace-tolerant and
 * whitespace-free matching, "start … end" spans, cross-page quotes,
 * scan/missing cases, Chinese text with page coordinates, rect computation
 * with tolerance, sortIndex and page-range parsing.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPage,
  charWidth,
  findInPage,
  findQuote,
  normalize,
  pageIndexFor,
  parsePages,
  readableText,
  rectsFor,
  searchPages,
  sortIndex,
  textAt,
  type PageText,
  type TextItem,
} from '../src/domain/text.ts'

/** One synthetic text item at (x, y) with the given width (11pt). */
const item = (str: string, x: number, y: number, width = 100): TextItem => ({ str, transform: [11, 0, 0, 11, x, y], width, height: 11 })

/** Build a page from lines (each line one item, 66pt wide, line height 14). */
function page(index: number, lines: string[], label = String(index + 1)): PageText {
  const items = lines.map((line, lineIndex) => item(line, 72, 700 - lineIndex * 14, 200))
  return buildPage(items, { index, label, width: 612, height: 792 })
}

describe('buildPage', () => {
  it('stitches items into text with line breaks between baselines and keeps spans', () => {
    const built = page(0, ['First line', 'Second line'])
    expect(built.text).toBe('First line\nSecond line')
    expect(built.spans).toHaveLength(2)
    expect(built.spans[0]).toMatchObject({ start: 0, end: 10, x: 72, y: 700 })
  })

  it('inserts a space at visible gaps inside one line and honors hasEOL', () => {
    const built = buildPage([item('Hello', 72, 700, 30), item('World', 120, 700, 30), { str: 'Next', transform: [11, 0, 0, 11, 72, 686], width: 25, height: 11, hasEOL: true }, { str: 'More', transform: [11, 0, 0, 11, 72, 672], width: 25, height: 11 }], {
      index: 0,
      label: '1',
      width: 612,
      height: 792,
    })
    expect(built.text).toContain('Hello World')
    expect(built.text).toContain('Next\nMore')
  })
})

describe('readableText / normalize', () => {
  it('merges end-of-line hyphenation and squeezes whitespace', () => {
    expect(readableText('stack-\nallocated  together.\n\n\nEnd')).toBe('stackallocated together.\n\nEnd')
  })

  it('folds quotes, dashes, ligatures (NFKC) and case; records original indexes', () => {
    const { value, map } = normalize('“ﬁne”–do-n\u2019t')
    // Inline hyphens stay (only line-break hyphenation merges); apostrophes fold.
    expect(value).toBe('"fine"-do-n\'t')
    // map[i] is the original index of output character i.
    expect(map).toHaveLength(value.length)
    expect(map[1]).toBe(1) // 'f' of the ligature 'ﬁ' (NFKC expands in place)
    expect(map[2]).toBe(1) // 'i' also came from the same ligature char
  })

  it('compact mode drops all whitespace', () => {
    const { value } = normalize('a  b\tc', true)
    expect(value).toBe('abc')
  })
})

describe('findInPage / findQuote', () => {
  const single = page(0, ['When a function returns a stack-allocated value,', 'the stack frame is de-', 'allocated together with a parent.'])

  it('matches across line breaks with de-hyphenation and returns original offsets', () => {
    const match = findInPage(single, 'stack-allocated value')
    expect(match).not.toBeNull()
    expect(single.text.slice(match!.start, match!.end)).toContain('stack-allocated value')
  })

  it('tolerates missing/extra whitespace (compact fallback)', () => {
    const match = findInPage(single, 'th estackframe')
    expect(match).not.toBeNull()
  })

  it('matches curly quotes and case-insensitively', () => {
    const curly = page(0, ['The “delayed popping” strategy works.'])
    expect(findInPage(curly, '"DELAYED popping" strategy')).not.toBeNull()
  })

  it('matches ellipsis spans ("start … end")', () => {
    const match = findInPage(single, 'When a function returns … allocated together')
    expect(match).not.toBeNull()
    expect(match!.start).toBe(0)
  })

  it('returns null when the quote is absent', () => {
    expect(findInPage(single, 'quantum chromodynamics')).toBeNull()
    expect(findInPage(single, 'ab')).toBeNull() // < 8 chars cannot span
  })

  it('prefers the preferred page and falls back to page order', () => {
    const pages = [page(0, ['alpha beta']), page(1, ['gamma delta']), page(2, ['alpha beta again'])]
    expect(findQuote(pages, 'gamma', 2)?.pageIndex).toBe(1)
    expect(findQuote(pages, 'alpha')?.pageIndex).toBe(0)
  })

  it('matches cross-page quotes and reports the part on the first page', () => {
    const pages = [page(0, ['… the evaluation section starts']), page(1, ['Evaluation', 'on our benchmarks.'])]
    const match = findQuote(pages, 'the evaluation section starts Evaluation')
    expect(match).not.toBeNull()
    expect(match!.pageIndex).toBe(0)
    expect(match!.end).toBe(pages[0]!.text.length)
  })
})

describe('rectsFor', () => {
  it('computes page-coordinate rectangles inside the text item, within tolerance', () => {
    const one = buildPage([item('Hello world', 72, 700, 100)], { index: 0, label: '1', width: 612, height: 792 })
    const match = findInPage(one, 'Hello')!
    const rects = rectsFor(one, match.start, match.end)
    expect(rects).toHaveLength(1)
    const [x1, y1, x2, y2] = rects[0]!
    expect(x1).toBeCloseTo(72, 1)
    expect(x2).toBeGreaterThan(x1)
    expect(x2).toBeLessThan(72 + 100 + 0.5)
    // Baseline 700: rect spans 0.25 size below and 0.75 above.
    expect(y1).toBeCloseTo(700 - 11 * 0.25, 1)
    expect(y2).toBeCloseTo(700 + 11 * 0.75, 1)
  })

  it('merges same-line fragments and keeps distinct lines separate', () => {
    const two = page(0, ['first half', 'second half'])
    const whole = rectsFor(two, 0, two.text.length)
    expect(whole.length).toBeGreaterThanOrEqual(2)
    // Ascending from the top (largest baseline first, since y grows upward).
    expect(whole[0]![1]!).toBeGreaterThan(whole[whole.length - 1]![1]!)
  })

  it('handles CJK full-width characters with page coordinates', () => {
    const chinese = page(0, ['中文引文测试', '第二行内容'])
    const match = findInPage(chinese, '引文')!
    expect(match).not.toBeNull()
    const rects = rectsFor(chinese, match.start, match.end)
    expect(rects).toHaveLength(1)
    const [x1, , x2] = rects[0]!
    // Each CJK char is a full em: two chars in ≈ 2/6 of the item width.
    expect(x1).toBeGreaterThan(72)
    expect(x2 - x1).toBeGreaterThan(20)
    expect(charWidth('中')).toBe(1000)
  })
})

describe('sortIndex / textAt', () => {
  it('builds Zotero-style sort keys: page|offset|distance-from-top', () => {
    // First line baseline y=700, rect top = 700 + 11*0.75 = 708.25;
    // distance from page top = floor(792 - 708.25) = 83.
    const one = page(2, ['top line', 'bottom line'])
    const rects = rectsFor(one, 0, one.text.length)
    const key = sortIndex(one, 5, rects)
    expect(key).toBe('00002|000005|00083')
  })

  it('extracts the matched text as written in the PDF (de-hyphenated)', () => {
    const one = page(0, ['stack frame is de-', 'allocated together'])
    const match = findInPage(one, 'deallocated')!
    expect(textAt(one, match.start, match.end)).toBe('deallocated')
  })
})

describe('parsePages', () => {
  it('parses single pages, ranges, lists and open-ended ranges (1-based in)', () => {
    expect(parsePages('3', 10)).toEqual([2])
    expect(parsePages('2-4', 10)).toEqual([1, 2, 3])
    expect(parsePages('1,4-6', 10)).toEqual([0, 3, 4, 5])
    expect(parsePages('10-', 12)).toEqual([9, 10, 11])
    expect(parsePages('-2', 10)).toEqual([0, 1])
  })

  it('throws on garbage and clamps out-of-range ends', () => {
    expect(() => parsePages('banana', 10)).toThrow()
    expect(parsePages('99', 3)).toEqual([])
  })
})

describe('searchPages', () => {
  it('returns each occurrence with page, label and context snippet', () => {
    const pages = [page(0, ['alpha says alpha']), page(1, ['beta uses alpha too'])]
    const results = searchPages(pages, 'alpha', 10)
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ pageIndex: 0, label: '1' })
    expect(results[0]!.snippet).toContain('«alpha»')
    expect(results[2]!.pageIndex).toBe(1)
  })

  it('honors maxResults', () => {
    const pages = [page(0, ['echo echo echo'])]
    expect(searchPages(pages, 'echo', 2)).toHaveLength(2)
  })
})

describe('pageIndexFor', () => {
  it('maps 1-based physical pages and rejects out-of-range', () => {
    const pages = [page(0, []), page(1, [])]
    expect(pageIndexFor(pages, 1)).toBe(0)
    expect(pageIndexFor(pages, 2)).toBe(1)
    expect(pageIndexFor(pages, 3)).toBeUndefined()
    expect(pageIndexFor(pages, 0)).toBeUndefined()
  })
})
