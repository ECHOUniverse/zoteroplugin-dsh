/**
 * SSRF-guarded HTTP for the metadata module (M7): the only outbound network
 * the plugin ever opens. Every hop — the requested URL and each redirect
 * target — must be `http(s)` on a **public** host:
 *
 * - the hostname is resolved through DNS (`dns.promises.lookup`, all
 *   addresses) and every resolved address is classified; loopback, private,
 *   link-local, multicast, broadcast/reserved and IPv6 infrastructure ranges
 *   are refused before any connection is attempted, as are IPv4/IPv6 literal
 *   hosts and IPv4-mapped IPv6 addresses;
 * - redirects are followed **manually** (`redirect: 'manual'`), so each hop
 *   is re-validated — a public URL that redirects to `127.0.0.1` or
 *   `169.254.169.254` fails with `download_failed` instead of connecting;
 * - there is no exception for loopback: the Zotero Local API base is the
 *   plugin's only loopback consumer and is reached exclusively through
 *   `zotero/client.ts` — external metadata/PDF downloads never touch it.
 *
 * The guard is fail-closed: DNS failure, unknown address families and lookup
 * errors all refuse the request. Streaming responses are size-capped by the
 * caller (`downloadPdf`).
 *
 * @module @hanxu131/dsh-zotero/metadata/net
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ZoteroError } from '../domain/model.ts'

/** Structural fetch so tests inject stubs; matches the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Injectable DNS resolver (tests fake it; production uses `dns.lookup`). */
export type LookupLike = (hostname: string) => Promise<{ address: string; family: number }[]>

const defaultLookup: LookupLike = (hostname) => lookup(hostname, { all: true, verbatim: true })

/**
 * Classify one address; `null` when the address may be dialed, a refusal
 * reason otherwise. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is unwrapped and
 * judged as IPv4 so mapped-private addresses cannot slip through.
 */
export function refusedAddressReason(address: string): string | null {
  let text = address
  let family = isIP(address)
  const mapped = /^(?:::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (family === 6 && mapped !== null) {
    text = mapped[1]!
    family = 4
  }
  if (family === 4) return refusedIpv4Reason(text)
  if (family === 6) return refusedIpv6Reason(text)
  return `unknown address format ${JSON.stringify(address)}`
}

function ipv4ToInt(text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function refusedIpv4Reason(text: string): string | null {
  const value = ipv4ToInt(text)
  if (value === null) return `malformed IPv4 address ${JSON.stringify(text)}`
  const inRange = (cidr: string): boolean => {
    const [base, bitsRaw] = cidr.split('/')
    const baseValue = ipv4ToInt(base!)
    if (baseValue === null) return false
    const bits = Number(bitsRaw)
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) === (baseValue & mask)
  }
  // 0/8 "this network", 10/8 private, 100.64/10 CGNAT, 127/8 loopback,
  // 169.254/16 link-local, 172.16/12 private, 192.0.0/24 + 192.0.2/24 TEST,
  // 192.168/16 private, 198.18/15 benchmarking, 198.51.100/24 + 203.0.113/24
  // TEST, 224/4 multicast, 240/4 reserved (incl. 255.255.255.255 broadcast).
  const blocked = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ]
  for (const range of blocked) {
    if (inRange(range)) return `address ${text} is in a non-public range (${range})`
  }
  return null
}

function refusedIpv6Reason(text: string): string | null {
  const value = text.toLowerCase()
  if (value === '::' || value === '::1') return `address ${text} is not a public unicast address`
  // Expand "::" to eight groups for prefix checks.
  const halves = value.split('::')
  const head = halves[0] === '' ? [] : halves[0]!.split(':')
  const tail = halves.length > 1 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : []
  const missing = 8 - head.length - tail.length
  if (halves.length > 2 || missing < 0) return `malformed IPv6 address ${JSON.stringify(text)}`
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return `malformed IPv6 address ${JSON.stringify(text)}`
  }
  const numbers = groups.map((group) => Number.parseInt(group, 16))
  const prefixBits = (count: number): string => {
    let bits = ''
    for (let index = 0; index < 8; index++) {
      bits = bits + numbers[index]!.toString(2).padStart(16, '0')
      if (bits.length >= count) return bits.slice(0, count)
    }
    return bits
  }
  const has = (count: number, prefix: string): boolean => prefixBits(count) === prefix
  // ::/128 unspecified, ::1/128 loopback, fc00::/7 unique-local, fe80::/10
  // link-local, ff00::/8 multicast, 2001:db8::/32 documentation, ::/8 reserved
  // (first 8 bits zero — includes e.g. `0:400::`, `1::`, `ff::`).
  if (has(128, '0'.repeat(128))) return `address ${text} is the unspecified address`
  if (has(128, '0'.repeat(127) + '1')) return `address ${text} is the IPv6 loopback`
  if (has(7, '1111110')) return `address ${text} is in the unique-local range (fc00::/7)`
  if (prefixBits(10).startsWith('1111111010')) return `address ${text} is in the link-local range (fe80::/10)`
  if (prefixBits(8).startsWith('11111111')) return `address ${text} is multicast (ff00::/8)`
  if (has(32, '0010000000000001' + '0000110110111000')) return `address ${text} is in the documentation range (2001:db8::/32)`
  if (prefixBits(8) === '00000000') return `address ${text} is in the reserved ::/8 range`
  return null
}

