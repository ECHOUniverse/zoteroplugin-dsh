/**
 * Browser-side pdf.js glue for the Reader chunk: loads a document over the
 * plugin's own authenticated routes (info → 2 MiB parts), runs the worker on
 * the main thread (the panel iframe cannot spawn dedicated workers), and
 * fetches CMaps/standard fonts/wasm through the whitelisted static routes.
 *
 * Attribution: adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `ui/pdf.ts` (repo LICENSE: Apache-2.0). Modifications: the data factory
 * reads the plugin's `/dsh-zotero/pdfjs/*` HTTP routes with `fetch` instead
 * of the reference's host resource bridge, PDF bytes stream through
 * `/dsh-zotero/pdf/part` (2 MiB chunks), and the document cache returns
 * plain objects shaped for this plugin's reader. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/client/pdf
 */

import * as pdfjs from 'pdfjs-dist'
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { apiBytes, getPdfInfo, pdfAssetPath, pdfPartPath } from './api.ts'
import type { PdfInfoResponse } from '../shared/protocol.ts'

// The panel iframe cannot spawn dedicated worker files: run the worker part
// on the main thread (pdf.js's documented fallback hook).
;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

/**
 * pdf.js data factory over the plugin's authenticated static routes — CMap,
 * standard-font and wasm binaries live behind the same fence as everything
 * else; the sandboxed panel has no direct network access.
 */
class RouteDataFactory {
  constructor(_options: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    return apiBytes(pdfAssetPath(kind, filename))
  }
}

export type { PDFDocumentProxy }
export const { TextLayer } = pdfjs

export interface LoadedPdf {
  info: PdfInfoResponse
  doc: PDFDocumentProxy
  /** Printed page labels; null when the document declares none. */
  labels: string[] | null
  destroy: () => Promise<void>
}

/** Small cache of open documents: back-navigation does not re-transfer. */
const cache = new Map<string, Promise<LoadedPdf>>()

/** Load one PDF (by validated library+attachment references) with progress. */
export function loadPdf(library: string, attachmentKey: string, onProgress: (done: number, total: number) => void): Promise<LoadedPdf> {
  const id = `${library}/${attachmentKey}`
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const info = await getPdfInfo(library, attachmentKey)
    const data = new Uint8Array(info.bytes)
    let offset = 0
    onProgress(0, info.parts)
    for (let part = 0; part < info.parts; part++) {
      const chunk = await apiBytes(pdfPartPath(library, attachmentKey, part))
      data.set(chunk, offset)
      offset += chunk.length
      onProgress(part + 1, info.parts)
    }
    if (offset !== info.bytes) throw new Error(`Received ${offset} of ${info.bytes} bytes.`)
    const task = pdfjs.getDocument({
      data,
      BinaryDataFactory: RouteDataFactory,
      useWorkerFetch: false,
      cMapUrl: 'zotero:cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'zotero:standard_fonts/',
      wasmUrl: 'zotero:wasm/',
      // Standard font binaries load through the data factory, not URLs.
      useSystemFonts: false,
      enableXfa: false,
      verbosity: 0,
    } as Parameters<typeof pdfjs.getDocument>[0])
    const doc = await task.promise
    const labels = await doc.getPageLabels().catch(() => null)
    return { info, doc, labels, destroy: () => task.destroy() }
  })()
  cache.set(id, promise)
  promise.catch(() => cache.delete(id))
  while (cache.size > 3) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const entry = cache.get(oldest)
    cache.delete(oldest)
    void entry
      ?.then((loaded) => loaded.destroy())
      .catch(() => undefined)
  }
  return promise
}

/** PDF user-space rectangle → viewport CSS-pixel box. */
export function toViewport(viewport: { convertToViewportPoint: (x: number, y: number) => number[] }, rect: [number, number, number, number]) {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]) as [number, number]
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]) as [number, number]
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}
