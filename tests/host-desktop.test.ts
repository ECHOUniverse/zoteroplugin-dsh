/**
 * Desktop wiring (M7): the session facade (installInfo / launchZoteroApp /
 * openInZotero) and the `/desktop/launch` + `/desktop/open` routes, all
 * against injected fakes — no real Zotero is started and no real deep link
 * is ever opened. Also covers the status route's install facts: the
 * not_installed vs not_running distinction and that the wire never carries
 * the absolute install path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mountRoutes, type MountedRoutes } from './helpers/host-harness.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'
import { ZoteroSession } from '../src/host/session.ts'
import { ROUTES } from '../src/shared/protocol.ts'
import { ZoteroError } from '../src/domain/model.ts'

describe('ZoteroSession desktop facade (injected seams)', () => {
  /** Install report the fake findApp returns (tilde-abbreviated path). */
  const INSTALL = { state: 'found' as const, path: '~/Applications/Zotero.app', version: '7.0.15', searched: [] as string[] }

  it('caches installInfo across calls and degrades probe errors to null', async () => {
    let calls = 0
    const session = new ZoteroSession({
      baseUrl: { get: () => 'http://127.0.0.1:23119' },
      findApp: async () => {
        calls += 1
        return INSTALL
      },
    })
    expect(await session.installInfo()).toEqual(INSTALL)
    expect(await session.installInfo()).toEqual(INSTALL)
    expect(calls).toBe(1)

    const failing = new ZoteroSession({
      baseUrl: { get: () => 'http://127.0.0.1:23119' },
      findApp: async () => {
        throw new Error('fs exploded')
      },
    })
    expect(await failing.installInfo()).toBeNull()
    await session.dispose()
    await failing.dispose()
  })

  it('launchZoteroApp and openInZotero route through the injected seams', async () => {
    const launched: string[] = []
    const opened: string[] = []
    const session = new ZoteroSession({
      baseUrl: { get: () => 'http://127.0.0.1:23119' },
      launchApp: async () => {
        launched.push('spawn')
        return '~/Applications/Zotero.app'
      },
      openLink: async (url) => {
        opened.push(url)
      },
    })
    await session.launchZoteroApp()
    expect(launched).toEqual(['spawn'])
    const result = await session.openInZotero({ kind: 'open-pdf', library: 'user', key: 'PDFATTAA', page: 2 })
    expect(result.url).toBe('zotero://open-pdf/library/items/PDFATTAA?page=2')
    expect(opened).toEqual(['zotero://open-pdf/library/items/PDFATTAA?page=2'])
    await expect(session.openInZotero({ kind: 'select', library: 'user', key: 'bad key' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(opened).toHaveLength(1) // the invalid target never reached the opener
    await session.dispose()
  })
})

describe('desktop routes (UI actions behind the trust fence)', () => {
  let fake: FakeZotero
  beforeAll(async () => {
    fake = await startFakeZotero()
  })
  afterAll(async () => {
    await fake.close()
  })

  function mounted(launchCalls: string[], openCalls: string[], options: { authenticated?: boolean } = {}): Promise<MountedRoutes> {
    return mountRoutes(fake, {
      ...options,
      session: {
        launchApp: async () => {
          launchCalls.push('launch')
          return '~/Applications/Zotero.app'
        },
        openLink: async (url: string) => {
          openCalls.push(url)
        },
        findApp: async () => INSTALL_FOUND,
      },
    })
  }
  const INSTALL_FOUND = { state: 'found' as const, path: '~/Applications/Zotero.app', version: '7.0.15', searched: [] as string[] }

  it('POST /desktop/launch starts Zotero exactly once per call', async () => {
    const launchCalls: string[] = []
    const openCalls: string[] = []
    const app = await mounted(launchCalls, openCalls)
    const res = await app.call(ROUTES.desktopLaunch, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ launched: true })
    expect(launchCalls).toEqual(['launch'])
    await app.close()
  })

  it('gates /desktop/launch to POST and behind the fence (a refused request never spawns)', async () => {
    const launchCalls: string[] = []
    const openCalls: string[] = []
    const app = await mounted(launchCalls, openCalls)
    const get = await app.call(ROUTES.desktopLaunch, { method: 'GET' })
    expect(get.status).toBe(405)
    const unauth = await mounted(launchCalls, openCalls, { authenticated: false })
    const denied = await unauth.call(ROUTES.desktopLaunch, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(401)
    expect(launchCalls).toEqual([])
    await app.close()
    await unauth.close()
  })

  it('maps zotero_not_installed to the error envelope without leaking a path', async () => {
    const app = await mountRoutes(fake, {
      session: { launchApp: async () => { throw new ZoteroError('zotero_not_installed', 'Zotero is not installed on this computer.') } },
    })
    const res = await app.call(ROUTES.desktopLaunch, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(502)
    expect(res.json()).toMatchObject({ error: { code: 'zotero_not_installed' } })
    expect(res.body).not.toContain('/Applications')
    await app.close()
  })

  it('POST /desktop/open builds the URL server-side for select and open-pdf', async () => {
    const launchCalls: string[] = []
    const openCalls: string[] = []
    const app = await mounted(launchCalls, openCalls)
    const select = await app.call(ROUTES.desktopOpen, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'user', key: 'ABCD2345', target: 'select' }),
    })
    expect(select.status).toBe(200)
    expect(select.json()).toEqual({ opened: true, url: 'zotero://select/library/items/ABCD2345' })

    const group = await app.call(ROUTES.desktopOpen, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: 'g88', key: 'ABCD2345', target: 'open-pdf', page: 4 }),
    })
    expect(group.json()).toEqual({ opened: true, url: 'zotero://open-pdf/groups/88/items/ABCD2345?page=4' })
    expect(openCalls).toEqual(['zotero://select/library/items/ABCD2345', 'zotero://open-pdf/groups/88/items/ABCD2345?page=4'])
    await app.close()
  })

  it('rejects bad targets/keys/pages with 400 and ignores client-supplied URL fields', async () => {
    const launchCalls: string[] = []
    const openCalls: string[] = []
    const app = await mounted(launchCalls, openCalls)
    const post = (body: Record<string, unknown>) =>
      app.call(ROUTES.desktopOpen, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post({ key: 'ABCD2345', target: 'select' })).status).toBe(200) // library defaults to user
    expect((await post({ key: 'ABCD2345', target: 'launch' })).status).toBe(400)
    expect((await post({ key: 'nope', target: 'select' })).status).toBe(400)
    expect((await post({ key: 'ABCD2345', target: 'open-pdf', page: 0 })).status).toBe(400)
    expect((await post({ key: 'ABCD2345', target: 'open-pdf', page: 2.5 })).status).toBe(400)
    expect((await post({ target: 'select' })).status).toBe(400)
    // A client cannot smuggle a URL or command through the body: the URL in
    // the response is the server-constructed one, and the opener only ever
    // saw that.
    const smuggled = await post({ key: 'ABCD2345', target: 'select', url: 'https://evil.example', command: 'rm -rf /' })
    expect(smuggled.status).toBe(200)
    expect((smuggled.json() as { url: string }).url).toBe('zotero://select/library/items/ABCD2345')
    expect(openCalls.every((url) => url.startsWith('zotero://'))).toBe(true)
    const get = await app.call(ROUTES.desktopOpen, { method: 'GET' })
    expect(get.status).toBe(405)
    await app.close()
  })
})

