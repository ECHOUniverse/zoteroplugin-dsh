/**
 * Metadata import tests (M7): identifier grammar (DOI/arXiv links, versions,
 * normalization), CSL-JSON → Zotero and arXiv Atom → Zotero conversion over
 * invented fixtures, the network contract of `resolveIdentifier` (content
 * negotiation headers, timeout wiring, error mapping) and the `downloadPdf`
 * budget (100 MiB cap, streamed-size cap, `%PDF-` magic, filename handling).
 * Every fetch is an injected fake — no test touches the real network.
 */
import { describe, expect, it } from 'vitest'
import {
  arxivToZotero,
  cslToZotero,
  downloadPdf,
  looksLikePdf,
  parseIdentifier,
  resolveIdentifier,
  safeFilename,
  zoteroFilename,
} from '../src/metadata/metadata.ts'
import { LIMITS, ZoteroError } from '../src/domain/model.ts'
import { ATOM_ENTRY, ATOM_ERROR, CSL_CONFERENCE, CSL_JOURNAL, CSL_LITERAL, PDF_BYTES } from './helpers/metadata-fixtures.ts'

describe('parseIdentifier (input normalization)', () => {
  it('accepts bare DOIs, doi: prefixes, doi.org links and trailing punctuation', () => {
    expect(parseIdentifier('10.9999/fake.2021.031')).toEqual({ kind: 'doi', value: '10.9999/fake.2021.031' })
    expect(parseIdentifier('  doi:10.9999/fake.2021.031 ')).toEqual({ kind: 'doi', value: '10.9999/fake.2021.031' })
    expect(parseIdentifier('https://doi.org/10.9999/fake.2021.031')).toEqual({ kind: 'doi', value: '10.9999/fake.2021.031' })
    expect(parseIdentifier('http://dx.doi.org/10.9999/fake.2021.031')).toEqual({ kind: 'doi', value: '10.9999/fake.2021.031' })
    // Trailing sentence punctuation is stripped; interior punctuation stays.
    expect(parseIdentifier('doi.org/10.9999/fake.2021,031.')).toEqual({ kind: 'doi', value: '10.9999/fake.2021,031' })
  })

  it('accepts new- and old-style arXiv ids, versions, prefixes and links', () => {
    expect(parseIdentifier('2401.01234')).toEqual({ kind: 'arxiv', value: '2401.01234' })
    expect(parseIdentifier('2401.01234v3')).toEqual({ kind: 'arxiv', value: '2401.01234' })
    expect(parseIdentifier('arXiv:2401.01234')).toEqual({ kind: 'arxiv', value: '2401.01234' })
    expect(parseIdentifier('https://arxiv.org/abs/2401.01234v2')).toEqual({ kind: 'arxiv', value: '2401.01234' })
    expect(parseIdentifier('arxiv.org/pdf/2401.01234')).toEqual({ kind: 'arxiv', value: '2401.01234' })
    expect(parseIdentifier('cs/0112017v1')).toEqual({ kind: 'arxiv', value: 'cs/0112017' })
    expect(parseIdentifier('math.GT/0309136')).toEqual({ kind: 'arxiv', value: 'math.GT/0309136' })
    // arXiv's own DOI resolves to the underlying id.
    expect(parseIdentifier('10.48550/arXiv.2401.01234')).toEqual({ kind: 'arxiv', value: '2401.01234' })
  })

  it('rejects non-identifiers', () => {
    expect(parseIdentifier('')).toBeNull()
    expect(parseIdentifier('not an identifier')).toBeNull()
    expect(parseIdentifier('10.9999')).toBeNull()
    expect(parseIdentifier('https://example.org/paper')).toBeNull()
    expect(parseIdentifier('2401.01')).toBeNull()
  })

  it('treats malformed percent-encoding as a non-identifier instead of throwing URIError', () => {
    expect(parseIdentifier('10.9999/fake%zz')).toBeNull()
    expect(parseIdentifier('https://doi.org/10.9999/a%2zb')).toBeNull()
    // Valid escapes still decode (existing behavior preserved).
    expect(parseIdentifier('https://doi.org/10.9999/fake%2F2021')).toEqual({ kind: 'doi', value: '10.9999/fake/2021' })
  })
})

