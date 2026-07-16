import type { StorageAdapter } from "../StorageAdapter.js"
import type { ExpirationOptions } from "../types.js"
import { resolveExpirationSeconds } from "../utils.js"

export class ExpirationSettings {
  private defaultExpiration: ExpirationOptions | undefined
  private peerExpiration: Map<string, ExpirationOptions | null> = new Map()
  private groupExpiration: Map<string, ExpirationOptions | null> = new Map()

  constructor(
    private readonly storage: StorageAdapter,
    private readonly versionPrefix: string,
  ) {}

  get default(): ExpirationOptions | undefined {
    return this.defaultExpiration
  }

  peer(peerPubkey: string): ExpirationOptions | null | undefined {
    return this.peerExpiration.get(peerPubkey)
  }

  hasPeer(peerPubkey: string): boolean {
    return this.peerExpiration.has(peerPubkey)
  }

  group(groupId: string): ExpirationOptions | null | undefined {
    return this.groupExpiration.get(groupId)
  }

  hasGroup(groupId: string): boolean {
    return this.groupExpiration.has(groupId)
  }

  async load(): Promise<void> {
    const storedDefault = await this.storage.get<ExpirationOptions>(this.defaultKey())
    if (storedDefault) {
      try {
        this.validate(storedDefault)
        this.defaultExpiration = storedDefault
      } catch {
        // Ignore invalid stored values.
      }
    }

    for (const key of await this.storage.list(this.peerPrefix())) {
      const peer = key.slice(this.peerPrefix().length)
      if (!peer) continue
      const value = await this.storage.get<ExpirationOptions | null>(key)
      if (value === undefined) continue
      if (value === null) {
        this.peerExpiration.set(peer, null)
        continue
      }
      try {
        this.validate(value)
        this.peerExpiration.set(peer, value)
      } catch {
        // Ignore invalid stored values.
      }
    }

    for (const key of await this.storage.list(this.groupPrefix())) {
      const encoded = key.slice(this.groupPrefix().length)
      if (!encoded) continue
      let groupId: string
      try {
        groupId = decodeURIComponent(encoded)
      } catch {
        continue
      }
      const value = await this.storage.get<ExpirationOptions | null>(key)
      if (value === undefined) continue
      if (value === null) {
        this.groupExpiration.set(groupId, null)
        continue
      }
      try {
        this.validate(value)
        this.groupExpiration.set(groupId, value)
      } catch {
        // Ignore invalid stored values.
      }
    }
  }

  async setDefault(options: ExpirationOptions | undefined): Promise<void> {
    this.validate(options)
    this.defaultExpiration = options
    if (!options) {
      await this.storage.del(this.defaultKey()).catch(() => {})
      return
    }
    await this.storage.put(this.defaultKey(), options).catch(() => {})
  }

  async setPeer(
    peerPubkey: string,
    options: ExpirationOptions | null | undefined,
  ): Promise<void> {
    this.validate(options || undefined)
    if (options === undefined) {
      this.peerExpiration.delete(peerPubkey)
      await this.storage.del(this.peerKey(peerPubkey)).catch(() => {})
      return
    }
    this.peerExpiration.set(peerPubkey, options)
    await this.storage.put(this.peerKey(peerPubkey), options).catch(() => {})
  }

  async setGroup(
    groupId: string,
    options: ExpirationOptions | null | undefined,
  ): Promise<void> {
    this.validate(options || undefined)
    if (options === undefined) {
      this.groupExpiration.delete(groupId)
      await this.storage.del(this.groupKey(groupId)).catch(() => {})
      return
    }
    this.groupExpiration.set(groupId, options)
    await this.storage.put(this.groupKey(groupId), options).catch(() => {})
  }

  private defaultKey(): string {
    return `${this.versionPrefix}/expiration/default`
  }

  private peerPrefix(): string {
    return `${this.versionPrefix}/expiration/peer/`
  }

  private peerKey(peerPubkey: string): string {
    return `${this.peerPrefix()}${peerPubkey}`
  }

  private groupPrefix(): string {
    return `${this.versionPrefix}/expiration/group/`
  }

  private groupKey(groupId: string): string {
    return `${this.groupPrefix()}${encodeURIComponent(groupId)}`
  }

  private validate(options: ExpirationOptions | undefined): void {
    if (!options) return
    resolveExpirationSeconds(options, 0)
  }
}