/**
 * Validate one URL for download: `http(s)` only, no credentials, and every
 * DNS-resolved address public. Returns the canonical URL string.
 * `invalid_input` for URL-shape problems, `download_failed` for refusals
 * discovered at the network layer.
 */
export async function assertPublicHttpUrl(rawUrl: string, options: { lookup?: LookupLike } = {}): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ZoteroError('invalid_input', `Not a URL: ${JSON.stringify(rawUrl)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ZoteroError('invalid_input', 'PDF URLs must use http or https.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ZoteroError('invalid_input', 'PDF URLs must not carry credentials.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '') throw new ZoteroError('invalid_input', 'PDF URL has an empty host.')
  await assertHostPublic(host, options.lookup ?? defaultLookup)
  return url.href
}

/** Resolve a host and refuse it when any resolved address is non-public. */
async function assertHostPublic(host: string, doLookup: LookupLike): Promise<void> {
  const literal = isIP(host)
  if (literal !== 0) {
    const reason = refusedAddressReason(host)
    if (reason !== null) throw new ZoteroError('download_failed', `Blocked a non-public download host: ${reason}.`)
    return
  }
  let addresses: { address: string; family: number }[]
  try {
    addresses = await doLookup(host)
  } catch (error) {
    throw new ZoteroError('download_failed', `Could not resolve the download host ${JSON.stringify(host)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (addresses.length === 0) {
    throw new ZoteroError('download_failed', `The download host ${JSON.stringify(host)} resolved to no addresses.`)
  }
  for (const { address } of addresses) {
    const reason = refusedAddressReason(address)
    if (reason !== null) throw new ZoteroError('download_failed', `Blocked a non-public download host (${host}): ${reason}.`)
  }
}

export interface GuardedFetchResult {
  response: Response
  /** The final URL after redirects (post-validation). */
  finalUrl: string
}

/**
 * Fetch a public URL following redirects manually: every hop (including the
 * first) passes `assertPublicHttpUrl` before it is requested. Non-redirect
 * responses are returned as-is for the caller to interpret.
 */
export async function guardedFetch(
  rawUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal; fetchImpl?: FetchLike; lookup?: LookupLike; redirects?: number } = {},
): Promise<GuardedFetchResult> {
  const doFetch = init.fetchImpl ?? ((url: string, requestInit?: RequestInit) => fetch(url, requestInit))
  const maxRedirects = init.redirects ?? 5
  let url = await assertPublicHttpUrl(rawUrl, { ...(init.lookup !== undefined ? { lookup: init.lookup } : {}) })
  for (let hop = 0; ; hop++) {
    const response = await doFetch(url, {
      method: 'GET',
      headers: init.headers,
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
      redirect: 'manual',
    }).catch((error: unknown) => {
      if (init.signal?.aborted) throw error
      throw new ZoteroError(
        'download_failed',
        `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location !== null) {
      if (hop >= maxRedirects) {
        throw new ZoteroError('download_failed', `The download followed more than ${maxRedirects} redirects.`)
      }
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new ZoteroError('download_failed', `The download redirect target is not a valid URL: ${JSON.stringify(location)}`)
      }
      // Re-validate every hop: a public URL must not bounce into a private
      // network (SSRF via redirect) or onto another scheme.
      url = await assertPublicHttpUrl(next.href, { ...(init.lookup !== undefined ? { lookup: init.lookup } : {}) })
      continue
    }
    return { response, finalUrl: url }
  }
}
