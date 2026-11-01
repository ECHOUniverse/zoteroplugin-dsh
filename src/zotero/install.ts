/**
 * Desktop install probe + launch (M7): is the Zotero desktop app installed,
 * where, and which version — plus "open Zotero" for the Setup view.
 *
 * - Candidates per platform: macOS `.app` bundles, the common Windows install
 *   locations, Linux package/flatpak paths and — Linux only — `zotero` on the
 *   `PATH`. The version is read from the bundle (`Info.plist` on macOS,
 *   `application.ini` next to the executable elsewhere) and is **never**
 *   guessed from a path: an unreadable version is simply absent.
 * - Detection is purely filesystem/exec read work; launching spawns a fixed,
 *   platform-whitelisted command (`/usr/bin/open -a` on macOS, the resolved
 *   executable directly on Windows/Linux, `flatpak run` for flatpak installs)
 *   with an argument array — never a shell, never a client-provided command.
 * - Everything is injectable (`exists`, `readText`, `spawn`) so tests run the
 *   real logic without touching the host machine.
 *
 * Attribution: candidate layout, version reads and the detached-spawn launch
 * shape are adapted from zai-org/zcode-plugins `ui-plugins/zotero`
 * `src/zotero/install.ts` (repo LICENSE: Apache-2.0). Modifications: injectable
 * filesystem/proc seams instead of module-level tests via the real `$HOME`,
 * and `launch` returns the exact command that was spawned so the host can log
 * it. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/zotero/install
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ZoteroError, type ZoteroInstall } from '../domain/model.ts'

/** Injectable seams (tests fake these; production uses the real host). */
export interface InstallOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  /** Path existence probe; default `fs/stat`. */
  exists?: (path: string) => Promise<boolean>
  /** Text file reader; default `fs/promises.readFile(…, 'utf8')`. */
  readText?: (path: string) => Promise<string>
  /** Executability probe (Linux PATH candidates); default: exists + X_OK. */
  isExecutable?: (path: string) => Promise<boolean>
}

interface Candidate {
  /** macOS: the `.app` directory; elsewhere: the executable file. */
  path: string
  /** Flatpak installs start through `flatpak run`. */
  flatpak?: boolean
}

/** Install locations probed in order (reference layout, cross-platform). */
export function candidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Candidate[] {
  if (platform === 'darwin') return ['/Applications/Zotero.app', join(home, 'Applications', 'Zotero.app')].map((path) => ({ path }))
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(env.ProgramFiles ?? 'C:\\Program Files', 'Zotero', 'zotero.exe'),
      join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Zotero', 'zotero.exe'),
      join(local, 'Zotero', 'zotero.exe'),
    ].map((path) => ({ path }))
  }
  const flatpak = 'app/org.zotero.Zotero/current/active/files/lib/zotero/zotero'
  return [
    { path: '/opt/zotero/zotero' },
    { path: '/usr/lib/zotero/zotero' },
    { path: '/usr/local/lib/zotero/zotero' },
    { path: join(home, 'Zotero_linux-x86_64', 'zotero') },
    { path: join(home, 'Zotero_linux-arm64', 'zotero') },
    { path: join(home, '.local', 'share', 'zotero', 'zotero') },
    { path: join(home, 'opt', 'zotero', 'zotero') },
    { path: join('/var/lib/flatpak', flatpak), flatpak: true },
    { path: join(home, '.local', 'share', 'flatpak', flatpak), flatpak: true },
  ]
}

/** Abbreviate the home directory for display (host logs/UI-free guidance). */
export function tilde(path: string, home: string): string {
  if (home === '') return path
  if (path === home) return '~'
  return path.startsWith(home + '/') || path.startsWith(home + '\\') ? `~${path.slice(home.length)}` : path
}

