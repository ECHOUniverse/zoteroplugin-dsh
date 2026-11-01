/**
 * Desktop install probe + launch + `zotero://` deep links (M7), fully faked:
 * the filesystem/exec seams (`exists`/`readText`/`isExecutable`) and the
 * spawn seam are injected, so no test ever touches the real install
 * locations or starts a real process / deep link.
 *
 * Covered here:
 * - candidate layouts per platform and the not_installed outcome (state
 *   `missing` with the searched list, home abbreviated to `~`);
 * - version reads (Info.plist / application.ini) and "never guessed from a
 *   path";
 * - the launch/open URL command whitelists (fixed command, argument array,
 *   no shell) and that a failed spawn surfaces as `zotero_error`;
 * - deep-link construction/validation for select / open-pdf.
 */
import { describe, expect, it } from 'vitest'
import {
  candidates,
  findZotero,
  launchCommand,
  launchZotero,
  majorVersionOf,
  openUrlCommand,
  openZoteroUrl,
  type InstallOptions,
} from '../src/zotero/install.ts'
import { openUrlCommand as desktopOpenUrlCommand, openZoteroUrl as desktopOpenZoteroUrl, zoteroDesktopUrl, type SpawnLike } from '../src/zotero/desktop.ts'
import { ZoteroError } from '../src/domain/model.ts'

/** Install options with a fake filesystem rooted at a set of present paths. */
function fakeFs(present: string[], files: Record<string, string> = {}): InstallOptions {
  return {
    exists: async (path) => present.includes(path),
    readText: async (path) => files[path] ?? '',
    isExecutable: async (path) => present.includes(path),
  }
}

/** Spawn seam that records calls and optionally fails. */
function fakeSpawn(fail?: Error): SpawnLike & { calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = []
  const fn = async (command: string, args: string[]) => {
    calls.push({ command, args })
    if (fail !== undefined) throw new ZoteroError('zotero_error', `Could not start Zotero: ${fail.message}`)
  }
  return Object.assign(fn, { calls })
}

