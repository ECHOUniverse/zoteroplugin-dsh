/**
 * Workspace writes (M7) and the local-path mode of `attach_pdf`:
 *
 * - `ZoteroSession.writeWorkspaceFile` against a fake official `ctx.fs` +
 *   `ctx.workingDirectory` face: relative-.bib-only, `..`/absolute rejected,
 *   realpath-escape (symlink) rejected against the workspace root, default
 *   no-overwrite via the backend `createIfAbsent` guard, fail-closed without
 *   the services;
 * - the `export_bib` tool with `path`: DSH approval first, then the write;
 *   without `path` it returns text and never asks;
 * - `attach_pdf` path mode: an explicit controlled source that is only read
 *   after the approved ask, with the %PDF- check and bare-filename rule.
 *
 * Everything is faked: the fake fs never touches a real workspace and the
 * attach tests read only files the test wrote into its own tmp directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZoteroSession, isInside } from '../src/host/session.ts'
import type { FsFace, FsTarget, WorkingDirectoryFace, ApprovalFace } from '../src/host/services.ts'
import { buildToolDefinitions } from '../src/tools/index.ts'
import type { ToolDefinition } from '../src/tools/define-tool.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'
import { sampleTwoPage } from './helpers/make-pdf.ts'

// ---------------------------------------------------------------------------
// fake official services
// ---------------------------------------------------------------------------

interface FsCalls {
  resolve: { path: string; cwd?: string }[]
  write: { target: FsTarget; content: string; expected: unknown }[]
}

/**
 * Fake of the official fs face: resolve joins against the cwd like the real
 * backend's local backend; `escapeTo` simulates a symlink/parent escape by
 * resolving into a foreign directory.
 */
function fakeFs(options: { cwdForeign?: string; escapeTo?: string; exists?: Set<string>; writeError?: Error & { code?: string } } = {}): FsFace & { calls: FsCalls } {
  const calls: FsCalls = { resolve: [], write: [] }
  return {
    calls,
    async resolve(path, opts) {
      calls.resolve.push({ path, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) })
      const cwd = opts?.cwd ?? options.cwdForeign ?? '/ws'
      const displayPath = options.escapeTo !== undefined ? join(options.escapeTo, path) : join(cwd, path)
      return { targetKey: displayPath, displayPath }
    },
    async writeText(target, content, expected) {
      calls.write.push({ target, content, expected })
      if (options.writeError !== undefined) throw options.writeError
      if (expected !== undefined && 'kind' in expected && expected.kind === 'createIfAbsent' && options.exists?.has(target.displayPath)) {
        throw Object.assign(new Error('exists'), { code: 'FS_NOT_OBSERVED' })
      }
      return { operation: expected === undefined ? 'update' : 'create' }
    },
  }
}

function fakeWorkingDir(cwd: string | undefined): WorkingDirectoryFace & { agents: unknown[] } {
  const agents: unknown[] = []
  return {
    get agents() {
      return agents
    },
    async ensure(agent) {
      agents.push(agent)
      return cwd
    },
  }
}

function fakeApproval(outcome: 'allowed-once' | 'rejected'): ApprovalFace & { asks: { toolName: string; reason?: string }[] } {
  const asks: { toolName: string; reason?: string }[] = []
  return {
    get asks() {
      return asks
    },
    async request(req) {
      asks.push({ toolName: req.toolName, ...(req.reason !== undefined ? { reason: req.reason } : {}) })
      return outcome
    },
  }
}

const AGENT = { id: 'agent-under-test' } as unknown
const exec = () => ({ agent: AGENT, callId: 'call-1' })

