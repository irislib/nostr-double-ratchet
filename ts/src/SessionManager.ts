import {
  IdentityKey,
  NostrSubscribe,
  NostrPublish,
  Rumor,
  Unsubscribe,
  CHAT_MESSAGE_KIND,
  CHAT_SETTINGS_KIND,
  RECEIPT_KIND,
  TYPING_KIND,
  ReceiptType,
  ExpirationOptions,
  ChatSettingsPayloadV1,
  MESSAGE_EVENT_KIND,
  INVITE_EVENT_KIND,
  INVITE_RESPONSE_KIND,
} from "./types"
import { StorageAdapter, InMemoryStorageAdapter } from "./StorageAdapter"
import {
  OutboundIntentQueue,
  RuntimeState,
  serializeUserRecords,
  type PreparedPublish,
  type PreparedPublishInput,
  type PreparedTransitionContext,
} from "./RuntimeState"
import { AppKeys, isAppKeysEvent } from "./AppKeys"
import { Invite } from "./Invite"
import { Session } from "./Session"
import { resolveInviteOwnerRouting } from "./multiDevice"
import { decryptInviteResponse, createSessionFromAccept } from "./inviteUtils"
import { type VerifiedEvent } from "nostr-tools"
import {
  buildRumorEvent,
  ensureMsTag,
  ensureRecipientTag,
} from "./messageBuilders"
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
} from "./MessageOrigin"
import { DeviceRecordActor } from "./session-manager/DeviceRecordActor"
import { ExpirationSettings } from "./session-manager/expirationSettings"
import { planInviteBootstrapEvent } from "./session-manager/inviteBootstrap"
import {
  collectAllMessagePushAuthorPubkeys,
  collectMessagePushAuthorPubkeys,
} from "./session-manager/messageAuthors"
import {
  applyExpirationPolicy,
  chatSettingsAdoptionForRumor,
  expirationOverrideFromSendOptions,
} from "./session-manager/messagePolicy"
import {
  queuedMessageDiagnostics,
  type QueuedMessageDiagnostic,
} from "./session-manager/queueDiagnostics"
import {
  sessionCanReceive,
  sessionCanSend,
  sessionHasActivity,
} from "./session-manager/sessionSelection"
import { UserRecordActor } from "./session-manager/UserRecordActor"
import { hydrateUserRecord } from "./session-manager/userRecordHydration"
import { deepCopyState } from "./utils"
import type {
  AcceptInviteOptions,
  AcceptInviteResult,
  DeviceRecord,
  InviteCredentials,
  NostrFacade,
  OnEventCallback,
  OnEventMeta,
  SessionManagerEvent,
  SessionManagerEventCallback,
  OutboundMutation,
  UserRecord,
} from "./session-manager/types"

export type {
  AcceptInviteOptions,
  AcceptInviteResult,
  DeviceRecord,
  InviteCredentials,
  OnEventCallback,
  OnEventMeta,
  SessionManagerEvent,
  SessionManagerEventCallback,
  UserRecord,
} from "./session-manager/types"

export type {
  QueuedMessageDiagnostic,
  QueuedMessageStage,
} from "./session-manager/queueDiagnostics"

export interface SendMessageOptions extends ExpirationOptions {
  kind?: number
  tags?: string[][]
  expiration?: ExpirationOptions | null
}

type PendingInviteResponse = {
  eventId: string
  ownerPublicKey: string
  deviceId: string
  inviteeSessionPublicKey: string
  ephemeralPrivateKey: Uint8Array
  sharedSecret: string
}

const MAX_PENDING_DIRECT_MESSAGES = 1000

export class SessionManager {
  // Params
  private deviceId: string
  private storage: StorageAdapter
  private legacyNostrSubscribe?: NostrSubscribe
  private legacyNostrPublish?: NostrPublish
  private identityKey: IdentityKey
  private ourPublicKey: string
  // Owner's public key - used for grouping devices together (all devices are delegates)
  private ownerPublicKey: string
  private nostrFacade: NostrFacade

  // Credentials for invite handshake
  private inviteKeys: InviteCredentials

  // Data
  private userRecords: Map<string, UserRecordActor> = new Map()
  private runtimeState: RuntimeState
  private messageQueue: OutboundIntentQueue
  private discoveryQueue: OutboundIntentQueue
  // Map delegate device pubkeys to their owner's pubkey
  private delegateToOwner: Map<string, string> = new Map()
  // Track processed InviteResponse event IDs to prevent replay
  private processedInviteResponses: Set<string> = new Set()
  private pendingInviteResponses: Map<string, PendingInviteResponse> = new Map()
  private pendingDirectMessages: Map<string, VerifiedEvent> = new Map()
  private inviteAcceptPromises: Map<string, Promise<AcceptInviteResult>> = new Map()
  private expirationSettings!: ExpirationSettings
  private autoAdoptChatSettings: boolean = true

  private userSetupPromises: Map<string, Promise<void>> = new Map()

  // Subscriptions
  private ourInviteResponseSubscription: Unsubscribe | null = null
  private legacyRuntimeSubscriptions: Map<string, Unsubscribe> = new Map()
  private legacyDirectMessageSubscription: Unsubscribe | null = null
  private legacyDirectMessageAuthors: string[] = []

  // Callbacks
  private internalSubscriptions: Set<OnEventCallback> = new Set()
  private messagePushAuthorCallbacks: Set<() => void> = new Set()
  private runtimeEventCallbacks: Set<SessionManagerEventCallback> = new Set()
  private preparedPublishCallbacks: Set<() => void> = new Set()
  private preparedPublishDrainPromise: Promise<void> | null = null

  // Initialization flag
  private initialized: boolean = false

  constructor(
    ourPublicKey: string,
    identityKey: IdentityKey,
    deviceId: string,
    nostrSubscribe: NostrSubscribe,
    nostrPublish: NostrPublish,
    ownerPublicKey: string,
    inviteKeys: InviteCredentials,
    storage?: StorageAdapter,
  ) {
    this.userRecords = new Map()
    this.legacyNostrSubscribe = nostrSubscribe
    this.legacyNostrPublish = nostrPublish
    this.ourPublicKey = ourPublicKey
    this.identityKey = identityKey
    this.deviceId = deviceId
    this.ownerPublicKey = ownerPublicKey
    this.inviteKeys = inviteKeys
    this.storage = storage || new InMemoryStorageAdapter()
    this.runtimeState = new RuntimeState(this.storage)
    this.messageQueue = new OutboundIntentQueue(this.runtimeState, "device")
    this.discoveryQueue = new OutboundIntentQueue(this.runtimeState, "discovery")
    this.expirationSettings = new ExpirationSettings(this.storage, "v1")
    this.nostrFacade = {
      subscribe: (subid, filter, onEvent) => this.emitSubscribe(subid, filter, onEvent),
    }
  }

