import {
  AppKeys,
  applyAppKeysSnapshotPreservingLabels,
  buildAppKeysFilter,
} from "../AppKeys"
import type { Rumor } from "../types"
import type { VerifiedEvent } from "nostr-tools"
import { DeviceRecordActor } from "./DeviceRecordActor"
import type {
  Unsubscribe,
  UserRecord as UserRecordShape,
  UserRecordDeps,
  UserSetupState,
} from "./types"

export class UserRecordActor implements UserRecordShape {
  private static readonly RECENT_OWN_DEVICE_SESSION_GRACE_MS = 5 * 60 * 1000

  public appKeys?: AppKeys
  public state: UserSetupState = "new"
  public devices: Map<string, DeviceRecordActor> = new Map()
  public setupPromise?: Promise<void>

  private appKeysSubscription?: Unsubscribe
  private latestAppKeysCreatedAt = 0

  constructor(
    public readonly publicKey: string,
    private readonly deps: UserRecordDeps,
  ) {}

  private setState(nextState: UserSetupState): void {
    this.state = nextState
  }

  ensureDevice(deviceId: string, createdAt?: number): DeviceRecordActor {
    if (!deviceId) {
      throw new Error("Device record must include a deviceId")
    }
    const existing = this.devices.get(deviceId)
    if (existing) {
      return existing
    }
    const device = new DeviceRecordActor(deviceId, {
      ownerPubkey: this.publicKey,
      user: this,
      nostr: this.deps.nostr,
      messageQueue: this.deps.messageQueue,
      ourDeviceId: this.deps.ourDeviceId,
      ourOwnerPubkey: this.deps.ourOwnerPubkey,
      identityKey: this.deps.identityKey,
      createdAt,
    })
    this.devices.set(deviceId, device)
    return device
  }

  get appKeysCreatedAt(): number {
    return this.latestAppKeysCreatedAt
  }

  setAppKeys(
    appKeys: AppKeys | undefined,
    createdAt = this.latestAppKeysCreatedAt,
  ): void {
    this.appKeys = appKeys
    this.latestAppKeysCreatedAt = createdAt
  }

  async queueOutboundMessage(rumor: Rumor): Promise<void> {
    if (!this.appKeys) {
      await this.deps.discoveryQueue.add(this.publicKey, rumor)
      return
    }

    const deviceIds = this.getTargetDeviceIds()
    if (deviceIds.length === 0) {
      await this.deps.discoveryQueue.add(this.publicKey, rumor)
      return
    }

    for (const deviceId of deviceIds) {
      await this.deps.messageQueue.add(deviceId, rumor)
    }
  }

  ensureSetup(): Promise<void> {
    if (this.state === "ready") {
      return Promise.all(
        this.getTargetDeviceIds().map((deviceId) =>
          this.ensureDevice(deviceId).ensureSetup().catch(() => {})
        )
      ).then(() => {})
    }
    if (this.setupPromise) {
      return this.setupPromise
    }
    this.setupPromise = this.doEnsureSetup().finally(() => {
      this.setupPromise = undefined
    })
    return this.setupPromise
  }

  private async doEnsureSetup(): Promise<void> {
    this.ensureAppKeysSubscription()

    if (!this.appKeys) {
      this.setState("new")
      return
    }

    this.setState("appkeys-known")
    await this.expandDiscoveryQueue()

    for (const deviceId of this.getTargetDeviceIds()) {
      const device = this.ensureDevice(deviceId)
      device.ensureSetup().catch(() => {})
    }

    this.setState("ready")
  }

  async onAppKeys(appKeys: AppKeys, createdAt = 0): Promise<void> {
    this.appKeys = appKeys
    this.latestAppKeysCreatedAt = Math.max(this.latestAppKeysCreatedAt, createdAt)
    this.setState("appkeys-known")
    this.deps.manager.updateDelegateMapping(this.publicKey, appKeys)

    const activeIds = new Set(
      appKeys.getAllDevices()
        .map((d) => d.identityPubkey)
        .filter(Boolean) as string[]
    )
    const activeTargetIds = [...activeIds].filter(
      (deviceId) => deviceId !== this.deps.ourDeviceId
    )

    for (const [deviceId, device] of this.devices) {
      if (!activeIds.has(deviceId)) {
        const isNewerOwnDeviceSession =
          this.publicKey === this.deps.ourOwnerPubkey &&
          Boolean(device.activeSession) &&
          Math.floor(device.createdAt / 1000) >= createdAt
        const isRecentOwnDeviceSession =
          this.publicKey === this.deps.ourOwnerPubkey &&
          Boolean(device.activeSession) &&
          Date.now() - device.createdAt <=
            UserRecordActor.RECENT_OWN_DEVICE_SESSION_GRACE_MS
        if (isNewerOwnDeviceSession || isRecentOwnDeviceSession) {
          continue
        }
        await this.migrateQueuedMessagesFromDevice(deviceId, activeTargetIds)
        await device.revoke()
        this.devices.delete(deviceId)
        this.deps.manager.removeDelegateMapping(deviceId)
      }
    }

    for (const deviceId of activeIds) {
      this.ensureDevice(deviceId)
    }

    await this.expandDiscoveryQueue()

    await Promise.all(
      this.getTargetDeviceIds().map((deviceId) =>
        this.devices.get(deviceId)?.ensureSetup().catch(() => {})
      )
    )

    this.setState("ready")
    this.onDeviceDirty()
  }