describe('candidates (cross-platform layout)', () => {
  it('probes the macOS app bundles', () => {
    const list = candidates('darwin', {}, '/home/u').map((candidate) => candidate.path)
    expect(list).toEqual(['/Applications/Zotero.app', '/home/u/Applications/Zotero.app'])
  })

  it('probes ProgramFiles and LOCALAPPDATA on Windows', () => {
    const list = candidates('win32', { ProgramFiles: 'D:\\Apps', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u').map((candidate) => candidate.path)
    // path.join uses the running platform's separator, so the exact strings
    // mix separators when the test runs on a non-Windows host; the segments
    // are what matters.
    expect(list.map((path) => path.replace(/\\/g, '/').split('/').slice(-2))).toEqual([
      ['Zotero', 'zotero.exe'],
      ['Zotero', 'zotero.exe'],
      ['Zotero', 'zotero.exe'],
    ])
    expect(list[0]).toContain('D:\\Apps')
    expect(list[1]).toContain('Program Files (x86)')
    expect(list[2]!.startsWith('C:\\Users\\u\\AppData\\Local')).toBe(true)
  })

  it('probes Linux package, tarball and flatpak locations, flatpak marked', () => {
    const list = candidates('linux', {}, '/home/u')
    expect(list.map((candidate) => candidate.path)).toContain('/opt/zotero/zotero')
    expect(list.map((candidate) => candidate.path)).toContain('/home/u/Zotero_linux-x86_64/zotero')
    const flatpak = list.find((candidate) => candidate.flatpak === true)
    expect(flatpak?.path).toBe('/var/lib/flatpak/app/org.zotero.Zotero/current/active/files/lib/zotero/zotero')
  })
})

describe('findZotero (found / missing / version)', () => {
  it('finds the macOS bundle and reads the version from Info.plist', async () => {
    const found = await findZotero({
      ...fakeFs(
        ['/Applications/Zotero.app'],
        { '/Applications/Zotero.app/Contents/Info.plist': '<key>CFBundleShortVersionString</key>\n  <string>7.0.15</string>' },
      ),
      platform: 'darwin',
      home: '/home/u',
    })
    expect(found.state).toBe('found')
    expect(found.version).toBe('7.0.15')
    expect(found.searched).toEqual([])
  })

  it('falls back to application.ini next to the macOS executable', async () => {
    const found = await findZotero({
      ...fakeFs(
        ['/Applications/Zotero.app'],
        { '/Applications/Zotero.app/Contents/Resources/application.ini': 'Version=6.0.37\n' },
      ),
      platform: 'darwin',
      home: '/home/u',
    })
    expect(found.state).toBe('found')
    expect(found.version).toBe('6.0.37')
  })

  it('reports found without a version when the bundle is unreadable (never guessed)', async () => {
    const found = await findZotero({ ...fakeFs(['/opt/zotero/zotero']), platform: 'linux', home: '/home/u' })
    expect(found.state).toBe('found')
    expect(found.version).toBeUndefined()
  })

  it('reports missing with the searched list, home abbreviated (not_installed)', async () => {
    const missing = await findZotero({ ...fakeFs([]), platform: 'darwin', home: '/home/u' })
    expect(missing.state).toBe('missing')
    expect(missing.searched).toEqual(['/Applications', '~/Applications'])
    expect(missing.searched.join(' ')).not.toContain('/home/u')
  })

  it('finds a Linux PATH install through the executability probe', async () => {
    const found = await findZotero({
      ...fakeFs(['/usr/local/bin/zotero'], { '/usr/local/bin/application.ini': 'Version=7.1.0\n' }),
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '/usr/local/bin:/usr/bin' },
    })
    expect(found.state).toBe('found')
    expect(found.version).toBe('7.1.0')
  })

  it('majorVersionOf parses the leading number only', () => {
    expect(majorVersionOf('7.0.15')).toBe(7)
    expect(majorVersionOf(undefined)).toBeNaN()
  })
})

describe('launchCommand whitelist', () => {
  it('macOS uses /usr/bin/open -a with the app path', () => {
    expect(launchCommand({ path: '/Applications/Zotero.app' }, 'darwin')).toEqual({ command: '/usr/bin/open', args: ['-a', '/Applications/Zotero.app'] })
  })

  it('flatpak goes through flatpak run org.zotero.Zotero', () => {
    expect(launchCommand({ path: '/var/lib/flatpak/app/org.zotero.Zotero/current/active/files/lib/zotero/zotero', flatpak: true }, 'linux')).toEqual({
      command: 'flatpak',
      args: ['run', 'org.zotero.Zotero'],
    })
  })

  it('Windows/Linux launch the resolved executable directly', () => {
    expect(launchCommand({ path: 'C:\\Program Files\\Zotero\\zotero.exe' }, 'win32')).toEqual({ command: 'C:\\Program Files\\Zotero\\zotero.exe', args: [] })
    expect(launchCommand({ path: '/opt/zotero/zotero' }, 'linux')).toEqual({ command: '/opt/zotero/zotero', args: [] })
  })
})

describe('launchZotero (injected spawn, never a shell)', () => {
  it('spawns the whitelisted command with an argument array and returns the install path', async () => {
    const spawnSeam = fakeSpawn()
    const options: InstallOptions & { spawn?: SpawnLike } = {
      ...fakeFs(['/Applications/Zotero.app'], { '/Applications/Zotero.app/Contents/Info.plist': '<key>CFBundleShortVersionString</key><string>7.0.15</string>' }),
      platform: 'darwin',
      home: '/home/u',
      spawn: spawnSeam,
    }
    const path = await launchZotero(options)
    expect(path).toBe('/Applications/Zotero.app')
    expect(spawnSeam.calls).toEqual([{ command: '/usr/bin/open', args: ['-a', '/Applications/Zotero.app'] }])
  })

  it('fails with zotero_not_installed (not zotero_error) when nothing is installed', async () => {
    const spawnSeam = fakeSpawn()
    const error = await launchZotero({ ...fakeFs([]), platform: 'darwin', home: '/home/u', spawn: spawnSeam }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ZoteroError)
    expect((error as ZoteroError).code).toBe('zotero_not_installed')
    expect(spawnSeam.calls).toEqual([]) // nothing was ever spawned
  })

  it('surfaces a spawn failure as zotero_error', async () => {
    const error = await launchZotero({
      ...fakeFs(['/opt/zotero/zotero']),
      platform: 'linux',
      home: '/home/u',
      spawn: fakeSpawn(new Error('EACCES')),
    }).catch((e: unknown) => e)
    expect((error as ZoteroError).code).toBe('zotero_error')
    expect((error as ZoteroError).message).toContain('EACCES')
  })
})

describe('zoteroDesktopUrl (strict construction)', () => {
  it('builds select/open-pdf links for user and group libraries', () => {
    expect(zoteroDesktopUrl({ kind: 'select', library: 'user', key: 'ABCD2345' })).toBe('zotero://select/library/items/ABCD2345')
    expect(zoteroDesktopUrl({ kind: 'select', library: 'g88', key: 'ABCD2345' })).toBe('zotero://select/groups/88/items/ABCD2345')
    expect(zoteroDesktopUrl({ kind: 'open-pdf', library: 'user', key: 'PDFATTAA' })).toBe('zotero://open-pdf/library/items/PDFATTAA')
    expect(zoteroDesktopUrl({ kind: 'open-pdf', library: 'user', key: 'PDFATTAA', page: 3 })).toBe('zotero://open-pdf/library/items/PDFATTAA?page=3')
  })

  it('rejects malformed keys, libraries and pages', () => {
    expect(() => zoteroDesktopUrl({ kind: 'select', library: 'user', key: 'short' })).toThrow(ZoteroError)
    expect(() => zoteroDesktopUrl({ kind: 'select', library: 'g zero', key: 'ABCD2345' })).toThrow(ZoteroError)
    expect(() => zoteroDesktopUrl({ kind: 'open-pdf', library: 'user', key: 'PDFATTAA', page: 0 })).toThrow(ZoteroError)
    expect(() => zoteroDesktopUrl({ kind: 'open-pdf', library: 'user', key: 'PDFATTAA', page: 1.5 })).toThrow(ZoteroError)
  })
})

describe('openZoteroUrl (platform whitelist, injected spawn)', () => {
  it('opens through /usr/bin/open on macOS and records the exact argv', async () => {
    const spawnSeam = fakeSpawn()
    const result = await desktopOpenZoteroUrl('zotero://select/library/items/ABCD2345', { platform: 'darwin', spawn: spawnSeam })
    expect(result).toEqual({ command: '/usr/bin/open', args: ['zotero://select/library/items/ABCD2345'] })
    expect(spawnSeam.calls).toEqual([{ command: '/usr/bin/open', args: ['zotero://select/library/items/ABCD2345'] }])
  })

  it('uses rundll32 on Windows and xdg-open on Linux', async () => {
    const win = await desktopOpenZoteroUrl('zotero://open-pdf/library/items/PDFATTAA?page=2', { platform: 'win32', spawn: fakeSpawn() })
    expect(win.command).toBe('C:\\Windows\\System32\\rundll32.exe')
    expect(win.args[0]).toBe('url.dll,FileProtocolHandler')
    const linux = await desktopOpenZoteroUrl('zotero://select/library/items/ABCD2345', { platform: 'linux', spawn: fakeSpawn() })
    expect(linux).toEqual({ command: 'xdg-open', args: ['zotero://select/library/items/ABCD2345'] })
  })

  it('refuses any non-zotero scheme before spawning anything', async () => {
    const spawnSeam = fakeSpawn()
    await expect(desktopOpenZoteroUrl('https://evil.example/x', { platform: 'darwin', spawn: spawnSeam })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(desktopOpenZoteroUrl('file:///etc/passwd', { platform: 'darwin', spawn: spawnSeam })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(spawnSeam.calls).toEqual([])
  })
})

describe('openUrlCommand whitelist', () => {
  it('is fixed per platform with the URL as the only dynamic argument', () => {
    expect(desktopOpenUrlCommand('zotero://select/library/items/ABCD2345', 'darwin')).toEqual({ command: '/usr/bin/open', args: ['zotero://select/library/items/ABCD2345'] })
    const win = desktopOpenUrlCommand('zotero://select/library/items/ABCD2345', 'win32')
    expect(win.command).toBe('C:\\Windows\\System32\\rundll32.exe')
    expect(win.args).toHaveLength(2)
    expect(desktopOpenUrlCommand('zotero://x', 'linux').command).toBe('xdg-open')
  })
})
