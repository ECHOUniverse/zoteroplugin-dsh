import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_LOCAL_API_BASE_URL, inject as hostInject, name as hostName } from '../src/index.ts'
import { inject as clientInject, NAMESPACE, TAB_DEFINITION_ID, TAB_KIND } from '../src/client.tsx'
import { PLUGIN_NAME } from '../src/shared/protocol.ts'
import manifest from '../package.json'

const root = fileURLToPath(new URL('../', import.meta.url))
const readText = (path: string) => readFileSync(root + path, 'utf8')

describe('package manifest', () => {
  it('declares the dual-half plugin shape', () => {
    expect(manifest.name).toBe(PLUGIN_NAME)
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.exports['.'].default).toBe('./lib/index.js')
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('declares the DSH client module and engine ranges', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-ui-sidebar-right'])
    expect(manifest.engines.dsh).toBe('>=0.2.1-rc.1 <0.3.0-0')
  })

  it('ships the license set and no source maps', () => {
    expect(manifest.files).toContain('LICENSE')
    expect(manifest.files).toContain('NOTICE')
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES.md')
    expect(manifest.files).toContain('lib')
    expect(manifest.license).toBe('Apache-2.0')
  })
})

describe('license artifacts exist on disk', () => {
  it('LICENSE is the Apache-2.0 text', () => {
    const license = readText('LICENSE')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0, January 2004')
    expect(license).toContain('Copyright 2026 hanxu131')
  })

  it('NOTICE carries the project copyright', () => {
    expect(readText('NOTICE')).toContain('hanxu131')
  })

  it('THIRD_PARTY_NOTICES registers consulted third-party material', () => {
    const notices = readText('THIRD_PARTY_NOTICES.md')
    expect(notices).toContain('zai-org/zcode-plugins')
    expect(notices).toContain('Apache-2.0')
  })
})

describe('bundle patch', () => {
  const patch = readText('cordis.patch.yml')

  it('inserts the bundle with its id and quoted package name', () => {
    expect(patch).toContain('- id: zotero')
    expect(patch).toContain(`name: '${PLUGIN_NAME}'`)
  })

  it('seeds the same config default the schema declares', () => {
    expect(patch).toContain(`localApiBaseUrl: ${DEFAULT_LOCAL_API_BASE_URL}`)
  })
})

describe('halves', () => {
  it('host half exposes name/inject/Config', () => {
    expect(hostName).toBe('zotero')
    expect([...hostInject]).toEqual([])
    expect(typeof Config).toBe('function')
    expect(Config.dict.localApiBaseUrl.meta.volatile).toBe(true)
    expect(Config.dict.localApiBaseUrl.meta.default).toBe(DEFAULT_LOCAL_API_BASE_URL)
  })

  it('client half exposes the tab identity and service injects', () => {
    expect(TAB_KIND).toBe('zotero')
    expect(TAB_DEFINITION_ID).toBe(PLUGIN_NAME)
    expect(NAMESPACE).toBe('zotero')
    expect([...clientInject]).toEqual(['slots', 'locale', 'sidebarRightTabs'])
  })
})
