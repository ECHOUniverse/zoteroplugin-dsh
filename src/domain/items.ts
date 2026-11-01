/**
 * Pure projections from raw Zotero Local API item JSON to domain summaries,
 * details, annotations and model-facing text. No I/O — everything here is
 * trivially unit-testable and reusable by routes, tools and stores.
 *
 * Attribution: adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/domain/items.ts` (repo LICENSE: Apache-2.0); `stripLocalPaths` comes
 * from the same project's `src/zotero/library.ts`. Modifications: renamed
 * `creatorSummary` → `creatorSummaryOf` to avoid confusion with the meta
 * field, extracted `noteInfo`/`attachmentInfo` builders, added `buildItemDetail`
 * as a pure function (the reference builds details inside its Library class),
 * and attachments never carry local paths (spec V-4 unresolved). See
 * THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/domain/items
 */

import { KEY_PATTERN, type Annotation, type AttachmentInfo, type Creator, type ItemDetail, type ItemSummary, type LibraryId, type NoteInfo, type Rect } from './model.ts'

/** Raw Local API item JSON (only the fields the projections use). */
export interface RawItem {
  key: string
  version: number
  links?: {
    attachment?: { href?: string; attachmentType?: string; attachmentSize?: number }
  }
  meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number }
  data: Record<string, unknown> & { key: string; itemType: string }
}

const VENUE_FIELDS = [
  'publicationTitle',
  'proceedingsTitle',
  'bookTitle',
  'conferenceName',
  'websiteTitle',
  'blogTitle',
  'forumTitle',
  'repository',
  'university',
  'institution',
  'publisher',
  'court',
  'programTitle',
] as const

/** Four-digit year: `meta.parsedDate` first, then a year token in `date`. */
export function yearOf(raw: RawItem): string {
  const parsed = raw.meta?.parsedDate ?? ''
  if (/^\d{4}/.test(parsed)) return parsed.slice(0, 4)
  const match = /\b(1[5-9]\d\d|20\d\d|21\d\d)\b/.exec(String(raw.data.date ?? ''))
  return match ? match[1]! : ''
}

export function creatorName(creator: Creator): string {
  if (creator.name) return creator.name
  return [creator.firstName, creator.lastName].filter(Boolean).join(' ')
}

/** Zotero's creator summary rule: 1 → "Last", 2 → "A and B", 3+ → "A et al.". */
export function creatorSummaryOf(creators: Creator[]): string {
  const authors = creators.filter((creator) => creator.creatorType === 'author')
  const list = authors.length ? authors : creators
  const last = (creator: Creator) => creator.lastName || creator.name || creator.firstName || ''
  if (!list.length) return ''
  if (list.length === 1) return last(list[0]!)
  if (list.length === 2) return `${last(list[0]!)} and ${last(list[1]!)}`
  return `${last(list[0]!)} et al.`
}

/** Item → list summary with title fallbacks and best-PDF detection. */
export function summarize(raw: RawItem): ItemSummary {
  const data = raw.data
  const isPdfAttachment = data.itemType === 'attachment' && data.contentType === 'application/pdf' && data.linkMode !== 'linked_url'
  const best = raw.links?.attachment
  const bestKey = best?.href?.split('/').pop()
  const pdf = isPdfAttachment
    ? { key: raw.key }
    : best?.attachmentType === 'application/pdf' && bestKey && KEY_PATTERN.test(bestKey)
      ? { key: bestKey, ...(best.attachmentSize ? { size: best.attachmentSize } : {}) }
      : null
  const creators = (data.creators as Creator[] | undefined) ?? []
  const title =
    String(data.title ?? '').trim() ||
    (data.itemType === 'note' ? htmlToText(String(data.note ?? '')).split('\n')[0]!.slice(0, 120) : '') ||
    String(data.filename ?? '') ||
    '(untitled)'
  return {
    key: raw.key,
    itemType: data.itemType,
    title,
    creatorSummary: raw.meta?.creatorSummary ?? creatorSummaryOf(creators),
    year: yearOf(raw),
    venue: VENUE_FIELDS.map((field) => String(data[field] ?? '').trim()).find(Boolean) ?? '',
    tags: ((data.tags as { tag: string }[] | undefined) ?? []).map((tag) => tag.tag),
    numChildren: raw.meta?.numChildren ?? 0,
    pdf,
    dateAdded: String(data.dateAdded ?? ''),
    dateModified: String(data.dateModified ?? ''),
  }
}