  static createForRuntime(
    ourPublicKey: string,
    identityKey: IdentityKey,
    deviceId: string,
    ownerPublicKey: string,
    inviteKeys: InviteCredentials,
    storage?: StorageAdapter,
  ): SessionManager {
    const noopSubscribe: NostrSubscribe = () => () => {}
    const noopPublish: NostrPublish = async (event) => event as VerifiedEvent
    const manager = new SessionManager(
      ourPublicKey,
      identityKey,
      deviceId,
      noopSubscribe,
      noopPublish,
      ownerPublicKey,
      inviteKeys,
      storage,
    )
    manager.legacyNostrSubscribe = undefined
    manager.legacyNostrPublish = undefined
    return manager
  }

  onRuntimeEvent(callback: SessionManagerEventCallback): Unsubscribe {
    this.runtimeEventCallbacks.add(callback)
    return () => {
      this.runtimeEventCallbacks.delete(callback)
    }
  }

  onPreparedPublishesAvailable(callback: () => void): Unsubscribe {
    this.preparedPublishCallbacks.add(callback)
    return () => {
      this.preparedPublishCallbacks.delete(callback)
    }
  }

  pendingPublishes(): PreparedPublish[] {
    return this.runtimeState.preparedPublishes()
  }

  acknowledgePublish(id: string): Promise<void> {
    return this.runtimeState.acknowledgePublish(id)
  }

  publishFailed(id: string, error: unknown): Promise<void> {
    return this.runtimeState.publishFailed(
      id,
      error instanceof Error ? error.message : String(error),
    )
  }

  private async emitEvent(event: SessionManagerEvent): Promise<void> {
    this.handleLegacyRuntimeEvent(event)
    await Promise.allSettled(
      Array.from(this.runtimeEventCallbacks, (callback) => callback(event))
    )
  }

  private handleLegacyRuntimeEvent(event: SessionManagerEvent): void {
    if (event.type === "decryptedMessage") {
      for (const cb of this.internalSubscriptions) {
        cb(event.event, event.sender, event.meta)
      }
      return
    }

    if (event.type === "subscribe") {
      if (!this.legacyNostrSubscribe) return
      this.legacyRuntimeSubscriptions.get(event.subid)?.()
      const unsubscribe = this.legacyNostrSubscribe(event.filter, (received) => {
        this.processReceivedEvent(received)
      })
      this.legacyRuntimeSubscriptions.set(event.subid, unsubscribe)
      return
    }

    if (event.type === "unsubscribe") {
      this.legacyRuntimeSubscriptions.get(event.subid)?.()
      this.legacyRuntimeSubscriptions.delete(event.subid)
    }
  }

  private emitSubscribe(
    subid: string,
    filter: Parameters<NostrFacade["subscribe"]>[1],
    onEvent?: Parameters<NostrFacade["subscribe"]>[2],
  ): Unsubscribe {
    if (this.legacyNostrSubscribe && onEvent) {
      this.legacyRuntimeSubscriptions.get(subid)?.()
      const cleanup = this.legacyNostrSubscribe(filter, onEvent)
      this.legacyRuntimeSubscriptions.set(subid, cleanup)
      return () => {
        this.legacyRuntimeSubscriptions.get(subid)?.()
        this.legacyRuntimeSubscriptions.delete(subid)
      }
    }

    void this.emitEvent({ type: "subscribe", subid, filter })
    return () => {
      void this.emitEvent({ type: "unsubscribe", subid })
    }
  }

  private async commitOutbound<T>(
    mutate: (context: PreparedTransitionContext) => OutboundMutation<T>,
    checkpoint: () => () => void,
  ): Promise<T> {
    const result = await this.runtimeState.commitPreparedTransition(
      (context) => {
        const transition = mutate(context)
        return {
          result: transition.result,
          userRecords: serializeUserRecords(this.userRecords),
          publishes: transition.publishes,
        }
      },
      checkpoint,
    )
    this.notifyPreparedPublishes()
    if (this.legacyNostrPublish) {
      void this.drainPendingPublishes(this.legacyNostrPublish)
    }
    return result
  }

  private notifyPreparedPublishes(): void {
    if (this.pendingPublishes().length === 0) return
    for (const callback of this.preparedPublishCallbacks) {
      try {
        callback()
      } catch {
        // Durable ownership has already transferred to the outbox.
      }
    }
  }

  async drainPendingPublishes(publish: NostrPublish): Promise<void> {
    if (this.preparedPublishDrainPromise) {
      return this.preparedPublishDrainPromise
    }

    this.preparedPublishDrainPromise = (async () => {
      const attempted = new Set<string>()
      while (true) {
        const prepared = this.pendingPublishes()
          .filter((entry) => !attempted.has(entry.id))
        if (prepared.length === 0) return

        for (const entry of prepared) {
          attempted.add(entry.id)
          try {
            await publish(entry.event, entry.innerEventId)
            await this.acknowledgePublish(entry.id)
          } catch (error) {
            await this.publishFailed(entry.id, error).catch(() => {})
          }
        }
      }
    })().finally(() => {
      this.preparedPublishDrainPromise = null
    })

    return this.preparedPublishDrainPromise
  }

  async init() {
    if (this.initialized) return
    this.initialized = true

    await this.runtimeState.init()
    this.hydrateUserRecords(this.runtimeState.userRecords())

    await this.expirationSettings.load().catch(() => {
      // Failed to load expiration settings
    })

    // Add our own device to user record to prevent accepting our own invite
    // Use ownerPublicKey so delegates are added to the owner's record
    const ourUserRecord = this.getOrCreateUserRecord(this.ownerPublicKey)
    this.upsertDeviceRecord(ourUserRecord, this.deviceId)

    // Start invite response listener BEFORE setting up users
    // This ensures we're listening when other devices respond to our invites
    this.startInviteResponseListener()

    // Setup sessions with our own devices and resume discovery for all known users
    Array.from(this.userRecords.keys()).forEach(pubkey => this.setupUser(pubkey))

    const pendingPublishes = this.pendingPublishes()
    if (pendingPublishes.length > 0) {
      this.notifyPreparedPublishes()
      if (this.legacyNostrPublish) {
        void this.drainPendingPublishes(this.legacyNostrPublish)
      }
    }
  }

