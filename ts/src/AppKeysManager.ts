import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools"
import {
  AppKeys,
  buildAppKeysFilter,
  createAppKeysProfileId,
  DeviceEntry,
  DeviceLabels,
} from "./AppKeys.js"
import { Invite } from "./Invite.js"
import { NostrSubscribe, NostrPublish, Unsubscribe } from "./types.js"
import { StorageAdapter, InMemoryStorageAdapter } from "./StorageAdapter.js"
import { SessionManager } from "./SessionManager.js"

export interface DelegatePayload {
  identityPubkey: string
  deviceLabel?: string
  clientLabel?: string
}

/**
 * Options for AppKeysManager (authority for AppKeys)
 */
export interface AppKeysManagerOptions {
  nostrPublish: NostrPublish
  storage?: StorageAdapter
  ownerIdentityKey?: Uint8Array
  ownerPubkey?: string
}

/**
 * Options for DelegateManager (device identity)
 */
export interface DelegateManagerOptions {
  nostrSubscribe: NostrSubscribe
  nostrPublish: NostrPublish
  storage?: StorageAdapter
}


/**
 * AppKeysManager - Authority for AppKeys.
 * Manages local AppKeys and publishes to relays.
 * Does NOT have device identity (no Invite, no SessionManager creation).
 */
export class AppKeysManager {
  private readonly nostrPublish: NostrPublish
  private readonly storage: StorageAdapter
  private readonly ownerIdentityKey?: Uint8Array
  private readonly ownerPubkey?: string

  private appKeys: AppKeys | null = null
  private appKeysProfileId: string | null = null
  private lastPublishedAppKeysCreatedAt = 0
  private initialized = false

  private readonly storageVersion = "3"
  private get versionPrefix(): string {
    return `v${this.storageVersion}`
  }

  constructor(options: AppKeysManagerOptions) {
    this.nostrPublish = options.nostrPublish
    this.storage = options.storage || new InMemoryStorageAdapter()
    this.ownerIdentityKey = options.ownerIdentityKey
    const keyPubkey = options.ownerIdentityKey ? getPublicKey(options.ownerIdentityKey) : undefined
    if (options.ownerPubkey && keyPubkey && options.ownerPubkey !== keyPubkey) {
      throw new Error("AppKeysManager ownerPubkey does not match ownerIdentityKey")
    }
    this.ownerPubkey = options.ownerPubkey ?? keyPubkey
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    // Load local only - no auto-subscribe, no auto-publish, no auto-merge
    this.appKeys = await this.loadAppKeys()
    if (!this.appKeys) {
      this.appKeys = new AppKeys()
    }
  }

  getAppKeys(): AppKeys | null {
    return this.appKeys
  }

  getOwnDevices(): DeviceEntry[] {
    return this.appKeys?.getAllDevices() || []
  }

  /**
   * Add a device to the AppKeys.
   * Only adds identity info - the device publishes its own Invite separately.
   * This is a local-only operation - call publish() to publish to relays.
   */
  addDevice(payload: DelegatePayload): void {
    if (!this.appKeys) {
      this.appKeys = new AppKeys()
    }

    const device: DeviceEntry = {
      identityPubkey: payload.identityPubkey,
      createdAt: Math.floor(Date.now() / 1000),
    }
    this.appKeys.addDevice(device)
    if (payload.deviceLabel || payload.clientLabel) {
      this.appKeys.setDeviceLabels(payload.identityPubkey, {
        deviceLabel: payload.deviceLabel,
        clientLabel: payload.clientLabel,
      })
    }
    this.saveAppKeys(this.appKeys).catch(() => {})
  }

  setDeviceLabels(
    identityPubkey: string,
    labels: {
      deviceLabel?: string
      clientLabel?: string
    }
  ): void {
    if (!this.appKeys) {
      this.appKeys = new AppKeys()
    }

    this.appKeys.setDeviceLabels(identityPubkey, labels)
    this.saveAppKeys(this.appKeys).catch(() => {})
  }

