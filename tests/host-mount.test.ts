/**
 * Real-Cordis mounting tests for the host half (`src/index.ts`).
 *
 * The real composition (verified live on Desktop 0.2.1-rc.5) mounts bundle
 * plugins as sibling Cordis fibers. Cordis only resolves a service property
 * (`ctx.webServer`) through a fiber's OWN `inject` declarations — an
 * `inject: []` plugin can never read sibling services, and an eager
 * `Reflect.get(ctx, 'webServer')` at apply time throws
 * `cannot get property "webServer" without inject`. Before the fix, that throw
 * failed the plugin fiber, so `/dsh-zotero/*` answered 404 from the host
 * webServer while the client bundle (served by the same webServer, no fiber
 * needed) kept working — the exact reported symptom.
 *
 * These tests mount the real plugin module on a real Cordis `Context` (the
 * same `@deepseek-ai/cordis` package the runtime ships) in both orderings and
 * pin the official late-binding contract:
 * - `@deepseek-ai/dsh-host-open-in-app` declares its route carriers
 *   (`inject = ["webServer", "connection", …]`) before registering routes;
 * - `@deepseek-ai/dsh-client-modules` mounts its optional `/plugins` carrier
 *   through `ctx.inject(["webServer"], …)` — register when (and only when)
 *   the service exists, never fail the plugin when it does not.
 *
 * No real Zotero is touched: only the public `health` route is dispatched.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as zotero from '../src/index.ts'
import { mountedSession } from '../src/index.ts'
import { MockResponse, fakeConnection, mockRequest, stubWebServer, type StubWebServer } from './helpers/host-harness.ts'
import type { ApprovalFace, ApprovalOutcome, CredentialRecord, CredentialsFace, FsFace, ToolsFace, WorkingDirectoryFace } from '../src/host/services.ts'
import type { ToolDefinition } from '../src/tools/define-tool.ts'
import { REGISTERED_TOOL_NAMES } from '../src/tools/index.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'

/** The real loader would validate config through the plugin's own schema. */
const config = { localApiBaseUrl: 'http://127.0.0.1:23119' } as const

/** Wait until `probe` returns a defined value (bounds cordis fiber settling). */
async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Dispatch `GET /dsh-zotero/health` against the registered prefix handler. */
async function callHealth(webServer: StubWebServer): Promise<MockResponse> {
  const route = await waitFor(() => webServer.routes.find((entry) => entry.path === '/dsh-zotero'), 'the /dsh-zotero route registration')
  const response = new MockResponse()
  await route.handler(mockRequest({ url: '/dsh-zotero/health' }), response)
  return response
}

describe('host half on a real cordis composition', () => {
  it('registers routes when webServer activates after the plugin fiber (desktop ordering)', async () => {
    const ctx = new Context()
    // The plugin mounts with no composition service present (inject: [] keeps
    // it activatable everywhere); webServer + connection arrive in a LATER fiber.
    await ctx.plugin(zotero, config)
    const webServer = stubWebServer()
    await ctx.plugin({
      name: 'late-webserver',
      apply: (svcCtx) => {
        svcCtx.provide('webServer', webServer)
        svcCtx.provide('connection', fakeConnection())
      },
    })
    const response = await callHealth(webServer)
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, plugin: '@hanxu131/dsh-zotero' })
  })

  it('registers routes when webServer is already active (web-style ordering)', async () => {
    const ctx = new Context()
    const webServer = stubWebServer()
    await ctx.plugin({
      name: 'early-webserver',
      apply: (svcCtx) => {
        svcCtx.provide('webServer', webServer)
        svcCtx.provide('connection', fakeConnection())
      },
    })
    await ctx.plugin(zotero, config)
    const response = await callHealth(webServer)
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, plugin: '@hanxu131/dsh-zotero' })
  })

  it('stays inert (no fenced route) when webServer appears without the connection fence', async () => {
    // Mirrors `@deepseek-ai/dsh-host-open-in-app`, whose route carrier effect
    // requires `webServer` AND `connection`: a webServer without the official
    // trust fence has no authenticated route channel, so no route mounts.
    const ctx = new Context()
    await ctx.plugin(zotero, config)
    const webServer = stubWebServer()
    await ctx.plugin({
      name: 'late-webserver-bare',
      apply: (svcCtx) => {
        svcCtx.provide('webServer', webServer)
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(webServer.routes.some((entry) => entry.path === '/dsh-zotero')).toBe(false)
  })

  it('activates cleanly (no route, no throw) when no webServer ever appears', async () => {
    const ctx = new Context()
    // Nothing to assert beyond "no throw" — the plugin must not drag the profile down.
    await ctx.plugin(zotero, config)
  })

  it('registers Agent tools when the tools service activates after the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(zotero, config)
    const registered: string[] = []
    const tools: ToolsFace = {
      register(definition: Record<string, unknown>) {
        registered.push(String(definition.name))
        return () => {}
      },
    }
    await ctx.plugin({
      name: 'late-tools',
      apply: (svcCtx) => {
        svcCtx.provide('tools', tools)
      },
    })
    await waitFor(() => (registered.length > 0 ? registered : undefined), 'zotero agent tool registrations')
    expect(registered).toContain('search_library')
  })
})