  /**
   * Start listening for invite responses on our ephemeral key.
   * This is used by devices to receive session establishment responses.
   */
  private startInviteResponseListener(): void {
    const { publicKey: ephemeralPubkey } = this.inviteKeys.ephemeralKeypair

    this.ourInviteResponseSubscription = this.emitSubscribe(
      `invite-responses-${ephemeralPubkey}`,
      {
        kinds: [INVITE_RESPONSE_KIND],
        "#p": [ephemeralPubkey],
      }
    )
  }

  private fetchAppKeysSnapshot(
    pubkey: string,
    timeoutMs = 2000,
  ): Promise<{ appKeys: AppKeys; createdAt: number } | null> {
    if (!this.legacyNostrSubscribe) {
      return Promise.resolve(null)
    }
    return AppKeys.waitForSnapshot(pubkey, this.legacyNostrSubscribe, timeoutMs)
  }

  // -------------------
  // User and Device Records helpers
  // -------------------
  private getOrCreateUserRecord(userPubkey: string): UserRecordActor {
    let rec = this.userRecords.get(userPubkey)
    if (!rec) {
      rec = new UserRecordActor(userPubkey, {
        manager: {
          updateDelegateMapping: (ownerPubkey, appKeys) => {
            this.updateDelegateMapping(ownerPubkey, appKeys)
          },
          removeDelegateMapping: (deviceId) => {
            this.delegateToOwner.delete(deviceId)
          },
          handleDeviceRumor: (ownerPubkey, deviceId, rumor, outerEvent) => {
            this.handleDeviceRumor(ownerPubkey, deviceId, rumor, outerEvent)
          },
          persistUserRecord: (ownerPubkey) => {
            this.storeUserRecord(ownerPubkey).catch(() => {})
            this.notifyMessagePushAuthorsChanged()
          },
          commitOutbound: (mutate, checkpoint) =>
            this.commitOutbound(mutate, checkpoint),
        },
        nostr: this.nostrFacade,
        messageQueue: this.messageQueue,
        discoveryQueue: this.discoveryQueue,
        ourDeviceId: this.deviceId,
        ourOwnerPubkey: this.ownerPublicKey,
        identityKey: this.identityKey,
      })
      this.userRecords.set(userPubkey, rec)
    }
    return rec
  }

  private handleDeviceRumor(
    ownerPubkey: string,
    deviceId: string,
    event: Rumor,
    outerEvent?: VerifiedEvent,
  ): void {
    const userRecord = this.userRecords.get(ownerPubkey)
    const knownDevice =
      ownerPubkey === deviceId ||
      userRecord?.appKeys?.getAllDevices().some((device) => device.identityPubkey === deviceId) ||
      false

    if (
      ownerPubkey !== this.ownerPublicKey &&
      (!userRecord?.appKeys || !knownDevice)
    ) {
      this.setupUser(ownerPubkey).catch(() => {})
    }

    this.maybeAutoAdoptChatSettings(event, ownerPubkey)

    const origin = classifyMessageOrigin({
      ourOwnerPubkey: this.ownerPublicKey,
      ourDevicePubkey: this.deviceId,
      senderOwnerPubkey: ownerPubkey,
      senderDevicePubkey: deviceId,
    })

    const meta: OnEventMeta = {
      fromDeviceId: deviceId,
      outerEventId: outerEvent?.id,
      senderOwnerPubkey: ownerPubkey,
      senderDevicePubkey: deviceId,
      origin,
      isSelf: isSelfOrigin(origin),
      isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
    }

    void this.emitEvent({
      type: "decryptedMessage",
      event,
      sender: ownerPubkey,
      senderDevice: deviceId,
      meta,
    })
  }

  private upsertDeviceRecord(userRecord: UserRecordActor, deviceId: string): DeviceRecordActor {
    return userRecord.ensureDevice(deviceId)
  }

  /**
   * Resolve a pubkey to its owner if it's a known delegate device.
   * Returns the input pubkey if not a known delegate.
   */
  private resolveToOwner(pubkey: string): string {
    return this.delegateToOwner.get(pubkey) || pubkey
  }

  /**
   * Update the delegate-to-owner mapping from an AppKeys.
   * Extracts delegate device pubkeys and maps them to the owner.
   * Persists the mapping in the user record for restart recovery.
   */
  private updateDelegateMapping(ownerPubkey: string, appKeys: AppKeys): void {
    const userRecord = this.getOrCreateUserRecord(ownerPubkey)
    const newDeviceIdentities = new Set(
      appKeys.getAllDevices()
        .map(d => d.identityPubkey)
        .filter(Boolean) as string[]
    )

    // Remove stale mappings for devices no longer in AppKeys
    const oldIdentities = (userRecord.appKeys?.getAllDevices() || [])
      .map(d => d.identityPubkey)
      .filter(Boolean) as string[]
    for (const identity of oldIdentities) {
      if (!newDeviceIdentities.has(identity)) {
        this.delegateToOwner.delete(identity)
        this.messageQueue.removeForTarget(identity).catch(() => {})
      }
    }

    // Store AppKeys in user record (single source of truth)
    userRecord.appKeys = appKeys

    // Update in-memory mapping for current devices
    for (const identity of newDeviceIdentities) {
      this.delegateToOwner.set(identity, ownerPubkey)
    }

    this.retryPendingInviteResponses(ownerPubkey, appKeys)

    // Persist
    this.storeUserRecord(ownerPubkey).catch(() => {})
  }

  private queuePendingInviteResponse(response: PendingInviteResponse): void {
    if (this.pendingInviteResponses.has(response.eventId)) {
      return
    }

    if (this.pendingInviteResponses.size >= 1000) {
      const oldest = this.pendingInviteResponses.keys().next().value
      if (oldest) {
        this.pendingInviteResponses.delete(oldest)
      }
    }

    this.pendingInviteResponses.set(response.eventId, response)
  }