  getDeviceLabels(identityPubkey: string): DeviceLabels | undefined {
    return this.appKeys?.getDeviceLabels(identityPubkey)
  }

  /**
   * Revoke a device from the AppKeys.
   * This is a local-only operation - call publish() to publish to relays.
   */
  revokeDevice(identityPubkey: string): void {
    if (!this.appKeys) return

    this.appKeys.removeDevice(identityPubkey)
    this.saveAppKeys(this.appKeys).catch(() => {})
  }

  /**
   * Publish the current AppKeys to relays.
   * This is the only way to publish - addDevice/revokeDevice are local-only.
   */
  async publish(): Promise<void> {
    if (!this.appKeys) {
      this.appKeys = new AppKeys()
    }

    const ownerPubkey = this.ownerPubkey
    if (!ownerPubkey) {
      throw new Error("Owner pubkey is required to publish AppKeys")
    }
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      this.lastPublishedAppKeysCreatedAt + 1
    )
    const event = this.appKeys.getEvent({
      ownerPrivateKey: this.ownerIdentityKey,
      ownerPubkey,
      ...(ownerPubkey ? { profileId: await this.ensureAppKeysProfileId(ownerPubkey) } : {}),
      createdAt,
    })
    const published = await this.nostrPublish(event)
    this.lastPublishedAppKeysCreatedAt = published.created_at ?? createdAt
  }

  /**
   * Replace the local AppKeys with the given list and save to storage.
   * Used for authority transfer - receive list from another device, then call publish().
   */
  async setAppKeys(list: AppKeys): Promise<void> {
    this.appKeys = list
    await this.saveAppKeys(list)
  }

  /**
   * Cleanup resources. Currently a no-op but kept for API consistency.
   */
  close(): void {
    // No-op - no subscriptions to clean up
  }

  private appKeysKey(): string {
    return `${this.versionPrefix}/app-keys-manager/app-keys`
  }

  private appKeysProfileIdKey(ownerPubkey: string): string {
    return `${this.versionPrefix}/app-keys-manager/profile-id/${ownerPubkey}`
  }

  private async ensureAppKeysProfileId(ownerPubkey: string): Promise<string> {
    if (this.appKeysProfileId) return this.appKeysProfileId
    const key = this.appKeysProfileIdKey(ownerPubkey)
    const stored = await this.storage.get<string>(key)
    if (stored) {
      this.appKeysProfileId = stored
      return stored
    }
    const profileId = createAppKeysProfileId()
    await this.storage.put(key, profileId)
    this.appKeysProfileId = profileId
    return profileId
  }

  private async loadAppKeys(): Promise<AppKeys | null> {
    const data = await this.storage.get<string>(this.appKeysKey())
    if (!data) return null
    try {
      return AppKeys.deserialize(data)
    } catch {
      return null
    }
  }

  private async saveAppKeys(list: AppKeys): Promise<void> {
    await this.storage.put(this.appKeysKey(), list.serialize())
  }
}

/**
 * DelegateManager - Device identity manager.
 * ALL devices (including main) use this for their device identity.
 * Publishes own Invite events, used for SessionManager DH encryption.
 */
export class DelegateManager {
  private readonly nostrSubscribe: NostrSubscribe
  private readonly nostrPublish: NostrPublish
  private readonly storage: StorageAdapter

  private devicePublicKey: string = ""
  private devicePrivateKey: Uint8Array = new Uint8Array()

  private invite: Invite | null = null
  private ownerPubkeyFromActivation?: string
  private initialized = false
  private subscriptions: Unsubscribe[] = []

  private readonly storageVersion = "1"
  private get versionPrefix(): string {
    return `v${this.storageVersion}`
  }

