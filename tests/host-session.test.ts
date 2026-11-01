/**
 * Host-session tests: configuration hot-update with safe connection
 * rebuilds, the credentials-backed KeyStore (official per-plugin grant
 * records), and the view-event hub (viewSeq, bounded history, subscriber
 * hygiene).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ZoteroSession, type VolatileRef } from '../src/host/session.ts'
import { CredentialsKeyStore } from '../src/host/keystore.ts'
import { zoteroCredentialKey } from '../src/host/services.ts'
import { createViewEventHub } from '../src/host/events.ts'
import { MAX_EVENT_HISTORY, MAX_ATTACHMENT_BYTES } from '../src/shared/protocol.ts'
import { startFakeZotero, type FakeZotero } from './helpers/fake-zotero.ts'

/** Mutable volatile stand-in for the config field. */
function volatileRef(initial: string): VolatileRef<string> & { set(next: string): void } {
  let value = initial
  return {
    get: () => value,
    set(next: string) {
      value = next
    },
  }
}

describe('ZoteroSession configuration hot-update', () => {
  let fakeA: FakeZotero
  let fakeB: FakeZotero
  beforeAll(async () => {
    fakeA = await startFakeZotero({ version: '10.0.2-test' })
    fakeB = await startFakeZotero({ version: '10.1.0-test' })
  })
  afterAll(async () => {
    await fakeA.close()
    await fakeB.close()
  })

  it('rebuilds the client when the configured base URL changes', async () => {
    const ref = volatileRef(fakeA.url)
    const session = new ZoteroSession({ baseUrl: ref })
    expect(session.client.baseUrl).toBe(fakeA.url)
    ref.set(fakeB.url)
    expect(session.client.baseUrl).toBe(fakeB.url)
    const status = await session.probe()
    expect(status.version).toBe('10.1.0-test')
    session.dispose()
  })

  it('keeps the last good stack when the new URL is not loopback (client half cannot inject a Zotero URL)', async () => {
    const ref = volatileRef(fakeA.url)
    const session = new ZoteroSession({ baseUrl: ref })
    ref.set('http://attacker.example:23119')
    expect(session.client.baseUrl).toBe(fakeA.url)
    ref.set('not a url')
    expect(session.client.baseUrl).toBe(fakeA.url)
    const status = await session.probe()
    expect(status.state).toBe('ready')
    session.dispose()
  })

  it('fails fast on an invalid initial URL', () => {
    const ref = volatileRef('http://0.0.0.0:23119')
    expect(() => new ZoteroSession({ baseUrl: ref })).toThrowError(/loopback/)
  })

  it('authorizeWrites returns the remembered flag, never the key', async () => {
    const ref = volatileRef(fakeA.url)
    const session = new ZoteroSession({ baseUrl: ref })
    const outcome = await session.authorizeWrites()
    expect(outcome.authorized).toBe(true)
    expect(outcome.remembered).toBe(true)
    expect(JSON.stringify(outcome)).not.toContain('AAAA')
    session.dispose()
  })
})