  private queuePendingDirectMessage(event: VerifiedEvent): void {
    if (this.pendingDirectMessages.has(event.id)) {
      return
    }

    if (this.pendingDirectMessages.size >= MAX_PENDING_DIRECT_MESSAGES) {
      const oldest = this.pendingDirectMessages.keys().next().value
      if (oldest) {
        this.pendingDirectMessages.delete(oldest)
      }
    }

    this.pendingDirectMessages.set(event.id, event)
  }

  private processDirectMessageEvent(event: VerifiedEvent): boolean {
    for (const userRecord of this.userRecords.values()) {
      for (const device of userRecord.devices.values()) {
        if (device.processReceivedEvent(event)) {
          this.syncLegacyDirectMessageSubscription()
          this.pendingDirectMessages.delete(event.id)
          return true
        }
      }
    }

    return false
  }

  private retryPendingDirectMessages(): void {
    for (const event of Array.from(this.pendingDirectMessages.values())) {
      this.processDirectMessageEvent(event)
    }
  }

  private installInviteResponseSession(
    response: PendingInviteResponse,
    appKeys?: AppKeys | null,
  ): boolean {
    const isSingleDevice = response.deviceId === response.ownerPublicKey
    const isAuthorized =
      isSingleDevice ||
      (
        appKeys?.getAllDevices().some(
          (device) => device.identityPubkey === response.deviceId
        ) ?? false
      )

    if (!isAuthorized) {
      return false
    }

    const userRecord = this.getOrCreateUserRecord(response.ownerPublicKey)
    const deviceRecord = this.upsertDeviceRecord(userRecord, response.deviceId)

    const session = createSessionFromAccept({
      theirPublicKey: response.inviteeSessionPublicKey,
      ourSessionPrivateKey: response.ephemeralPrivateKey,
      sharedSecret: response.sharedSecret,
      isSender: false,
      name: response.eventId,
    })

    deviceRecord.installSession(session, true)
    this.pendingInviteResponses.delete(response.eventId)
    this.processedInviteResponses.add(response.eventId)
    this.storeUserRecord(response.ownerPublicKey).catch(() => {})
    this.notifyMessagePushAuthorsChanged()
    this.retryPendingDirectMessages()
    return true
  }

  private retryPendingInviteResponses(ownerPubkey: string, appKeys?: AppKeys): void {
    for (const response of this.pendingInviteResponses.values()) {
      if (response.ownerPublicKey !== ownerPubkey) {
        continue
      }

      this.installInviteResponseSession(response, appKeys)
    }
  }

  /**
   * Check if a device is currently authorized by the owner's AppKeys.
   * Returns true if the device is in the owner's current AppKeys.
   */
  private isDeviceAuthorized(ownerPubkey: string, deviceId: string): boolean {
    const appKeys = this.userRecords.get(ownerPubkey)?.appKeys
    if (!appKeys) return false
    return appKeys.getAllDevices().some(d => d.identityPubkey === deviceId)
  }

  async setupUser(userPubkey: string): Promise<void> {
    const existing = this.userSetupPromises.get(userPubkey)
    if (existing) {
      return existing
    }

    const setupPromise = this.doSetupUser(userPubkey).finally(() => {
      if (this.userSetupPromises.get(userPubkey) === setupPromise) {
        this.userSetupPromises.delete(userPubkey)
      }
    })
    this.userSetupPromises.set(userPubkey, setupPromise)
    return setupPromise
  }

  private async doSetupUser(userPubkey: string): Promise<void> {
    const userRecord = this.getOrCreateUserRecord(userPubkey)
    await userRecord.ensureSetup().catch(() => {})

    const latestAppKeys = await this.fetchAppKeysSnapshot(userPubkey, 50).catch(() => null)
    if (latestAppKeys) {
      await userRecord
        .applyAppKeysSnapshot(latestAppKeys.appKeys, latestAppKeys.createdAt)
        .catch(() => {})
      return
    }

    const shouldTrySingleDeviceInviteFallback =
      userPubkey !== this.ownerPublicKey || this.deviceId === this.ownerPublicKey

    if (
      shouldTrySingleDeviceInviteFallback &&
      !userRecord.appKeys &&
      !userRecord.devices.has(userPubkey)
    ) {
      const directDevice = this.upsertDeviceRecord(userRecord, userPubkey)
      await directDevice.ensureSetup().catch(() => {})
      await this.storeUserRecord(userPubkey).catch(() => {})
    }
  }

  onEvent(callback: OnEventCallback) {
    this.internalSubscriptions.add(callback)

    return () => {
      this.internalSubscriptions.delete(callback)
    }
  }

  onMessagePushAuthorsChanged(callback: () => void): Unsubscribe {
    this.messagePushAuthorCallbacks.add(callback)
    callback()
    return () => {
      this.messagePushAuthorCallbacks.delete(callback)
    }
  }

  private notifyMessagePushAuthorsChanged(): void {
    for (const callback of this.messagePushAuthorCallbacks) {
      callback()
    }
    this.syncLegacyDirectMessageSubscription()
  }

  private syncLegacyDirectMessageSubscription(): void {
    if (!this.legacyNostrSubscribe) return
    const nextAuthors = this.getAllMessagePushAuthorPubkeys()
    if (
      nextAuthors.length === this.legacyDirectMessageAuthors.length &&
      nextAuthors.every((author, index) => author === this.legacyDirectMessageAuthors[index])
    ) {
      return
    }

    this.legacyDirectMessageSubscription?.()
    this.legacyDirectMessageSubscription = null
    this.legacyDirectMessageAuthors = nextAuthors
    if (nextAuthors.length === 0) {
      return
    }

    this.legacyDirectMessageSubscription = this.legacyNostrSubscribe(
      {
        kinds: [MESSAGE_EVENT_KIND],
        authors: nextAuthors,
      },
      (event) => {
        this.processReceivedEvent(event)
      }
    )
  }

  /**
   * Enable/disable automatically adopting incoming `chat-settings` events (kind 10448).
   * When enabled, receiving a valid settings payload updates per-peer expiration defaults.
   */
  setAutoAdoptChatSettings(enabled: boolean) {
    this.autoAdoptChatSettings = enabled
  }

  getDeviceId(): string {
    return this.deviceId
  }