describe('cslToZotero (CSL-JSON fixtures)', () => {
  it('maps a journal article with creators, date parts, container and JATS cleaning', () => {
    const item = cslToZotero(CSL_JOURNAL)
    expect(item.itemType).toBe('journalArticle')
    expect(item.title).toBe('Containment Hierarchies for Test Fixtures')
    expect(item.creators).toEqual([
      { creatorType: 'author', firstName: 'Grace', lastName: 'Hopper' },
      { creatorType: 'author', firstName: 'Alan', lastName: 'Turing' },
      { creatorType: 'author', firstName: 'Radia', lastName: 'Perlman' },
      { creatorType: 'editor', firstName: 'Edsger', lastName: 'Dijkstra' },
    ])
    expect(item.date).toBe('2021-03-14')
    expect(item.publicationTitle).toBe('Journal of Imaginary Systems')
    expect(item.volume).toBe('12')
    expect(item.issue).toBe('3')
    expect(item.pages).toBe('101-118')
    expect(item.DOI).toBe('10.9999/fake.2021.031')
    expect(item.url).toBe('https://example.org/fake-article')
    expect(item.ISSN).toBe('1234-5678')
    expect(item.publisher).toBe('Pretend Press')
    expect(item.place).toBe('Nowhere')
    expect(item.language).toBe('en')
    // JATS tags are stripped (incl. the section title) and entities decoded.
    expect(item.abstractNote).toBe('An imaginary study.')
    expect(item.abstractNote).not.toContain('<')
  })

  it('maps a conference paper with proceedings title and event name', () => {
    const item = cslToZotero(CSL_CONFERENCE)
    expect(item.itemType).toBe('conferencePaper')
    expect(item.proceedingsTitle).toBe('Proceedings of the Conference on Made-Up Systems')
    expect(item.conferenceName).toBe('MUPS 2020')
    expect(item.date).toBe('2020-11-02')
  })

  it('keeps literal dates and organizational authors as given', () => {
    const item = cslToZotero(CSL_LITERAL)
    expect(item.itemType).toBe('report')
    expect(item.creators).toEqual([{ creatorType: 'author', name: 'Fictional Standards Committee' }])
    expect(item.date).toBe('March 2019')
    expect(item.reportNumber).toBe('RFC-0000')
    expect(item.institution).toBe('Imaginary Consortium')
  })

  it('falls back to journalArticle for unknown types', () => {
    expect(cslToZotero({ type: 'song', title: 'x' }).itemType).toBe('journalArticle')
  })
})