  constructor(options: DelegateManagerOptions) {
    this.nostrSubscribe = options.nostrSubscribe
    this.nostrPublish = options.nostrPublish
    this.storage = options.storage || new InMemoryStorageAdapter()
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    // Load or generate identity keys
    const storedPublicKey = await this.storage.get<string>(this.identityPublicKeyKey())
    const storedPrivateKey = await this.storage.get<number[]>(this.identityPrivateKeyKey())

    if (storedPublicKey && storedPrivateKey) {
      this.devicePublicKey = storedPublicKey
      this.devicePrivateKey = new Uint8Array(storedPrivateKey)
    } else {
      this.devicePrivateKey = generateSecretKey()
      this.devicePublicKey = getPublicKey(this.devicePrivateKey)
      await this.storage.put(this.identityPublicKeyKey(), this.devicePublicKey)
      await this.storage.put(this.identityPrivateKeyKey(), Array.from(this.devicePrivateKey))
    }

    const storedOwnerPubkey = await this.storage.get<string>(this.ownerPubkeyKey())
    if (storedOwnerPubkey) {
      this.ownerPubkeyFromActivation = storedOwnerPubkey
    }

    // Load or create Invite for this device
    const savedInvite = await this.loadInvite()
    this.invite = savedInvite || Invite.createNew(this.devicePublicKey, this.devicePublicKey)
    await this.saveInvite(this.invite)

  }

  /**
   * Get the registration payload for adding this device to an AppKeysManager.
   * Must be called after init().
   */
  getRegistrationPayload(): DelegatePayload {
    return { identityPubkey: this.devicePublicKey }
  }

  getIdentityPublicKey(): string {
    return this.devicePublicKey
  }

  getIdentityKey(): Uint8Array {
    return this.devicePrivateKey
  }

  getInvite(): Invite | null {
    return this.invite
  }

  getOwnerPublicKey(): string | null {
    return this.ownerPubkeyFromActivation || null
  }

  /**
   * Publish the current device invite.
   * Clients should call this only after activation/session-manager setup so
   * invite responses are observed by the active listener.
   */
  async publishInvite(): Promise<void> {
    await this.init()

    if (!this.invite) {
      throw new Error("Invite not initialized")
    }

    const inviteEvent = this.invite.getEvent()
    const signedInvite = finalizeEvent(inviteEvent, this.devicePrivateKey)
    await this.nostrPublish(signedInvite)
  }

  /**
   * Rotate this device's invite - generates new ephemeral keys and shared secret.
   */
  async rotateInvite(): Promise<void> {
    await this.init()

    this.invite = Invite.createNew(this.devicePublicKey, this.devicePublicKey)
    await this.saveInvite(this.invite)
    await this.publishInvite()
  }

  /**
   * Activate this device with a known owner.
   * Use this when you know the device has been added (e.g., main device adding itself).
   * Skips fetching from relay - just stores the owner pubkey.
   */
  async activate(ownerPublicKey: string): Promise<void> {
    this.ownerPubkeyFromActivation = ownerPublicKey
    await this.storage.put(this.ownerPubkeyKey(), ownerPublicKey)
  }

