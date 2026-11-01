/**
 * Offline smoke test for the built artifacts (runs after `npm run build`).
 *
 * - `lib/client.js` must keep the `window.__ModuleLoader__.load` contract,
 *   materialize against the platform module table, export the Cordis inject
 *   list, register the tab type plus the keyed tab body on `apply`, lazily
 *   pull the reader through the official package-local chunk contract
 *   (`require.async('./client.pdf.js')` — pdf.js never loads with a plain
 *   library), and never contain Zotero credential headers (the client half
 *   holds no key).
 * - `lib/client.pdf.js` must register as a package-local chunk
 *   (`{ id, chunk }`) and contain the reader/pdf.js surface.
 * - `lib/pdfjs/` must ship the packaged runtime assets (legacy build +
 *   cmaps/standard_fonts/wasm + licenses).
 * - `lib/index.js` must export the host-half contract (`name`/`inject`/
 *   `Config`/`apply`), register the protected route table with a
 *   connection-style trust fence, answer health publicly, run a REAL status
 *   probe (never constant `unknown`), refuse protected routes without the
 *   connection service, serve the M4 PDF route surface (info/part/assets —
 *   no 501 fake), and register all 19 Agent tools including the PDF tools.
 *
 * No Zotero connection (status probes a closed loopback port), no DSH host,
 * no DOM: everything runs against stubs.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const PLUGIN_NAME = '@hanxu131/dsh-zotero'
const ROOT = new URL('..', import.meta.url).pathname

// ---------------------------------------------------------------------------
// Client half
// ---------------------------------------------------------------------------
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(source.startsWith('window.__ModuleLoader__.load('), 'bundle must open with the module loader call')
// Credential red line: the browser half never sees the Zotero key headers.
assert.ok(!source.includes('Zotero-API-Key'), 'client bundle must not carry the Zotero-API-Key header name')
assert.ok(!source.includes('Zotero-Server-ID'), 'client bundle must not carry the Zotero-Server-ID header name')
// The skeleton must be gone: the bundle carries the real search/detail/chat
// surfaces (relative route tables, session-scope chat face, DOMPurify).
assert.ok(!source.includes('初始化骨架'), 'skeleton notice must be removed from the bundle')
assert.ok(source.includes('"/dsh-zotero"'), 'bundle must keep the host route namespace as its only fetch target')
for (const marker of ['ROUTES.items', 'ROUTES.events', 'itemsPath', 'connectViewEvents']) {
  assert.ok(source.includes(marker), `bundle must wire the client data plane (${marker})`)
}
assert.ok(source.includes('inputActions'), 'bundle must consume the official inputActions chat face')
assert.ok(source.includes('setDraft') && source.includes('submit'), 'bundle must wire chat setDraft/submit')
assert.ok(source.toLowerCase().includes('dompurify'), 'bundle must sanitize note HTML with DOMPurify')
assert.ok(!source.includes('127.0.0.1:23119'), 'client bundle must never point at the Zotero Local API directly')

// The PDF reader must be lazy: the main bundle references the official chunk
// contract and never carries pdf.js itself.
assert.ok(/require\.async\(['"]\.\/client\.pdf\.js['"]\)/.test(source), 'main bundle must load the reader through require.async (official chunk contract)')
assert.ok(!source.includes('pdfjsWorker'), 'main bundle must not embed pdf.js (it lives in the chunk)')

// ---- pdf.js chunk: registered as a package-local chunk, carries the reader.
const chunkSource = readFileSync(new URL('../lib/client.pdf.js', import.meta.url), 'utf8')
const requireTable = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
}
const chunkRegistrations = []
const chunkWindow = {
  __ModuleLoader__: {
    load(value) {
      chunkRegistrations.push(value)
    },
  },
}
const chunkDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}
vm.runInNewContext(chunkSource, { window: chunkWindow, document: chunkDocument, console, TextDecoder, TextEncoder, URL, setTimeout, clearTimeout }, { filename: 'lib/client.pdf.js' })
assert.equal(chunkRegistrations.length, 1, 'chunk registers exactly one factory')
assert.equal(chunkRegistrations[0].id, PLUGIN_NAME, 'chunk registration id')
assert.equal(chunkRegistrations[0].chunk, 'client.pdf.js', 'chunk must declare its package-local chunk filename')
assert.equal(typeof chunkRegistrations[0].factory, 'function')
const chunkExports = chunkRegistrations[0].factory((specifier) => {
  if (specifier in requireTable) return requireTable[specifier]
  throw new Error('unexpected chunk platform require: ' + specifier)
})
void chunkExports
assert.equal(typeof chunkExports.Reader, 'function', 'chunk must export the Reader component')
assert.equal(typeof chunkExports.loadPdf, 'function', 'chunk must export the pdf loader')

// Packaged pdf.js runtime assets must ship inside lib/pdfjs (no node_modules
// dependency at runtime).
for (const asset of ['pdfjs/legacy/pdf.mjs', 'pdfjs/legacy/pdf.worker.mjs', 'pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap', 'pdfjs/standard_fonts/FoxitSerif.pfb', 'pdfjs/wasm/openjpeg.wasm', 'pdfjs/LICENSE']) {
  assert.ok(existsSync(ROOT + 'lib/' + asset), 'packaged pdf.js asset must ship: lib/' + asset)
}

let entry
const windowStub = {
  __ModuleLoader__: {
    load(value) {
      entry = value
    },
  },
}
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}
vm.runInNewContext(source, { window: windowStub, document: documentStub, console, TextDecoder, TextEncoder, URL, setTimeout, clearTimeout }, { filename: 'lib/client.js' })

assert.equal(entry?.id, PLUGIN_NAME, 'factory id must equal the package name')
assert.equal(typeof entry.factory, 'function')

/** The factory `require`: platform table sync + package-local chunk async. */
function makeRequire() {
  const require = (specifier) => {
    if (!(specifier in requireTable)) throw new Error('unexpected platform require: ' + specifier)
    return requireTable[specifier]
  }
  require.async = async (specifier) => {
    assert.ok(specifier.startsWith('./') && specifier.slice(2) === 'client.pdf.js', 'chunk specifier must be package-local: ' + specifier)
    return chunkExports
  }
  return require
}
const mod = entry.factory(makeRequire())
assert.deepEqual([...mod.inject], ['slots', 'locale', 'sidebarRightTabs'], 'client inject list')

