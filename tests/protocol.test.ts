import { describe, expect, it } from 'vitest'
import {
  PLUGIN_NAME,
  PLUGIN_VERSION,
  ROUTE_BASE,
  ROUTES,
  type HealthResponse,
  type StatusResponse,
} from '../src/shared/protocol.ts'
import manifest from '../package.json'

describe('plugin identity', () => {
  it('matches the npm manifest', () => {
    expect(PLUGIN_NAME).toBe(manifest.name)
    expect(PLUGIN_VERSION).toBe(manifest.version)
  })
})

describe('route table', () => {
  it('derives every route from the single prefix namespace', () => {
    const paths = Object.values(ROUTES)
    for (const path of paths) {
      expect(path.startsWith(`${ROUTE_BASE}/`)).toBe(true)
    }
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('keeps the health route canonical', () => {
    expect(ROUTES.health).toBe('/dsh-zotero/health')
    expect(ROUTES.status).toBe('/dsh-zotero/status')
  })
})

describe('wire shapes', () => {
  it('health payloads type-check against the contract', () => {
    const body: HealthResponse = { ok: true, plugin: PLUGIN_NAME, version: PLUGIN_VERSION }
    expect(body.ok).toBe(true)
  })

  it('status payloads may omit optional diagnostics', () => {
    const body: StatusResponse = { plugin: PLUGIN_NAME, state: 'unknown', checkedAt: 0, baseUrl: 'http://127.0.0.1:23119' }
    expect(body.zoteroVersion).toBeUndefined()
    expect(body.error).toBeUndefined()
  })

  it('status always carries the loopback baseUrl (display-only; edits live in the DSH settings form)', () => {
    const body: StatusResponse = { plugin: PLUGIN_NAME, state: 'ready', checkedAt: 0, baseUrl: 'http://127.0.0.1:23119' }
    expect(body.baseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/)
    // Credential-bearing addresses are refused host-side before they could
    // ever reach this wire type.
    expect(body.baseUrl).not.toMatch(/@/)
  })
})
