/**
 * Structural faces of the DSH host services this plugin consumes, typed
 * locally instead of imported.
 *
 * Rationale (documented deviation): the official 0.2.1-rc.2 packages are
 * distributed inside the DSH runtime (`@deepseek-ai/dsh` install tree) and
 * are not resolvable from a third-party plugin directory; the npm registry
 * only carries stale 0.0.1-rc.1 versions. The official host plugin
 * `dsh-host-open-in-app` uses the same pattern — its `connectionOf(ctx)`
 * helper reads the service defensively and types it locally ("The
 * composition's connection service (typed locally: its package is
 * browser-side)"). The runtime registration points remain the official ones:
 * `ctx.webServer.register`, `ctx.connection.requestRejection`,
 * `ctx.credentials.readRecord/modifyRecord/deleteRecord`,
 * `ctx.tools.register`, `ctx.approval.request`.
 *
 * Consumption contract (real-mount 0.2.1-rc.5 lesson): composition services
 * live in sibling Cordis fibers and are only readable from a fiber that
 * declared them. `apply` therefore consumes everything through per-capability
 * `ctx.inject(deps, callback)` effects (`src/index.ts`); `servicesOf(ctx)` is
 * the eager snapshot seam for `createRuntime` (tests/smoke), which must be
 * called with EXPLICIT services — its default lookup throws on a real
 * composition context.
 *
 * @module @hanxu131/dsh-zotero/host/services
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Minimal `register` face of `@deepseek-ai/dsh-host-webserver` (`WebServer.register`). */
export interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Request headers as the official fence reads them (`ConnectionTrustRequest`):
 * `node:http` headers are accepted as-is.
 */
export interface TrustHeaders {
  readonly headers: IncomingMessage['headers'] | Record<string, string | string[] | undefined>
}

/**
 * Minimal trust/authentication face of `@deepseek-ai/dsh-client-connection`
 * (`HostConnectionHandle.requestRejection`). Returns the HTTP status that
 * refuses the request (401 unauthenticated, 403 untrusted — including
 * `sec-fetch-site: cross-site` and cross-origin `Origin`), or `undefined`
 * when the request may proceed. This is the official guard for custom
 * webServer routes; it defeats DNS rebinding and cross-site browser calls.
 */
export interface ConnectionFace {
  requestRejection(request: TrustHeaders): 401 | 403 | undefined
}

/**
 * Durable record face of `@deepseek-ai/dsh-credentials`
 * (`CredentialProvider`). Keys are `<scope>/<id>` strings whose segments
 * match `^[a-z][a-z0-9-]*$`; records are `{kind:'grant', payload}` where the
 * payload is owner-defined JSON persisted by the local provider in
 * `$DSH_HOME/.credentials.yaml` with owner-only file permissions.
 */
export interface CredentialRecord {
  readonly kind: 'api-key' | 'grant'
  readonly key?: string
  readonly env?: Readonly<Record<string, string>>
  readonly payload?: unknown
}

export interface CredentialsFace {
  readRecord(key: string): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord(key: string): Promise<void>
}

/**
 * Canonical credential record address for a Zotero server id. The id segment
 * must satisfy the official `^[a-z][a-z0-9-]*$` grammar, so the server id is
 * fingerprinted (sha-256 prefix) instead of used verbatim; the payload
 * carries the original server id and is verified on load.
 */
export function zoteroCredentialKey(serverId: string): string {
  return `zotero/server-${serverIdFingerprint(serverId)}`
}

