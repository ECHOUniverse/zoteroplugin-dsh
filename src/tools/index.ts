/**
 * Agent tool surface (`ctx.tools.register`, implementation spec §7 / ADR
 * 0003).
 *
 * Registered:
 * - read-only: `list_collections`, `search_library`, `get_item`,
 *   `search_annotations` (one item's PDF annotations), `cite` (metadata
 *   formatting), `export_bib` without `path` (BibTeX text),
 *   `read_fulltext` (M4: page-by-page PDF text with page labels, budget and
 *   continuation hint) and `find_in_pdf` (M4: locate a phrase with page +
 *   context snippets).
 * - view intents / session state: `open_item` (details or reader; PDF
 *   page/quote targeting), `show_items`, `highlight` (quote → rects, in
 *   session state; `save: true` additionally asks DSH approval and writes a
 *   Zotero annotation), `clear_highlights` (session state only).
 * - writes (DSH approval first — for `add_item` BEFORE any external network
 *   or Zotero traffic — then the same Zotero authorization every UI write
 *   goes through; `isConcurrencySafe: false`): `add_item` (M7: DOI/arXiv
 *   import with duplicate detection, optional collections/tags/PDF),
 *   `update_item`, `add_note`, `create_collection`, `authorize_writes`,
 *   `attach_pdf` (M7: URL downloads through the SSRF-guarded fetcher, plus
 *   local path / inline bytes), `save_highlights` (session highlights →
 *   Zotero highlight annotations), `export_bib` with `path` (M7: writes the
 *   workspace .bib through the official fs/workingDirectory services;
 *   per-args concurrency: text-only export stays safe).
 *
 * Approval is an execution-time seam: `ToolDeps.approval` accepts a concrete
 * face OR a getter re-read on every write execution, so tools register once
 * against the composition's `tools` service while an approval service that
 * activates later (or cycles) is adopted transparently; absence keeps every
 * write fail-closed (ADR 0003).
 *
 * Deletion is not exposed anywhere (spec non-goal); `clear_highlights` never
 * touches Zotero annotations.
 *
 * Errors never carry the key: failures surface as thrown `ZoteroError`s the
 * registry materializes, and the messages are data-layer diagnostics.
 *
 * @module @hanxu131/dsh-zotero/tools
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { LIMITS, ZOTERO_MANAGED_FIELDS, ZoteroError, parseItemKey, type ItemQuery, type SearchMode } from '../domain/model.ts'
import { bestPdfKeyOf, creatorName } from '../domain/items.ts'
import { readableText, pageIndexFor, parsePages, searchPages } from '../domain/text.ts'
import { MAX_ATTACHMENT_BYTES } from '../shared/protocol.ts'
import type { ZoteroSession } from '../host/session.ts'
import type { ApprovalFace, ToolsFace } from '../host/services.ts'
import { requestWriteApproval } from './approval.ts'
import { defineTool, type ToolDefinition } from './define-tool.ts'

/**
 * DSH approval seam, in either form: a concrete face, or a getter re-read on
 * EVERY write execution so an approval service that activates (or cycles)
 * after tool registration is adopted at execution time; absence keeps the
 * write fail-closed (ADR 0003).
 */
export type ApprovalProvider = ApprovalFace | (() => ApprovalFace | undefined)

export interface ToolDeps {
  session: ZoteroSession
  /** DSH approval seam; write tools fail closed without it (ADR 0003). */
  approval?: ApprovalProvider
}

/** Resolve the provider form to the face of THIS execution. */
function approvalFaceOf(provider: ApprovalProvider | undefined): ApprovalFace | undefined {
  return typeof provider === 'function' ? provider() : provider
}

/** Execution identity the write tools forward to the approval seam. */
interface GateContext {
  agent?: unknown
  callId?: unknown
  signal?: AbortSignal
}

const LIBRARY_PARAM = {
  type: 'string',
  description: 'Zotero library: "user" (personal, default) or "g<groupId>".',
} as const

const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]

const PDF_KEY_SCHEMA = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

// Argument coercion helpers. `defineTool` validates against the declared
// parameter schema before the body runs, so these narrow with the schema as
// the contract; they re-check defensively because logged/replayed arguments
// of older calls may predate a schema change.
type Args = Record<string, unknown>
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const int = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined)
const strArray = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined)
const rec = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)

/** Agent search budget: default 25, hard cap 100 (spec §4.2). */
function searchLimit(limit: unknown): number {
  const requested = int(limit)
  return Math.min(Math.max(requested ?? LIMITS.searchDefault, 1), LIMITS.searchMax)
}

/** Ask DSH approval; throws (error result) without executing on any non-grant. */
async function gate(approval: ApprovalProvider | undefined, toolName: string, reason: string, exec: GateContext): Promise<void> {
  const result = await requestWriteApproval(approvalFaceOf(approval), {
    agent: exec.agent,
    toolName,
    reason,
    ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  })
  if (!result.approved) {
    throw new ZoteroError('write_denied', `The ${toolName} write was not approved by the user (DSH approval outcome: ${result.outcome}). Nothing was written and the request was not retried.`)
  }
}

/** Zotero-owned fields a model may never set. */
function assertNoOwnedFields(fields: Record<string, unknown>): void {
  for (const owned of ZOTERO_MANAGED_FIELDS) {
    if (owned in fields) throw new ZoteroError('invalid_input', `field "${owned}" is managed by Zotero and cannot be set.`)
  }
}

/**
 * Build the tool definitions against one session + approval seam. Split from
 * registration so tests can exercise `execute`/`render` directly through the
 * public seam without a ToolRuntime.
 */