  getUserRecords(): Map<string, UserRecord> {
    return this.userRecords as unknown as Map<string, UserRecord>
  }

  getMessagePushAuthorPubkeys(peerPubkey: string): string[] {
    const ownerPubkey = this.resolveToOwner(peerPubkey)
    const userRecord = this.userRecords.get(ownerPubkey)
    return collectMessagePushAuthorPubkeys(userRecord)
  }

  getKnownDeviceIdentityPubkeysForOwner(ownerPubkey: string): string[] {
    const owner = this.resolveToOwner(ownerPubkey)
    const userRecord = this.userRecords.get(owner)
    if (!userRecord) {
      return []
    }

    const devices = new Set<string>()
    for (const device of userRecord.appKeys?.getAllDevices() ?? []) {
      if (device.identityPubkey) {
        devices.add(device.identityPubkey)
      }
    }
    for (const deviceId of userRecord.devices.keys()) {
      devices.add(deviceId)
    }
    return [...devices].sort()
  }

  getAllMessagePushAuthorPubkeys(): string[] {
    return collectAllMessagePushAuthorPubkeys(this.userRecords.values())
  }

  feedEvent(event: VerifiedEvent): boolean {
    return this.processReceivedEvent(event)
  }

  processReceivedEvent(event: VerifiedEvent): boolean {
    if (isAppKeysEvent(event)) {
      void this.processAppKeysEvent(event).then(() => {
        this.retryPendingDirectMessages()
      })
      return true
    }

    if (event.kind === INVITE_RESPONSE_KIND) {
      void this.processInviteResponseEvent(event).then(() => {
        this.retryPendingDirectMessages()
      })
      return true
    }

    if (event.kind === INVITE_EVENT_KIND) {
      void this.processInviteEvent(event)
      return true
    }

    if (event.kind !== MESSAGE_EVENT_KIND) {
      return false
    }

    if (this.processDirectMessageEvent(event)) {
      return true
    }

    this.queuePendingDirectMessage(event)
    return false
  }

  private async processAppKeysEvent(event: VerifiedEvent): Promise<boolean> {
    const userRecord = this.getOrCreateUserRecord(event.pubkey)
    return userRecord.processAppKeysEvent(event)
  }

  private async processInviteResponseEvent(event: VerifiedEvent): Promise<boolean> {
    if (
      this.processedInviteResponses.has(event.id) ||
      this.pendingInviteResponses.has(event.id)
    ) {
      return false
    }

    try {
      const { privateKey: ephemeralPrivkey } = this.inviteKeys.ephemeralKeypair
      const decrypted = await decryptInviteResponse({
        envelopeContent: event.content,
        envelopeSenderPubkey: event.pubkey,
        inviterEphemeralPrivateKey: ephemeralPrivkey,
        inviterPrivateKey: this.identityKey instanceof Uint8Array ? this.identityKey : undefined,
        sharedSecret: this.inviteKeys.sharedSecret,
        decrypt: this.identityKey instanceof Uint8Array ? undefined : this.identityKey.decrypt,
      })

      if (decrypted.inviteeIdentity === this.deviceId) {
        return false
      }

      const claimedOwner = decrypted.ownerPublicKey || this.resolveToOwner(decrypted.inviteeIdentity)
      const pendingResponse: PendingInviteResponse = {
        eventId: event.id,
        ownerPublicKey: claimedOwner,
        deviceId: decrypted.inviteeIdentity,
        inviteeSessionPublicKey: decrypted.inviteeSessionPublicKey,
        ephemeralPrivateKey: ephemeralPrivkey,
        sharedSecret: this.inviteKeys.sharedSecret,
      }

      const persistedAppKeys = this.userRecords.get(claimedOwner)?.appKeys
      if (this.installInviteResponseSession(pendingResponse, persistedAppKeys)) {
        return true
      }

      this.queuePendingInviteResponse(pendingResponse)
      await this.setupUser(claimedOwner).catch(() => {})
      return true
    } catch {
      return false
    }
  }

  private async processInviteEvent(event: VerifiedEvent): Promise<boolean> {
    let invite: Invite
    try {
      invite = Invite.fromEvent(event)
    } catch {
      return false
    }

    const deviceId = invite.deviceId || invite.inviter
    if (!deviceId) {
      return false
    }
    if (deviceId === this.deviceId) {
      return false
    }

    let handled = false
    for (const userRecord of this.userRecords.values()) {
      const device = userRecord.devices.get(deviceId)
      if (!device) continue
      handled = true
      await device.acceptInvite(invite).catch(() => {})
    }
    return handled
  }

  /**
   * Set a global default expiration for outgoing rumors sent via this SessionManager.
   * Pass `undefined` to clear.
   */
  async setDefaultExpiration(options: ExpirationOptions | undefined): Promise<void> {
    await this.expirationSettings.setDefault(options)
  }

  /**
   * Set a per-peer default expiration for outgoing rumors. Pass `undefined` to clear.
   */
  async setExpirationForPeer(
    peerPubkey: string,
    options: ExpirationOptions | null | undefined
  ): Promise<void> {
    await this.expirationSettings.setPeer(peerPubkey, options)
  }

  /**
   * Set a per-group default expiration, keyed by groupId (typically carried via `["l", groupId]`).
   * Pass `undefined` to clear.
   */
  async setExpirationForGroup(
    groupId: string,
    options: ExpirationOptions | null | undefined
  ): Promise<void> {
    await this.expirationSettings.setGroup(groupId, options)
  }

  close() {
    for (const userRecord of this.userRecords.values()) {
      userRecord.close()
    }

    this.ourInviteResponseSubscription?.()
    this.ourInviteResponseSubscription = null
    this.legacyDirectMessageSubscription?.()
    this.legacyDirectMessageSubscription = null
    this.legacyDirectMessageAuthors = []
    this.pendingDirectMessages.clear()
    for (const unsubscribe of this.legacyRuntimeSubscriptions.values()) {
      unsubscribe()
    }
    this.legacyRuntimeSubscriptions.clear()
  }

  deactivateCurrentSessions(publicKey: string) {
    const userRecord = this.userRecords.get(publicKey)
    if (!userRecord) return
    userRecord.deactivateCurrentSessions()
    this.storeUserRecord(publicKey).catch(() => {})
  }