/** Fingerprint of a server id that satisfies the credential key grammar. */
export function serverIdFingerprint(serverId: string): string {
  return sha256Hex(serverId).slice(0, 16)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Minimal registration face of `@deepseek-ai/dsh-tools`
 * (`ToolRuntime.register`). Definitions follow the official
 * `ToolDefinition` shape: compiled JSON Schema parameters/output plus
 * `execute`/`render`.
 */
export interface ToolsFace {
  register(definition: Record<string, unknown>): () => void
}

/** Approval outcome vocabulary of `@deepseek-ai/dsh-user-approval`. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Minimal request face of `@deepseek-ai/dsh-user-approval`
 * (`ApprovalService.request`). Only `'allowed-once'` grants; every other
 * outcome (and a missing service, or a missing agent) fails closed.
 */
export interface ApprovalFace {
  request(req: {
    agent?: unknown
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * Filesystem service face (`@deepseek-ai/dsh-fs`, `ctx.fs`) — the OFFICIAL
 * workspace-file API (verified field-by-field against the types of the
 * locally installed 0.2.1-rc.2 package: `resolve` at index.d.ts:94,
 * `FsTarget.targetKey/displayPath` at types.d.ts:54/59, `writeText` at
 * index.d.ts:221, `FsWriteIntent {kind:'createIfAbsent'}` at types.d.ts:112
 * with "rejects an existing target", and `FsWriteOutcome.operation` at
 * types.d.ts:120; the official `dsh-tool-fs/session-cwd` shows the intended
 * driving pattern — a working-directory service supplies `cwd`, the tool
 * supplies `agent`/`signal`): `resolve(path, {cwd, signal})` returns the
 * target with a realpath-derived stable key and a display path (missing
 * files resolve against the nearest existing ancestor, so symlink/
 * parent-escape checks are the backend's own semantics), and
 * `writeText(target, content, expected, signal)` performs the atomic write;
 * the `expected` guard `{kind: 'createIfAbsent'}` makes "never overwrite"
 * the backend-enforced contract (`FS_NOT_OBSERVED` on an existing file).
 */
export interface FsTarget {
  /** Backend identity (local backend: the realpath). */
  targetKey: string
  /** Resolved absolute path in the backend's execution world. */
  displayPath: string
}

export type FsWriteExpectation = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string } | undefined

export interface FsFace {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<{ type: string; version?: string } | undefined>
  writeText(target: FsTarget, content: string, expected?: FsWriteExpectation, signal?: AbortSignal): Promise<{ operation: 'create' | 'update' }>
}

/**
 * Working-directory service face (`ctx.workingDirectory`): the session's
 * current directory — the workspace root export_bib resolves relative paths
 * against. Agent-less calls have no directory (`undefined`). Documented
 * deviation: the exact service package is not among the locally installed
 * `@deepseek-ai` packages (no `dsh-tool-working-directory` on disk), but the
 * official `dsh-tool-fs/session-cwd` declares the concept ("context
 * containing the working-directory service") and this face is consumed
 * defensively (`servicesOf`) with a fail-closed `undefined` path, so a
 * shape mismatch degrades to text-only export instead of a wrong write.
 */
export interface WorkingDirectoryFace {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string | undefined>
}

/** A Cordis context as this plugin reads it: services looked up defensively. */
export interface HostServices {
  webServer?: WebServerFace
  connection?: ConnectionFace
  credentials?: CredentialsFace
  tools?: ToolsFace
  approval?: ApprovalFace
  fs?: FsFace
  workingDirectory?: WorkingDirectoryFace
}

/** Read the plugin-facing services off a Cordis host context, defensively. */
export function servicesOf(ctx: unknown): HostServices {
  const source = ctx as Record<string, unknown>
  const face = <T>(name: string): T | undefined => {
    const value = Reflect.get(source, name)
    return (value !== null && typeof value === 'object') || typeof value === 'function' ? (value as T) : undefined
  }
  return {
    webServer: face<WebServerFace>('webServer'),
    connection: face<ConnectionFace>('connection'),
    credentials: face<CredentialsFace>('credentials'),
    tools: face<ToolsFace>('tools'),
    approval: face<ApprovalFace>('approval'),
    fs: face<FsFace>('fs'),
    workingDirectory: face<WorkingDirectoryFace>('workingDirectory'),
  }
}
