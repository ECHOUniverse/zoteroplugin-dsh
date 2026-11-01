/**
 * Metadata import (M7): DOI/arXiv identifier parsing, doi.org content
 * negotiation (CSL-JSON), arXiv Atom parsing, and the SSRF-guarded PDF
 * downloader shared by `add_item` and `attach_pdf`.
 *
 * Only the metadata allowlist hosts are ever contacted (doi.org for DOI
 * resolution redirects, export.arxiv.org for Atom, plus the caller-supplied
 * direct PDF URL — each still filtered through `metadata/net.ts`, which
 * refuses non-public hosts on every hop). Timeouts and the 100 MiB /
 * 60 s download budget come from `LIMITS`.
 *
 * Attribution: identifier grammar, CSL→Zotero and Atom→Zotero mappings,
 * filename sanitization and the download/streaming shape are adapted from
 * zai-org/zcode-plugins `ui-plugins/zotero` `src/metadata/metadata.ts`
 * (repo LICENSE: Apache-2.0). Modifications for this project: downloads go
 * through the SSRF-guarded `guardedFetch` (manual redirect validation, DNS
 * classification — the reference trusts public URLs as-is), timeouts flow
 * through this plugin's `LIMITS`, `ZoteroError` comes from the local domain
 * module, and the fetcher/lookup are injectable for offline tests. See
 * THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/metadata/metadata
 */

import { LIMITS, ZoteroError } from '../domain/model.ts'
import { decodeEntities } from '../domain/items.ts'
import { guardedFetch, type FetchLike, type LookupLike } from './net.ts'

/** A Zotero item the model may create (never key/version — Zotero owns those). */
export interface NewItem {
  itemType: string
  title: string
  creators: Creator[]
  [field: string]: unknown
}

export type Creator = import('../domain/model.ts').Creator

export interface ResolvedMetadata {
  item: NewItem
  /** Known open-access PDF location (arXiv always has one). */
  pdfUrl?: string
  source: 'doi' | 'arxiv'
}

export type Identifier = { kind: 'doi'; value: string } | { kind: 'arxiv'; value: string }

