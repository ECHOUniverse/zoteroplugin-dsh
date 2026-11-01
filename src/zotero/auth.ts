/**
 * Write-key storage abstraction for the Zotero Local API.
 *
 * Keys are stored **per `Zotero-Server-ID`**: when another Zotero instance
 * takes over the loopback port, keys issued for the previous instance simply
 * stop matching and new ones are authorized. The default store keeps keys in
 * process memory only; the host half provides the persisted adapter
 * (`CredentialsKeyStore` over the official DSH credentials records) through
 * the session's late binding — attaching it rebuilds the client, unbinding
 * falls back to this in-memory store. Keys never leave this layer: they
 * are not exposed by the client, not logged, and never placed in
 * `shared/` wire types or the client half.
 *
 * @module @hanxu131/dsh-zotero/zotero/auth
 */

/**
 * Persistence seam for remembered ("always allow") keys. Implementations must
 * keep the key confidential (e.g. 0600 files) and scoped by server id.
 */
export interface KeyStore {
  /** Stored key for this server id, or null. */
  load(serverId: string): Promise<string | null>
  /** Store (or replace) the key for this server id. */
  save(serverId: string, key: string): Promise<void>
  /** Forget the key for this server id. */
  remove(serverId: string): Promise<void>
}

/** In-memory `KeyStore` — the default; nothing survives the process. */
export class MemoryKeyStore implements KeyStore {
  private readonly entries = new Map<string, string>()

  async load(serverId: string): Promise<string | null> {
    return this.entries.get(serverId) ?? null
  }

  async save(serverId: string, key: string): Promise<void> {
    this.entries.set(serverId, key)
  }

  async remove(serverId: string): Promise<void> {
    this.entries.delete(serverId)
  }
}

/** Shape of a locally issued key (alphanumeric, 16–64 chars). */
export const API_KEY_PATTERN = /^[a-zA-Z0-9]{16,64}$/

export function isValidApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_PATTERN.test(value)
}
