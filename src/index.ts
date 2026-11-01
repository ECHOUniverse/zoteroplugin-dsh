/**
 * `@hanxu131/dsh-zotero` — Zotero 文库接入 DSH 的独立插件（宿主半）。
 *
 * 装配契约（apply）：
 *
 * 1. 构建 `ZoteroSession` 门面：`ZoteroLocalClient`（key 的唯一持有者）+
 *    `ZoteroLibrary` + `ZoteroWrites` + 事件 hub。`localApiBaseUrl` 是 live
 *    volatile 引用，改动后按需安全重建（见 host/session.ts）；客户端半无法
 *    注入任意 Zotero URL——非 loopback 地址在构造时即被拒绝。
 * 2. 组合服务通过 Cordis 的官方晚绑定 effect 挂载（`ctx.inject(deps, cb)`，
 *    官方 `dsh-client-modules` 对 `/plugins` 路由的同款形态；必需组合见
 *    `dsh-host-open-in-app` 的 `inject = ["webServer", "connection", …]`）。
 *    Cordis 只把服务暴露进声明了它的 fiber——组合插件是兄弟 fiber，`inject`
 *    为空的插件在 apply 期读兄弟服务会直接抛
 *    `cannot get property "webServer" without inject`（真实 Desktop
 *    0.2.1-rc.5 实测：宿主半 fiber 失败，`/dsh-zotero/*` 全部 404，而同以
 *    webServer 服务的 client bundle 正常装载）。因此：
 *    - `['webServer', 'connection']` → `/dsh-zotero` 路由表（与 open-in-app
 *      相同的必需对；无认证栅栏的 webServer 不构成可用的路由通道）；
 *    - `['tools']` → Agent 工具（approval 不在此 effect 内，见第 5 条）。
 *    服务永不出现的 profile 上回调不执行、插件保持已激活——不拖垮 profile。
 * 3. 文库路由全部经官方 `ctx.connection.requestRejection` 认证与信任门
 *    （已认证浏览器或 API Peer；Host/Origin/Sec-Fetch-Site 防护在门内）。
 *    `health` 最小公开，仅返回插件标识，不含文库数据。
 * 4. Zotero key 经官方 credentials durable per-plugin record 持久化的设计见
 *    `host/services.ts`；会话能力全部晚绑定：`['credentials']`（持久
 *    KeyStore 生效，client 按需安全重建；解绑回内存且不外带 key）、
 *    `['fs', 'workingDirectory']`（export_bib 真实落盘；解绑回纯文本）。
 * 5. approval 不参与工具注册：工具按 `['tools']` 注册一次，approval 经
 *    独立 effect 写入执行期引用，写工具每次执行时读取——晚到即被采用，
 *    缺失/解绑仍 fail-closed。每个 effect 都返回自己的 disposer，服务
 *    cycle 时由 cordis 卸载重挂，不重复注册。
 *
 * 不声明必需插件级 `inject`：缺失服务时插件保持可激活（功能降级），契约由
 * 上面的 per-capability effect 表达。
 *
 * Named exports are required so the Cordis loader retains `inject` and `Config`.
 *
 * @module @hanxu131/dsh-zotero
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PLUGIN_NAME, PLUGIN_VERSION, ROUTE_BASE, ROUTES, type HealthResponse, type StatusResponse } from './shared/protocol.ts'
import { registerRoutes } from './host/routes.ts'
import { ZoteroSession } from './host/session.ts'
import { servicesOf, type ApprovalFace, type ConnectionFace, type CredentialsFace, type FsFace, type HostServices, type ToolsFace, type WebServerFace, type WorkingDirectoryFace } from './host/services.ts'
import { registerTools } from './tools/index.ts'

/** Bundle id inside a profile composition; the client half keys its UI by it. */
export const name = 'zotero'

/**
 * No required host services: every composition service is consumed through a
 * per-capability `ctx.inject(deps, callback)` effect (see the module header),
 * so the bundle also activates — degraded but healthy — on profiles that lack
 * any of them.
 */
export const inject = [] as const

/**
 * Parsed plugin configuration. The single field is a live `Volatile` reference
 * so a settings-form save takes effect without reloading the plugin.
 */
export interface Config {
  /** Root address of the Zotero desktop local API. */
  localApiBaseUrl: Volatile<string>
}

/** Default Zotero local API address (loopback, standard port). */
export const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:23119'

/** Runtime configuration schema; top-level scalars only (settings-form constraint). */
export const Config = z.object({
  localApiBaseUrl: z.string().default(DEFAULT_LOCAL_API_BASE_URL).volatile(),
})

/**
 * Read one composition service off a Cordis context. Callers must guarantee
 * availability (inside a `ctx.inject` callback whose deps include the name) —
 * Cordis throws when no fiber in the ancestor chain declared and received it.
 */
function serviceOf<T>(ctx: unknown, name: string): T {
  const value: unknown = Reflect.get(ctx as Record<string, unknown>, name)
  if (value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Error(`composition service "${name}" is not readable from this fiber`)
  }
  return value as T
}

/**
 * Diagnostics seam: the `ZoteroSession` mounted by `apply` on the plugin
 * fiber's context (`mountedSession(fiber.ctx)`). The session itself never
 * holds key material — the client is the only owner and never exposes it —
 * so this leaks no credentials; it exists for status probes, tests and the
 * smoke script. Production code goes through routes/tools instead.
 */