/** zh strings the render assertions read (mirrors src/client/i18n.ts). */
const zhStrings = {
  'setup.connecting': '正在连接 Zotero…',
  'setup.statusLabel': '连接状态',
  'setup.checkAgain': '再次检查',
  'setup.notRunningTitle': 'Zotero 未运行',
}

/** Cordis-like context capturing effect cleanups and slot registrations. */
function createClientContext() {
  const cleanups = []
  const registrations = []
  return {
    ctx: {
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') cleanups.push(dispose)
        return () => {}
      },
      locale: {
        register: () => () => {},
        bind: () => (key) => zhStrings[key] ?? key,
      },
      slots: {
        inject(slot, callback) {
          const dispose = callback()
          return typeof dispose === 'function' ? dispose : () => {}
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
      sidebarRightTabs: {
        register(definition) {
          registrations.push({ options: { name: 'sidebarRightTabs', ...definition }, component: null })
          return () => {}
        },
      },
    },
    registrations,
    cleanups,
  }
}

const mount = createClientContext()
mod.apply(mount.ctx)
const tabType = mount.registrations.find((r) => r.options.name === 'sidebarRightTabs')
assert.ok(tabType, 'apply must register the right-sidebar tab type')
assert.equal(tabType.options.kind, 'zotero', 'tab kind')
assert.equal(tabType.options.id, PLUGIN_NAME, 'tab definition id')
assert.ok(Array.isArray(tabType.options.guide) && tabType.options.guide.length === 1, 'guide entry for discoverability')

const tabBody = mount.registrations.find((r) => r.options.name === 'sidebar.right.pane.tab')
assert.ok(tabBody, 'apply must register the keyed tab body')
assert.equal(tabBody.options.key, PLUGIN_NAME, 'tab body key must equal the definition id')

// The real tab renders the connection card (never the "initialization
// skeleton"), with localized copy and accessible controls.
const html = renderToStaticMarkup(React.createElement(tabBody.component, { hooks: undefined, t: (key) => zhStrings[key] ?? key }))
assert.ok(html.includes('dshZotSetup'), 'tab body must render the connection card: ' + html)
assert.ok(html.includes('正在连接 Zotero'), 'tab body must render localized copy: ' + html)
assert.ok(html.includes('初始化骨架') === false, 'skeleton must be gone: ' + html)
assert.ok(html.includes('aria-label'), 'controls must carry accessible names: ' + html)
assert.ok(html.includes('PLUGIN') === false, 'no unrendered constants: ' + html)

while (mount.cleanups.length > 0) mount.cleanups.pop()()

// ---------------------------------------------------------------------------
// Host half
// ---------------------------------------------------------------------------
const host = await import(new URL('../lib/index.js', import.meta.url))
assert.equal(host.name, 'zotero', 'host bundle id')
assert.deepEqual([...host.inject], [], 'host inject list (defensive service lookup)')
assert.equal(typeof host.apply, 'function')
assert.equal(typeof host.createRuntime, 'function', 'createRuntime seam exported for tests/smoke')
assert.equal(typeof host.Config, 'function', 'Config must be a schemastery schema')
assert.equal(host.Config.dict.localApiBaseUrl.meta.volatile, true, 'config field must be volatile')
assert.equal(host.Config.dict.localApiBaseUrl.meta.default, 'http://127.0.0.1:23119', 'config default')

/** Minimal webServer stub capturing registered routes. */
function createWebServerStub() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

/** Stand-in for the official connection trust fence (documented contract). */
function createConnectionStub({ authenticated = true } = {}) {
  return {
    requests: 0,
    requestRejection(req) {
      this.requests += 1
      const host = String(req.headers?.host ?? '')
      if (!/^127\.0\.0\.1(:\d+)?$/.test(host) && !/^localhost(:\d+)?$/.test(host)) return 403
      if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') return 403
      return authenticated ? undefined : 401
    },
  }
}

/** Node-http-like response sink. */
function createResponseSink() {
  const headers = {}
  return {
    headers,
    statusCode: 200,
    body: '',
    chunks: [],
    writableEnded: false,
    ended: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value
    },
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    end(body) {
      if (body !== undefined) this.chunks.push(body)
      this.body = this.chunks.join('')
      this.ended = true
      this.writableEnded = true
    },
    once() {},
  }
}

