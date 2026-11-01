import { describe, expect, it } from 'vitest'
import type { RawItem } from '../src/domain/items.ts'
import {
  annotationLine,
  attachmentInfo,
  buildItemDetail,
  creatorSummaryOf,
  htmlToText,
  itemLine,
  noteInfo,
  parseAnnotation,
  stripLocalPaths,
  summarize,
  yearOf,
} from '../src/domain/items.ts'
import type { Annotation, Creator } from '../src/domain/model.ts'

/** Generic fixture builders — no personal data, all values invented for tests. */
function rawItem(overrides: Record<string, unknown>, extra: Partial<Omit<RawItem, 'data'>> = {}): RawItem {
  return {
    key: 'PAPERAAA',
    version: 7,
    meta: {},
    data: { key: 'PAPERAAA', itemType: 'journalArticle', title: '', tags: [], dateAdded: '2026-01-01T00:00:00Z', dateModified: '2026-01-02T00:00:00Z', ...overrides },
    ...extra,
  }
}

describe('summarize', () => {
  it('falls back through title candidates', () => {
    expect(summarize(rawItem({ title: '  A Real Title  ' })).title).toBe('A Real Title')
    expect(summarize(rawItem({ itemType: 'note', note: '<p>first line of the note</p><p>second</p>' })).title).toBe('first line of the note')
    expect(summarize(rawItem({ title: '', filename: 'fallback.pdf', itemType: 'attachment' })).title).toBe('fallback.pdf')
    expect(summarize(rawItem({ title: '' })).title).toBe('(untitled)')
  })

  it('prefers the server-provided creator summary over the local rule', () => {
    const creators: Creator[] = [
      { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
      { creatorType: 'author', firstName: 'Alan', lastName: 'Turing' },
    ]
    expect(summarize(rawItem({ creators }, { meta: { creatorSummary: 'Lovelace and Turing' } })).creatorSummary).toBe('Lovelace and Turing')
    expect(creatorSummaryOf(creators)).toBe('Lovelace and Turing')
    expect(creatorSummaryOf([{ creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' }])).toBe('Hopper')
    expect(creatorSummaryOf([
      { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
      { creatorType: 'author', firstName: 'Alan', lastName: 'Turing' },
      { creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' },
    ])).toBe('Lovelace et al.')
    // 非 author 仍然进入兜底（编辑、译者）。
    expect(creatorSummaryOf([{ creatorType: 'editor', name: 'Ed Itor' }])).toBe('Ed Itor')
    expect(creatorSummaryOf([])).toBe('')
  })

  it('derives the year from meta.parsedDate then from the date field', () => {
    expect(yearOf(rawItem({ date: '1999-03-01' }, { meta: { parsedDate: '1999-03-01' } }))).toBe('1999')
    expect(yearOf(rawItem({ date: 'published 1987' }))).toBe('1987')
    expect(yearOf(rawItem({ date: 'no year here' }))).toBe('')
    expect(yearOf(rawItem({}))).toBe('')
  })

  it('picks the first non-empty venue field', () => {
    expect(summarize(rawItem({ publicationTitle: 'Journal of Tests', publisher: ' ignored ' })).venue).toBe('Journal of Tests')
    expect(summarize(rawItem({ repository: 'arXiv' })).venue).toBe('arXiv')
    expect(summarize(rawItem({})).venue).toBe('')
  })

  it('extracts plain tag strings', () => {
    expect(summarize(rawItem({ tags: [{ tag: 'stack' }, { tag: 'types' }] })).tags).toEqual(['stack', 'types'])
    expect(summarize(rawItem({ tags: [] })).tags).toEqual([])
  })

  it('uses links.attachment as the best PDF', () => {
    const pdf = summarize(
      rawItem({}, { links: { attachment: { href: 'http://127.0.0.1:23119/api/users/0/items/PDFATTAA', attachmentType: 'application/pdf', attachmentSize: 1234 } } }),
    )
    expect(pdf.pdf).toEqual({ key: 'PDFATTAA', size: 1234 })
    const notPdf = summarize(rawItem({}, { links: { attachment: { href: 'http://127.0.0.1:23119/api/users/0/items/SNAPAACC', attachmentType: 'image/png' } } }))
    expect(notPdf.pdf).toBeNull()
  })

  it('treats a PDF attachment item as its own best PDF', () => {
    const attachment = rawItem({ itemType: 'attachment', contentType: 'application/pdf', linkMode: 'imported_file', filename: 'paper.pdf' })
    const summary = summarize(attachment)
    expect(summary.pdf).toEqual({ key: 'PAPERAAA' })
    expect(summary.title).toBe('paper.pdf')
    const linkedUrl = rawItem({ itemType: 'attachment', contentType: 'application/pdf', linkMode: 'linked_url', url: 'https://example.com/a.pdf' })
    expect(summarize(linkedUrl).pdf).toBeNull()
  })
})

describe('htmlToText', () => {
  it('converts block structure to newlines and list markers', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo')
    expect(htmlToText('<ul><li>alpha</li><li>beta</li></ul>')).toBe('- alpha\n- beta')
    expect(htmlToText('a<br>b')).toBe('a\nb')
  })

  it('drops script/style and decodes entities', () => {
    expect(htmlToText('<script>alert(1)</script>visible')).toBe('visible')
    expect(htmlToText('<style>p{}</style>x &amp; y &lt;z&gt;')).toBe('x & y <z>')
    expect(htmlToText('café&nbsp;&mdash; ok')).toBe('café — ok')
  })
})

describe('parseAnnotation', () => {
  it('parses position JSON into rects', () => {
    const annotation = parseAnnotation(rawItem({
      itemType: 'annotation',
      parentItem: 'PDFATTAA',
      annotationType: 'highlight',
      annotationText: 'We design a type system.',
      annotationComment: 'Key contribution',
      annotationColor: '#ffd400',
      annotationPageLabel: '2',
      annotationSortIndex: '00002|000010|00072',
      annotationPosition: JSON.stringify({ pageIndex: 1, rects: [[72, 692, 380, 703], [1, 2]] }),
      tags: [{ tag: 'important' }],
    }))
    expect(annotation.type).toBe('highlight')
    expect(annotation.pageIndex).toBe(1)
    expect(annotation.pageLabel).toBe('2')
    expect(annotation.rects).toEqual([[72, 692, 380, 703]])
    expect(annotation.sortIndex).toBe('00002|000010|00072')
    expect(annotation.tags).toEqual(['important'])
  })

  it('survives malformed position payloads with defaults', () => {
    const annotation = parseAnnotation(rawItem({ itemType: 'annotation', annotationPosition: '{not json' }))
    expect(annotation.pageIndex).toBe(0)
    expect(annotation.rects).toEqual([])
    expect(annotation.pageLabel).toBe('1')
    expect(annotation.color).toBe('#ffd400')
  })
})

describe('attachment and note projections', () => {
  it('attachmentInfo keeps link metadata but never a local path', () => {
    const info = attachmentInfo(rawItem({
      itemType: 'attachment',
      linkMode: 'imported_file',
      contentType: 'application/pdf',
      filename: 'paper.pdf',
      title: 'Full Text PDF',
      parentItem: 'PAPERAAA',
    }))
    expect(info.isPdf).toBe(true)
    expect(info.filename).toBe('paper.pdf')
    expect(info.parent).toBe('PAPERAAA')
    expect(JSON.stringify(info)).not.toMatch(/file:\/\/|\/Users\/|storage\//)
        const linked = attachmentInfo(rawItem({ itemType: 'attachment', linkMode: 'linked_url', contentType: 'application/pdf', url: 'https://example.com/x.pdf' }))
    expect(linked.isPdf).toBe(false)
    expect(linked.url).toBe('https://example.com/x.pdf')
  })

  it('noteInfo carries html plus a plain-text excerpt', () => {
    const info = noteInfo(rawItem({ itemType: 'note', note: '<p><strong>Reading note</strong>: compare.</p>', dateModified: '2026-01-03T00:00:00Z' }))
    expect(info.html).toContain('<strong>')
    expect(info.excerpt).toBe('Reading note: compare.')
    expect(info.dateModified).toBe('2026-01-03T00:00:00Z')
  })
})

describe('buildItemDetail', () => {
  it('projects fields, collections, children and self-notes', () => {
    const paper = rawItem({
      title: 'Second-Class Values Revisited',
      creators: [
        { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
        { creatorType: 'author', firstName: 'Alan', lastName: 'Turing' },
      ],
      abstractNote: 'We design a type system.',
      publicationTitle: 'Journal of Stack Studies',
      date: '2022-06-01',
      DOI: '10.1234/stack',
      collections: ['CLTYAAAA'],
      extraField: 'kept',
      relations: {},
    }, { meta: { creatorSummary: 'Lovelace et al.', parsedDate: '2022-06-01', numChildren: 2 } })
    const children = [
      rawItem({ itemType: 'attachment', parentItem: 'PAPERAAA', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'paper.pdf', title: 'Full Text PDF', dateModified: '2026-01-05T00:00:00Z' }, { key: 'PDFATTAA' }),
      rawItem({ itemType: 'note', parentItem: 'PAPERAAA', note: '<p>child note</p>' }, { key: 'NTEAAAAA' }),
    ]
    const detail = buildItemDetail(paper, children, [{ key: 'CLTYAAAA', name: 'Type Systems' }], 42, 'user')
    expect(detail.title).toBe('Second-Class Values Revisited')
    expect(detail.itemVersion).toBe(7)
    expect(detail.version).toBe(42)
    expect(detail.fields.DOI).toBe('10.1234/stack')
    expect(detail.fields.extraField).toBe('kept')
    expect(detail.fields.title).toBeUndefined()
    expect(detail.fields.creators).toBeUndefined()
    expect(detail.abstract).toBe('We design a type system.')
    expect(detail.collections).toEqual([{ key: 'CLTYAAAA', name: 'Type Systems' }])
    expect(detail.attachments).toHaveLength(1)
    expect(detail.attachments[0]!.key).toBe('PDFATTAA')
    expect(detail.notes).toHaveLength(1)
    expect(detail.notes[0]!.excerpt).toBe('child note')
    expect(detail.pdf).toEqual({ key: 'PDFATTAA' })
    expect(detail.parent).toBeNull()
  })

  it('sorts PDF attachments first and includes the item itself for attachments', () => {
    const attachment = rawItem({
      itemType: 'attachment',
      linkMode: 'imported_file',
      contentType: 'application/pdf',
      filename: 'solo.pdf',
      title: '',
      parentItem: 'PAPERAAA',
    }, { key: 'PDFBAAAA' })
    const detail = buildItemDetail(attachment, [], [], 1, 'g99')
    expect(detail.attachments.map((a) => a.key)).toEqual(['PDFBAAAA'])
    expect(detail.pdf).toEqual({ key: 'PDFBAAAA' })
    expect(detail.parent).toBe('PAPERAAA')

    const parent = rawItem({ title: 'Parent' })
    const children = [
      rawItem({ itemType: 'attachment', parentItem: 'PAPERAAA', contentType: 'text/html', linkMode: 'imported_file', title: 'Snapshot', filename: 'x.html' }, { key: 'SNAPAACC' }),
      rawItem({ itemType: 'attachment', parentItem: 'PAPERAAA', contentType: 'application/pdf', linkMode: 'imported_file', title: 'Zeta PDF', filename: 'z.pdf' }, { key: 'PDFZAAAA' }),
    ]
    const detail2 = buildItemDetail(parent, children, [], 3, 'user')
    expect(detail2.library).toBe('user')
    expect(detail2.attachments.map((a) => a.key)).toEqual(['PDFZAAAA', 'SNAPAACC'])
  })
})

describe('model text', () => {
  it('itemLine renders one line with key, authors, venue, pdf and tags', () => {
    const summary = summarize(rawItem({
      title: 'A Paper',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
      publicationTitle: 'Journal of Tests',
      date: '2020-01-01',
      tags: [{ tag: 'a' }, { tag: 'b' }],
    }, { meta: { parsedDate: '2020-01-01' } }))
    const line = itemLine(summary)
    expect(line).toContain('[PAPERAAA] A Paper')
    expect(line).toContain('Lovelace (2020)')
    expect(line).toContain('Journal of Tests')
    expect(line).toContain('tags: a, b')
    const withPdf = summarize(rawItem({ title: 'P' }, { links: { attachment: { href: 'http://127.0.0.1:23119/api/users/0/items/PDFATTAA', attachmentType: 'application/pdf' } } }))
    expect(itemLine(withPdf)).toContain('PDF PDFATTAA')
  })

  it('annotationLine renders page, type, text and comment', () => {
    const annotation: Annotation = {
      key: 'ANNTAAAA',
      type: 'highlight',
      text: '  We design  a type system. ',
      comment: ' Key contribution ',
      color: '#ffd400',
      pageIndex: 1,
      pageLabel: '2',
      rects: [],
      sortIndex: '',
      tags: ['important'],
      dateModified: '',
    }
    const line = annotationLine(annotation)
    expect(line).toContain('p. 2 highlight #ffd400')
    expect(line).toContain('“We design a type system.”')
    expect(line).toContain('comment: Key contribution')
    expect(line).toContain('[tags: important]')
    expect(line).toContain('key ANNTAAAA')
  })
})

describe('stripLocalPaths', () => {
  it('removes BibTeX file fields pointing into local storage', () => {
    const bib = `@article{lovelace_2020,\n\ttitle = {A Paper},\n\tauthor = {Lovelace, Ada},\n\tyear = {2020},\n\tfile = {PDF:/Users/someone/Zotero/storage/PDFATTAA/paper.pdf:application/pdf},\n}`
    const stripped = stripLocalPaths(bib)
    expect(stripped).not.toContain('/Users/someone')
    expect(stripped).toContain('title = {A Paper}')
  })

  it('removes RIS L1 lines with local file links', () => {
    const ris = 'TY  - JOUR\nTI  - A Paper\nL1  - file:///Users/someone/Zotero/storage/PDFATTAA/paper.pdf\nER  -\n'
    const stripped = stripLocalPaths(ris)
    expect(stripped).not.toContain('L1')
    expect(stripped).not.toContain('/Users/someone')
    expect(stripped).toContain('TI  - A Paper')
  })
})