describe('status install facts (not_installed vs not_running, no absolute paths)', () => {
  let fake: FakeZotero
  /** A bound-then-released loopback port: nothing listens there anymore. */
  let deadPort: number
  beforeAll(async () => {
    fake = await startFakeZotero()
    const dead = createServer()
    deadPort = await new Promise<number>((done) => {
      dead.listen(0, '127.0.0.1', () => done((dead.address() as { port: number }).port))
    })
    await new Promise<void>((done) => dead.close(() => done()))
  })
  afterAll(async () => {
    await fake.close()
  })

  it('carries install.state=found + version when Zotero is not answering but installed', async () => {
    const app = await mountRoutes(fake, {
      baseUrl: `http://127.0.0.1:${deadPort}`,
      session: { findApp: async () => ({ state: 'found' as const, path: '/Applications/Zotero.app', version: '7.0.15', searched: [] as string[] }) },
    })
    const res = await app.call(ROUTES.status)
    expect(res.status).toBe(200)
    const body = res.json() as { state: string; install?: { state: string; version?: string; path?: string } }
    expect(body.state).toBe('not_running')
    expect(body.install).toEqual({ state: 'found', version: '7.0.15' })
    expect(body.install?.path).toBeUndefined() // the absolute path never crosses the wire
    await app.close()
  })

  it('carries install.state=missing with tilde-abbreviated searched locations when not installed', async () => {
    const app = await mountRoutes(fake, {
      baseUrl: `http://127.0.0.1:${deadPort}`,
      session: {
        findApp: async () => ({
          state: 'missing' as const,
          searched: ['/Applications', '~/Applications', '~/.local/share/flatpak'],
        }),
      },
    })
    const res = await app.call(ROUTES.status)
    const body = res.json() as { state: string; install?: { state: string; searched?: string[] } }
    expect(body.state).toBe('not_running')
    expect(body.install?.state).toBe('missing')
    expect(body.install?.searched).toEqual(['/Applications', '~/Applications', '~/.local/share/flatpak'])
    expect(res.body).not.toMatch(/\/home\/[a-z]/) // no absolute home path leaks
    await app.close()
  })

  it('omits install entirely when Zotero answers (state ready)', async () => {
    let findCalls = 0
    const app = await mountRoutes(fake, {
      session: {
        findApp: async () => {
          findCalls += 1
          return { state: 'found' as const, path: '/Applications/Zotero.app', searched: [] as string[] }
        },
      },
    })
    const res = await app.call(ROUTES.status)
    const body = res.json() as { state: string; install?: unknown }
    expect(body.state).toBe('ready')
    expect(body.install).toBeUndefined()
    expect(findCalls).toBe(0) // no install probe work at all when Zotero is up
    await app.close()
  })

  it('keeps the client api surface POSTing the desktop endpoints (UI wiring contract)', async () => {
    const { launchZotero, showInZotero, browserRef } = await import('../src/client/api.ts')
    const calls: { path: string; body: unknown }[] = []
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const path = String(input)
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as unknown })
      // The browser half references host route keys document-relative
      // (official boundary rule; see client/api.ts browserRef).
      const payload = path === browserRef(ROUTES.desktopLaunch) ? { launched: true } : { opened: true, url: 'zotero://open-pdf/library/items/PDFATTAA?page=2' }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response
    }
    expect(await launchZotero({ fetchImpl })).toEqual({ launched: true })
    const opened = await showInZotero({ library: 'user', key: 'PDFATTAA', target: 'open-pdf', page: 2 }, { fetchImpl })
    expect(opened.url).toBe('zotero://open-pdf/library/items/PDFATTAA?page=2')
    expect(calls.map((call) => call.path)).toEqual([browserRef(ROUTES.desktopLaunch), browserRef(ROUTES.desktopOpen)])
    expect(calls[1]?.body).toEqual({ library: 'user', key: 'PDFATTAA', target: 'open-pdf', page: 2 })
  })
})