// -----------------------------------------------------------------------------
// Host-service late binding on a real cordis composition
// (tools/approval/credentials/fs/workingDirectory arrive, cycle and leave).
// -----------------------------------------------------------------------------

/** Composition service stub with LIVE registrations (its disposer unregisters). */
function stubTools(): ToolsFace & { names(): string[]; get(name: string): ToolDefinition | undefined } {
  const live = new Map<string, ToolDefinition>()
  return {
    register(definition: Record<string, unknown>) {
      const name = String(definition.name)
      live.set(name, definition as unknown as ToolDefinition)
      return () => {
        live.delete(name)
      }
    },
    names: () => [...live.keys()],
    get: (name: string) => live.get(name),
  }
}

/** Official credential-record stub over a Map, recording every write/read/delete. */
function fakeCredentials(): CredentialsFace & { writes: { key: string }[]; reads: string[]; deletions: string[] } {
  const records = new Map<string, CredentialRecord>()
  const writes: { key: string }[] = []
  const reads: string[] = []
  const deletions: string[] = []
  return {
    async readRecord(key) {
      reads.push(key)
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      writes.push({ key })
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      deletions.push(key)
      records.delete(key)
    },
    writes,
    reads,
    deletions,
  }
}

/** Fake official fs + workingDirectory pair resolving inside one workspace root. */
function fakeWorkspace(root = '/tmp/dsh-zotero-host-mount-workspace'): {
  fs: FsFace
  workingDirectory: WorkingDirectoryFace
  writes: { path: string; content: string }[]
} {
  const writes: { path: string; content: string }[] = []
  const written = new Set<string>()
  return {
    fs: {
      async resolve(path, options) {
        const cwd = typeof options?.cwd === 'string' ? options.cwd : root
        return { targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }
      },
      async stat() {
        return undefined
      },
      async writeText(target, content) {
        const operation = written.has(target.targetKey) ? 'update' : 'create'
        written.add(target.targetKey)
        writes.push({ path: target.displayPath, content })
        return { operation }
      },
    },
    workingDirectory: {
      async ensure() {
        return root
      },
    },
    writes,
  }
}

/** Approval stub recording every ask (default outcome allowed-once). */
function fakeApproval(outcome: ApprovalOutcome = 'allowed-once'): ApprovalFace & { asks: { toolName: string; agent: unknown }[] } {
  const asks: { toolName: string; agent: unknown }[] = []
  return {
    asks,
    async request(req) {
      asks.push({ toolName: req.toolName, agent: req.agent })
      return outcome
    },
  }
}

/**
 * Provide composition services directly on the composition root, keeping each
 * provide's disposer so a test can revoke (cycle) the service like a real
 * host fiber restarting would.
 */
function serviceSwitch(ctx: Context) {
  const disposers = new Map<string, () => void>()
  return {
    async provide(name: string, value: unknown): Promise<void> {
      await this.revoke(name)
      disposers.set(name, (ctx as unknown as { provide(name: string, value: unknown): () => void }).provide(name, value))
    },
    async revoke(name: string): Promise<void> {
      const dispose = disposers.get(name)
      if (dispose === undefined) return
      disposers.delete(name)
      dispose()
    },
  }
}