function requestLike(url, options = {}) {
  const body = options.body !== undefined ? options.body : undefined
  return {
    url,
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:3080', ...(options.headers ?? {}) },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
    resume() {},
  }
}

// A closed loopback port: status probing it must land on `not_running`.
const dead = createServer()
const deadPort = await new Promise((done) => {
  dead.listen(0, '127.0.0.1', () => done(dead.address().port))
})
await new Promise((done) => dead.close(done))
const deadBaseUrl = `http://127.0.0.1:${deadPort}`

// apply() with webServer + connection registers exactly one prefix route.
// The stub mirrors the official late-binding shape the plugin mounts through:
// `ctx.inject(deps, callback)` starts the callback once its deps are all
// present on the composition (Cordis fiber semantics; real-cordis ordering is
// covered by tests/host-mount.test.ts).
const webServer = createWebServerStub()
const connection = createConnectionStub()
const cleanups = []
const pendingMounts = []
const ctx = {
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return () => {}
  },
  inject(deps, callback) {
    pendingMounts.push({ deps, callback })
    return { await: async () => {} }
  },
  webServer,
  connection,
  tools: {
    registered: [],
    register(definition) {
      this.registered.push(definition.name)
      return () => {}
    },
  },
}
host.apply(ctx, { localApiBaseUrl: { get: () => deadBaseUrl } })
for (const mount of pendingMounts.splice(0)) {
  if (mount.deps.every((name) => ctx[name] !== undefined)) mount.callback(ctx)
}
assert.equal(webServer.routes.length, 1, 'apply must register exactly one prefix route')
const route = webServer.routes[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/dsh-zotero')
assert.equal(ctx.tools.registered.length, 19, 'agent tools registered (14 pre-M4 + 5 PDF tools)')
for (const pdfTool of ['read_fulltext', 'find_in_pdf', 'highlight', 'clear_highlights', 'save_highlights']) {
  assert.equal(typeof ctx.tools.registered.find((n) => n === pdfTool), 'string', `PDF tool registered: ${pdfTool}`)
}
assert.equal(ctx.tools.registered.includes('delete_items'), false, 'no deletion tool')
assert.ok(cleanups.length >= 1, 'effect cleanup registered')

// health endpoint: minimal-public (no fence consult), identity only.
const health = createResponseSink()
await route.handler(requestLike('/dsh-zotero/health'), health)
assert.equal(health.statusCode, 200)
assert.ok(health.headers['content-type'].startsWith('application/json'), 'health must answer JSON')
const healthBody = JSON.parse(health.body)
assert.equal(healthBody.ok, true)
assert.equal(healthBody.plugin, PLUGIN_NAME)
assert.equal(typeof healthBody.version, 'string', 'health must carry a version string')
assert.ok(healthBody.version.length > 0, 'health version must be non-empty')
assert.equal(connection.requests, 0, 'health must not depend on the trust fence')

// status endpoint: a REAL probe against a closed port → not_running (never
// the constant `unknown` skeleton answer).
const status = createResponseSink()
await route.handler(requestLike('/dsh-zotero/status'), status)
assert.equal(status.statusCode, 200)
const statusBody = JSON.parse(status.body)
assert.equal(statusBody.state, 'not_running', `status must really probe (got ${statusBody.state})`)
assert.notEqual(statusBody.state, 'unknown', 'skeleton behavior removed')
assert.ok(connection.requests > 0, 'protected routes consult the trust fence')

// unauthenticated requests are refused with 401 before any data access.
const lockedConnection = createConnectionStub({ authenticated: false })
const lockedWebServer = createWebServerStub()
const lockedRuntime = host.createRuntime(
  { webServer: lockedWebServer, connection: lockedConnection },
  { localApiBaseUrl: { get: () => deadBaseUrl } },
)
const lockedHandler = lockedWebServer.routes[0].handler
const locked = createResponseSink()
await lockedHandler(requestLike('/dsh-zotero/status'), locked)
assert.equal(locked.statusCode, 401, 'unauthenticated status must be 401')
const lockedItems = createResponseSink()
await lockedHandler(requestLike('/dsh-zotero/items?q=x'), lockedItems)
assert.equal(lockedItems.statusCode, 401, 'unauthenticated reads must be 401')
await lockedRuntime.dispose()

// cross-site fetch metadata is refused with 403.
const csrf = createResponseSink()
await route.handler(requestLike('/dsh-zotero/status', { headers: { 'sec-fetch-site': 'cross-site' } }), csrf)
assert.equal(csrf.statusCode, 403, 'cross-site requests must be 403')

// Without a connection service, protected routes serve nothing (503) while
// health stays minimal-public.
const noFenceWebServer = createWebServerStub()
const noFenceRuntime = host.createRuntime(
  { webServer: noFenceWebServer },
  { localApiBaseUrl: { get: () => deadBaseUrl } },
)
const noFenceHandler = noFenceWebServer.routes[0].handler
const bare = createResponseSink()
await noFenceHandler(requestLike('/dsh-zotero/status'), bare)
assert.equal(bare.statusCode, 503, 'protected route without connection service must be 503')
const bareHealth = createResponseSink()
await noFenceHandler(requestLike('/dsh-zotero/health'), bareHealth)
assert.equal(bareHealth.statusCode, 200, 'health stays minimal-public')
await noFenceRuntime.dispose()

// The M4 PDF surface answers for real: info rejects a garbage key with the
// envelope (400) — proving the route is registered and validated, not 501.
const pdfInfo = createResponseSink()
await route.handler(requestLike('/dsh-zotero/pdf/info?library=user&attachment=SHORTKEY'), pdfInfo)
assert.equal(pdfInfo.statusCode, 400)
assert.equal(JSON.parse(pdfInfo.body).error.code, 'invalid_input')
const pdfPart = createResponseSink()
await route.handler(requestLike('/dsh-zotero/pdf/part?library=user&attachment=SHORTKEY&part=0'), pdfPart)
assert.equal(pdfPart.statusCode, 400)
// Static pdf.js assets refuse non-whitelisted kinds/files.
const pdfAsset = createResponseSink()
await route.handler(requestLike('/dsh-zotero/pdfjs/evil/whatever.bin'), pdfAsset)
assert.equal(pdfAsset.statusCode, 404)
// UI highlight write routes exist (empty body → 400 invalid_input).
const hlSave = createResponseSink()
await route.handler(requestLike('/dsh-zotero/writes/highlights/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":"nope"}' }), hlSave)
assert.equal(hlSave.statusCode, 400)
const hlClear = createResponseSink()
await route.handler(requestLike('/dsh-zotero/writes/highlights/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), hlClear)
assert.equal(hlClear.statusCode, 200)

// unknown endpoint under the namespace
const missing = createResponseSink()
await route.handler(requestLike('/dsh-zotero/nothing'), missing)
assert.equal(missing.statusCode, 404)

while (cleanups.length > 0) cleanups.pop()()

// apply() without any services must not throw: no-web profiles stay
// activatable (the default loopback URL validates; an invalid configured URL
// fails activation loudly by design — the session constructor rejects it).
const bareCtx = () => ({ effect: () => () => {}, inject: () => ({ await: async () => {} }) })
host.apply(bareCtx(), { localApiBaseUrl: { get: () => 'http://127.0.0.1:23119' } })
assert.throws(
  () => host.apply(bareCtx(), { localApiBaseUrl: { get: () => 'http://attacker.example:1' } }),
  /loopback/,
  'a non-loopback configured URL must fail activation loudly',
)

// Credential red line on the host bundle: key material never literal.
const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
for (const file of ['index.js']) {
  const text = readFileSync(new URL('../lib/' + file, import.meta.url), 'utf8')
  assert.ok(!/"Zotero-API-Key"\s*:\s*"[^"]+"/.test(text), 'host bundle must not embed a literal key value')
}

console.log('smoke: client bundle keeps the __ModuleLoader__ contract, renders the real tab (no skeleton; search/chat/detail markers present), loads the reader through the official require.async chunk contract, and carries no Zotero credential headers')
console.log('smoke: host half registers the protected route table; health public; status really probes (not_running); 401/403/503/404 enforced; M4 PDF routes + highlight UI writes live (no 501); 19 agent tools registered')
console.log('smoke: packaged pdf.js assets ship under lib/pdfjs; activation without services is a no-op')
