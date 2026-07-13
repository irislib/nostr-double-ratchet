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
import { MessageQueue } from "./MessageQueue"
import {
  AppKeys,
  applyAppKeysSnapshotPreservingLabels,
  isAppKeysEvent,
} from "./AppKeys"
import { Invite } from "./Invite"
import { Session } from "./Session"
import {
  resolveInviteOwnerRouting,
  type AppKeysSnapshotDecision,
  type KnownAppKeysSnapshot,
} from "./multiDevice"
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
import {
  planInviteBootstrapEvents,
  scheduleInviteBootstrapRetryEvents,
} from "./session-manager/inviteBootstrap"
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
import { UserRecordStorage } from "./session-manager/userRecordStorage"
import type {
  AcceptInviteOptions,
  AcceptInviteResult,
  DeviceRecord,
  InviteCredentials,
  NostrFacade,
  OnEventCallback,
  OnEventMeta,
  SessionManagerEvent,
  SessionManagerEventsAvailableCallback,
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
  SessionManagerEventsAvailableCallback,
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
  // Versioning
  private readonly storageVersion = "1"
  private readonly versionPrefix: string

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
  private messageQueue!: MessageQueue
  private discoveryQueue!: MessageQueue
  // Map delegate device pubkeys to their owner's pubkey
  private delegateToOwner: Map<string, string> = new Map()
  // Track processed InviteResponse event IDs to prevent replay
  private processedInviteResponses: Set<string> = new Set()
  private pendingInviteResponses: Map<string, PendingInviteResponse> = new Map()
  private pendingDirectMessages: Map<string, VerifiedEvent> = new Map()
  private inviteAcceptPromises: Map<string, Promise<AcceptInviteResult>> = new Map()
  private expirationSettings!: ExpirationSettings
  private userRecordStorage!: UserRecordStorage
  private autoAdoptChatSettings: boolean = true

  private userSetupPromises: Map<string, Promise<void>> = new Map()
  private bootstrapRetryTimeouts: Set<ReturnType<typeof setTimeout>> = new Set()

  // Subscriptions
  private ourInviteResponseSubscription: Unsubscribe | null = null
  private legacyRuntimeSubscriptions: Map<string, Unsubscribe> = new Map()
  private legacyDirectMessageSubscription: Unsubscribe | null = null
  private legacyDirectMessageAuthors: string[] = []

  // Callbacks
  private internalSubscriptions: Set<OnEventCallback> = new Set()
  private messagePushAuthorCallbacks: Set<() => void> = new Set()
  private eventsAvailableCallbacks: Set<SessionManagerEventsAvailableCallback> = new Set()
  private emittedEvents: SessionManagerEvent[] = []

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
    this.versionPrefix = `v${this.storageVersion}`
    this.messageQueue = new MessageQueue(this.storage, "v1/message-queue/")
    this.discoveryQueue = new MessageQueue(this.storage, "v1/discovery-queue/")
    this.expirationSettings = new ExpirationSettings(this.storage, this.versionPrefix)
    this.userRecordStorage = new UserRecordStorage(this.storage, this.versionPrefix)
    this.nostrFacade = {
      subscribe: (subid, filter, onEvent) => this.emitSubscribe(subid, filter, onEvent),
      publish: (event, innerEventId) => this.emitPublish(event, innerEventId),
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

  onEventsAvailable(callback: SessionManagerEventsAvailableCallback): Unsubscribe {
    this.eventsAvailableCallbacks.add(callback)
    return () => {
      this.eventsAvailableCallbacks.delete(callback)
    }
  }

  drainEvents(): SessionManagerEvent[] {
    const events = this.emittedEvents
    this.emittedEvents = []
    return events
  }

  hasPendingEvents(): boolean {
    return this.emittedEvents.length > 0
  }

  private async emitEvent(event: SessionManagerEvent): Promise<void> {
    this.emittedEvents.push(event)
    const legacy = this.handleLegacyEmittedEvent(event)
    for (const callback of this.eventsAvailableCallbacks) {
      try {
        void callback()
      } catch {
        // Event-availability observers should not break core state changes.
      }
    }
    if (legacy) await legacy
  }

  private handleLegacyEmittedEvent(event: SessionManagerEvent): Promise<void> | void {
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
      return
    }

    if (!this.legacyNostrPublish) return
    return this.legacyNostrPublish(event.event).then(() => {})
  }

  private emitSubscribe(
    subid: string,
    filter: Parameters<NostrFacade["subscribe"]>[1],
    onEvent?: Parameters<NostrFacade["subscribe"]>[2],
  ): Unsubscribe {
    if (this.legacyNostrSubscribe && onEvent) {
      this.emittedEvents.push({ type: "subscribe", subid, filter })
      this.legacyRuntimeSubscriptions.get(subid)?.()
      const cleanup = this.legacyNostrSubscribe(filter, onEvent)
      this.legacyRuntimeSubscriptions.set(subid, cleanup)
      return () => {
        this.emittedEvents.push({ type: "unsubscribe", subid })
        this.legacyRuntimeSubscriptions.get(subid)?.()
        this.legacyRuntimeSubscriptions.delete(subid)
      }
    }

    void this.emitEvent({ type: "subscribe", subid, filter })
    return () => {
      void this.emitEvent({ type: "unsubscribe", subid })
    }
  }

  private emitPublish(
    event: Parameters<NostrFacade["publish"]>[0],
    innerEventId?: string,
  ): Promise<void> {
    return this.emitEvent({ type: "publish", event, innerEventId })
  }

  async init() {
    if (this.initialized) return
    this.initialized = true

    await this.userRecordStorage.runMigrations().catch(() => {
      // Failed to run migrations
    })

    await this.loadAllUserRecords().catch(() => {
      // Failed to load user records
    })

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

  private fetchAppKeys(pubkey: string, timeoutMs = 2000): Promise<AppKeys | null> {
    return this.fetchAppKeysSnapshot(pubkey, timeoutMs).then(
      (snapshot) => snapshot?.appKeys ?? null
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

    const latestAppKeys = await this.fetchAppKeysSnapshot(userPubkey, 50)
      .catch(() => null)
    if (latestAppKeys) {
      await this.applyTrustedAppKeysSnapshot({
        ownerPubkey: userPubkey,
        ...latestAppKeys,
      }).catch(() => {})
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

  getKnownAppKeysSnapshots(): KnownAppKeysSnapshot[] {
    return Array.from(this.userRecords.values())
      .filter((record): record is UserRecordActor & { appKeys: AppKeys } =>
        record.appKeys !== undefined
      )
      .map((record) => ({
        ownerPubkey: record.publicKey,
        appKeys: new AppKeys(
          record.appKeys.getAllDevices().map((device) => ({ ...device })),
        ),
        createdAt: record.appKeysCreatedAt,
      }))
      .sort((left, right) => left.ownerPubkey.localeCompare(right.ownerPubkey))
  }

  async applyTrustedAppKeysSnapshot(
    snapshot: KnownAppKeysSnapshot,
  ): Promise<AppKeysSnapshotDecision> {
    const record = this.getOrCreateUserRecord(snapshot.ownerPubkey)
    await record.ensureSetup().catch(() => {})
    const incoming = new AppKeys(
      snapshot.appKeys.getAllDevices().map((device) => ({ ...device })),
      snapshot.appKeys.getAllDeviceLabels().map((labels) => ({ ...labels })),
    )
    const update = applyAppKeysSnapshotPreservingLabels({
      currentAppKeys: record.appKeys,
      currentCreatedAt: record.appKeysCreatedAt,
      incomingAppKeys: incoming,
      incomingCreatedAt: snapshot.createdAt,
    })
    if (update.decision !== "stale") {
      await record.onAppKeys(update.appKeys, update.createdAt)
      this.syncLegacyDirectMessageSubscription()
    }
    return update.decision
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
    for (const timeout of this.bootstrapRetryTimeouts) {
      clearTimeout(timeout)
    }
    this.bootstrapRetryTimeouts.clear()

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

    await this.userRecordStorage.deleteUserData(ownerPubkey)
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
      const bootstrapEvents = planInviteBootstrapEvents(session, deviceId)
      const [initialBootstrap] = bootstrapEvents
      if (!initialBootstrap) {
        return
      }
      await this.emitPublish(initialBootstrap)
      scheduleInviteBootstrapRetryEvents(
        bootstrapEvents,
        (event) => this.emitPublish(event),
        this.bootstrapRetryTimeouts,
      )
      await this.storeUserRecord(ownerPublicKey).catch(() => {})
    } catch {
      // Ignore bootstrap send failures; the next valid inbound event will retry queue flush.
    }
  }

  private async sendInviteBootstrap(
    session: Session,
    recipientDevicePubkey: string,
  ): Promise<void> {
    try {
      const bootstrapEvents = planInviteBootstrapEvents(session, recipientDevicePubkey)
      const [initialBootstrap] = bootstrapEvents
      if (!initialBootstrap) {
        return
      }
      await this.emitPublish(initialBootstrap)
      scheduleInviteBootstrapRetryEvents(
        bootstrapEvents,
        (event) => this.emitPublish(event),
        this.bootstrapRetryTimeouts,
      )
    } catch {
      // The session is still established even if the bootstrap publish fails.
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
    let shouldApplyPreloadedRoster = false

    // When an invite claims delegate ownership, verify against AppKeys when available.
    // If claim verification fails for chat invites, fall back to device-identity routing.
    // For owner-side link flow, allow pre-registration acceptance and register via AppKeys afterward.
    if (claimedOwnerPublicKey !== deviceId) {
      const persistedAppKeys =
        this.userRecords.get(claimedOwnerPublicKey)?.appKeys ||
        (await this.fetchAppKeys(claimedOwnerPublicKey, 50).catch(() => null)) ||
        undefined
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
      userRecord.setAppKeys(preloadedAppKeys)
    }
    const applyPreloadedRoster = async () => {
      if (
        preloadedAppKeys &&
        shouldApplyPreloadedRoster &&
        ownerPublicKey === claimedOwnerPublicKey
      ) {
        await userRecord.onAppKeys(preloadedAppKeys).catch(() => {})
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

    const deviceRecord = this.upsertDeviceRecord(userRecord, deviceId)
    this.delegateToOwner.set(deviceId, ownerPublicKey)
    deviceRecord.installSession(session, false, { preferActive: true })
    await this.emitPublish(event)
    await this.sendInviteBootstrap(session, deviceId)
    if (invite.purpose === "link" && ownerPublicKey === this.ownerPublicKey) {
      await this.sendLinkBootstrap(ownerPublicKey, deviceId)
    }
    await this.flushMessageQueue(deviceId).catch(() => {})
    await this.storeUserRecord(ownerPublicKey).catch(() => {})
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

    // Ratchet all sessions synchronously first, then persist state BEFORE network I/O.
    //
    // This is important for apps that "fire and forget" sendEvent() (e.g. UI click handlers):
    // if the page reloads/crashes while publishes are still in-flight, we still want the
    // updated session keys to be on disk so the next incoming message can be decrypted.
    const toPublish: Parameters<NostrPublish>[0][] = []
    const sentDeviceIds: string[] = []
    for (const device of devices) {
      // Check if device is still authorized
      const deviceOwner = this.resolveToOwner(device.deviceId)
      if (deviceOwner !== device.deviceId && !this.isDeviceAuthorized(deviceOwner, device.deviceId)) {
        continue
      }

      const verifiedEvent = device.prepareOutboundEvent(completeEvent)
      if (!verifiedEvent) {
        continue
      }
      toPublish.push(verifiedEvent)
      sentDeviceIds.push(device.deviceId)
    }

    // Persist recipient + owner records before publishing (best-effort).
    await this.storeUserRecord(recipientIdentityKey).catch(() => {})
    if (this.ownerPublicKey !== recipientIdentityKey) {
      await this.storeUserRecord(this.ownerPublicKey).catch(() => {})
    }

    await Promise.allSettled(
      toPublish.map((evt, i) =>
        this.emitPublish(evt, (event as Rumor).id).then(() => {
          const deviceId = sentDeviceIds[i]
          this.messageQueue.removeByTargetAndEventId(deviceId, (event as Rumor).id).catch(() => {})
          this.flushMessageQueue(deviceId).catch(() => {})
        })
      )
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

    // Use sendEvent for actual sending (includes queueing).
    // Note: sendEvent is not awaited to maintain backward compatibility.
    this.sendEvent(recipientPublicKey, rumor).catch(() => {})

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

  private storeUserRecord(publicKey: string) {
    const userRecord = this.userRecords.get(publicKey)
    return this.userRecordStorage.storeUserRecord(publicKey, userRecord)
  }

  private loadUserRecord(publicKey: string) {
    return this.userRecordStorage
      .loadUserRecord(publicKey)
      .then((data) => {
        if (!data) return
        hydrateUserRecord({
          data,
          publicKey,
          getOrCreateUserRecord: (ownerPubkey) => this.getOrCreateUserRecord(ownerPubkey),
          rememberDelegate: (deviceId, ownerPubkey) => {
            this.delegateToOwner.set(deviceId, ownerPubkey)
          },
          rememberProcessedInviteResponse: (eventId) => {
            this.processedInviteResponses.add(eventId)
          },
        })
      })
      .catch(() => {
        // Failed to load user record
      })
  }

  private loadAllUserRecords() {
    return this.userRecordStorage
      .loadAllUserRecordPubkeys()
      .then((publicKeys) => Promise.all(
        publicKeys.map((publicKey) => this.loadUserRecord(publicKey))
      ))
  }
}