export function buildToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const { session, approval } = deps

  // ------------------------------------------------------------- read-only

  const listCollections = defineTool({
    name: 'list_collections',
    description: 'List the Zotero collection tree and saved searches of one library.',
    parameters: { library: { ...LIBRARY_PARAM } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: { type: 'string' },
          collections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string' },
                name: { type: 'string' },
                parent: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                numItems: { type: 'integer' },
              },
            },
          },
          searches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { key: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { library: string; collections: { key: string; name: string; numItems: number; parent: string | null }[]; searches: { key: string; name: string }[] }
        const lines = [`Library ${v.library}: ${v.collections.length} collections, ${v.searches.length} saved searches.`]
        for (const collection of v.collections) {
          lines.push(`- [${collection.key}] ${collection.name} (${collection.numItems} items${collection.parent ? `, under ${collection.parent}` : ''})`)
        }
        for (const search of v.searches) lines.push(`- saved search [${search.key}] ${search.name}`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const doc = await session.library.collections(str(args.library) ?? 'user')
      return {
        library: doc.library,
        collections: doc.collections.map((collection) => ({ key: collection.key, name: collection.name, parent: collection.parent, numItems: collection.numItems })),
        searches: doc.searches.map((search) => ({ key: search.key, name: search.name })),
      }
    },
  })

  const searchLibrary = defineTool({
    name: 'search_library',
    description:
      'Search one Zotero library. Two modes: metadata search (default, title/creator/year fields) and full-text search (mode "everything"). Supports tag/collection/saved-search filters, sorting and paging. Returns item summaries with keys.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      q: { type: 'string', description: 'Search text.' },
      mode: { type: 'string', enum: ['titleCreatorYear', 'everything'], description: 'Search mode; default titleCreatorYear.' },
      tag: { type: 'array', items: { type: 'string' }, description: 'Tags to AND-filter by.' },
      collection: { type: 'string', description: 'Collection key or name to restrict the search to.' },
      search: { type: 'string', description: 'Saved-search key to execute.' },
      sort: { type: 'string', enum: ['dateModified', 'dateAdded', 'title', 'creator', 'date'] },
      direction: { type: 'string', enum: ['asc', 'desc'] },
      start: { type: 'integer', minimum: 0, description: 'Offset into the result list.' },
      limit: { type: 'integer', minimum: 1, maximum: LIMITS.searchMax, description: `Page size; default ${LIMITS.searchDefault}, max ${LIMITS.searchMax}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: { type: 'string' },
          total: { type: 'integer' },
          start: { type: 'integer' },
          limit: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string' },
                title: { type: 'string' },
                creatorSummary: { type: 'string' },
                year: { type: 'string' },
                itemType: { type: 'string' },
                pdfKey: { ...PDF_KEY_SCHEMA },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { library: string; total: number; start: number; items: { key: string; title: string; creatorSummary: string; year: string; itemType: string; pdfKey: string | null }[] }
        const lines = [`Library ${v.library}: ${v.total} matches (showing ${v.start + 1}–${v.start + v.items.length}).`]
        for (const item of v.items) {
          lines.push(`- [${item.key}] ${item.title} — ${item.creatorSummary}${item.year ? ` (${item.year})` : ''} · ${item.itemType}${item.pdfKey ? ` · PDF ${item.pdfKey}` : ''}`)
        }
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const mode = str(args.mode)
      const sort = str(args.sort)
      const direction = str(args.direction)
      const tags = strArray(args.tag)
      const query: ItemQuery = {
        ...(str(args.q) !== undefined ? { q: str(args.q) } : {}),
        ...(mode === 'titleCreatorYear' || mode === 'everything' ? { mode } : {}),
        ...(tags !== undefined && tags.length > 0 ? { tag: tags } : {}),
        ...(str(args.collection) !== undefined ? { collection: str(args.collection) } : {}),
        ...(str(args.search) !== undefined ? { search: str(args.search) } : {}),
        ...(sort !== undefined ? { sort: sort as ItemQuery['sort'] } : {}),
        ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
        ...(int(args.start) !== undefined ? { start: int(args.start) } : {}),
        limit: searchLimit(args.limit),
      }
      const list = await session.library.items(str(args.library) ?? 'user', query)
      return {
        library: list.library,
        total: list.total,
        start: list.query.start,
        limit: list.query.limit,
        items: list.items.map((item) => ({
          key: item.key,
          title: item.title,
          creatorSummary: item.creatorSummary,
          year: item.year,
          itemType: item.itemType,
          pdfKey: item.pdf?.key ?? null,
        })),
      }
    },
  })

  const getItem = defineTool({
    name: 'get_item',
    description: 'Fetch the full metadata of one Zotero item: creators, fields, abstract, tags, collections, attachments, notes.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Zotero item key (8 characters).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          itemType: { type: 'string' },
          title: { type: 'string' },
          itemVersion: { type: 'integer' },
          creators: { type: 'array', items: { type: 'string' } },
          year: { type: 'string' },
          venue: { type: 'string' },
          abstract: { type: 'string' },
          fields: { type: 'object', additionalProperties: true },
          tags: { type: 'array', items: { type: 'string' } },
          collections: { type: 'array', items: { type: 'string' } },
          pdfKey: { ...PDF_KEY_SCHEMA },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { key: { type: 'string' }, title: { type: 'string' }, isPdf: { type: 'boolean' } },
            },
          },
          notes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { key: { type: 'string' }, excerpt: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { key: string; title: string; creators: string[]; year: string; abstract: string; fields: Record<string, string>; tags: string[]; pdfKey: string | null; notes: { key: string; excerpt: string }[] }
        const lines = [`[${v.key}] ${v.title}`, `Creators: ${v.creators.join('; ') || '—'}${v.year ? ` (${v.year})` : ''}`]
        if (v.abstract) lines.push(`Abstract: ${v.abstract}`)
        for (const [name, fieldValue] of Object.entries(v.fields)) lines.push(`${name}: ${fieldValue}`)
        if (v.tags.length > 0) lines.push(`Tags: ${v.tags.join(', ')}`)
        if (v.pdfKey) lines.push(`PDF: ${v.pdfKey}`)
        for (const note of v.notes) lines.push(`Note [${note.key}]: ${note.excerpt}`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const detail = await session.library.item(str(args.library) ?? 'user', str(args.key) ?? '')
      return {
        key: detail.key,
        itemType: detail.itemType,
        title: detail.title,
        itemVersion: detail.itemVersion,
        creators: detail.creators.map(creatorName),
        year: detail.year,
        venue: detail.venue,
        abstract: detail.abstract,
        fields: detail.fields,
        tags: detail.tags,
        collections: detail.collections.map((collection) => collection.name),
        pdfKey: detail.pdf?.key ?? null,
        attachments: detail.attachments.map((attachment) => ({ key: attachment.key, title: attachment.title, isPdf: attachment.isPdf })),
        notes: detail.notes.map((note) => ({ key: note.key, excerpt: note.excerpt })),
      }
    },
  })

  const searchAnnotations = defineTool({
    name: 'search_annotations',
    description:
      'Search the PDF annotations (highlights/notes) of ONE Zotero item — the annotations of its best PDF attachment, or its own when the item is an attachment. Matches are case-insensitive over annotation text and comments; an optional tag filters further. This is the full annotation scope of the current data layer; library-wide annotation search is not available.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      item: { type: 'string', required: true, description: 'Parent item key whose PDF annotations to search.' },
      query: { type: 'string', description: 'Case-insensitive text to match against annotation text/comments.' },
      tag: { type: 'string', description: 'Only annotations carrying this tag.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          attachment: { ...PDF_KEY_SCHEMA },
          total: { type: 'integer' },
          annotations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string' },
                pageLabel: { type: 'string' },
                type: { type: 'string' },
                text: { type: 'string' },
                comment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { item: string; attachment: string | null; total: number; annotations: { key: string; pageLabel: string; type: string; text: string; comment: string; tags: string[] }[] }
        if (v.attachment === null) return text(`Item ${v.item} has no PDF attachment to search annotations in.`)
        const lines = [`Item ${v.item} (attachment ${v.attachment}): ${v.total} matching annotations.`]
        for (const annotation of v.annotations) {
          lines.push(`- p. ${annotation.pageLabel} ${annotation.type} “${annotation.text}”${annotation.comment ? ` — ${annotation.comment}` : ''}${annotation.tags.length ? ` [${annotation.tags.join(', ')}]` : ''} (key ${annotation.key})`)
        }
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const library = str(args.library) ?? 'user'
      const item = str(args.item) ?? ''
      const detail = await session.library.item(library, item)
      const attachmentKey = bestPdfKeyOf(detail) ?? undefined
      if (attachmentKey === undefined) return { item, attachment: null, total: 0, annotations: [] }
      const all = await session.library.annotations(library, attachmentKey)
      const query = str(args.query)
      const tag = str(args.tag)
      const needle = query?.toLowerCase()
      const matches = all.filter((annotation) => {
        if (tag !== undefined && !annotation.tags.includes(tag)) return false
        if (needle === undefined) return true
        return annotation.text.toLowerCase().includes(needle) || annotation.comment.toLowerCase().includes(needle)
      })
    return {
      item,
      attachment: attachmentKey,
        total: matches.length,
        annotations: matches.map((annotation) => ({
          key: annotation.key,
          pageLabel: annotation.pageLabel,
          type: annotation.type,
          text: annotation.text,
          comment: annotation.comment,
          tags: annotation.tags,
        })),
      }
    },
  })

  const cite = defineTool({
    name: 'cite',
    description:
      'Format a citation for one Zotero item from its stored metadata. Formats: "apa" (plain text, default) or "bibtex". Formatting is a local metadata projection — no external service.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Zotero item key.' },
      format: { type: 'string', enum: ['apa', 'bibtex'], description: 'Citation format; default apa.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' }, format: { type: 'string' }, citation: { type: 'string' } },
      },
      render: (_args, value) => text((value as { citation: string }).citation),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const detail = await session.library.item(str(args.library) ?? 'user', str(args.key) ?? '')
      const citation = str(args.format) === 'bibtex' ? bibtexOf(detail) : apaOf(detail)
      return { key: detail.key, format: str(args.format) ?? 'apa', citation }
    },
  })

  const exportBib = defineTool({
    name: 'export_bib',
    description:
      "Export items as BibTeX (Zotero's own export, local file paths stripped). Without path, returns the text. With a workspace-relative path ending in .bib, writes the file through the session workspace (asks for approval first; refuses to overwrite an existing file unless overwrite is true) and returns the citation keys to use with \\cite.",
    parameters: {
      library: { ...LIBRARY_PARAM },
      keys: { type: 'array', items: { type: 'string' }, required: true, description: 'Item keys to export (max 50).' },
      path: { type: 'string', description: 'Workspace-relative .bib path (e.g. "references.bib"). When given, the file is written after approval.' },
      overwrite: { type: 'boolean', description: 'Replace an existing file (default false: an existing file is an error).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: { type: 'string' },
          text: { type: 'string' },
          path: { type: 'string' },
          operation: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          citeKeys: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as { text: string; path?: string; operation?: string | null; citeKeys?: string[] }
        if (v.path === undefined) return text(`BibTeX export:\n\n${v.text}`)
        const keys = v.citeKeys !== undefined && v.citeKeys.length > 0 ? `\nCitation keys: ${v.citeKeys.slice(0, 60).join(', ')}${v.citeKeys.length > 60 ? ', …' : ''}` : ''
        return text(`${v.operation === 'update' ? 'Updated' : 'Wrote'} ${v.path} in the workspace.${keys}`)
      },
    },
    // Text-only export is a read; the workspace write is an exclusive write.
    isConcurrencySafe: (args) => str((args as Args).path) === undefined,
    async execute(args, exec) {
      const rawKeys = strArray(args.keys) ?? []
      if (rawKeys.length === 0) throw new ZoteroError('invalid_input', 'keys must list at least one item key.')
      if (rawKeys.length > LIMITS.itemKeyBatch) throw new ZoteroError('invalid_input', `keys supports at most ${LIMITS.itemKeyBatch} items.`)
      const keys = rawKeys.map((key) => parseItemKey(key, 'keys[]'))
      const exported = await session.library.exportText(str(args.library) ?? 'user', 'bibtex', { keys, limit: LIMITS.panelMax })
      const rawPath = str(args.path)
      if (rawPath === undefined) {
        return { format: 'bibtex', text: exported, operation: null, citeKeys: citeKeysOf(exported) }
      }
      await gate(approval, 'export_bib', `Write the BibTeX export of ${rawKeys.length} item(s) to the workspace file ${rawPath}.`, exec)
      const written = await session.writeWorkspaceFile({
        path: rawPath,
        content: exported,
        ...(args.overwrite === true ? { overwrite: true } : {}),
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      })
      return { format: 'bibtex', text: exported, path: rawPath, operation: written.operation, citeKeys: citeKeysOf(exported) }
    },
  })

  // ---------------------------------------------------- view intents (SSE)

  const openItem = defineTool({
    name: 'open_item',
    description:
      'Navigate the user\'s Zotero panel to one item: its details, or its PDF in the reader (optionally at a physical page or at the page containing a quote). The intent is pushed to the panel over the event channel; it does not move data.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Item key to open.' },
      attachmentKey: { type: 'string', description: 'Specific attachment to open (defaults to the best PDF).' },
      page: { type: 'integer', minimum: 1, description: '1-based physical page to open in the PDF reader.' },
      quote: { type: 'string', description: 'Open the reader at the page containing this text (quote_not_found when absent from the PDF).' },
    },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { delivered: { type: 'boolean' }, seq: { type: 'integer' }, page: { oneOf: [{ type: 'integer' }, { type: 'null' }] } },
        },
        render: (_args, value) => {
          const v = value as { seq: number; page: number | null }
          return text(`Open-item intent delivered (seq ${v.seq})${v.page !== null ? ` at page ${v.page}` : ''}.`)
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const key = parseItemKey(str(args.key), 'key')
        const library = str(args.library) ?? 'user'
        const attachmentKey = str(args.attachmentKey)
        if (attachmentKey !== undefined) parseItemKey(attachmentKey, 'attachmentKey')
        const page = int(args.page)
        const quote = str(args.quote)
      // Quote targeting resolves to a physical page here, so the panel opens
      // exactly where the evidence lives; an absent quote is an error, not a
      // silent open at page 1.
      let resolved: number | null = null
      if (quote !== undefined || page !== undefined) {
        const target = attachmentKey ?? (bestPdfKeyOf(await session.library.item(library, key)) ?? undefined)
        if (target === undefined) throw new ZoteroError('not_pdf', `Item ${key} has no PDF attachment to open.`)
        const pdf = await session.pdf.text(library, target)
        let pageIndex = page !== undefined ? pageIndexFor(pdf.pages, page) : undefined
        if (quote !== undefined) {
          const found = searchPages(pdf.pages, quote, 1)[0]
          if (found === undefined) throw new ZoteroError('quote_not_found', `The quote was not found in the PDF (key ${key}). Use find_in_pdf to locate the exact wording.`)
          pageIndex = found.pageIndex
        }
        if (pageIndex === undefined) {
          throw new ZoteroError('invalid_input', `The PDF has ${pdf.pageCount} pages; page ${String(page)} is out of range.`)
        }
        resolved = pageIndex + 1
        const event = session.events.publish({
          kind: 'open_item',
          library,
          key,
          attachmentKey: target,
          page: resolved,
        })
        return { delivered: true, seq: event.seq, page: resolved }
      }
      const event = session.events.publish({
        kind: 'open_item',
        library,
        key,
        ...(attachmentKey !== undefined ? { attachmentKey } : {}),
      })
      return { delivered: true, seq: event.seq, page: null }
    },
  })

  const showItems = defineTool({
    name: 'show_items',
    description:
      'Highlight a list of items in the user\'s Zotero panel (e.g. the results of a search). Pushes one navigation intent over the event channel.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      keys: { type: 'array', items: { type: 'string' }, required: true, description: 'Item keys to show (max 50).' },
      title: { type: 'string', description: 'Optional heading for the list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { delivered: { type: 'boolean' }, seq: { type: 'integer' } },
      },
      render: (_args, value) => text(`Show-items intent delivered (seq ${(value as { seq: number }).seq}).`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const rawKeys = strArray(args.keys) ?? []
      if (rawKeys.length === 0) throw new ZoteroError('invalid_input', 'keys must list at least one item key.')
      if (rawKeys.length > LIMITS.itemKeyBatch) throw new ZoteroError('invalid_input', `keys supports at most ${LIMITS.itemKeyBatch} items.`)
      const keys = rawKeys.map((key) => parseItemKey(key, 'keys[]'))
      const title = str(args.title)
      const event = session.events.publish({
        kind: 'show_items',
        library: str(args.library) ?? 'user',
        keys,
        ...(title !== undefined ? { title } : {}),
      })
      return { delivered: true, seq: event.seq }
    },
  })

  // ------------------------------------------------------------- PDF (M4)

  const readFulltext = defineTool({
    name: 'read_fulltext',
    description:
      'Read the text of an item\'s PDF page by page ("--- page N ---" markers use physical page numbers; printed page labels are shown when different). Give an item key (its PDF is used) or a PDF attachment key. Use pages to read a range; long documents are cut at maxChars, and the result says where to continue.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Item key or PDF attachment key.' },
      pages: { type: 'string', description: 'Physical pages, e.g. "1-3", "5", "2,7-9", "10-". Default: from the start.' },
      maxChars: { type: 'integer', minimum: 1_000, maximum: 100_000, description: `Character budget; default ${LIMITS.fulltextChars}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          library: { type: 'string' },
          itemKey: { type: 'string' },
          attachmentKey: { type: 'string' },
          pageCount: { type: 'integer' },
          lastPage: { type: 'integer' },
        },
      },
      render: (_args, value) => text((value as { text: string }).text),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const library = str(args.library) ?? 'user'
      const key = parseItemKey(str(args.key), 'key')
      const { itemKey, attachmentKey, pdf } = await session.pdfText(library, key)
      let indexes: number[]
      const pagesSpec = str(args.pages)
      try {
        indexes = pagesSpec !== undefined ? parsePages(pagesSpec, pdf.pageCount) : pdf.pages.map((page) => page.index)
      } catch (error) {
        throw new ZoteroError('invalid_input', error instanceof Error ? error.message : String(error))
      }
      if (indexes.length === 0) throw new ZoteroError('invalid_input', `The PDF has ${pdf.pageCount} pages.`)
      const budget = Math.min(Math.max(int(args.maxChars) ?? LIMITS.fulltextChars, 1_000), 100_000)
      const parts: string[] = []
      let used = 0
      let lastPage = -1
      for (const index of indexes) {
        const page = pdf.pages[index]
        if (page === undefined) continue
        const marker = `--- page ${index + 1}${page.label !== String(index + 1) ? ` (printed ${page.label})` : ''} ---`
        const body = readableText(page.text) || '(no text on this page; it may be a scanned image)'
        if (used > 0 && used + marker.length + body.length > budget) break
        const room = budget - used - marker.length
        parts.push(marker, body.length > room ? `${body.slice(0, room)}…` : body)
        used += marker.length + body.length
        lastPage = index
      }
      const remaining = indexes.filter((index) => index > lastPage)
      const footer =
        remaining.length > 0 && remaining[0] !== undefined && remaining.at(-1) !== undefined
          ? `\n… stopped after page ${lastPage + 1}. Continue with pages: "${remaining[0] + 1}-${(remaining.at(-1) as number) + 1}".`
          : ''
      const scanned = pdf.pages.every((page) => page.text.trim() === '') ? '\nThis PDF has no text layer (scanned); Zotero cannot index it either.' : ''
      const title = (await session.library.item(library, itemKey)).title
      const output = `"${title}" [${itemKey}], PDF ${attachmentKey}, ${pdf.pageCount} pages.\n\n${parts.join('\n')}${footer}${scanned}`
      return { text: output, library, itemKey, attachmentKey, pageCount: pdf.pageCount, lastPage: lastPage + 1 }
    },
  })

  const findInPdf = defineTool({
    name: 'find_in_pdf',
    description:
      'Find a word or phrase in an item\'s PDF and return each occurrence with its page and surrounding text. Matching ignores case, line breaks, hyphenation and ligatures. Useful before highlight or open_item to locate a passage.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Item key or PDF attachment key.' },
      query: { type: 'string', required: true, description: 'Word or phrase to find (min 2 characters).' },
      maxResults: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: { type: 'string' },
          itemKey: { type: 'string' },
          attachmentKey: { type: 'string' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { page: { type: 'integer' }, label: { type: 'string' }, snippet: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { library: string; itemKey: string; attachmentKey: string; matches: { page: number; label: string; snippet: string }[] }
        if (v.matches.length === 0) return text(`No match for the query in the PDF (item ${v.itemKey}, PDF ${v.attachmentKey}).`)
        const lines = [`${v.matches.length} match(es) (item ${v.itemKey}, PDF ${v.attachmentKey}):`]
        for (const match of v.matches) {
          lines.push(`- page ${match.page}${match.label !== String(match.page) ? ` (printed ${match.label})` : ''}: ${match.snippet}`)
        }
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const library = str(args.library) ?? 'user'
      const key = parseItemKey(str(args.key), 'key')
      const query = str(args.query) ?? ''
      if (query.trim().length < 2) throw new ZoteroError('invalid_input', 'query must be at least 2 characters.')
      const { itemKey, attachmentKey, pdf } = await session.pdfText(library, key)
      const max = Math.min(Math.max(int(args.maxResults) ?? 20, 1), 100)
      const results = searchPages(pdf.pages, query, max)
      return {
        library,
        itemKey,
        attachmentKey,
        matches: results.map((result) => ({ page: result.pageIndex + 1, label: result.label, snippet: result.snippet })),
      }
    },
  })

  const highlight = defineTool({
    name: 'highlight',
    description:
      'Highlight a passage in an item\'s PDF with an optional comment, shown in the panel\'s reader as the Agent\'s highlight (purple, distinct from the user\'s own annotations). It lasts for this session; use save: true or save_highlights to store it as a real Zotero annotation. The quote must be copied from the PDF text (read_fulltext / find_in_pdf); matching ignores case, spacing and hyphenation, and "start … end" spans a longer passage.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Item key or PDF attachment key.' },
      quote: { type: 'string', required: true, description: `The passage to highlight (3–${LIMITS.quoteMaxChars} characters).` },
      page: { type: 'integer', minimum: 1, description: 'Physical page to look on first.' },
      comment: { type: 'string', description: 'Comment attached to the highlight.' },
      color: { type: 'string', description: 'Named Zotero color or #rrggbb (default purple).' },
      save: { type: 'boolean', description: 'Also save it to Zotero as an annotation now (asks for write approval).' },
      open: { type: 'boolean', description: 'Open the reader at the highlight (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: { type: 'string' },
          highlight: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              page: { type: 'integer' },
              pageLabel: { type: 'string' },
              attachmentKey: { type: 'string' },
              savedAs: PDF_KEY_SCHEMA,
            },
          },
          exact: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { highlight: { id: string; page: number; pageLabel: string; savedAs: string | null }; exact: string }
        const printed = v.highlight.pageLabel !== String(v.highlight.page) ? ` (printed ${v.highlight.pageLabel})` : ''
        const saved = v.highlight.savedAs !== null ? ` Saved to Zotero as annotation ${v.highlight.savedAs}.` : ''
        return text(`Highlighted ${v.highlight.id} on page ${v.highlight.page}${printed}: “${v.exact}”.${saved}`)
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const library = str(args.library) ?? 'user'
      const key = parseItemKey(str(args.key), 'key')
      const quote = str(args.quote) ?? ''
      if (quote.length < 3) throw new ZoteroError('invalid_input', 'quote must be at least 3 characters.')
      if (quote.length > LIMITS.quoteMaxChars) throw new ZoteroError('invalid_input', `quote must not exceed ${LIMITS.quoteMaxChars} characters.`)
      const { highlight: created } = await session.createHighlight(library, key, {
        quote,
        ...(int(args.page) !== undefined ? { page: int(args.page) } : {}),
        ...(str(args.comment) !== undefined ? { comment: str(args.comment) } : {}),
        ...(str(args.color) !== undefined ? { color: str(args.color) } : {}),
      })
      if (args.open !== false) {
        session.events.publish({
          kind: 'open_item',
          library,
          key: created.itemKey,
          attachmentKey: created.attachmentKey,
          page: created.pageIndex + 1,
        })
      }
      let savedAs: string | null = null
      if (args.save === true) {
        await gate(approval, 'highlight', `Save the highlighted passage from the PDF as a Zotero annotation.`, exec)
        const [saved] = await session.saveHighlights([created])
        if (saved !== undefined) savedAs = saved.key
      }
      return {
        library,
        highlight: {
          id: created.id,
          page: created.pageIndex + 1,
          pageLabel: created.pageLabel,
          attachmentKey: created.attachmentKey,
          savedAs,
        },
        exact: created.quote,
      }
    },
  })

  const clearHighlights = defineTool({
    name: 'clear_highlights',
    description:
      'Remove the Agent\'s session highlights from the panel: the given ids, all on one item/attachment, or all. Annotations already saved to Zotero stay in Zotero (this never deletes user data).',
    parameters: {
      library: { ...LIBRARY_PARAM },
      ids: { type: 'array', items: { type: 'string' }, description: 'Highlight ids to remove; omit for key/all.' },
      key: { type: 'string', description: 'Remove all highlights on this item or attachment.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { removed: { type: 'integer' } },
      },
      render: (_args, value) => text(`Removed ${(value as { removed: number }).removed} highlight(s).`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const key = str(args.key)
      if (key !== undefined) parseItemKey(key, 'key')
      const removed = session.clearHighlights(strArray(args.ids), key)
      return { removed }
    },
  })

  // ------------------------------------------------- writes (DSH approval)

  const saveHighlights = defineTool({
    name: 'save_highlights',
    description:
      'Save the Agent\'s session highlights to Zotero as highlight annotations on the PDF (with their comments), so they stay in the user\'s library. Without ids, saves all unsaved highlights (or those on key). Already-saved highlights are skipped.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      ids: { type: 'array', items: { type: 'string' }, description: 'Highlight ids to save; omit for key/all.' },
      key: { type: 'string', description: 'Save all highlights on this item or attachment.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, key: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        const saved = (value as { saved: { id: string; key: string }[] }).saved
        return text(
          saved.length > 0
            ? `Saved ${saved.length} highlight(s) to Zotero: ${saved.map((entry) => `${entry.id} → ${entry.key}`).join(', ')}.`
            : 'Nothing to save; those highlights are already in Zotero.',
        )
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = str(args.key)
      if (key !== undefined) parseItemKey(key, 'key')
      const highlights = session.findHighlights(strArray(args.ids), key)
      await gate(approval, 'save_highlights', `Save ${highlights.length} highlighted PDF passage(s) as Zotero annotations.`, exec)
      const saved = await session.saveHighlights(highlights)
      return { saved }
    },
  })

  const addItem = defineTool({
    name: 'add_item',
    description:
      'Create one new Zotero item. Pass a DOI or arXiv id and the metadata is fetched from doi.org / arXiv (arXiv preprints get their open-access PDF attached automatically, unless attachPdf is false); or pass structured metadata (itemType + fields) for anything else. Optionally file it into collections and tag it. If an item with the same DOI is already in the library, nothing is added and that item\'s key is returned. The user is asked to approve before anything is fetched or written.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      identifier: { type: 'string', description: 'DOI (10.…, doi.org link) or arXiv id / link. Metadata for it is fetched from doi.org / arXiv.' },
      itemType: { type: 'string', description: 'Zotero item type for structured metadata, e.g. journalArticle, book, preprint. Required with metadata (ignored with identifier).' },
      fields: {
        type: 'object',
        additionalProperties: true,
        description: 'Structured metadata (title, creators, publicationTitle, date, DOI, url, abstractNote, …); overrides fetched metadata when combined with identifier. Zotero-owned fields (key/version/dateAdded/dateModified) are rejected.',
      },
      collections: { type: 'array', items: { type: 'string' }, description: 'Collection keys or names to add the item to.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the new item.' },
      pdfUrl: { type: 'string', description: 'Direct PDF link to attach (downloaded only after approval).' },
      attachPdf: { type: 'boolean', description: 'Attach the arXiv open-access PDF automatically (default true for arXiv identifiers).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          source: { type: 'string' },
          attachmentKey: { ...PDF_KEY_SCHEMA },
          duplicate: { ...PDF_KEY_SCHEMA },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as { key: string; title: string; source: string; attachmentKey: string | null; duplicate: string | null; warnings: string[] }
        if (v.duplicate !== null) return text(`"${v.title}" is already in the library as ${v.duplicate}; nothing was added.`)
        const lines = [`Added "${v.title}" as ${v.key} (metadata from ${v.source}).`]
        if (v.attachmentKey !== null) lines.push(`Attached PDF ${v.attachmentKey}.`)
        lines.push(...v.warnings)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const library = str(args.library) ?? 'user'
      const identifier = str(args.identifier)
      const fields = rec(args.fields)
      const itemType = str(args.itemType)
      if (identifier === undefined && fields === undefined) {
        throw new ZoteroError('invalid_input', 'Give an identifier (DOI or arXiv id) or structured metadata (itemType + fields).')
      }
      if (identifier === undefined && itemType === undefined) {
        throw new ZoteroError('invalid_input', 'metadata requires itemType.')
      }
      if (fields !== undefined) assertNoOwnedFields(fields)
      // DSH approval BEFORE any external network or Zotero write. The reason
      // names what will be contacted (the identifier) but never the private
      // field payload.
      const target = identifier !== undefined ? `DOI/arXiv ${identifier}` : `a new ${itemType} item`
      await gate(approval, 'add_item', `Fetch metadata (doi.org / arXiv when an identifier is given) and create ${target} in your Zotero library.`, exec)
      const collections = strArray(args.collections)
      const result = await session.addItem(library, {
        ...(identifier !== undefined ? { identifier } : {}),
        ...(fields !== undefined ? { metadata: { ...(itemType !== undefined ? { itemType } : {}), ...fields } } : {}),
        ...(collections !== undefined ? { collections } : {}),
        ...(strArray(args.tags) !== undefined ? { tags: strArray(args.tags) } : {}),
        ...(str(args.pdfUrl) !== undefined ? { pdfUrl: str(args.pdfUrl) } : {}),
        ...(args.attachPdf !== undefined ? { attachPdf: args.attachPdf === true } : {}),
      })
      return {
        key: result.key,
        title: result.title,
        source: result.source,
        attachmentKey: result.attachmentKey ?? null,
        duplicate: result.duplicate ?? null,
        warnings: result.warnings,
      }
    },
  })

  const updateItem = defineTool({
    name: 'update_item',
    description:
      'Update fields of one existing Zotero item (version-checked; a conflict with concurrent Zotero edits surfaces as an error instead of overwriting).',
    parameters: {
      library: { ...LIBRARY_PARAM },
      key: { type: 'string', required: true, description: 'Item key to update.' },
      fields: { type: 'object', additionalProperties: true, required: true, description: 'Field overrides to apply.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' }, changed: { type: 'boolean' } },
      },
      render: (_args, value) => text(`Item ${(value as { key: string }).key} ${(value as { changed: boolean }).changed ? 'updated' : 'needed no changes'}.`),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = parseItemKey(str(args.key), 'key')
      const library = str(args.library) ?? 'user'
      const fields = rec(args.fields) ?? {}
      await gate(approval, 'update_item', `Update the fields of item ${key} in your Zotero library.`, exec)
      assertNoOwnedFields(fields)
      const result = await session.writes.patchItem(library, key, () => (Object.keys(fields).length > 0 ? fields : null))
      return { key: result.item.key, changed: result.changed }
    },
  })

  const addNote = defineTool({
    name: 'add_note',
    description: 'Attach a child note (HTML) to one existing Zotero item.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      item: { type: 'string', required: true, description: 'Parent item key.' },
      html: { type: 'string', required: true, description: 'Note content as HTML.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the note.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' } },
      },
      render: (_args, value) => text(`Created note ${(value as { key: string }).key}.`),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const item = parseItemKey(str(args.item), 'item')
      const library = str(args.library) ?? 'user'
      const html = str(args.html) ?? ''
      const tags = strArray(args.tags)
      await gate(approval, 'add_note', `Attach a note to item ${item} in your Zotero library.`, exec)
      const [key] = await session.writes.create(library, 'items', [
        { itemType: 'note', parentItem: item, note: html, ...(tags !== undefined ? { tags: tags.map((tag) => ({ tag })) } : {}) },
      ])
      return { key }
    },
  })

  const createCollection = defineTool({
    name: 'create_collection',
    description: 'Create a collection (optionally under a parent collection) in one Zotero library.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      name: { type: 'string', required: true, description: 'Collection name.' },
      parentKey: { type: 'string', description: 'Parent collection key; omitted creates a root collection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' } },
      },
      render: (_args, value) => text(`Created collection ${(value as { key: string }).key}.`),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = str(args.name) ?? ''
      const library = str(args.library) ?? 'user'
      const rawParent = str(args.parentKey)
      const parentKey = rawParent !== undefined ? parseItemKey(rawParent, 'parentKey') : undefined
      await gate(approval, 'create_collection', `Create the collection “${name}” in your Zotero library.`, exec)
      const [key] = await session.writes.create(library, 'collections', [
        { name, parentCollection: parentKey ?? false },
      ])
      return { key }
    },
  })

  const authorizeWrites = defineTool({
    name: 'authorize_writes',
    description:
      'Open Zotero\'s write-authorization dialog so the user can grant (or deny) write access. Triggers the dialog only; writes no data. Denial is final for this request — the tool does not retry.',
    parameters: { library: { ...LIBRARY_PARAM } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { authorized: { type: 'boolean' }, remembered: { type: 'boolean' } },
      },
      render: (_args, value) => text((value as { authorized: boolean }).authorized ? 'Zotero write access granted.' : 'Zotero write access was not granted.'),
    },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      await gate(approval, 'authorize_writes', 'Open the Zotero authorization dialog to grant write access.', exec)
      const outcome = await session.authorizeWrites()
      return { authorized: outcome.authorized, remembered: outcome.remembered }
    },
  })

  const attachPdf = defineTool({
    name: 'attach_pdf',
    description:
      'Attach a PDF to one existing Zotero item. Source is a direct http(s) URL (downloaded through a SSRF-guarded fetcher: public hosts only, ≤100 MiB, 60 s, %PDF- checked, redirects re-validated), an absolute local file path, or inline base64 bytes. Downloads and file reads happen only after you approve this call.',
    parameters: {
      library: { ...LIBRARY_PARAM },
      item: { type: 'string', required: true, description: 'Parent item key.' },
      url: { type: 'string', description: 'Direct link to the PDF to download and attach.' },
      path: { type: 'string', description: 'Absolute path of the local PDF file (alternative to url).' },
      bytesBase64: { type: 'string', description: 'PDF bytes, base64-encoded (alternative to url/path).' },
      filename: { type: 'string', description: 'File name for byte inputs (default derived from the source).' },
      title: { type: 'string', description: 'Attachment title (default file name).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' } },
      },
      render: (_args, value) => text(`Attached PDF as ${(value as { key: string }).key}.`),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const item = parseItemKey(str(args.item), 'item')
      const library = str(args.library) ?? 'user'
      const url = str(args.url)
      const path = str(args.path)
      const encoded = str(args.bytesBase64)
      const sources = [url, path, encoded].filter((source) => source !== undefined)
      if (sources.length !== 1) {
        throw new ZoteroError('invalid_input', 'Pass exactly one of "url", "path" or "bytesBase64".')
      }
      await gate(approval, 'attach_pdf', `Attach a PDF (from ${url !== undefined ? `the URL ${url}` : path !== undefined ? 'a local file' : 'inline bytes'}) to item ${item} in your Zotero library.`, exec)
      let bytes: Uint8Array
      let filename: string
      if (url !== undefined) {
        // SSRF-guarded download (approval already granted): public hosts only.
        const download = await session.downloadPdfBytes(url)
        bytes = download.bytes
        filename = str(args.filename) ?? download.filename
      } else if (path !== undefined) {
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || !info.isFile()) throw new ZoteroError('file_missing', `No readable file at ${path}.`)
        if (info.size > MAX_ATTACHMENT_BYTES) throw new ZoteroError('invalid_input', 'The PDF exceeds the 100 MiB attachment limit.')
        bytes = await readFile(path)
        filename = str(args.filename) ?? basename(path)
      } else {
        bytes = Buffer.from(encoded ?? '', 'base64')
        filename = str(args.filename) ?? 'file.pdf'
      }
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new ZoteroError('invalid_input', 'Attachment bytes must be between 1 byte and 100 MiB.')
      }
      if (!Buffer.from(bytes.subarray(0, 5)).toString('latin1').startsWith('%PDF-')) {
        throw new ZoteroError('not_pdf', 'The attachment does not look like a PDF (missing %PDF- header).')
      }
      if (/[/\\]/.test(filename) || filename.includes('..')) {
        throw new ZoteroError('invalid_input', 'filename must be a bare file name.')
      }
      const key = await session.writes.attachFile(library, item, {
        bytes,
        filename,
        contentType: 'application/pdf',
        title: str(args.title) ?? filename,
      })
      return { key }
    },
  })

  return [
    listCollections,
    searchLibrary,
    getItem,
    searchAnnotations,
    cite,
    exportBib,
    readFulltext,
    findInPdf,
    openItem,
    showItems,
    highlight,
    clearHighlights,
    addItem,
    updateItem,
    addNote,
    createCollection,
    authorizeWrites,
    attachPdf,
    saveHighlights,
  ]
}

