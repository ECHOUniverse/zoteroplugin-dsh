#!/usr/bin/env node
/**
 * Agent-runnable probe for the DSH Desktop host-route symptom (read-only).
 *
 * Reproduces, against the RUNNING Desktop, the exact chain behind the tab's
 * “无法连接插件宿主路由” card (setup.hostUnreachable):
 *
 *   1. discover the owned Host webServer port (lsof on the running
 *      dsh-desktop-host process — no GUI interaction),
 *   2. GET  /dsh-zotero/health        → registered? (public liveness route)
 *   3. GET  /dsh-zotero/status        → protected route table present?
 *   4. GET  /plugins/events           → the official HMR graph (lists every
 *      mounted client bundle; proves the client carrier works),
 *   5. GET  the zotero bundle combo URL from that graph (document-relative
 *      `plugins/??<id>/client.js&rev=<rev>` — the same shape the tab itself
 *      loads through the shell's forwardWebRequest bridge).
 *
 * Interpretation (matches src/client/views.tsx SetupView):
 *   - health 404 → the host half never registered its routes → the tab shows
 *     setup.hostUnreachable regardless of Zotero's state.
 *   - health 200 → routes registered; a status 401/403 is the trust fence,
 *     not the symptom.
 *
 * Usage: node scripts/probe-desktop.mjs [port]
 * Only loopback GETs are performed; nothing is written to Zotero or the GUI.
 */
import { execFileSync } from 'node:child_process'

const ROUTE_BASE = '/dsh-zotero'
const PLUGIN_ID = '@hanxu131/dsh-zotero'

function discoverPort() {
  const out = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' })
  const line = out.split('\n').find((entry) => entry.includes('dsh-desktop-host/lib/index.js'))
  if (line === undefined) throw new Error('no running dsh-desktop-host process found')
  const pids = execFileSync('pgrep', ['-f', 'dsh-desktop-host/lib/index.js'], { encoding: 'utf8' })
    .split('\n')
    .filter((value) => value !== '')
  if (pids.length === 0) throw new Error('could not resolve the host pid')
  const lsof = execFileSync('lsof', ['-a', '-nP', '-iTCP', '-sTCP:LISTEN', '-p', pids[0]], { encoding: 'utf8' })
  const match = lsof.match(/127\.0\.0\.1:(\d+) \(LISTEN\)/)
  if (match === null) throw new Error(`the host process (pid ${pids[0]}) has no loopback webServer listener`)
  return Number(match[1])
}

async function probe(port, path, { timeoutMs = 4000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal })
    const text = await response.text().catch(() => '')
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text }
  } catch (error) {
    return { status: 0, contentType: '', text: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const port = Number(process.argv[2]) || discoverPort()
console.log(`DSH host webServer: http://127.0.0.1:${port}`)

const health = await probe(port, `${ROUTE_BASE}/health`)
console.log(`1) GET ${ROUTE_BASE}/health   → ${health.status} ${health.text.slice(0, 120)}`)

const status = await probe(port, `${ROUTE_BASE}/status`)
console.log(`2) GET ${ROUTE_BASE}/status   → ${status.status} ${status.text.slice(0, 120)}`)

const hmr = await probe(port, '/plugins/events', { timeoutMs: 1500 })
let bundle = null
if (hmr.status === 200) {
  console.log('3) GET /plugins/events       → 200 (official HMR graph is streaming; client carrier alive)')
  for (const line of hmr.text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const payload = JSON.parse(line.slice(6))
      if (payload.type !== 'graph') continue
      const entry = payload.graph.entries.find((candidate) => candidate.id === PLUGIN_ID)
      if (entry !== undefined) {
        bundle = entry.url
        console.log(`4) graph entry ${PLUGIN_ID}  → rev ${entry.rev} url ${entry.url}`)
      }
      break
    } catch {
      /* partial SSE frame — ignore */
    }
  }
} else {
  console.log(`3) GET /plugins/events       → ${hmr.status} (HMR channel absent)`)
}

if (bundle !== null) {
  const bundleProbe = await probe(port, `/${bundle}`)
  console.log(`5) GET /${bundle.slice(0, 60)}… → ${bundleProbe.status} ${bundleProbe.contentType} (${bundleProbe.text.length} bytes)`)
}

if (health.status === 200) {
  console.log('\nVERDICT: host routes registered. If the tab still shows the error card, reload it.')
} else if (health.status === 404) {
  console.log('\nVERDICT: host routes NOT registered — the tab shows setup.hostUnreachable')
  console.log('(“无法连接插件宿主路由…”). With the fixed build (ctx.inject late binding)')
  console.log('in lib/index.js this needs the DSH host to remount the plugin: restart the')
  console.log('plugin (or the Desktop app). A 404 here is the exact production symptom.')
} else {
  console.log(`\nVERDICT: unexpected health status ${health.status} — inspect manually.`)
}