/** Recognize DOI and arXiv identifiers (incl. doi.org / arxiv.org links and arXiv DOIs). */
export function parseIdentifier(input: string): Identifier | null {
  const text = input.trim()
  const arxiv =
    /^(?:arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i.exec(text) ??
    /^(?:arxiv:\s*)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i.exec(text) ??
    /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/i.exec(text) ??
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i.exec(text)
  if (arxiv) return { kind: 'arxiv', value: arxiv[1]!.replace(/v\d+$/i, '') }
  const doi = /(?:^|doi\.org\/|doi:\s*)(10\.\d{4,9}\/[^\s"<>]+)$/i.exec(text)
  if (doi !== null) {
    // Malformed percent-encoding (`10.1234/a%zz`) is not a usable identifier:
    // surface `null` (callers map it to `invalid_input`), never a raw URIError.
    try {
      return { kind: 'doi', value: decodeURIComponent(doi[1]!).replace(/[.,;]+$/, '') }
    } catch {
      return null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// CSL-JSON (doi.org content negotiation) → Zotero
// ---------------------------------------------------------------------------

interface CslName {
  family?: string
  given?: string
  literal?: string
  name?: string
}
interface CslDate {
  'date-parts'?: (number | string)[][]
  literal?: string
  raw?: string
}
export interface CslItem {
  type?: string
  title?: string | string[]
  'container-title'?: string | string[]
  'collection-title'?: string
  'short-container-title'?: string | string[]
  'event-title'?: string
  event?: string | { name?: string }
  author?: CslName[]
  editor?: CslName[]
  issued?: CslDate
  published?: CslDate
  'published-print'?: CslDate
  'published-online'?: CslDate
  volume?: string | number
  issue?: string | number
  page?: string
  DOI?: string
  URL?: string
  ISSN?: string | string[]
  ISBN?: string | string[]
  publisher?: string
  'publisher-place'?: string
  abstract?: string
  language?: string
  number?: string | number
  genre?: string
  subtype?: string
}

const CSL_TYPES: Record<string, string> = {
  'article-journal': 'journalArticle',
  'journal-article': 'journalArticle',
  'paper-conference': 'conferencePaper',
  'proceedings-article': 'conferencePaper',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  chapter: 'bookSection',
  'book-chapter': 'bookSection',
  'reference-entry': 'bookSection',
  report: 'report',
  thesis: 'thesis',
  dissertation: 'thesis',
  'posted-content': 'preprint',
  article: 'preprint',
  dataset: 'dataset',
  webpage: 'webpage',
  'article-magazine': 'magazineArticle',
  'article-newspaper': 'newspaperArticle',
  standard: 'standard',
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || ''
const clean = (value: string) => decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

function cslNames(names: CslName[] | undefined, creatorType: string): Creator[] {
  return (names ?? [])
    .map((name) =>
      name.family
        ? { creatorType, firstName: name.given?.trim() ?? '', lastName: name.family.trim() }
        : { creatorType, name: (name.literal ?? name.name ?? '').trim() },
    )
    .filter((creator) => creator.lastName || creator.name)
}

function cslDate(item: CslItem): string {
  for (const date of [item.issued, item['published-print'], item['published-online'], item.published]) {
    const parts = date?.['date-parts']?.[0]
    if (parts?.length && parts[0]) {
      const [year, month, day] = parts.map(Number)
      return [String(year).padStart(4, '0'), month ? String(month).padStart(2, '0') : '', day ? String(day).padStart(2, '0') : '']
        .filter(Boolean)
        .join('-')
    }
    if (date?.literal || date?.raw) return String(date.literal ?? date.raw)
  }
  return ''
}

export function cslToZotero(csl: CslItem): NewItem {
  const itemType = CSL_TYPES[csl.type ?? ''] ?? 'journalArticle'
  const container = clean(first(csl['container-title']))
  const item: NewItem = {
    itemType,
    title: clean(first(csl.title)),
    creators: [...cslNames(csl.author, 'author'), ...cslNames(csl.editor, 'editor')],
    date: cslDate(csl),
    DOI: csl.DOI ?? '',
    url: csl.URL ?? '',
    abstractNote: csl.abstract ? clean(csl.abstract.replace(/<jats:title>[^<]*<\/jats:title>/g, '')) : '',
    language: csl.language ?? '',
    volume: csl.volume !== undefined ? String(csl.volume) : '',
    issue: csl.issue !== undefined ? String(csl.issue) : '',
    pages: csl.page ?? '',
    publisher: csl.publisher ?? '',
    place: csl['publisher-place'] ?? '',
    ISSN: first(csl.ISSN),
    ISBN: first(csl.ISBN),
    series: csl['collection-title'] ?? '',
    journalAbbreviation: clean(first(csl['short-container-title'])),
  }
  const event = typeof csl.event === 'string' ? csl.event : (csl.event?.name ?? csl['event-title'] ?? '')
  if (itemType === 'journalArticle' || itemType === 'magazineArticle' || itemType === 'newspaperArticle') item.publicationTitle = container
  else if (itemType === 'conferencePaper') {
    item.proceedingsTitle = container
    item.conferenceName = event
  } else if (itemType === 'bookSection') item.bookTitle = container
  else if (itemType === 'preprint') {
    item.repository = csl.publisher ?? container
    item.archiveID = csl.number !== undefined ? String(csl.number) : ''
  } else if (itemType === 'report') {
    item.institution = csl.publisher ?? ''
    item.reportNumber = csl.number !== undefined ? String(csl.number) : ''
  } else if (itemType === 'thesis') {
    item.university = csl.publisher ?? ''
    item.thesisType = csl.genre ?? ''
  } else if (itemType === 'webpage') item.websiteTitle = container
  return item
}

// ---------------------------------------------------------------------------
// arXiv Atom → Zotero
// ---------------------------------------------------------------------------

const tag = (xml: string, name: string) => {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return match ? clean(match[1]!) : ''
}

export function arxivToZotero(atom: string, id: string): ResolvedMetadata {
  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(atom)?.[1]
  if (!entry || /<title>\s*Error\s*<\/title>/i.test(entry)) throw new ZoteroError('metadata_not_found', `arXiv has no paper ${id}.`)
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((match) => clean(match[1]!))
  const creators: Creator[] = authors.map((name) => {
    const parts = name.split(' ')
    const lastName = parts.pop() ?? name
    return { creatorType: 'author', firstName: parts.join(' '), lastName }
  })
  const absId = tag(entry, 'id') // http://arxiv.org/abs/2401.01234v2
  const version = /v(\d+)$/.exec(absId)?.[1]
  const doi = tag(entry, 'arxiv:doi')
  const published = tag(entry, 'published').slice(0, 10)
  const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((match) => match[1]!)
  const comment = tag(entry, 'arxiv:comment')
  const journalRef = tag(entry, 'arxiv:journal_ref')
  const item: NewItem = {
    itemType: 'preprint',
    title: tag(entry, 'title'),
    creators,
    abstractNote: tag(entry, 'summary'),
    date: published,
    repository: 'arXiv',
    archiveID: `arXiv:${id}`,
    url: `https://arxiv.org/abs/${id}`,
    DOI: `10.48550/arXiv.${id}`,
    extra: [comment && `Comment: ${comment}`, journalRef && `Journal reference: ${journalRef}`, doi && `Published DOI: ${doi}`]
      .filter(Boolean)
      .join('\n'),
    tags: categories.map((category) => ({ tag: category, type: 1 })),
  }
  return { item, pdfUrl: `https://arxiv.org/pdf/${id}${version !== undefined ? `v${version}` : ''}`, source: 'arxiv' }
}

// ---------------------------------------------------------------------------
// Network (SSRF-guarded; fake fetchers in tests)
// ---------------------------------------------------------------------------

export type { FetchLike, LookupLike }

const USER_AGENT = '@hanxu131/dsh-zotero (DSH Zotero plugin; metadata import)'

export interface MetadataNetOptions {
  fetchImpl?: FetchLike
  lookup?: LookupLike
}

/** Resolve a DOI/arXiv identifier to Zotero item metadata over the network. */
export async function resolveIdentifier(identifier: Identifier, options: MetadataNetOptions = {}): Promise<ResolvedMetadata> {
  const signal = AbortSignal.timeout(LIMITS.metadataTimeoutMs)
  const base = {
    signal,
    redirects: LIMITS.downloadRedirects,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
  }
  if (identifier.kind === 'arxiv') {
    const { response } = await guardedFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(identifier.value)}`, {
      ...base,
      headers: { 'User-Agent': USER_AGENT },
    }).catch((error: unknown) => {
      // Reference error semantics: every transport-level failure of a
      // metadata lookup surfaces as metadata_not_found (with the reason kept
      // in the message — including SSRF refusals, which stay blocked).
      throw new ZoteroError('metadata_not_found', `Could not reach arXiv: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (!response.ok) throw new ZoteroError('metadata_not_found', `arXiv answered HTTP ${response.status}.`)
    return arxivToZotero(await response.text(), identifier.value)
  }
  const { response } = await guardedFetch(`https://doi.org/${encodeURI(identifier.value)}`, {
    ...base,
    headers: { Accept: 'application/vnd.citationstyles.csl+json', 'User-Agent': USER_AGENT },
  }).catch((error: unknown) => {
    // See the arXiv branch: transport failures are metadata_not_found.
    throw new ZoteroError('metadata_not_found', `Could not reach doi.org: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (response.status === 404) throw new ZoteroError('metadata_not_found', `doi.org does not know DOI ${identifier.value}.`)
  if (!response.ok) throw new ZoteroError('metadata_not_found', `doi.org answered HTTP ${response.status} for ${identifier.value}.`)
  let csl: CslItem
  try {
    csl = (await response.json()) as CslItem
  } catch {
    throw new ZoteroError('metadata_not_found', `doi.org returned no citation data for ${identifier.value}.`)
  }
  const item = cslToZotero(csl)
  if (!item.DOI) item.DOI = identifier.value
  if (!item.title) throw new ZoteroError('metadata_not_found', `The metadata for ${identifier.value} has no title.`)
  return { item, source: 'doi' }
}

export interface DownloadedPdf {
  bytes: Uint8Array
  filename: string
  finalUrl: string
}

/**
 * Download a PDF over the SSRF-guarded fetch: http(s) + public hosts on
 * every redirect hop, content-length and streamed-size caps at
 * `LIMITS.downloadBytes`, and the `%PDF-` magic check (within the first KiB,
 * tolerating leading junk some publishers prepend).
 */
export async function downloadPdf(url: string, options: MetadataNetOptions = {}): Promise<DownloadedPdf> {
  const signal = AbortSignal.timeout(LIMITS.downloadTimeoutMs)
  const { response, finalUrl } = await guardedFetch(url, {
    headers: { Accept: 'application/pdf,*/*;q=0.5', 'User-Agent': USER_AGENT },
    signal,
    redirects: LIMITS.downloadRedirects,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
  })
  if (!response.ok) throw new ZoteroError('download_failed', `Downloading ${url} failed with HTTP ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > LIMITS.downloadBytes) throw new ZoteroError('download_failed', `The file at ${url} is too large (over the ${Math.round(LIMITS.downloadBytes / 1024 / 1024)} MiB limit).`)
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > LIMITS.downloadBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ZoteroError('download_failed', `The file at ${url} is too large (over the ${Math.round(LIMITS.downloadBytes / 1024 / 1024)} MiB limit).`)
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (!looksLikePdf(bytes)) {
    throw new ZoteroError(
      'download_failed',
      `${url} did not return a PDF (got ${response.headers.get('content-type') ?? 'unknown content'}). It may be behind a login or a landing page; find a direct PDF link.`,
    )
  }
  const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
  let fromPath: string
  try {
    fromPath = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() ?? '')
  } catch {
    // A `%`-malformed URL path must degrade to `download_failed`, not leak a
    // URIError upstream (which would surface as an internal error).
    throw new ZoteroError('download_failed', `The download URL ${finalUrl} has a malformed percent-encoded file name.`)
  }
  return { bytes, filename: safeFilename(disposition ?? fromPath ?? 'document.pdf'), finalUrl }
}

/** `%PDF-` within the first 1 KiB (publishers sometimes prepend bytes). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  return head.includes('%PDF-')
}

/** Storage filename: strip path separators/control characters, force `.pdf`. */
export function safeFilename(name: string): string {
  const base =
    [...name]
      .map((char) => (char.charCodeAt(0) < 32 ? ' ' : char))
      .join('')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'document'
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

/** Zotero-style PDF filename: "Author - Year - Title.pdf". */
export function zoteroFilename(item: { title: string; creators: Creator[]; date?: unknown }): string {
  const authors = item.creators.filter((creator) => creator.creatorType === 'author')
  const last = (creator: Creator) => creator.lastName || creator.name || ''
  const who =
    authors.length === 0
      ? ''
      : authors.length === 1
        ? last(authors[0]!)
        : authors.length === 2
          ? `${last(authors[0]!)} and ${last(authors[1]!)}`
          : `${last(authors[0]!)} et al.`
  const year = /\d{4}/.exec(String(item.date ?? ''))?.[0] ?? ''
  const title = item.title.replace(/[:?]/g, '').slice(0, 100)
  return safeFilename([who, year, title].filter(Boolean).join(' - '))
}
