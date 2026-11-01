/**
 * `CredentialsKeyStore` — durable `KeyStore` over the official DSH
 * credentials seam (`ctx.credentials`, provided by
 * `@deepseek-ai/dsh-credentials-local`).
 *
 * Keys are stored as per-plugin **grant records** addressed
 * `zotero/server-<fingerprint>`: the id segment must match the official
 * credential-key grammar `^[a-z][a-z0-9-]*$`, so the `Zotero-Server-ID` is
 * reduced to a sha-256 fingerprint and the record payload carries the
 * original server id, which is re-verified on load (a fingerprint collision
 * or a record moved between instances cannot hand out the wrong key). The
 * local provider persists grant payloads verbatim in
 * `$DSH_HOME/.credentials.yaml` with owner-only file permissions and refuses
 * to load world-readable files — the confidentiality contract the red line
 * requires, without guessing any path ourselves.
 *
 * When no credentials service exists (a profile without the credential
 * seam), the host half falls back to the in-memory store: keys stay
 * process-local and nothing is ever written to a guessed path.
 *
 * @module @hanxu131/dsh-zotero/host/keystore
 */

import type { KeyStore } from '../zotero/auth.ts'
import { API_KEY_PATTERN, isValidApiKey } from '../zotero/auth.ts'
import { zoteroCredentialKey, type CredentialsFace } from './services.ts'

/** Version tag of the grant payload this store writes. */
const PAYLOAD_VERSION = 1

interface StoredPayload {
  version: number
  serverId: string
  key: string
}

export class CredentialsKeyStore implements KeyStore {
  constructor(private readonly credentials: CredentialsFace) {}

  async load(serverId: string): Promise<string | null> {
    let record: Awaited<ReturnType<CredentialsFace['readRecord']>>
    try {
      record = await this.credentials.readRecord(zoteroCredentialKey(serverId))
    } catch {
      return null // An unreadable store behaves like "no stored key".
    }
    if (record?.kind !== 'grant') return null
    const payload = this.parsePayload(record.payload, serverId)
    return payload !== undefined && isValidApiKey(payload.key) ? payload.key : null
  }

  async save(serverId: string, key: string): Promise<void> {
    if (!API_KEY_PATTERN.test(key)) throw new Error('CredentialsKeyStore: refusing to store a malformed key')
    await this.credentials.modifyRecord(zoteroCredentialKey(serverId), () =>
      Promise.resolve({ kind: 'grant', payload: { version: PAYLOAD_VERSION, serverId, key } satisfies StoredPayload }),
    )
  }

  async remove(serverId: string): Promise<void> {
    await this.credentials.deleteRecord(zoteroCredentialKey(serverId))
  }

  private parsePayload(payload: unknown, serverId: string): StoredPayload | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined
    const candidate = payload as Partial<StoredPayload>
    if (candidate.version !== PAYLOAD_VERSION) return undefined
    if (candidate.serverId !== serverId) return undefined
    if (typeof candidate.key !== 'string') return undefined
    return { version: candidate.version, serverId: candidate.serverId, key: candidate.key }
  }
}