const mountedSessions = new WeakMap<object, ZoteroSession>()

/** The session `apply` mounted for this plugin fiber, if it is mounted. */
export function mountedSession(ctx: object): ZoteroSession | undefined {
  return mountedSessions.get(ctx)
}

/**
 * Assemble the host half against EXPLICIT services: build the session facade,
 * register the protected route table and the Agent tools, and return the
 * combined disposer. This is the eager seam for tests and the smoke script,
 * which construct every service themselves and pass it in — never call it
 * from `apply` with the default lookup: sibling composition services are not
 * readable from an `inject: []` plugin fiber (module header).
 */
export function createRuntime(ctx: unknown, config: Config, services: HostServices = servicesOf(ctx)): { session: ZoteroSession; dispose: () => void } {
  const session = new ZoteroSession({
    baseUrl: config.localApiBaseUrl,
    ...(services.credentials !== undefined ? { credentials: services.credentials } : {}),
    // Official workspace-file services (export_bib .bib writes): present in
    // desktop profiles; absent elsewhere → export_bib degrades to text-only.
    ...(services.fs !== undefined ? { fs: services.fs } : {}),
    ...(services.workingDirectory !== undefined ? { workingDirectory: services.workingDirectory } : {}),
  })
  const cleanups: (() => void)[] = []
  if (services.webServer !== undefined) {
    cleanups.push(registerRoutes(services.webServer, { session, ...(services.connection !== undefined ? { connection: services.connection } : {}) }))
  }
  if (services.tools !== undefined) {
    cleanups.push(registerTools(services.tools, { session, ...(services.approval !== undefined ? { approval: services.approval } : {}) }))
  }
  return {
    session,
    dispose: () => {
      for (const cleanup of cleanups.reverse()) cleanup()
      session.dispose()
    },
  }
}

/**
 * Mount the host half.
 *
 * No composition service is read at apply time. Each capability mounts through
 * the official `ctx.inject(deps, callback)` effect — Cordis starts the callback
 * once (and only once) its deps are active, re-runs it if they cycle, and
 * disposes the child fibers with this plugin. Every callback RETURNS its
 * disposer, so a service cycle tears down exactly that effect's registration
 * before re-running (no duplicate routes/tools); the plugin-level effect only
 * owns the session teardown.
 *
 * @param ctx - host plugin context.
 * @param config - validated configuration: live volatile references.
 */
export function apply(ctx: Context, config: Config): void {
  const session = new ZoteroSession({ baseUrl: config.localApiBaseUrl })
  mountedSessions.set(ctx, session)

  // Execution-time approval reference: write tools read it on every call, so
  // the approval service may activate before or after the tools fiber.
  const approvalRef: { current: HostServices['approval'] } = { current: undefined }

  // Route carrier — the same required pair `dsh-host-open-in-app` declares:
  // routes are the authenticated browser/API channel, and a webServer without
  // the official connection fence is not one.
  ctx.inject(['webServer', 'connection'], (svcCtx) =>
    registerRoutes(serviceOf<WebServerFace>(svcCtx, 'webServer'), {
      session,
      connection: serviceOf<ConnectionFace>(svcCtx, 'connection'),
    }),
  )

  // Agent tools — registered once per tools-service availability; approval
  // joins through the execution-time reference above (never re-registers).
  ctx.inject(['tools'], (svcCtx) =>
    registerTools(serviceOf<ToolsFace>(svcCtx, 'tools'), { session, approval: () => approvalRef.current }),
  )

  // Write approval — its own effect so the late-arriving (or cycled) service
  // is adopted/unbound independently of tool registration.
  ctx.inject(['approval'], (svcCtx) => {
    approvalRef.current = serviceOf<ApprovalFace>(svcCtx, 'approval')
    return () => {
      approvalRef.current = undefined
    }
  })

  // Durable Zotero keys — attaching rebuilds the client onto the official
  // credential records (durable KeyStore); cycling falls back to in-memory.
  ctx.inject(['credentials'], (svcCtx) => {
    session.attachServices({ credentials: serviceOf<CredentialsFace>(svcCtx, 'credentials') })
    return () => session.detachServices(['credentials'])
  })

  // Workspace-file write pair for export_bib — mounted together (the write
  // path needs both); absent or cycled → export_bib degrades to text-only.
  ctx.inject(['fs', 'workingDirectory'], (svcCtx) => {
    session.attachServices({
      fs: serviceOf<FsFace>(svcCtx, 'fs'),
      workingDirectory: serviceOf<WorkingDirectoryFace>(svcCtx, 'workingDirectory'),
    })
    return () => session.detachServices(['fs', 'workingDirectory'])
  })

  // 没有可注册的服务时也要留一个 effect，保证 dispose 语义统一（释放 session）；
  // 上面各 effect 的 disposer 由 cordis 在服务 cycle / 插件卸载时自行清理。
  ctx.effect(
    () => () => session.dispose(),
    'zotero: session + late-mounted routes/tools',
  )
}

// Re-exported for the smoke script and tests: the route table shape the
// client half and reviewers rely on.
export { ROUTE_BASE, ROUTES, PLUGIN_NAME, PLUGIN_VERSION, registerRoutes, type HealthResponse, type StatusResponse }