describe('CredentialsKeyStore (official durable per-plugin records)', () => {
  /** In-memory fake of the official CredentialProvider record face. */
  function fakeCredentials() {
    const records = new Map<string, unknown>()
    const calls: string[] = []
    return {
      calls,
      async readRecord(key: string) {
        calls.push(`read:${key}`)
        return records.get(key) as undefined | { kind: string; payload?: unknown }
      },
      async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) {
        calls.push(`modify:${key}`)
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      },
      async deleteRecord(key: string) {
        calls.push(`delete:${key}`)
        records.delete(key)
      },
      dump: () => records,
    }
  }

  it('round-trips a key through a grant record keyed by the server fingerprint', async () => {
    const provider = fakeCredentials()
    const store = new CredentialsKeyStore(provider)
    const serverId = 'FAKESERVER01'
    expect(await store.load(serverId)).toBeNull()
    await store.save(serverId, 'KEYVALUE1234567890AB')
    expect(await store.load(serverId)).toBe('KEYVALUE1234567890AB')
    const key = zoteroCredentialKey(serverId)
    expect(key).toMatch(/^zotero\/server-[a-z0-9-]+$/)
    const record = provider.dump().get(key) as { kind: string; payload: { version: number; serverId: string; key: string } }
    expect(record.kind).toBe('grant')
    expect(record.payload.serverId).toBe(serverId)
    expect(record.payload.key).toBe('KEYVALUE1234567890AB')
    await store.remove(serverId)
    expect(await store.load(serverId)).toBeNull()
    expect(provider.calls.some((entry) => entry === `delete:${key}`)).toBe(true)
  })

  it('scopes records per server id', async () => {
    const provider = fakeCredentials()
    const store = new CredentialsKeyStore(provider)
    await store.save('SERVER-ONE-X', 'KEYVALUE1234567890AA')
    await store.save('SERVER-TWO-Y', 'KEYVALUE1234567890BB')
    expect(await store.load('SERVER-ONE-X')).toBe('KEYVALUE1234567890AA')
    expect(await store.load('SERVER-TWO-Y')).toBe('KEYVALUE1234567890BB')
    expect(provider.dump().size).toBe(2)
  })

  it('ignores records whose payload server id does not match (fingerprint collision defense)', async () => {
    const provider = fakeCredentials()
    const store = new CredentialsKeyStore(provider)
    const serverId = 'FAKESERVER01'
    const key = zoteroCredentialKey(serverId)
    provider.dump().set(key, { kind: 'grant', payload: { version: 1, serverId: 'ANOTHERSERVER', key: 'KEYVALUE1234567890CC' } })
    expect(await store.load(serverId)).toBeNull()
    provider.dump().set(key, { kind: 'api-key', key: 'KEYVALUE1234567890DD' })
    expect(await store.load(serverId)).toBeNull()
    provider.dump().set(key, { kind: 'grant', payload: { version: 2, serverId, key: 'KEYVALUE1234567890EE' } })
    expect(await store.load(serverId)).toBeNull()
  })

  it('tolerates a broken provider (load → null, errors surface on save)', async () => {
    const store = new CredentialsKeyStore({
      readRecord: () => Promise.reject(new Error('disk on fire')),
      modifyRecord: () => Promise.reject(new Error('disk on fire')),
      deleteRecord: () => Promise.reject(new Error('disk on fire')),
    })
    expect(await store.load('ANYTHING12')).toBeNull()
    await expect(store.save('ANYTHING12', 'KEYVALUE1234567890FF')).rejects.toThrowError(/disk on fire/)
  })

  it('refuses to store malformed keys', async () => {
    const provider = fakeCredentials()
    const store = new CredentialsKeyStore(provider)
    await expect(store.save('ANYTHING12', 'short')).rejects.toThrowError(/malformed/)
  })
})

describe('view event hub (viewSeq state)', () => {
  it('stamps monotonic seqs and carries navigation data only', () => {
    const hub = createViewEventHub()
    const first = hub.publish({ kind: 'open_item', library: 'user', key: 'PAPERAAA' })
    const second = hub.publish({ kind: 'show_items', library: 'user', keys: ['PAPERAAA'], title: 'Results' })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    const wire = JSON.stringify([first, second])
    // No credential material may ride on view events: no api-key field, no
    // value shaped like a Zotero key (16–64 alphanumerics).
    expect(wire).not.toMatch(/api[-_]?key|serverid|server-id/i)
    expect(wire).not.toMatch(new RegExp(`"[A-Za-z0-9]{${16},${64}}"`))
    hub.dispose()
  })

  it('fans out to subscribers until unsubscribed; broken subscribers are contained', () => {
    const hub = createViewEventHub()
    const seen: number[] = []
    const unsubscribe = hub.subscribe((event) => {
      seen.push(event.seq)
    })
    hub.subscribe(() => {
      throw new Error('broken listener')
    })
    hub.publish({ kind: 'open_item', library: 'user', key: 'PAPERAAA' })
    expect(seen).toEqual([1])
    unsubscribe()
    hub.publish({ kind: 'open_item', library: 'user', key: 'PDFATTAA' })
    expect(seen).toEqual([1])
    hub.dispose()
  })

  it('keeps a bounded history for Last-Event-ID replay', () => {
    const hub = createViewEventHub()
    for (let index = 0; index < MAX_EVENT_HISTORY + 10; index++) {
      hub.publish({ kind: 'open_item', library: 'user', key: 'PAPERAAA' })
    }
    expect(hub.replaySince(0)).toHaveLength(MAX_EVENT_HISTORY)
    expect(hub.replaySince(0)[0]?.seq).toBe(11) // oldest retained seq
    expect(hub.replaySince(MAX_EVENT_HISTORY + 9)).toHaveLength(1)
    expect(hub.currentSeq).toBe(MAX_EVENT_HISTORY + 10)
    hub.dispose()
  })

  it('detaches every subscriber on dispose and refuses later publishes', () => {
    const hub = createViewEventHub()
    const seen: number[] = []
    hub.subscribe((event) => seen.push(event.seq))
    hub.dispose()
    expect(() => hub.publish({ kind: 'open_item', library: 'user', key: 'PAPERAAA' })).toThrowError(/disposed/)
    expect(seen).toEqual([])
  })

  it('keeps the attachment ceiling constant next to the hub (audit anchor)', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(104857600)
  })
})