  private async migrateQueuedMessagesFromDevice(
    staleDeviceId: string,
    targetDeviceIds: string[],
  ): Promise<void> {
    const entries = await this.deps.messageQueue.getForTarget(staleDeviceId)
    if (entries.length === 0) {
      return
    }

    if (targetDeviceIds.length === 0) {
      for (const entry of entries) {
        await this.deps.discoveryQueue.add(this.publicKey, entry.event)
      }
      return
    }

    for (const entry of entries) {
      for (const targetDeviceId of targetDeviceIds) {
        await this.deps.messageQueue.add(targetDeviceId, entry.event)
      }
    }
  }

  private ensureAppKeysSubscription(): void {
    if (this.appKeysSubscription) {
      return
    }

    this.appKeysSubscription = this.deps.nostr.subscribe(
      `app-keys-${this.publicKey}`,
      buildAppKeysFilter(this.publicKey),
      (event) => {
        this.processAppKeysEvent(event).catch(() => {})
      }
    )
  }

  async processAppKeysEvent(event: VerifiedEvent): Promise<boolean> {
    if (event.pubkey !== this.publicKey) return false
    try {
      const appKeys = AppKeys.fromEvent(event)
      const next = applyAppKeysSnapshotPreservingLabels({
        currentAppKeys: this.appKeys,
        currentCreatedAt: this.latestAppKeysCreatedAt,
        incomingAppKeys: appKeys,
        incomingCreatedAt: event.created_at,
      })
      if (next.decision === "stale") {
        return false
      }
      await this.onAppKeys(next.appKeys, next.createdAt)
      return true
    } catch {
      return false
    }
  }

  private async expandDiscoveryQueue(): Promise<void> {
    const entries = await this.deps.discoveryQueue.getForTarget(this.publicKey)
    if (entries.length === 0) {
      return
    }

    const deviceIds = this.getTargetDeviceIds()
    if (deviceIds.length === 0) {
      return
    }

    for (const entry of entries) {
      let expandedForAllDevices = true
      for (const deviceId of deviceIds) {
        try {
          await this.deps.messageQueue.add(deviceId, entry.event)
        } catch {
          expandedForAllDevices = false
        }
      }

      if (expandedForAllDevices) {
        await this.deps.discoveryQueue.remove(entry.id).catch(() => {})
      }
    }
  }

  private getTargetDeviceIds(): string[] {
    if (!this.appKeys) {
      return []
    }
    return this.appKeys.getAllDevices()
      .map((d) => d.identityPubkey)
      .filter((deviceId): deviceId is string =>
        Boolean(deviceId) && deviceId !== this.deps.ourDeviceId
      )
  }

  isDeviceAuthorized(deviceId: string): boolean {
    if (this.publicKey === deviceId) {
      return true
    }
    if (!this.appKeys) return false
    return this.appKeys.getAllDevices().some((d) => d.identityPubkey === deviceId)
  }

  onDeviceRumor(
    deviceId: string,
    rumor: Rumor,
    outerEvent?: VerifiedEvent,
  ): void {
    this.deps.manager.handleDeviceRumor(this.publicKey, deviceId, rumor, outerEvent)
  }

  onDeviceDirty(): void {
    this.deps.manager.persistUserRecord(this.publicKey)
  }

  deactivateCurrentSessions(): void {
    for (const device of this.devices.values()) {
      device.deactivateCurrentSession()
    }
  }

  close(): void {
    this.appKeysSubscription?.()
    this.appKeysSubscription = undefined
    for (const device of this.devices.values()) {
      device.close()
    }
  }
}