describe('arxivToZotero (Atom fixture)', () => {
  it('builds a preprint with creators, categories, extra fields and the PDF url', () => {
    const resolved = arxivToZotero(ATOM_ENTRY, '2401.01234')
    expect(resolved.source).toBe('arxiv')
    expect(resolved.pdfUrl).toBe('https://arxiv.org/pdf/2401.01234v2')
    const item = resolved.item
    expect(item.itemType).toBe('preprint')
    expect(item.title).toBe('A Fabricated Study of Placeholder Topics')
    expect(item.creators).toEqual([
      { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
      { creatorType: 'author', firstName: 'Charles', lastName: 'Babbage' },
      // "von Neumann, John" is split the same way the reference does: the
      // last blank-separated token becomes the last name.
      { creatorType: 'author', firstName: 'von Neumann,', lastName: 'John' },
    ])
    expect(item.date).toBe('2024-01-03')
    expect(item.repository).toBe('arXiv')
    expect(item.archiveID).toBe('arXiv:2401.01234')
    expect(item.DOI).toBe('10.48550/arXiv.2401.01234')
    expect(item.url).toBe('https://arxiv.org/abs/2401.01234')
    expect(item.tags).toEqual([
      { tag: 'cs.DB', type: 1 },
      { tag: 'cs.LO', type: 1 },
    ])
    expect(item.extra).toContain('Comment: 12 pages, 3 figures')
    expect(item.extra).toContain('Journal reference: Imaginary Transactions 45 (2024) 7')
    expect(item.extra).toContain('Published DOI: 10.9999/real-journal.2024.7')
  })

  it('throws metadata_not_found on the arXiv error entry', () => {
    expect(() => arxivToZotero(ATOM_ERROR, '9999.99999')).toThrowError(ZoteroError)
    expect(() => arxivToZotero('', '0000.00000')).toThrowError(/metadata_not_found|no paper/)
  })
})

describe('resolveIdentifier (network contract, fake fetch)', () => {
  it('requests CSL-JSON from doi.org with content negotiation and the timeout signal', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify(CSL_JOURNAL), { status: 200, headers: { 'content-type': 'application/vnd.citationstyles.csl+json' } })
    }
    const resolved = await resolveIdentifier({ kind: 'doi', value: '10.9999/fake.2021.031' }, { fetchImpl })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://doi.org/10.9999/fake.2021.031')
    expect((seen[0]!.init?.headers as Record<string, string>).Accept).toBe('application/vnd.citationstyles.csl+json')
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(resolved.source).toBe('doi')
    expect(resolved.item.DOI).toBe('10.9999/fake.2021.031')
  })

  it('maps doi.org 404 and non-ok answers to metadata_not_found', async () => {
    const notFound = resolveIdentifier({ kind: 'doi', value: '10.9999/unknown' }, { fetchImpl: async () => new Response('not found', { status: 404 }) })
    await expect(notFound).rejects.toMatchObject({ code: 'metadata_not_found' })
    const boom = resolveIdentifier({ kind: 'doi', value: '10.9999/x' }, { fetchImpl: async () => new Response('bad gateway', { status: 502 }) })
    await expect(boom).rejects.toMatchObject({ code: 'metadata_not_found' })
    const junk = resolveIdentifier({ kind: 'doi', value: '10.9999/x' }, { fetchImpl: async () => new Response('<html>landing</html>', { status: 200 }) })
    await expect(junk).rejects.toMatchObject({ code: 'metadata_not_found' })
  })

  it('queries export.arxiv.org with the id_list and parses the Atom answer', async () => {
    const seen: string[] = []
    const resolved = await resolveIdentifier({ kind: 'arxiv', value: '2401.01234' }, {
      fetchImpl: async (url) => {
        seen.push(url)
        return new Response(ATOM_ENTRY, { status: 200 })
      },
    })
    expect(seen).toEqual(['https://export.arxiv.org/api/query?id_list=2401.01234'])
    expect(resolved.source).toBe('arxiv')
    expect(resolved.item.title).toContain('Fabricated')
  })

  it('maps arXiv errors and transport failures to metadata_not_found', async () => {
    await expect(
      resolveIdentifier({ kind: 'arxiv', value: '9999.99999' }, { fetchImpl: async () => new Response(ATOM_ERROR, { status: 200 }) }),
    ).rejects.toMatchObject({ code: 'metadata_not_found' })
    await expect(
      resolveIdentifier({ kind: 'arxiv', value: '2401.01234' }, { fetchImpl: async () => new Response('nope', { status: 500 }) }),
    ).rejects.toMatchObject({ code: 'metadata_not_found' })
    await expect(
      resolveIdentifier({ kind: 'arxiv', value: '2401.01234' }, { fetchImpl: async () => { throw new Error('connection reset') } }),
    ).rejects.toMatchObject({ code: 'metadata_not_found' })
  })
})

