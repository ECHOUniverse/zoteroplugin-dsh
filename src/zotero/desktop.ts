/**
 * Zotero deep links + the platform "open URL" seam (M7): the Setup view's
 * "Open Zotero", and the item/reader "Show in Zotero" buttons, all route
 * through here.
 *
 * - Link construction is strict and server-owned: `zotero://select/library/
 *   items/<key>` / `zotero://select/groups/<id>/items/<key>` for items,
 *   `zotero://open-pdf/…` (plus `?page=<n>`) for PDFs. Library ids and item
 *   keys are re-validated here so a malformed reference can never become a
 *   deep link (defense in depth — callers validate first too).
 * - Opening spawns a fixed per-platform command with an argument array
 *   (macOS `/usr/bin/open <url>`, Windows `rundll32 url.dll,
 *   FileProtocolHandler <url>`, Linux `xdg-open <url>`) — never a shell and
 *   never a client-provided command or path; the only dynamic part is the
 *   strictly constructed URL.
 *
 * Attribution: URL shapes adapted from zai-org/zcode-plugins
 * `ui-plugins/zotero` `ui/common.tsx` (repo LICENSE: Apache-2.0); the
 * reference hands the URL to its MCP host's `openLink`, while this plugin
 * owns a webServer route and therefore performs the open itself with a
 * whitelisted spawn. See THIRD_PARTY_NOTICES.md.
 *
 * @module @hanxu131/dsh-zotero/zotero/desktop
 */

import { spawn } from 'node:child_process'
import { ZoteroError, parseItemKey, parseLibraryId, type LibraryId } from '../domain/model.ts'

/** What the deep link should open. */
export type DesktopTarget =
  /** Select (reveal) a regular item in the Zotero main window. */
  | { kind: 'select'; library: LibraryId; key: string }
  /** Open the PDF reader on an attachment (optionally at a 1-based page). */
  | { kind: 'open-pdf'; library: LibraryId; key: string; page?: number }

/** Build the `zotero://` URL for a target; throws `invalid_input` on bad refs. */
export function zoteroDesktopUrl(target: DesktopTarget): string {
  const library = parseLibraryId(target.library)
  const key = parseItemKey(target.key, 'key')
  const base = library.type === 'user' ? `zotero://${target.kind}/library/items/${key}` : `zotero://${target.kind}/groups/${library.id}/items/${key}`
  if (target.kind === 'open-pdf' && target.page !== undefined) {
    if (!Number.isInteger(target.page) || target.page < 1 || target.page > 100_000) {
      throw new ZoteroError('invalid_input', `page must be a positive integer; got ${JSON.stringify(target.page)}`)
    }
    return `${base}?page=${target.page}`
  }
  return base
}

/** The exact, whitelisted open command per platform (test/log surface). */
export function openUrlCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] }
  if (platform === 'win32') return { command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

export type SpawnLike = (command: string, args: string[]) => Promise<void>

/** Default detached spawn (no shell, stdio ignored). */
const defaultSpawn: SpawnLike = (command, args) =>
  new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(new ZoteroError('zotero_error', `Could not open ${urlSchemeOf(args)}: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    child.once('error', (error: Error) => reject(new ZoteroError('zotero_error', `Could not open ${urlSchemeOf(args)}: ${error.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

const urlSchemeOf = (args: string[]): string => (args.at(-1) ?? '').split(':')[0] ?? 'link'

/** Validate and open a `zotero://` URL with the platform whitelist. */
export async function openZoteroUrl(
  url: string,
  options: { platform?: NodeJS.Platform; spawn?: SpawnLike } = {},
): Promise<{ command: string; args: string[] }> {
  if (!url.startsWith('zotero://')) throw new ZoteroError('invalid_input', `Only zotero:// links can be opened; got ${JSON.stringify(url.split(':')[0] ?? '')}://`)
  const platform = options.platform ?? process.platform
  const { command, args } = openUrlCommand(url, platform)
  await (options.spawn ?? defaultSpawn)(command, args)
  return { command, args }
}