describe('ZoteroSession.writeWorkspaceFile (official fs/workingDirectory faces)', () => {
  const CWD = '/Users/tester/workspace'
  const base = (fs: FsFace, wd: WorkingDirectoryFace) => ({ baseUrl: { get: () => 'http://127.0.0.1:23119' }, fs, workingDirectory: wd })

  it('resolves a relative .bib path against the working directory and creates it', async () => {
    const fs = fakeFs()
    const wd = fakeWorkingDir(CWD)
    const session = new ZoteroSession(base(fs, wd))
    const result = await session.writeWorkspaceFile({ path: 'refs/bibliography.bib', content: '@article{x,}', agent: AGENT })
    expect(result).toEqual({ displayPath: join(CWD, 'refs/bibliography.bib'), operation: 'create' })
    // The backend receives the normalized relative path + the session cwd
    // (never process.cwd, never an absolute caller path).
    expect(fs.calls.resolve).toEqual([{ path: 'refs/bibliography.bib', cwd: CWD }])
    expect(wd.agents).toEqual([AGENT])
    expect(fs.calls.write[0]?.expected).toEqual({ kind: 'createIfAbsent' }) // default: never overwrite
    expect(fs.calls.write[0]?.content).toBe('@article{x,}')
    await session.dispose()
  })

  it('normalizes backslashes before resolve and passes the backend contract through', async () => {
    const fs = fakeFs()
    const session = new ZoteroSession(base(fs, fakeWorkingDir(CWD)))
    await session.writeWorkspaceFile({ path: 'sub\\refs.bib', content: 'x', overwrite: true })
    expect(fs.calls.resolve[0]?.path).toBe('sub/refs.bib')
    expect(fs.calls.write[0]?.expected).toBeUndefined() // overwrite: true → plain atomic write
    await session.dispose()
  })

  it('rejects absolute paths (POSIX and drive-letter) as path_outside_workspace', async () => {
    const session = new ZoteroSession(base(fakeFs(), fakeWorkingDir(CWD)))
    for (const bad of ['/etc/passwd.bib', 'C:\\temp\\x.bib', 'C:/temp/x.bib']) {
      await expect(session.writeWorkspaceFile({ path: bad, content: 'x' })).rejects.toMatchObject({ code: 'path_outside_workspace' })
    }
    await session.dispose()
  })

  it('rejects ".." segments anywhere in the path', async () => {
    const session = new ZoteroSession(base(fakeFs(), fakeWorkingDir(CWD)))
    for (const bad of ['../escape.bib', 'a/../../escape.bib', 'sub/..\\..\\escape.bib']) {
      await expect(session.writeWorkspaceFile({ path: bad, content: 'x' })).rejects.toMatchObject({ code: 'path_outside_workspace' })
    }
    await session.dispose()
  })

  it('rejects a resolved display path outside the workspace root (symlink/realpath escape)', async () => {
    // The backend resolved through realpaths and landed outside the root —
    // exactly what a symlink planted inside the workspace does.
    const fs = fakeFs({ escapeTo: '/Users/tester/other-project' })
    const session = new ZoteroSession(base(fs, fakeWorkingDir(CWD)))
    await expect(session.writeWorkspaceFile({ path: 'link.bib', content: 'x' })).rejects.toMatchObject({ code: 'path_outside_workspace' })
    expect(fs.calls.write).toEqual([]) // refused before any write
    await session.dispose()
  })

  it('requires a .bib name and a sane path', async () => {
    const session = new ZoteroSession(base(fakeFs(), fakeWorkingDir(CWD)))
    await expect(session.writeWorkspaceFile({ path: 'notes.txt', content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(session.writeWorkspaceFile({ path: '', content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(session.writeWorkspaceFile({ path: '   ', content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(session.writeWorkspaceFile({ path: `${'x'.repeat(520)}.bib`, content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await session.dispose()
  })

  it('fails closed without the official services and without a session cwd', async () => {
    const noServices = new ZoteroSession({ baseUrl: { get: () => 'http://127.0.0.1:23119' } })
    await expect(noServices.writeWorkspaceFile({ path: 'x.bib', content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    const noCwd = new ZoteroSession(base(fakeFs(), fakeWorkingDir(undefined)))
    await expect(noCwd.writeWorkspaceFile({ path: 'x.bib', content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await noServices.dispose()
    await noCwd.dispose()
  })

  it('maps the backend guards: existing file → ask for overwrite; missing backend path → invalid_input', async () => {
    const existing = fakeFs({ exists: new Set([join(CWD, 'refs.bib')]) })
    const session = new ZoteroSession(base(existing, fakeWorkingDir(CWD)))
    await expect(session.writeWorkspaceFile({ path: 'refs.bib', content: 'x' })).rejects.toThrowError(/overwrite: true/)
    await expect(session.writeWorkspaceFile({ path: 'refs.bib', content: 'x', overwrite: true })).resolves.toMatchObject({ operation: 'update' })
    const missing = fakeFs({ writeError: Object.assign(new Error('gone'), { code: 'FS_NOT_FOUND' }) })
    const session2 = new ZoteroSession(base(missing, fakeWorkingDir(CWD)))
    await expect(session2.writeWorkspaceFile({ path: 'refs.bib', content: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await session.dispose()
    await session2.dispose()
  })

  it('keeps isInside as the escape oracle (root itself allowed, siblings and parents not)', () => {
    expect(isInside(CWD, CWD)).toBe(true)
    expect(isInside(CWD, join(CWD, 'a.bib'))).toBe(true)
    expect(isInside(CWD, '/Users/tester/other')).toBe(false)
    expect(isInside(CWD, '/Users/tester/workspace-twin/a.bib')).toBe(false)
    expect(isInside(CWD, '/ws/a.bib')).toBe(false)
  })
})

/** Minimal fetch impl so the session's client talks to the fake Zotero server. */

describe('export_bib with a workspace path (approval → write)', () => {
  let fake: FakeZotero
  let pdfDir: string
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
    pdfDir = await mkdtemp(join(tmpdir(), 'dsh-attach-'))
  })
  afterAll(async () => {
    await fake.close()
  })

  function mounted(approval: ApprovalFace, fs: FsFace, wd: WorkingDirectoryFace) {
    const session = new ZoteroSession({
      baseUrl: { get: () => fake.url },
      fs,
      workingDirectory: wd,
    })
    const tools = new Map(buildToolDefinitions({ session, approval }).map((definition) => [definition.name, definition] as const)) as Map<string, ToolDefinition>
    return { session, tools }
  }

  it('without path: returns the text (paths stripped), never asks for approval', async () => {
    const approval = fakeApproval('rejected') // would fail any ask
    const fs = fakeFs()
    const { session, tools } = mounted(approval, fs, fakeWorkingDir(undefined))
    const result = (await tools.get('export_bib')!.execute({ keys: ['PAPERAAA'] }, exec())) as { format: string; text: string; path?: string; operation: string | null; citeKeys: string[] }
    expect(result.format).toBe('bibtex')
    expect(result.text).toContain('@article{PAPERAAA')
    expect(result.text).not.toContain('/storage/') // Zotero's local file paths are stripped
    expect(result.operation).toBeNull()
    expect(result.path).toBeUndefined()
    expect(result.citeKeys).toContain('PAPERAAA')
    expect(approval.asks).toEqual([]) // a text export is a read
    expect(fs.calls.write).toEqual([])
    await session.dispose()
  })

  it('with path and a rejected approval: the backend write never happens', async () => {
    const approval = fakeApproval('rejected')
    const fs = fakeFs()
    const { session, tools } = mounted(approval, fs, fakeWorkingDir('/ws'))
    await expect(tools.get('export_bib')!.execute({ keys: ['PAPERAAA'], path: 'refs.bib' }, exec())).rejects.toMatchObject({ code: 'write_denied' })
    expect(approval.asks).toHaveLength(1)
    expect(approval.asks[0]?.reason).toContain('refs.bib')
    expect(fs.calls.write).toEqual([])
    await session.dispose()
  })

  it('with path and approval: writes through the official faces and reports the operation', async () => {
    const approval = fakeApproval('allowed-once')
    const fs = fakeFs()
    const wd = fakeWorkingDir('/ws')
    const { session, tools } = mounted(approval, fs, wd)
    const result = (await tools.get('export_bib')!.execute({ keys: ['PAPERAAA'], path: 'sub/refs.bib' }, exec())) as { path: string; operation: string; citeKeys: string[] }
    expect(result.path).toBe('sub/refs.bib')
    expect(result.operation).toBe('create')
    expect(fs.calls.write).toHaveLength(1)
    expect(fs.calls.write[0]?.expected).toEqual({ kind: 'createIfAbsent' })
    expect(fs.calls.write[0]?.content).toContain('@article{PAPERAAA')
    expect(fs.calls.write[0]?.content).not.toContain('/storage/')
    expect(wd.agents).toEqual([AGENT])
    const render = tools.get('export_bib')!.output.render({}, result)[0]
    expect(render).toMatchObject({ type: 'text' })
    await session.dispose()
  })

  it('an existing workspace file is refused unless overwrite is true (backend guard)', async () => {
    const approval = fakeApproval('allowed-once')
    const fs = fakeFs({ exists: new Set(['/ws/refs.bib']) })
    const { session, tools } = mounted(approval, fs, fakeWorkingDir('/ws'))
    await expect(tools.get('export_bib')!.execute({ keys: ['PAPERAAA'], path: 'refs.bib' }, exec())).rejects.toThrowError(/overwrite/)
    await expect(tools.get('export_bib')!.execute({ keys: ['PAPERAAA'], path: 'refs.bib', overwrite: true }, exec())).resolves.toMatchObject({ operation: 'update' })
    await session.dispose()
  })

  it('declares per-args concurrency: text-only safe, workspace write exclusive', () => {
    const { session } = mounted(fakeApproval('rejected'), fakeFs(), fakeWorkingDir('/ws'))
    const definition = buildToolDefinitions({ session }).find((entry) => entry.name === 'export_bib')!
    expect(definition.isConcurrencySafe?.({})).toBe(true)
    expect(definition.isConcurrencySafe?.({ path: 'x.bib' })).toBe(false)
    void session.dispose()
  })
})

// ---------------------------------------------------------------------------
// attach_pdf path mode (controlled local source)
// ---------------------------------------------------------------------------

describe('attach_pdf path mode (approval first, controlled read)', () => {
  let fake: FakeZotero
  let dir: string
  let pdfPath: string
  let textPath: string
  beforeAll(async () => {
    fake = await startFakeZotero({ authorize: 'always' })
    dir = await mkdtemp(join(tmpdir(), 'dsh-attach-path-'))
    pdfPath = join(dir, 'real-paper.pdf')
    textPath = join(dir, 'not-a-pdf.pdf')
    await writeFile(pdfPath, sampleTwoPage())
    await writeFile(textPath, 'definitely not a pdf')
  })
  afterAll(async () => {
    await fake.close()
  })

  function mounted(approval: ApprovalFace) {
    const session = new ZoteroSession({ baseUrl: { get: () => fake.url } })
    const tools = new Map(buildToolDefinitions({ session, approval }).map((definition) => [definition.name, definition] as const)) as Map<string, ToolDefinition>
    return { session, tools }
  }

  it('a declined approval means the file is never read and nothing is attached', async () => {
    const approval = fakeApproval('rejected')
    const { session, tools } = mounted(approval)
    const before = fake.state.items.size
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', path: pdfPath }, exec())).rejects.toMatchObject({ code: 'write_denied' })
    expect(approval.asks).toHaveLength(1)
    expect(fake.state.items.size).toBe(before)
    await session.dispose()
  })

  it('after approval: attaches a real local PDF, defaulting the filename to the basename', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = mounted(approval)
    const result = (await tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', path: pdfPath }, exec())) as { key: string }
    const attachment = fake.state.items.get(result.key)
    expect(attachment?.data.filename).toBe('real-paper.pdf')
    expect(attachment?.data.contentType).toBe('application/pdf')
    expect(fake.state.files.get(result.key)).toBeDefined()
    await session.dispose()
  })

  it('refuses non-PDF bytes, directories and path-bearing filenames', async () => {
    const approval = fakeApproval('allowed-once')
    const { session, tools } = mounted(approval)
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', path: textPath }, exec())).rejects.toMatchObject({ code: 'not_pdf' })
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', path: dir }, exec())).rejects.toMatchObject({ code: 'file_missing' })
    await expect(
      tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', bytesBase64: Buffer.from('%PDF-1.4 x').toString('base64'), filename: '../evil.pdf' }, exec()),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', bytesBase64: Buffer.from('%PDF-1.4 x').toString('base64'), filename: 'a/b.pdf' }, exec()),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    // Exactly one source at a time.
    await expect(tools.get('attach_pdf')!.execute({ item: 'PAPERAAA', path: pdfPath, url: 'https://x.example/a.pdf' }, exec())).rejects.toThrowError(/exactly one/)
    await session.dispose()
  })
})