  /**
   * Wait for this device to be activated (added to an AppKeys).
   * Returns the owner's public key once activated.
   * For delegate devices that don't know the owner ahead of time.
   */
  async waitForActivation(timeoutMs = 60000): Promise<string> {
    if (this.ownerPubkeyFromActivation) {
      return this.ownerPubkeyFromActivation
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error("Activation timeout"))
      }, timeoutMs)

      // Subscribe to all AppKeys events and look for our identityPubkey
      const unsubscribe = this.nostrSubscribe(
        buildAppKeysFilter(),
        async (event) => {
          try {
            const appKeys = AppKeys.fromEvent(event)
            const device = appKeys.getDevice(this.devicePublicKey)

            // Check that our identity pubkey is in the list
            if (device) {
              clearTimeout(timeout)
              unsubscribe()
              this.ownerPubkeyFromActivation = event.pubkey
              await this.storage.put(this.ownerPubkeyKey(), event.pubkey)
              resolve(event.pubkey)
            }
          } catch {
            // Invalid AppKeys
          }
        }
      )

      this.subscriptions.push(unsubscribe)
    })
  }

  /**
   * Check if this device has been revoked from the owner's AppKeys.
   * @param options.timeoutMs - Timeout for each attempt (default 2000ms)
   * @param options.retries - Number of retry attempts (default 2)
   */
  async isRevoked(options: { timeoutMs?: number; retries?: number } = {}): Promise<boolean> {
    const { timeoutMs = 2000, retries = 2 } = options
    const ownerPubkey = this.getOwnerPublicKey()
    if (!ownerPubkey) return false

    // Retry loop to handle slow relays
    for (let attempt = 0; attempt <= retries; attempt++) {
      const appKeys = await AppKeys.waitFor(ownerPubkey, this.nostrSubscribe, timeoutMs)
      if (appKeys) {
        const device = appKeys.getDevice(this.devicePublicKey)
        // Device is revoked if not in list
        return !device
      }
    }

    // No AppKeys found after all retries - assume revoked
    return true
  }

  close(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe()
    }
    this.subscriptions = []
  }

  /**
   * Create a SessionManager for this device.
   */
  createSessionManager(sessionStorage?: StorageAdapter): SessionManager {
    if (!this.initialized) {
      throw new Error("DelegateManager must be initialized before creating SessionManager")
    }

    const ownerPublicKey = this.getOwnerPublicKey()
    if (!ownerPublicKey) {
      throw new Error("Owner public key required for SessionManager - device must be activated first")
    }

    if (!this.invite || !this.invite.inviterEphemeralPrivateKey) {
      throw new Error("Invite with ephemeral keys required for SessionManager")
    }

    const ephemeralKeypair = {
      publicKey: this.invite.inviterEphemeralPublicKey,
      privateKey: this.invite.inviterEphemeralPrivateKey,
    }
    const sharedSecret = this.invite.sharedSecret

    return new SessionManager(
      this.devicePublicKey,
      this.devicePrivateKey,
      this.devicePublicKey, // Use identityPubkey as deviceId
      this.nostrSubscribe,
      this.nostrPublish,
      ownerPublicKey,
      { ephemeralKeypair, sharedSecret },
      sessionStorage || this.storage,
    )
  }

  createRuntimeSessionManager(sessionStorage?: StorageAdapter): SessionManager {
    if (!this.initialized) {
      throw new Error("DelegateManager must be initialized before creating SessionManager")
    }

    const ownerPublicKey = this.getOwnerPublicKey()
    if (!ownerPublicKey) {
      throw new Error("Owner public key required for SessionManager - device must be activated first")
    }

    if (!this.invite || !this.invite.inviterEphemeralPrivateKey) {
      throw new Error("Invite with ephemeral keys required for SessionManager")
    }

    const ephemeralKeypair = {
      publicKey: this.invite.inviterEphemeralPublicKey,
      privateKey: this.invite.inviterEphemeralPrivateKey,
    }
    const sharedSecret = this.invite.sharedSecret

    return SessionManager.createForRuntime(
      this.devicePublicKey,
      this.devicePrivateKey,
      this.devicePublicKey,
      ownerPublicKey,
      { ephemeralKeypair, sharedSecret },
      sessionStorage || this.storage,
    )
  }

  private ownerPubkeyKey(): string {
    return `${this.versionPrefix}/device-manager/owner-pubkey`
  }

  private inviteKey(): string {
    return `${this.versionPrefix}/device-manager/invite`
  }

  private async loadInvite(): Promise<Invite | null> {
    const data = await this.storage.get<string>(this.inviteKey())
    if (!data) return null
    try {
      return Invite.deserialize(data)
    } catch {
      return null
    }
  }

  private async saveInvite(invite: Invite): Promise<void> {
    await this.storage.put(this.inviteKey(), invite.serialize())
  }

  private identityPublicKeyKey(): string {
    return `${this.versionPrefix}/device-manager/identity-public-key`
  }

  private identityPrivateKeyKey(): string {
    return `${this.versionPrefix}/device-manager/identity-private-key`
  }
}