const defaults = (options: InstallOptions) => {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir()
  const exists = options.exists ?? ((path: string) => statExists(path))
  const readText =
    options.readText ??
    ((path: string) =>
      import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')).catch(() => ''))
  const isExecutable = options.isExecutable ?? exists
  return { env, platform, home, exists, readText, isExecutable }
}

async function statExists(path: string): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises')
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

/** Version from the bundle: macOS `Info.plist`, elsewhere `application.ini`. */
async function versionOf(candidate: Candidate, platform: NodeJS.Platform, readText: (path: string) => Promise<string>): Promise<string | undefined> {
  if (platform === 'darwin') {
    const plist = await readText(join(candidate.path, 'Contents', 'Info.plist')).catch(() => '')
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
    if (version !== undefined) return version.trim()
    candidate = { path: join(candidate.path, 'Contents', 'Resources', 'zotero') }
  }
  const ini = await readText(join(dirname(candidate.path), 'application.ini')).catch(() => '')
  return /^Version=(.+)$/m.exec(ini)?.[1]?.trim()
}

/**
 * Find the installed Zotero. When missing, `searched` lists the probed
 * locations (home abbreviated to `~`) so guidance can name them.
 */
export async function findZotero(options: InstallOptions = {}): Promise<ZoteroInstall & { launch?: Candidate }> {
  const { env, platform, home, exists, readText, isExecutable } = defaults(options)
  const list = candidates(platform, env, home)
  for (const candidate of list) {
    if (!(await exists(candidate.path))) continue
    const version = await versionOf(candidate, platform, readText)
    return { state: 'found', path: tilde(candidate.path, home), ...(version !== undefined ? { version } : {}), searched: [], launch: candidate }
  }
  // Linux also supports package-manager installs reachable through PATH.
  if (platform === 'linux') {
    const dirs = (env.PATH ?? '').split(':').filter(Boolean)
    for (const dir of dirs) {
      const onPath = join(dir, 'zotero')
      if (!(await isExecutable(onPath))) continue
      const version = await versionOf({ path: onPath }, platform, readText)
      return { state: 'found', path: tilde(onPath, home), ...(version !== undefined ? { version } : {}), searched: [], launch: { path: onPath } }
    }
  }
  const searched = platform === 'darwin' ? ['/Applications', '~/Applications'] : [...new Set(list.map((candidate) => tilde(dirname(candidate.path), home))), 'PATH']
  return { state: 'missing', searched }
}

/** Major version of a "7.0.15"-style string (NaN when absent). */
export const majorVersionOf = (version: string | undefined): number => (version !== undefined ? Number.parseInt(version, 10) : Number.NaN)

/** The exact, whitelisted command used to start Zotero (test/log surface). */
export function launchCommand(candidate: Candidate, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: ['-a', candidate.path] }
  if (candidate.flatpak) return { command: 'flatpak', args: ['run', 'org.zotero.Zotero'] }
  return { command: candidate.path, args: [] }
}

export type SpawnLike = (command: string, args: string[]) => Promise<void>

/** Default detached spawn: never a shell, stdio ignored, errors surfaced once. */
const defaultSpawn: SpawnLike = (command, args) =>
  new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(new ZoteroError('zotero_error', `Could not start Zotero (${basename(command)}): ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    child.once('error', (error: Error) => reject(new ZoteroError('zotero_error', `Could not start Zotero (${basename(command)}): ${error.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

/**
 * Start the installed Zotero desktop app (does not wait for it to become
 * ready; the plugin's own probing discovers it). Only the platform
 * whitelist above is ever spawned.
 */
export async function launchZotero(options: InstallOptions & { spawn?: SpawnLike } = {}): Promise<string> {
  const { platform } = defaults(options)
  const found = await findZotero(options)
  if (found.state !== 'found' || found.launch === undefined) {
    throw new ZoteroError('zotero_not_installed', 'Zotero is not installed on this computer. Install the Zotero desktop app from https://www.zotero.org/download/.')
  }
  const { command, args } = launchCommand(found.launch, platform)
  await (options.spawn ?? defaultSpawn)(command, args)
  return found.path ?? ''
}