  async deleteChat(userPubkey: string): Promise<void> {
    return this.deleteUser(this.resolveToOwner(userPubkey))
  }

  async deleteUser(userPubkey: string): Promise<void> {
    await this.init()

    const ownerPubkey = this.resolveToOwner(userPubkey)
    if (ownerPubkey === this.ownerPublicKey) return

    const userRecord = this.userRecords.get(ownerPubkey)

    if (userRecord) {
      userRecord.close()
      for (const device of userRecord.devices.values()) {
        await device.revoke()
      }
      this.userRecords.delete(ownerPubkey)
    }

    // Remove discovery queue entries for this owner
    await this.discoveryQueue.removeForTarget(ownerPubkey)
    // Remove message queue entries for all known devices
    if (userRecord) {
      for (const [deviceId] of userRecord.devices) {
        await this.messageQueue.removeForTarget(deviceId)
      }
    }

    await this.runtimeState.deleteUser(
      serializeUserRecords(this.userRecords),
      ownerPubkey,
    )
  }

  async queuedMessageDiagnostics(innerEventId?: string): Promise<QueuedMessageDiagnostic[]> {
    await this.init()
    return queuedMessageDiagnostics({
      userRecords: this.userRecords,
      discoveryQueue: this.discoveryQueue,
      messageQueue: this.messageQueue,
      innerEventId,
    })
  }

  private async flushMessageQueue(deviceIdentity: string): Promise<void> {
    const ownerPubkey = this.resolveToOwner(deviceIdentity)
    const userRecord = this.userRecords.get(ownerPubkey)
    const device = userRecord?.devices.get(deviceIdentity)
    if (!device) {
      return
    }

    await device.flushMessageQueue()
    await this.storeUserRecord(ownerPubkey).catch(() => {})
  }

  private async sendLinkBootstrap(
    ownerPublicKey: string,
    deviceId: string,
  ): Promise<void> {
    const userRecord = this.userRecords.get(ownerPublicKey)
    const session = userRecord?.devices.get(deviceId)?.activeSession
    if (!session) {
      return
    }

    try {
      await this.commitOutbound(
        () => ({
          result: undefined,
          publishes: [{ event: planInviteBootstrapEvent(session, deviceId) }],
        }),
        () => {
          const before = deepCopyState(session.state)
          return () => {
            session.state = before
          }
        },
      )
    } catch {
      // The established session remains usable if bootstrap persistence fails.
    }
  }

  private async sendInviteBootstrap(
    session: Session,
    recipientDevicePubkey: string,
  ): Promise<void> {
    try {
      await this.commitOutbound(
        () => ({
          result: undefined,
          publishes: [{
            event: planInviteBootstrapEvent(session, recipientDevicePubkey),
          }],
        }),
        () => {
          const before = deepCopyState(session.state)
          return () => {
            session.state = before
          }
        },
      )
    } catch {
      // The session is still established even if bootstrap persistence fails.
    }
  }

  async acceptInvite(
    invite: Invite,
    options: AcceptInviteOptions = {}
  ): Promise<AcceptInviteResult> {
    await this.init()

    const deviceId = invite.deviceId || invite.inviter
    if (!deviceId) {
      throw new Error("Invite device id is required")
    }

    if (deviceId === this.deviceId) {
      throw new Error("Cannot accept invite from this device")
    }

    const explicitSameDeviceOwnerHint = options.ownerPublicKey === deviceId
    const claimedOwnerPublicKey =
      options.ownerPublicKey ||
      invite.ownerPubkey ||
      this.resolveToOwner(deviceId) ||
      deviceId

    const acceptKey = [
      invite.purpose || "chat",
      claimedOwnerPublicKey,
      deviceId,
      invite.inviterEphemeralPublicKey,
      invite.sharedSecret,
    ].join(":")
    const existingAccept = this.inviteAcceptPromises.get(acceptKey)
    if (existingAccept) {
      return existingAccept
    }

    const acceptPromise = this.doAcceptInvite(invite, options, {
      deviceId,
      explicitSameDeviceOwnerHint,
      claimedOwnerPublicKey,
    })
    this.inviteAcceptPromises.set(acceptKey, acceptPromise)
    try {
      return await acceptPromise
    } finally {
      if (this.inviteAcceptPromises.get(acceptKey) === acceptPromise) {
        this.inviteAcceptPromises.delete(acceptKey)
      }
    }
  }

