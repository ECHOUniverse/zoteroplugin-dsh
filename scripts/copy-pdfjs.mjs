/**
 * Copy the pdf.js runtime assets from `node_modules/pdfjs-dist` into
 * `lib/pdfjs/` so the npm package ships them (the `files` list already
 * includes `lib/`):
 *
 * - `legacy/pdf.mjs` + `legacy/pdf.worker.mjs` — the Node-side extraction
 *   entry (dynamically imported by `src/pdf/extract.ts`; self-contained, no
 *   further relative imports);
 * - `cmaps/`, `standard_fonts/`, `wasm/` — data served to the browser reader
 *   through the authenticated `/dsh-zotero/pdfjs/<kind>/<file>` routes and
 *   used for Node CMap resolution;
 * - `LICENSE` (+ wasm component licenses) — redistribution requirement.
 *
 * The packaged copy is preferred at runtime; `node_modules` remains a
 * dev/test fallback so `vitest` runs before any build. Running the built
 * plugin therefore never depends on a developer's `node_modules` layout.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'lib', 'pdfjs')

function pdfjsDistDir() {
  try {
    return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  } catch {
    return null
  }
}

const source = pdfjsDistDir()
if (source === null) throw new Error('copy-pdfjs: pdfjs-dist is not installed (run npm install)')
const src = resolve(source)
if (!existsSync(join(src, 'cmaps')) || !existsSync(join(src, 'legacy', 'build', 'pdf.mjs'))) {
  throw new Error(`copy-pdfjs: unexpected pdfjs-dist layout at ${src}`)
}

const version = JSON.parse(await readFile(join(src, 'package.json'), 'utf8')).version

await mkdir(join(OUTPUT, 'legacy'), { recursive: true })
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  await cp(join(src, 'legacy', 'build', name), join(OUTPUT, 'legacy', name))
}
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(join(src, dir), join(OUTPUT, dir), { recursive: true })
}
// License redistribution: the package license plus the wasm component
// licenses shipped inside pdfjs-dist.
await cp(join(src, 'LICENSE'), join(OUTPUT, 'LICENSE'))
for (const license of ['LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_QCMS', 'LICENSE_QCMS']) {
  if (existsSync(join(src, 'wasm', license))) await cp(join(src, 'wasm', license), join(OUTPUT, 'wasm', license))
}
await writeFile(
  join(OUTPUT, 'README'),
  `pdf.js runtime assets copied from pdfjs-dist ${version} (Apache-2.0). See LICENSE and the component licenses inside wasm/.\n`,
  'utf8',
)
console.log('copy-pdfjs: assets written to ' + OUTPUT)
