/**
 * Lazy PDF chunk entry (`client.pdf.js` in the built package): holds pdf.js
 * and the Reader view so the plain-library tab never loads the multi-megabyte
 * pdf.js body on first paint.
 *
 * Loaded by the main bundle through the official package-local chunk
 * contract — `require.async('./client.pdf.js')` (dsh-client-modules
 * `ClientBundleRequire.async`); this file's build output registers via
 * `window.__ModuleLoader__.load({ id, chunk: 'client.pdf.js', factory })`.
 *
 * @module @hanxu131/dsh-zotero/client-pdf
 */

export { Reader } from './client/reader.tsx'
export { loadPdf, toViewport } from './client/pdf.ts'
