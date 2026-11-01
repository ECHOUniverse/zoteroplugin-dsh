/**
 * Invented metadata fixtures for the import tests (M7). All data is made up
 * for tests — no real paper, author or publisher is referenced; the shapes
 * mirror the documented doi.org content-negotiation (CSL-JSON) and arXiv
 * Atom responses so the parser contracts are exercised faithfully.
 *
 * @module tests/helpers/metadata-fixtures
 */

/** CSL-JSON for a journal article (Crossref-style fields). */
export const CSL_JOURNAL = {
  type: 'journal-article',
  title: ['Containment Hierarchies for Test Fixtures'],
  'container-title': ['Journal of Imaginary Systems'],
  author: [
    { given: 'Grace', family: 'Hopper' },
    { given: 'Alan', family: 'Turing' },
    { given: 'Radia', family: 'Perlman' },
  ],
  editor: [{ given: 'Edsger', family: 'Dijkstra' }],
  issued: { 'date-parts': [[2021, 3, 14]] },
  volume: '12',
  issue: '3',
  page: '101-118',
  DOI: '10.9999/fake.2021.031',
  URL: 'https://example.org/fake-article',
  ISSN: ['1234-5678', '8765-4321'],
  publisher: 'Pretend Press',
  'publisher-place': 'Nowhere',
  abstract: '<jats:p>An <jats:italic>imaginary</jats:italic> study.</jats:p><jats:title>Summary</jats:title>',
  language: 'en',
} as const

/** CSL-JSON for a conference paper. */
export const CSL_CONFERENCE = {
  type: 'paper-conference',
  title: ['Scaling Fake Data to production'],
  'container-title': ['Proceedings of the Conference on Made-Up Systems'],
  event: 'MUPS 2020',
  author: [{ given: 'Barbara', family: 'Liskov' }],
  issued: { 'date-parts': [[2020, 11, 2]] },
  DOI: '10.9999/conf.2020.42',
  publisher: 'Union of Fictional Publishers',
} as const

/** CSL-JSON with a literal date and a literal (organizational) author. */
export const CSL_LITERAL = {
  type: 'report',
  title: 'State of the Art of Nothing',
  author: [{ literal: 'Fictional Standards Committee' }],
  issued: { literal: 'March 2019' },
  number: 'RFC-0000',
  publisher: 'Imaginary Consortium',
} as const

/** arXiv Atom entry (single entry, new-style id, with journal ref + DOI). */
export const ATOM_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: test</title>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <updated>2024-01-05T18:00:00Z</updated>
    <published>2024-01-03T18:00:00Z</published>
    <title>A Fabricated Study of Placeholder Topics</title>
    <summary>We present an entirely invented abstract about placeholder topics.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Charles Babbage</name></author>
    <author><name>von Neumann, John</name></author>
    <arxiv:comment>12 pages, 3 figures</arxiv:comment>
    <arxiv:journal_ref>Imaginary Transactions 45 (2024) 7</arxiv:journal_ref>
    <arxiv:doi>10.9999/real-journal.2024.7</arxiv:doi>
    <category term="cs.DB" />
    <category term="cs.LO" />
  </entry>
</feed>
`

/** arXiv Atom error entry (unknown id). */
export const ATOM_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/9999.99999v1</id>
    <updated>2024-01-01T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>Error</title>
    <summary>Malformed or expired id.</summary>
  </entry>
</feed>
`

/** A minimal `%PDF-` document used by the download tests. */
export const PDF_BYTES = (marker = '%PDF-1.4 fake fixture'): Uint8Array => new TextEncoder().encode(`${marker}\n`)