  private async doAcceptInvite(
    invite: Invite,
    options: AcceptInviteOptions,
    resolved: {
      deviceId: string
      explicitSameDeviceOwnerHint: boolean
      claimedOwnerPublicKey: string
    }
  ): Promise<AcceptInviteResult> {
    const {
      deviceId,
      explicitSameDeviceOwnerHint,
      claimedOwnerPublicKey,
    } = resolved

    let ownerPublicKey = claimedOwnerPublicKey
    let preloadedAppKeys: AppKeys | null = null
    let preloadedAppKeysCreatedAt = 0
    let shouldApplyPreloadedRoster = false

    // When an invite claims delegate ownership, verify against AppKeys when available.
    // If claim verification fails for chat invites, fall back to device-identity routing.
    // For owner-side link flow, allow pre-registration acceptance and register via AppKeys afterward.
    if (claimedOwnerPublicKey !== deviceId) {
      const persistedRecord = this.userRecords.get(claimedOwnerPublicKey)
      const fetchedSnapshot = persistedRecord?.appKeys
        ? null
        : await this.fetchAppKeysSnapshot(claimedOwnerPublicKey, 50).catch(() => null)
      const persistedAppKeys = persistedRecord?.appKeys || fetchedSnapshot?.appKeys
      const persistedAppKeysCreatedAt = persistedRecord?.appKeys
        ? persistedRecord.appKeysCreatedAt()
        : fetchedSnapshot?.createdAt ?? 0
      if (options.ownerPublicKey && !persistedAppKeys) {
        ownerPublicKey = claimedOwnerPublicKey
      } else {
        const routing = resolveInviteOwnerRouting({
          devicePubkey: deviceId,
          claimedOwnerPublicKey,
          invitePurpose: invite.purpose,
          currentOwnerPublicKey: this.ownerPublicKey,
          appKeys: persistedAppKeys,
        })
        if (!routing.fellBackToDeviceIdentity && persistedAppKeys) {
          preloadedAppKeys = persistedAppKeys
          preloadedAppKeysCreatedAt = persistedAppKeysCreatedAt
          shouldApplyPreloadedRoster = routing.verifiedWithAppKeys
          this.updateDelegateMapping(claimedOwnerPublicKey, persistedAppKeys)
        }
        ownerPublicKey = routing.ownerPublicKey
      }
      if (!persistedAppKeys) {
        await this.setupUser(claimedOwnerPublicKey).catch(() => {})
      }
    }

    const userRecord = this.getOrCreateUserRecord(ownerPublicKey)
    if (preloadedAppKeys && ownerPublicKey === claimedOwnerPublicKey) {
      userRecord.setAppKeys(preloadedAppKeys, preloadedAppKeysCreatedAt)
    }
    const applyPreloadedRoster = async () => {
      if (
        preloadedAppKeys &&
        shouldApplyPreloadedRoster &&
        ownerPublicKey === claimedOwnerPublicKey
      ) {
        await userRecord
          .onAppKeys(preloadedAppKeys, preloadedAppKeysCreatedAt)
          .catch(() => {})
      }
    }

    const existingRecord = userRecord.devices.get(deviceId)
    const existingSessions = [
      ...(existingRecord?.activeSession ? [existingRecord.activeSession] : []),
      ...(existingRecord?.inactiveSessions ?? []),
    ]
    if (invite.purpose === "link" && existingSessions.length > 0) {
      await applyPreloadedRoster()
      return { ownerPublicKey, deviceId, session: existingSessions[0] }
    }
    const reusableEstablishedSession = existingSessions.find(
      (session) =>
        sessionCanSend(session) &&
        (sessionCanReceive(session) || sessionHasActivity(session))
    )
    if (reusableEstablishedSession) {
      await applyPreloadedRoster()
      return { ownerPublicKey, deviceId, session: reusableEstablishedSession }
    }

    const hasAnySession = existingSessions.length > 0
    const hasDormantImportedPlaceholder =
      explicitSameDeviceOwnerHint &&
      invite.purpose !== "link" &&
      hasAnySession &&
      existingSessions.every(
        (session) =>
          !sessionCanSend(session) &&
          !sessionCanReceive(session) &&
          !sessionHasActivity(session)
      )
    if (hasDormantImportedPlaceholder) {
      await applyPreloadedRoster()
      return { ownerPublicKey, deviceId, session: existingSessions[0] }
    }

    const encryptor =
      this.identityKey instanceof Uint8Array ? this.identityKey : this.identityKey.encrypt
    const inviteeOwnerClaim =
      invite.purpose === "link"
        ? this.ownerPublicKey
        : await this.resolveInviteeOwnerClaim(ownerPublicKey)
    const { session, event } = await invite.accept(
      this.ourPublicKey,
      encryptor,
      inviteeOwnerClaim
    )

    await this.commitOutbound(
      () => {
        const deviceRecord = this.upsertDeviceRecord(userRecord, deviceId)
        this.delegateToOwner.set(deviceId, ownerPublicKey)
        deviceRecord.installSession(session, false, {
          persist: false,
          preferActive: true,
        })
        return { result: undefined, publishes: [{ event }] }
      },
      () => {
        const recordsBefore = serializeUserRecords(this.userRecords)
        return () => this.hydrateUserRecords(recordsBefore)
      },
    )
    this.notifyMessagePushAuthorsChanged()
    await this.sendInviteBootstrap(session, deviceId)
    if (invite.purpose === "link" && ownerPublicKey === this.ownerPublicKey) {
      await this.sendLinkBootstrap(ownerPublicKey, deviceId)
    }
    await this.flushMessageQueue(deviceId).catch(() => {})
    await applyPreloadedRoster()

    return { ownerPublicKey, deviceId, session }
  }

  private async resolveInviteeOwnerClaim(
    recipientOwnerPublicKey: string,
  ): Promise<string | undefined> {
    if (
      recipientOwnerPublicKey === this.ownerPublicKey &&
      this.deviceId !== this.ownerPublicKey &&
      !this.isDeviceAuthorized(this.ownerPublicKey, this.deviceId)
    ) {
      return undefined
    }

    // Always advertise the local owner claim when we know it. The receiver still
    // treats that claim as untrusted until AppKeys prove that this device belongs
    // to the claimed owner, but omitting the claim entirely makes later
    // verification impossible because the inviter has no owner timeline to watch.
    return this.ownerPublicKey
  }

  async sendEvent(
    recipientIdentityKey: string,
    event: Partial<Rumor>
  ): Promise<Rumor | undefined> {
    return this.sendEventTransition(recipientIdentityKey, event)
  }