/**
 * Best PDF attachment key of a projected item: the item itself when it is a
 * PDF attachment, else Zotero's best attachment link key (`null` when there
 * is none or the attachment is not a stored PDF). Single home of the
 * "best PDF" rule, shared by the session facade, routes and tools. Best-PDF
 * link keys come from Zotero hrefs; anything that is not an item key is
 * rejected (`KEY_PATTERN`).
 */
export function bestPdfKeyOf(item: { key: string; itemType: string; pdf: { key: string } | null }): string | null {
  if (item.itemType === 'attachment') return item.pdf !== null ? item.key : null
  return item.pdf?.key ?? null
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Note / citation HTML to plain text: block elements break lines, list items get "- ". */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<span class="Z3988"[^>]*>[\s\S]*?<\/span>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|pre|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Raw annotation item → domain annotation; malformed positions degrade to empty rects. */
export function parseAnnotation(raw: RawItem): Annotation {
  const data = raw.data
  let pageIndex = 0
  let rects: Rect[] = []
  try {
    const position = JSON.parse(String(data.annotationPosition ?? '{}')) as { pageIndex?: number; rects?: number[][] }
    pageIndex = position.pageIndex ?? 0
    rects = (position.rects ?? []).filter((rect) => rect.length === 4).map((rect) => [rect[0]!, rect[1]!, rect[2]!, rect[3]!] as Rect)
  } catch {
    // Annotations whose position cannot be parsed still list; they just do not draw.
  }
  return {
    key: raw.key,
    type: String(data.annotationType ?? 'highlight'),
    text: String(data.annotationText ?? ''),
    comment: String(data.annotationComment ?? ''),
    color: String(data.annotationColor ?? '#ffd400'),
    pageIndex,
    pageLabel: String(data.annotationPageLabel ?? pageIndex + 1),
    rects,
    sortIndex: String(data.annotationSortIndex ?? ''),
    tags: ((data.tags as { tag: string }[] | undefined) ?? []).map((tag) => tag.tag),
    dateModified: String(data.dateModified ?? ''),
  }
}

/** Raw attachment item → domain attachment info (no local path — see model.ts). */
export function attachmentInfo(raw: RawItem): AttachmentInfo {
  const contentType = String(raw.data.contentType ?? '')
  const filename = raw.data.filename === undefined ? undefined : String(raw.data.filename)
  const url = raw.data.url === undefined ? undefined : String(raw.data.url)
  return {
    key: raw.key,
    title: String(raw.data.title || raw.data.filename || 'Attachment'),
    contentType,
    linkMode: String(raw.data.linkMode ?? ''),
    ...(filename !== undefined ? { filename } : {}),
    ...(url !== undefined ? { url } : {}),
    isPdf: contentType === 'application/pdf' && raw.data.linkMode !== 'linked_url',
    parent: (raw.data.parentItem as string | undefined) ?? null,
  }
}

/** Raw note item → domain note info with a plain-text excerpt. */
export function noteInfo(raw: RawItem): NoteInfo {
  const html = String(raw.data.note ?? '')
  return {
    key: raw.key,
    html,
    excerpt: htmlToText(html).slice(0, 400),
    dateModified: String(raw.data.dateModified ?? ''),
  }
}

/** Fields never mirrored into `ItemDetail.fields` (they live in dedicated slots). */
const DETAIL_FIELD_SKIP = new Set([
  'key',
  'version',
  'itemType',
  'title',
  'creators',
  'abstractNote',
  'tags',
  'collections',
  'relations',
  'dateAdded',
  'dateModified',
  'parentItem',
  'note',
  'accessDate',
  'libraryCatalog',
])

/**
 * Pure detail projection: raw item + its children + collection names.
 *
 * `children` may be empty for attachment/note items (callers skip the children
 * request there); for a standalone attachment the item itself joins the
 * attachment list.
 */
export function buildItemDetail(
  raw: RawItem,
  children: RawItem[],
  collections: { key: string; name: string }[],
  version: number,
  library: LibraryId,
): ItemDetail {
  const data = raw.data
  const summary = summarize(raw)
  const creators = (data.creators as Creator[] | undefined) ?? []
  const attachments: AttachmentInfo[] = []
  const notes: NoteInfo[] = []
  const own = data.itemType === 'attachment' ? [raw] : data.itemType === 'note' ? [] : children
  for (const child of own) {
    if (child.data.itemType === 'attachment') attachments.push(attachmentInfo(child))
    else if (child.data.itemType === 'note') notes.push(noteInfo(child))
  }
  if (data.itemType === 'note') notes.push(noteInfo(raw))
  // PDFs first, then by title.
  attachments.sort((a, b) => Number(b.isPdf) - Number(a.isPdf) || a.title.localeCompare(b.title))
  const fields: Record<string, string> = {}
  for (const [name, value] of Object.entries(data)) {
    if (!DETAIL_FIELD_SKIP.has(name) && (typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      fields[name] = String(value)
    }
  }
  return {
    ...summary,
    pdf: summary.pdf ?? (attachments.some((attachment) => attachment.isPdf) ? { key: attachments.find((attachment) => attachment.isPdf)!.key } : null),
    library,
    version,
    itemVersion: raw.version,
    creators,
    fields,
    abstract: String(data.abstractNote ?? ''),
    collections: ((data.collections as string[] | undefined) ?? []).map((collectionKey) => ({
      key: collectionKey,
      name: collections.find((collection) => collection.key === collectionKey)?.name ?? collectionKey,
    })),
    attachments,
    notes,
    parent: (data.parentItem as string | undefined) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Model text (Agent-facing single-line projections)
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  journalArticle: 'article',
  conferencePaper: 'conference paper',
  bookSection: 'book chapter',
  preprint: 'preprint',
  thesis: 'thesis',
  report: 'report',
  book: 'book',
  webpage: 'web page',
  attachment: 'attachment',
  note: 'note',
}

/** One line per item: `[KEY] Title — Authors (Year), Venue · PDF · tags`. */
export function itemLine(item: ItemSummary): string {
  const who = [item.creatorSummary, item.year && `(${item.year})`].filter(Boolean).join(' ')
  const parts = [`[${item.key}] ${item.title}`]
  if (who) parts.push(`— ${who}`)
  const extras = [
    item.venue && item.venue !== item.title ? item.venue : '',
    TYPE_NAMES[item.itemType] ?? item.itemType,
    item.pdf ? `PDF ${item.pdf.key}` : '',
    item.tags.length ? `tags: ${item.tags.slice(0, 6).join(', ')}${item.tags.length > 6 ? '…' : ''}` : '',
  ].filter(Boolean)
  return `${parts.join(' ')}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
}

export function annotationLine(annotation: Annotation): string {
  const text = annotation.text ? ` “${annotation.text.replace(/\s+/g, ' ').trim()}”` : ''
  const comment = annotation.comment ? ` — comment: ${annotation.comment.replace(/\s+/g, ' ').trim()}` : ''
  const tags = annotation.tags.length ? ` [tags: ${annotation.tags.join(', ')}]` : ''
  return `- p. ${annotation.pageLabel} ${annotation.type} ${annotation.color}${text}${comment}${tags} (key ${annotation.key})`
}

// ---------------------------------------------------------------------------
// Export hygiene
// ---------------------------------------------------------------------------

/**
 * Strip local-storage attachment paths from BibTeX/RIS export text
 * (BibTeX `file` field, RIS `L1` line) so shared `.bib` files never leak
 * machine paths. Adapted from the reference `library.ts` of the same name.
 */
export function stripLocalPaths(text: string): string {
  return text
    .replace(/^[ \t]*file[ \t]*=[ \t]*\{.*\},?[ \t]*\r?\n/gim, '')
    .replace(/^L1  - .*\r?\n/gm, '')
}