describe('downloadPdf (budget + magic, fake fetch)', () => {
  const pdfResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf', ...headers } })

  it('returns bytes, a sanitized filename from content-disposition or the URL', async () => {
    const result = await downloadPdf('https://example.org/papers/Fake%20Paper.pdf', {
      fetchImpl: async () => pdfResponse(PDF_BYTES(), { 'content-disposition': 'attachment; filename="real-name.pdf"' }),
    })
    expect(result.filename).toBe('real-name.pdf')
    expect(looksLikePdf(result.bytes)).toBe(true)
    expect(result.finalUrl).toBe('https://example.org/papers/Fake%20Paper.pdf')

    const fromPath = await downloadPdf('https://example.org/other.pdf', { fetchImpl: async () => pdfResponse(PDF_BYTES()) })
    expect(fromPath.filename).toBe('other.pdf')
  })

  it('refuses oversized declared sizes (content-length cap)', async () => {
    const promise = downloadPdf('https://example.org/huge.pdf', {
      fetchImpl: async () => pdfResponse(PDF_BYTES(), { 'content-length': String(LIMITS.downloadBytes + 1) }),
    })
    await expect(promise).rejects.toMatchObject({ code: 'download_failed' })
    await expect(promise).rejects.toThrowError(/too large/)
  })

  it('caps streamed bodies that exceed the limit without declaring it', async () => {
    const big = new Uint8Array(LIMITS.downloadBytes + 1)
    big.set(PDF_BYTES())
    const promise = downloadPdf('https://example.org/streamed.pdf', {
      fetchImpl: async () => new Response(big as BodyInit, { status: 200 }),
    })
    await expect(promise).rejects.toMatchObject({ code: 'download_failed' })
    await expect(promise).rejects.toThrowError(/too large/)
  })

  it('refuses non-PDF payloads with the %PDF- magic check', async () => {
    const promise = downloadPdf('https://example.org/landing', {
      fetchImpl: async () => pdfResponse(new TextEncoder().encode('<html>login wall</html>'), { 'content-type': 'text/html' }),
    })
    await expect(promise).rejects.toMatchObject({ code: 'download_failed' })
    await expect(promise).rejects.toThrowError(/did not return a PDF/)
  })

  it('maps HTTP errors to download_failed', async () => {
    await expect(downloadPdf('https://example.org/x.pdf', { fetchImpl: async () => new Response('forbidden', { status: 403 }) })).rejects.toMatchObject({
      code: 'download_failed',
    })
  })

  it('maps a malformed percent-encoded URL path to download_failed (no URIError leak)', async () => {
    // The PDF bytes are fine; only the `%zz` path segment is undecodable.
    const promise = downloadPdf('https://example.org/papers/a%zz.pdf', { fetchImpl: async () => pdfResponse(PDF_BYTES()) })
    await expect(promise).rejects.toBeInstanceOf(ZoteroError)
    await expect(promise).rejects.toMatchObject({ code: 'download_failed' })
    await expect(promise).rejects.toThrowError(/percent-encoded/)
  })
})

describe('filename helpers', () => {
  it('safeFilename strips separators/control chars and forces .pdf', () => {
    expect(safeFilename('weird/name:*.pdf')).toBe('weird name .pdf')
    expect(safeFilename('no-extension')).toBe('no-extension.pdf')
    expect(safeFilename('a\u0000b')).toBe('a b.pdf')
    expect(safeFilename('')).toBe('document.pdf')
    expect(safeFilename('x'.repeat(500)).length).toBeLessThanOrEqual(154)
  })

  it('zoteroFilename follows the "Author - Year - Title" convention', () => {
    const creators = [
      { creatorType: 'author' as const, firstName: 'Grace', lastName: 'Hopper' },
      { creatorType: 'author' as const, firstName: 'Alan', lastName: 'Turing' },
      { creatorType: 'author' as const, firstName: 'Radia', lastName: 'Perlman' },
    ]
    expect(zoteroFilename({ title: 'Fake: Study?', creators, date: '2021-03-14' })).toBe('Hopper et al. - 2021 - Fake Study.pdf')
    expect(zoteroFilename({ title: 'Duo', creators: creators.slice(0, 2), date: '2020' })).toBe('Hopper and Turing - 2020 - Duo.pdf')
    expect(zoteroFilename({ title: 'Solo', creators: [creators[0]!], date: '' })).toBe('Hopper - Solo.pdf')
    expect(zoteroFilename({ title: 'Nobody', creators: [], date: '1999' })).toBe('1999 - Nobody.pdf')
  })
})