  private async sendEventTransition(
    recipientIdentityKey: string,
    event: Partial<Rumor>,
  ): Promise<Rumor | undefined> {
    await this.init()

    await Promise.allSettled([
      this.setupUser(recipientIdentityKey),
      this.setupUser(this.ownerPublicKey),
    ])

    // Queue event for devices that don't have sessions yet
    const completeEvent = event as Rumor
    const targets = new Set([recipientIdentityKey, this.ownerPublicKey])
    const queuedDeviceIds = new Set<string>()
    for (const target of targets) {
      const userRecord = this.userRecords.get(target)
      const knownDeviceIds = new Set<string>()

      for (const device of userRecord?.appKeys?.getAllDevices() ?? []) {
        if (device.identityPubkey && device.identityPubkey !== this.deviceId) {
          knownDeviceIds.add(device.identityPubkey)
        }
      }

      for (const deviceId of userRecord?.devices.keys() ?? []) {
        if (deviceId && deviceId !== this.deviceId) {
          knownDeviceIds.add(deviceId)
        }
      }

      if (knownDeviceIds.size > 0) {
        // If we know concrete device ids, queue directly to them so delivery can
        // flush as soon as any invite/session bootstrap completes.
        for (const deviceId of knownDeviceIds) {
          await this.messageQueue.add(deviceId, completeEvent)
          queuedDeviceIds.add(deviceId)
        }
      } else {
        await this.discoveryQueue.add(target, completeEvent)
      }
    }

    const userRecord = this.getOrCreateUserRecord(recipientIdentityKey)
    // Use ownerPublicKey to find sibling devices (important for delegates)
    const ourUserRecord = this.getOrCreateUserRecord(this.ownerPublicKey)

    const recipientDevices = Array.from(userRecord.devices.values())
    const ownDevices = Array.from(ourUserRecord.devices.values())

    // Merge and deduplicate by deviceId, excluding our own sending device
    // This fixes the self-message bug where sending to yourself would duplicate devices
    const deviceMap = new Map<string, DeviceRecord>()
    for (const d of [...recipientDevices, ...ownDevices]) {
      if (d.deviceId !== this.deviceId) {  // Exclude sender's own device
        deviceMap.set(d.deviceId, d)
      }
    }
    const devices = Array.from(deviceMap.values())

    await this.commitOutbound(
      ({ hasIntent }) => {
        const publishes: PreparedPublishInput[] = []
        for (const device of devices) {
          const deviceOwner = this.resolveToOwner(device.deviceId)
          if (
            deviceOwner !== device.deviceId &&
            !this.isDeviceAuthorized(deviceOwner, device.deviceId)
          ) {
            continue
          }

          const intentId = `${completeEvent.id}/${device.deviceId}`
          if (!hasIntent(intentId)) continue

          const prepared = device.prepareOutboundEvent(completeEvent)
          if (!prepared) continue
          publishes.push({
            event: prepared,
            innerEventId: completeEvent.id,
            intentId,
          })
        }
        return { result: undefined, publishes }
      },
      () => {
        const recordsBefore = serializeUserRecords(this.userRecords)
        return () => this.hydrateUserRecords(recordsBefore)
      },
    )

    await Promise.allSettled(
      Array.from(queuedDeviceIds).map((deviceId) => this.flushMessageQueue(deviceId))
    )

    // Return the event with computed ID (same as library would compute)
    return completeEvent
  }

  async sendMessage(
    recipientPublicKey: string,
    content: string,
    options: SendMessageOptions = {}
  ): Promise<Rumor> {
    const { kind = CHAT_MESSAGE_KIND, tags = [] } = options

    const now = Date.now()
    const builtTags = ensureMsTag(
      ensureRecipientTag(tags, recipientPublicKey),
      now,
    )

    const groupId = builtTags.find(t => t[0] === "l")?.[1]
    applyExpirationPolicy({
      kind,
      nowSeconds: Math.floor(now / 1000),
      tags: builtTags,
      expirationOverride: expirationOverrideFromSendOptions(options),
      defaultExpiration: this.expirationSettings.default,
      peerExpiration: this.expirationSettings.peer(recipientPublicKey),
      hasPeerExpiration: this.expirationSettings.hasPeer(recipientPublicKey),
      groupExpiration: groupId ? this.expirationSettings.group(groupId) : undefined,
      hasGroupExpiration: groupId ? this.expirationSettings.hasGroup(groupId) : false,
    })

    const rumor = buildRumorEvent({
      kind,
      content,
      tags: builtTags,
      pubkey: this.ourPublicKey,
      nowMs: now,
      ensureMsTag: false,
    })

    await this.sendEventTransition(recipientPublicKey, rumor)

    return rumor
  }

  /**
   * Send an encrypted 1:1 chat settings event (inner kind 10448).
   *
   * Settings events themselves should never expire; they are sent without a NIP-40 expiration tag.
   */
  async sendChatSettings(
    recipientPublicKey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"]
  ): Promise<Rumor> {
    const payload: ChatSettingsPayloadV1 = {
      type: "chat-settings",
      v: 1,
      messageTtlSeconds,
    }
    return this.sendMessage(recipientPublicKey, JSON.stringify(payload), {
      kind: CHAT_SETTINGS_KIND,
      expiration: null,
    })
  }

  /**
   * Convenience: set per-peer disappearing-message TTL and notify the peer via a settings event.
   *
   * `messageTtlSeconds`:
   * - `> 0`: set per-peer ttlSeconds
   * - `0` or `null`: disable per-peer expiration even if a global default exists
   * - `undefined`: clear per-peer override (fall back to global default)
   */
  async setChatSettingsForPeer(
    peerPubkey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"]
  ): Promise<Rumor> {
    if (messageTtlSeconds === undefined) {
      await this.setExpirationForPeer(peerPubkey, undefined)
    } else if (messageTtlSeconds === null || messageTtlSeconds === 0) {
      await this.setExpirationForPeer(peerPubkey, null)
    } else {
      await this.setExpirationForPeer(peerPubkey, { ttlSeconds: messageTtlSeconds })
    }

    return this.sendChatSettings(peerPubkey, messageTtlSeconds)
  }

  async sendReceipt(
    recipientPublicKey: string,
    receiptType: ReceiptType,
    messageIds: string[]
  ): Promise<Rumor | undefined> {
    if (messageIds.length === 0) return
    return this.sendMessage(recipientPublicKey, receiptType, {
      kind: RECEIPT_KIND,
      tags: messageIds.map((id) => ["e", id]),
    })
  }

  async sendTyping(recipientPublicKey: string): Promise<Rumor> {
    return this.sendMessage(recipientPublicKey, "typing", {
      kind: TYPING_KIND,
    })
  }

  private maybeAutoAdoptChatSettings(event: Rumor, fromOwnerPubkey: string): void {
    if (!this.autoAdoptChatSettings) return
    const adoption = chatSettingsAdoptionForRumor(
      event,
      fromOwnerPubkey,
      this.ownerPublicKey,
    )
    if (!adoption) return

    this.setExpirationForPeer(adoption.peerPubkey, adoption.options).catch(() => {})
  }

  private storeUserRecord(_publicKey: string) {
    return this.runtimeState.persistRecords(serializeUserRecords(this.userRecords))
  }

  private hydrateUserRecords(records: ReturnType<typeof serializeUserRecords>): void {
    for (const record of this.userRecords.values()) record.close()
    this.userRecords.clear()
    this.delegateToOwner.clear()
    for (const data of records) {
      hydrateUserRecord({
        data,
        publicKey: data.publicKey,
        getOrCreateUserRecord: (ownerPubkey) => this.getOrCreateUserRecord(ownerPubkey),
        rememberDelegate: (deviceId, ownerPubkey) => {
          this.delegateToOwner.set(deviceId, ownerPubkey)
        },
        rememberProcessedInviteResponse: (eventId) => {
          this.processedInviteResponses.add(eventId)
        },
      })
    }
  }
}