// ---------------------------------------------------------------------------
// Citation formatting (pure projections over stored metadata)
// ---------------------------------------------------------------------------

/** Citation keys (`@article{key,`) of a BibTeX export, in file order. */
function citeKeysOf(text: string): string[] {
  return [...text.matchAll(/^@\w+\{([^,\s]+),/gm)].map((match) => match[1]!)
}

interface CiteMetadata {
  creators: { creatorType: string; firstName?: string; lastName?: string; name?: string }[]
  year: string
  title: string
  venue: string
  fields: Record<string, string>
}

/** APA-ish plain text from stored metadata (name/initials, ≤6 authors, DOI link). */
export function apaOf(detail: CiteMetadata): string {
  const names = detail.creators.map((creator) => {
    const last = creator.lastName ?? creator.name ?? creator.firstName ?? ''
    const initials = (creator.firstName ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `${part[0]!.toUpperCase()}.`)
      .join(' ')
    return initials ? `${last}, ${initials}` : last
  })
  const authors = names.length > 6 ? `${names.slice(0, 6).join(', ')} et al.` : names.join(', ')
  const head = authors ? `${authors} (${detail.year || 'n.d.'}).` : `(${detail.year || 'n.d.'}).`
  const doi = detail.fields.DOI !== undefined ? ` https://doi.org/${detail.fields.DOI}` : ''
  return `${head} ${detail.title}.${detail.venue ? ` ${detail.venue}.` : ''}${doi}`.trim()
}

const BIBTEX_TYPES: Record<string, string> = {
  journalArticle: 'article',
  book: 'book',
  bookSection: 'incollection',
  conferencePaper: 'inproceedings',
  thesis: 'phdthesis',
  report: 'techreport',
  preprint: 'misc',
}

/** Minimal BibTeX entry from stored metadata (keys only; Zotero's own export covers full fidelity). */
export function bibtexOf(detail: CiteMetadata & { key: string; itemType: string }): string {
  const entryType = BIBTEX_TYPES[detail.itemType] ?? 'misc'
  const authors = detail.creators
    .filter((creator) => creator.creatorType === 'author')
    .map((creator) => (creator.name !== undefined ? creator.name : [creator.lastName, creator.firstName].filter(Boolean).join(', ')))
  const lines = [
    `@${entryType}{${detail.key},`,
    `  title = {${detail.title}}`,
    ...(authors.length > 0 ? [`  author = {${authors.join(' and ')}}`] : []),
    ...(detail.year ? [`  year = {${detail.year}}`] : []),
    ...(detail.venue && entryType === 'article' ? [`  journal = {${detail.venue}}`] : []),
    ...Object.entries(detail.fields)
      .filter(([name]) => ['volume', 'issue', 'pages', 'publisher', 'address', 'DOI', 'url', 'ISBN'].includes(name))
      .map(([name, value]) => `  ${name} = {${value}}`),
    '}',
  ]
  return lines.join(',\n')
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register every tool on the composition's ToolRuntime; returns the combined
 * disposer. The registry passes the caller identity (`agent`, `callId`,
 * `signal`) on the execution context the write tools forward to the gate.
 */
export function registerTools(tools: ToolsFace, deps: ToolDeps): () => void {
  const disposers = buildToolDefinitions(deps).map((definition) => tools.register(definition as unknown as Record<string, unknown>))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Tool names this milestone registers (used by tests and docs). */
export const REGISTERED_TOOL_NAMES = [
  'list_collections',
  'search_library',
  'get_item',
  'search_annotations',
  'cite',
  'export_bib',
  'read_fulltext',
  'find_in_pdf',
  'open_item',
  'show_items',
  'highlight',
  'clear_highlights',
  'add_item',
  'update_item',
  'add_note',
  'create_collection',
  'authorize_writes',
  'attach_pdf',
  'save_highlights',
] as const

/** Tools deliberately not registered (destructive surface stays closed). */
export const DEFERRED_TOOL_NAMES = ['delete_items', 'delete_annotations'] as const
