/**
 * SSRF-guard tests for the metadata fetcher (M7): address classification
 * (loopback/private/link-local/multicast/reserved, IPv4-mapped IPv6, IPv6
 * infrastructure ranges), URL validation (scheme/credentials/literal hosts),
 * DNS resolution failures, and manual-redirect re-validation (a public URL
 * that bounces to a private address is refused before any connection). All
 * DNS and fetch calls are injected fakes.
 */
import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, guardedFetch, refusedAddressReason } from '../src/metadata/net.ts'
import { ZoteroError } from '../src/domain/model.ts'

/** DNS fake: hostname → addresses (missing names fail the lookup). */
const dns = (table: Record<string, string[]>): ((host: string) => Promise<{ address: string; family: number }[]>) => async (host) => {
  const addresses = table[host]
  if (addresses === undefined) throw new Error(`NXDOMAIN ${host}`)
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

/** Permissive DNS: every name resolves to a public documentation address. */
const allow = async (host: string) => [{ address: '93.184.216.34', family: 4 }, { address: `2606:2800:220:1:248:1893:25c8:${host.length.toString(16).padStart(4, '0')}`, family: 6 }]

describe('refusedAddressReason (address classification)', () => {
  it('refuses loopback, private, link-local, multicast, CGNAT and reserved IPv4', () => {
    for (const address of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.1.2.3', '100.64.0.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.9', '203.0.113.9']) {
      expect(refusedAddressReason(address), address).toMatch(/non-public|loopback|multicast|reserved|malformed|private/)
    }
  })

  it('refuses IPv6 loopback, unique-local, link-local, multicast and documentation ranges', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:0:0']) {
      expect(refusedAddressReason(address), address).not.toBeNull()
    }
  })

  it('refuses the whole reserved ::/8 range (first group zero, second group non-zero included)', () => {
    // Group 1 all-zero, group 2 non-zero: inside ::/8, reserved.
    expect(refusedAddressReason('0:400::')).toMatch(/reserved ::\/8/)
    expect(refusedAddressReason('0:ffff:0:0:0:0:0:0')).toMatch(/reserved ::\/8/)
    expect(refusedAddressReason('::ff:0:0:0:0:0:0')).toMatch(/reserved ::\/8/)
    // Addresses whose first 8 bits are zero but whose 9th–16th are not are
    // reserved as well — these slipped through when the filter wrongly
    // matched /16 (first 16 bits).
    for (const address of ['1::', '80::', 'ff::', '0:1::']) {
      expect(refusedAddressReason(address), address).toMatch(/reserved ::\/8/)
    }
    // Public unicast first octets are untouched (no CIDR regression).
    expect(refusedAddressReason('100::1')).toBeNull()
    expect(refusedAddressReason('2606:4700::1111')).toBeNull()
  })

  it('judges IPv4-mapped IPv6 addresses as IPv4 (mapped-private cannot slip through)', () => {
    expect(refusedAddressReason('::ffff:10.0.0.1')).toMatch(/non-public/)
    expect(refusedAddressReason('::ffff:127.0.0.1')).toMatch(/non-public/)
    expect(refusedAddressReason('::ffff:169.254.169.254')).toMatch(/non-public/)
  })

  it('allows public unicast addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111', '2620:fe::fe']) {
      expect(refusedAddressReason(address), address).toBeNull()
    }
  })

  it('refuses malformed input', () => {
    expect(refusedAddressReason('not-an-ip')).not.toBeNull()
    expect(refusedAddressReason('999.1.1.1')).not.toBeNull()
    expect(refusedAddressReason('1.2.3')).not.toBeNull()
    expect(refusedAddressReason('gg::1')).not.toBeNull()
  })
})

