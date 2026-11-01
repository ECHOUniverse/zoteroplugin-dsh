/**
 * Ambient declarations for the untyped pdf.js entry points. The main API
 * ships types (`pdfjs-dist/types`); the worker module and the dynamically
 * imported legacy build are opaque to this project (the structural faces live
 * in `src/pdf/extract.ts`).
 */

declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(options: Record<string, unknown>): { promise: Promise<unknown>; destroy(): Promise<void> }
  export const version: string
}
