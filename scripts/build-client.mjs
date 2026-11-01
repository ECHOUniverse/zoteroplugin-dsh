/**
 * Bundle the browser half into the module system's lazy-CJS factory format:
 *
 * - `src/client.tsx` → `lib/client.js`, wrapped as
 *   `window.__ModuleLoader__.load({ id, factory })` (the package entry);
 * - `src/client-pdf.tsx` → `lib/client.pdf.js`, wrapped as
 *   `window.__ModuleLoader__.load({ id, chunk: 'client.pdf.js', factory })`
 *   (the package-local dynamic chunk; pdf.js + the Reader live only here).
 *
 * The Harness Web shell seeds a fixed module table and registers plugin
 * bundles with `window.__ModuleLoader__.load`; the factory receives a
 * synchronous `require` for shared platform modules PLUS an `async`
 * operation that loads package-local chunks (dsh-client-modules
 * `ClientBundleRequire`; chunk filenames must match `client.<name>.js`).
 * The main bundle's reader route calls `require.async('./client.pdf.js')`,
 * so browsing a plain library never downloads pdf.js. No @deepseek-ai
 * package is required to build: every external is supplied by the shell's
 * module table at runtime.
 */
import { build, context } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Package identity; must equal the manifest name and the factory id. */
const PACKAGE_NAME = '@hanxu131/dsh-zotero'
/** Source entry and build output. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'lib')

/** Chunk filename constant — MUST match the `client.[A-Za-z0-9._-]*.js` grammar the shell enforces. */
export const PDF_CHUNK = 'client.pdf.js'

/**
 * Modules the Harness Web shell seeds into the module table
 * (`staticModules` in `@deepseek-ai/dsh-web-frontend`). Bundling any of them
 * would ship a duplicate React/cordis instance and break plugin interop.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

function envelope(code, { chunk }) {
  const head =
    'window.__ModuleLoader__.load({\n' +
    '\tid: ' +
    JSON.stringify(PACKAGE_NAME) +
    ',\n' +
    (chunk !== undefined ? '\tchunk: ' + JSON.stringify(chunk) + ',\n' : '') +
    '\tfactory: (require) => {\n' +
    '\t\tvar module = { exports: {} };\n' +
    '\t\tvar exports = module.exports;\n' +
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n'
  return head + code + '\n\t\treturn module.exports;\n\t}\n});\n'
}

const options = {
  outdir: OUT_DIR,
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox110'],
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  logLevel: 'warning',
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' },
}

async function emit(name, chunk, outputFiles, checks) {
  const file = outputFiles.find((candidate) => candidate.path.endsWith(name))
  if (file === undefined) throw new Error('build-client: esbuild produced no ' + name + ' output')
  const code = envelope(file.text, { chunk })
  await mkdir(dirname(file.path), { recursive: true })
  await writeFile(file.path, code, 'utf8')
  const marker = 'window.__ModuleLoader__.load('
  if (!code.startsWith(marker)) throw new Error('build-client: ' + name + ' does not start with the module loader call')
  for (const needle of checks) {
    if (!code.includes(needle)) throw new Error('build-client: ' + name + ' is missing "' + needle + '"')
  }
  return code.length
}

const watch = process.argv.includes('--watch')

if (watch) {
  const watcher = await context({
    ...options,
    entryPoints: [
      { in: join(ROOT, 'src', 'client.tsx'), out: 'client' },
      { in: join(ROOT, 'src', 'client-pdf.tsx'), out: 'client.pdf' },
    ],
    plugins: [
      {
        name: 'wrap-module-loader',
        setup(buildApi) {
          buildApi.onEnd(async (result) => {
            if (result.errors.length > 0) return
            try {
              const files = result.outputFiles ?? []
              const main = await emit('client.js', undefined, files, ['factory', 'sidebar.right.pane.tab', 'sidebarRightTabs', 'inject'])
              const chunk = await emit(PDF_CHUNK, PDF_CHUNK, files, ['chunk', 'dshZotTextLayer'])
              console.log('build-client: wrote lib/client.js (' + main + ' bytes) + lib/' + PDF_CHUNK + ' (' + chunk + ' bytes)')
            } catch (error) {
              console.error(error)
            }
          })
        },
      },
    ],
  })
  await watcher.watch()
  console.log('build-client: watching src/client.tsx + src/client-pdf.tsx')
} else {
  const result = await build({
    ...options,
    entryPoints: [
      { in: join(ROOT, 'src', 'client.tsx'), out: 'client' },
      { in: join(ROOT, 'src', 'client-pdf.tsx'), out: 'client.pdf' },
    ],
  })
  const files = result.outputFiles ?? []
  const main = await emit('client.js', undefined, files, ['factory', 'sidebar.right.pane.tab', 'sidebarRightTabs', 'inject'])
  const chunk = await emit(PDF_CHUNK, PDF_CHUNK, files, ['chunk', 'dshZotTextLayer'])
  console.log('build-client: wrote lib/client.js (' + main + ' bytes) + lib/' + PDF_CHUNK + ' (' + chunk + ' bytes)')
}