describe('assertPublicHttpUrl (URL validation)', () => {
  it('accepts public http(s) URLs and canonicalizes them', async () => {
    expect(await assertPublicHttpUrl('https://example.org/paper.pdf', { lookup: allow })).toBe('https://example.org/paper.pdf')
    expect(await assertPublicHttpUrl('http://example.com/x', { lookup: allow })).toBe('http://example.com/x')
  })

  it('rejects non-http schemes before any DNS work', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.org/x', 'zotero://select/library/items/ABCD2345', 'data:text/html,hi', 'javascript:alert(1)']) {
      await expect(assertPublicHttpUrl(url, { lookup: allow })).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('rejects URLs with embedded credentials', async () => {
    await expect(assertPublicHttpUrl('https://user:pass@example.org/x.pdf', { lookup: allow })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('resolves hostnames and refuses any non-public answer', async () => {
    const privateDns = dns({ 'internal.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '192.168.0.9'], 'v6.example': ['fd00::1'] })
    await expect(assertPublicHttpUrl('https://internal.example/x.pdf', { lookup: privateDns })).rejects.toMatchObject({ code: 'download_failed' })
    // One private address among public ones is enough to refuse.
    await expect(assertPublicHttpUrl('https://mixed.example/x.pdf', { lookup: privateDns })).rejects.toMatchObject({ code: 'download_failed' })
    await expect(assertPublicHttpUrl('https://v6.example/x.pdf', { lookup: privateDns })).rejects.toMatchObject({ code: 'download_failed' })
  })

  it('refuses IP-literal private hosts without touching DNS', async () => {
    const spy = dns({})
    await expect(assertPublicHttpUrl('https://127.0.0.1/x.pdf', { lookup: spy })).rejects.toMatchObject({ code: 'download_failed' })
    await expect(assertPublicHttpUrl('https://[fd00::1]/x.pdf', { lookup: spy })).rejects.toMatchObject({ code: 'download_failed' })
  })

  it('fails closed on DNS errors and empty answers', async () => {
    await expect(assertPublicHttpUrl('https://missing.example/x.pdf', { lookup: dns({}) })).rejects.toMatchObject({ code: 'download_failed' })
    const empty = async () => []
    await expect(assertPublicHttpUrl('https://empty.example/x.pdf', { lookup: empty })).rejects.toMatchObject({ code: 'download_failed' })
  })

  it('rejects garbage URLs as invalid_input', async () => {
    await expect(assertPublicHttpUrl('not a url', { lookup: allow })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('guardedFetch (manual redirect re-validation)', () => {
  const ok = (body = 'payload') => new Response(body, { status: 200 })

  it('follows public redirects and returns the final URL', async () => {
    const hops: string[] = []
    const result = await guardedFetch('https://start.example/one', {
      lookup: allow,
      fetchImpl: async (url) => {
        hops.push(url)
        if (url === 'https://start.example/one') return new Response('', { status: 302, headers: { location: 'https://finish.example/two' } })
        return ok()
      },
    })
    expect(hops).toEqual(['https://start.example/one', 'https://finish.example/two'])
    expect(result.finalUrl).toBe('https://finish.example/two')
    await expect(result.response.text()).resolves.toBe('payload')
  })

  it('resolves relative redirect targets', async () => {
    const hops: string[] = []
    await guardedFetch('https://start.example/dir/page', {
      lookup: allow,
      fetchImpl: async (url) => {
        hops.push(url)
        if (hops.length === 1) return new Response('', { status: 301, headers: { location: 'other.pdf' } })
        return ok()
      },
    })
    expect(hops[1]).toBe('https://start.example/dir/other.pdf')
  })

  it('refuses a redirect to a private host WITHOUT connecting to it (SSRF)', async () => {
    const hops: string[] = []
    const table = { 'evil.example': ['169.254.169.254'] }
    const promise = guardedFetch('https://public.example/redirect', {
      lookup: dns({ 'public.example': ['93.184.216.34'], ...table }),
      fetchImpl: async (url) => {
        hops.push(url)
        return new Response('', { status: 302, headers: { location: 'https://evil.example/grab' } })
      },
    })
    await expect(promise).rejects.toMatchObject({ code: 'download_failed' })
    await expect(promise).rejects.toThrowError(/non-public/)
    expect(hops).toEqual(['https://public.example/redirect'])
  })

  it('refuses a redirect to a loopback literal and to non-http schemes', async () => {
    for (const location of ['http://127.0.0.1:23119/api/', 'file:///etc/passwd', 'ftp://public.example/x']) {
      await expect(
        guardedFetch('https://public.example/redirect', {
          lookup: allow,
          fetchImpl: async () => new Response('', { status: 302, headers: { location } }),
        }),
      ).rejects.toThrowError(ZoteroError)
    }
  })

  it('caps the redirect chain', async () => {
    let calls = 0
    await expect(
      guardedFetch('https://loop.example/a', {
        lookup: allow,
        redirects: 3,
        fetchImpl: async () => {
          calls += 1
          return new Response('', { status: 302, headers: { location: `https://loop.example/${calls}` } })
        },
      }),
    ).rejects.toThrowError(/redirects/)
    expect(calls).toBe(4) // 1 initial + 3 followed hops, then refused.
  })

  it('wraps transport errors as download_failed with the target named', async () => {
    await expect(
      guardedFetch('https://broken.example/x', {
        lookup: allow,
        fetchImpl: async () => {
          throw new Error('socket hangup')
        },
      }),
    ).rejects.toMatchObject({ code: 'download_failed' })
  })

  it('propagates aborts from the caller signal', async () => {
    const controller = new AbortController()
    // A real fetch rejects with an AbortError once its signal aborts; the
    // fake aborts the caller's controller mid-flight and does the same. The
    // guard must rethrow it as-is (not wrapped as download_failed).
    await expect(
      guardedFetch('https://public.example/x', {
        lookup: allow,
        signal: controller.signal,
        fetchImpl: async (_url, init) => {
          controller.abort()
          if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
          return ok()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('wraps non-abort transport errors even after an abortable signal is wired', async () => {
    // The mirror case: an ordinary network error is download_failed, not an
    // AbortError, even though a signal is attached.
    await expect(
      guardedFetch('https://public.example/x', {
        lookup: allow,
        signal: new AbortController().signal,
        fetchImpl: async () => {
          throw new Error('ECONNRESET')
        },
      }),
    ).rejects.toMatchObject({ code: 'download_failed' })
  })
})