/** Execute `run` until it stops failing closed with `write_denied` (cordis settle window). */
async function untilWriteApproved(run: () => Promise<unknown>, what: string): Promise<void> {
  const deadline = Date.now() + 1000
  for (;;) {
    try {
      await run()
      return
    } catch (error) {
      if ((error as { code?: string }).code !== 'write_denied' || Date.now() > deadline) {
        throw new Error(`write never got approved (${what}): ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

/** Execute `run` until it fails closed with `write_denied` (cordis settle window). */
async function untilWriteDenied(run: () => Promise<unknown>, what: string): Promise<void> {
  const deadline = Date.now() + 1000
  for (;;) {
    try {
      await run()
    } catch (error) {
      if ((error as { code?: string }).code === 'write_denied') return
      if (Date.now() > deadline) throw new Error(`write never failed closed (${what}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Date.now() > deadline) throw new Error(`write never failed closed (${what}): still succeeding`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('host services late binding (real cordis cycles)', () => {
  it('cycles the tools service without duplicating or leaking registrations', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(zotero, config)
    await fiber
    const services = serviceSwitch(ctx)
    const toolsA = stubTools()
    await services.provide('tools', toolsA)
    await waitFor(() => (toolsA.names().length === REGISTERED_TOOL_NAMES.length ? toolsA : undefined), 'tools registered on stub A')
    expect(toolsA.names()).toEqual([...REGISTERED_TOOL_NAMES])

    // Service cycle: the fiber unloads → every registration on stub A goes.
    await services.revoke('tools')
    await waitFor(() => (toolsA.names().length === 0 ? toolsA : undefined), 'stub A unregistered after service cycle')

    const toolsB = stubTools()
    await services.provide('tools', toolsB)
    await waitFor(() => (toolsB.names().length === REGISTERED_TOOL_NAMES.length ? toolsB : undefined), 'tools registered on stub B')
    expect(toolsA.names()).toHaveLength(0)
    expect(toolsB.names()).toEqual([...REGISTERED_TOOL_NAMES])
  })

  it('cycles the route carrier without duplicate /dsh-zotero registrations', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(zotero, config)
    await fiber
    const services = serviceSwitch(ctx)
    const webServer = stubWebServer()
    await services.provide('webServer', webServer)
    await services.provide('connection', fakeConnection())
    await waitFor(() => (webServer.routes.some((route) => route.path === '/dsh-zotero') ? webServer : undefined), 'the /dsh-zotero route')
    expect(webServer.routes.filter((route) => route.path === '/dsh-zotero')).toHaveLength(1)

    // The trust fence cycles (restart) → the route effect must unregister and
    // re-register exactly once (a real webServer throws on duplicate (kind, path)).
    await services.revoke('connection')
    await waitFor(() => (webServer.routes.some((route) => route.path === '/dsh-zotero') ? undefined : webServer), 'route unregistered while the fence is down')
    await services.provide('connection', fakeConnection())
    await waitFor(() => (webServer.routes.some((route) => route.path === '/dsh-zotero') ? webServer : undefined), 'route re-registered after the fence returns')
    expect(webServer.routes).toHaveLength(1)
    const response = new MockResponse()
    await webServer.routes[0]!.handler(mockRequest({ url: '/dsh-zotero/health' }), response)
    expect(response.status).toBe(200)
  })

  it('plugin dispose unregisters routes and tools (session teardown stays intact)', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(zotero, config)
    await fiber
    const services = serviceSwitch(ctx)
    const webServer = stubWebServer()
    const tools = stubTools()
    await services.provide('webServer', webServer)
    await services.provide('connection', fakeConnection())
    await services.provide('tools', tools)
    await waitFor(() => (webServer.routes.length > 0 && tools.names().length > 0 ? true : undefined), 'routes and tools mounted')
    await fiber.dispose()
    await waitFor(() => (webServer.routes.length === 0 && tools.names().length === 0 ? true : undefined), 'registrations released by plugin dispose')
  })

  it('writes adopt the late-arriving approval service and fail closed when it leaves', async () => {
    const fake = await startFakeZotero({ authorize: 'always' })
    try {
      const ctx = new Context()
      const fiber = ctx.plugin(zotero, { localApiBaseUrl: fake.url })
      await fiber
      const services = serviceSwitch(ctx)
      const tools = stubTools()
      await services.provide('tools', tools)
      await waitFor(() => (tools.names().length === REGISTERED_TOOL_NAMES.length ? tools : undefined), 'tool registration')
      const session = mountedSession(fiber.ctx)
      expect(session).toBeDefined()
      const authorize = () => tools.get('authorize_writes')!.execute({}, { agent: { id: 'agent-1' }, callId: 'call-1' })

      // No approval service yet → fail-closed without touching Zotero.
      await untilWriteDenied(authorize, 'before the approval service arrives')
      expect(fake.state.authorizeRequests).toBe(0)

      // Approval arrives on its own fiber → the same registered tool uses it.
      const approval = fakeApproval('allowed-once')
      await services.provide('approval', approval)
      await untilWriteApproved(authorize, 'after the approval service arrives')
      expect(approval.asks.map((ask) => ask.toolName)).toEqual(['authorize_writes'])
      expect(fake.state.authorizeRequests).toBeGreaterThanOrEqual(1)

      // Approval cycles away → fail-closed again, and the late face is not asked.
      await services.revoke('approval')
      const asksBefore = approval.asks.length
      await untilWriteDenied(authorize, 'after the approval service leaves')
      expect(approval.asks).toHaveLength(asksBefore)
      expect(mountedSession(fiber.ctx)).toBe(session)
    } finally {
      await fake.close()
    }
  })

  it('late credentials are used by the live client; unbinding returns to in-memory keys', async () => {
    const fake = await startFakeZotero({ authorize: 'always' })
    try {
      const ctx = new Context()
      const fiber = ctx.plugin(zotero, { localApiBaseUrl: fake.url })
      await fiber
      const services = serviceSwitch(ctx)
      const tools = stubTools()
      await services.provide('tools', tools)
      await services.provide('approval', fakeApproval('allowed-once'))
      await waitFor(() => (tools.names().length === REGISTERED_TOOL_NAMES.length ? tools : undefined), 'tool registration')
      const session = mountedSession(fiber.ctx)
      expect(session).toBeDefined()
      const authorize = () => tools.get('authorize_writes')!.execute({}, { agent: { id: 'agent-1' } })

      const credentials = fakeCredentials()
      await services.provide('credentials', credentials)
      await untilWriteApproved(authorize, 'with late credentials attached')
      // Zotero's remembered key landed in the OFFICIAL credential record — the
      // late-bound durable KeyStore is live inside the client built before it.
      expect(credentials.writes).toHaveLength(1)
      expect(credentials.writes[0]!.key).toMatch(/^zotero\/server-[0-9a-f]{16}$/)
      expect(credentials.deletions).toHaveLength(0)

      // The credentials service cycles away → the client falls back to the
      // in-memory store (fresh auth, no durable write, no record deletion).
      await services.revoke('credentials')
      await waitFor(() => (session!.status.auth !== 'remembered' ? session : undefined), 'client rebuilt after credentials unbind')
      await untilWriteApproved(authorize, 'after credentials unbind (in-memory fallback)')
      expect(credentials.writes).toHaveLength(1)
      expect(credentials.deletions).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })

  it('late fs/workingDirectory mount the real workspace export; cycling degrades to text-only', async () => {
    const fake = await startFakeZotero()
    try {
      const ctx = new Context()
      const fiber = ctx.plugin(zotero, { localApiBaseUrl: fake.url })
      await fiber
      const services = serviceSwitch(ctx)
      const tools = stubTools()
      await services.provide('tools', tools)
      await services.provide('approval', fakeApproval('allowed-once'))
      await waitFor(() => (tools.names().length === REGISTERED_TOOL_NAMES.length ? tools : undefined), 'tool registration')
      const session = mountedSession(fiber.ctx)
      expect(session).toBeDefined()
      const keys = [...fake.state.items.keys()].slice(0, 2)
      expect(keys.length).toBeGreaterThanOrEqual(1)
      const exportBib = (path?: string) =>
        tools.get('export_bib')!.execute(
          { keys, ...(path !== undefined ? { path } : {}) },
          { agent: { id: 'agent-1' } },
        )

      // Before fs/workingDirectory exist: export_bib with a path degrades.
      await expect(exportBib('references.bib')).rejects.toMatchObject({ code: 'invalid_input' })

      // The official pair arrives → the same registered tool writes for real.
      const workspace = fakeWorkspace()
      await services.provide('fs', workspace.fs)
      await services.provide('workingDirectory', workspace.workingDirectory)
      const deadline = Date.now() + 1000
      let written: { path: string; content: string } | undefined
      while (Date.now() < deadline) {
        try {
          await exportBib('references.bib')
          written = workspace.writes.at(-1)
          if (written !== undefined) break
        } catch {
          // workspace pair not attached yet — retry within the settle window
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(written).toBeDefined()
      expect(written!.path).toBe(`${'/tmp/dsh-zotero-host-mount-workspace'}/references.bib`)
      expect(written!.content).toContain('@')

      // The pair cycles away → text-only degrade again; cycling back recovers.
      await services.revoke('fs')
      await services.revoke('workingDirectory')
      await waitFor(() => (session!.canWriteWorkspace() ? undefined : session), 'workspace capability detached')
      await expect(exportBib('references.bib')).rejects.toMatchObject({ code: 'invalid_input' })
      const writesBefore = workspace.writes.length
      await services.provide('fs', workspace.fs)
      await services.provide('workingDirectory', workspace.workingDirectory)
      await waitFor(() => (session!.canWriteWorkspace() ? session : undefined), 'workspace capability recovered')
      await exportBib('after-recovery.bib')
      expect(workspace.writes.length).toBe(writesBefore + 1)
      expect(workspace.writes.at(-1)!.path).toContain('after-recovery.bib')
    } finally {
      await fake.close()
    }
  })
})
