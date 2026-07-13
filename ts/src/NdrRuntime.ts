import {
  AppKeys,
  buildAppKeysFilter,
  createAppKeysProfileId,
  type DeviceEntry,
} from "./AppKeys";
import {
  AppKeysManager,
  DelegateManager,
  type DelegatePayload,
} from "./AppKeysManager";
import { Invite } from "./Invite";
import {
  GroupManager,
  type GroupData,
  type GroupDecryptedEvent,
} from "./Group";
import {
  applyAppKeysSnapshot,
  evaluateDeviceRegistrationState,
  shouldRequireRelayRegistrationConfirmation,
  type DeviceRegistrationState,
  type SessionUserRecordsLike,
} from "./multiDevice";
import {
  SessionManager,
  type AcceptInviteOptions,
  type AcceptInviteResult,
  type OnEventCallback,
  type QueuedMessageDiagnostic,
  type SendMessageOptions,
  type SessionManagerEvent,
} from "./SessionManager";
import { InMemoryStorageAdapter, type StorageAdapter } from "./StorageAdapter";
import {
  type ChatSettingsPayloadV1,
  type ExpirationOptions,
  MESSAGE_EVENT_KIND,
  type NostrFetch,
  type NostrPublish,
  type NostrSubscribe,
  type ReceiptType,
  type Rumor,
  type Unsubscribe,
} from "./types";
import { finalizeEvent, type VerifiedEvent } from "nostr-tools";
import {
  SessionGroupRuntime,
  type RuntimeGroupEvent,
  type SendGroupEventOptions,
} from "./RuntimeGroupController";

export type { QueuedMessageDiagnostic } from "./SessionManager";
export type { RuntimeGroupEvent, SendGroupEventOptions } from "./RuntimeGroupController";

export interface NdrRuntimeOptions {
  nostrSubscribe: NostrSubscribe;
  nostrPublish: NostrPublish;
  nostrFetch?: NostrFetch;
  storage?: StorageAdapter;
  sessionStorage?: StorageAdapter;
  groupStorage?: StorageAdapter;
  ownerIdentityKey?: Uint8Array;
  appKeysFetchTimeoutMs?: number;
  appKeysFastTimeoutMs?: number;
}

export interface NdrRuntimeState extends DeviceRegistrationState {
  ownerPubkey: string | null;
  currentDevicePubkey: string | null;
  registeredDevices: DeviceEntry[];
  hasLocalAppKeys: boolean;
  lastAppKeysCreatedAt: number;
  appKeysManagerReady: boolean;
  delegateManagerReady: boolean;
  sessionManagerReady: boolean;
  groupManagerReady: boolean;
  appKeysSubscriptionActive: boolean;
}

export interface PrepareRegistrationOptions {
  ownerPubkey: string;
  timeoutMs?: number;
  deviceLabel?: string;
  clientLabel?: string;
}

export interface PrepareRegistrationForIdentityOptions extends PrepareRegistrationOptions {
  identityPubkey: string;
}

export interface PreparedRegistration {
  ownerPubkey: string;
  appKeys: AppKeys;
  devices: DeviceEntry[];
  baseDevices: DeviceEntry[];
  newDeviceIdentity: string;
}

export interface PublishPreparedRegistrationResult {
  createdAt: number;
  relayConfirmationRequired: boolean;
}

export interface PrepareRevocationOptions {
  ownerPubkey: string;
  identityPubkey: string;
  timeoutMs?: number;
}

export interface PreparedRevocation {
  ownerPubkey: string;
  appKeys: AppKeys;
  devices: DeviceEntry[];
  revokedIdentity: string;
}

export interface RegisterCurrentDeviceOptions extends PrepareRegistrationOptions {}

export interface RegisterDeviceIdentityOptions extends PrepareRegistrationForIdentityOptions {}

export interface RevokeDeviceOptions extends PrepareRevocationOptions {}

const DEFAULT_APP_KEYS_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_APP_KEYS_FAST_TIMEOUT_MS = 2_000;

const cloneAppKeys = (appKeys: AppKeys): AppKeys =>
  new AppKeys(appKeys.getAllDevices(), appKeys.getAllDeviceLabels());

const now = () => Math.floor(Date.now() / 1000);

export class NdrRuntime {
  private readonly nostrSubscribe: NostrSubscribe;
  private readonly nostrPublish: NostrPublish;
  private readonly nostrFetch?: NostrFetch;
  private readonly storage: StorageAdapter;
  private readonly sessionStorage: StorageAdapter;
  private readonly groupStorage: StorageAdapter;
  private readonly groupController: SessionGroupRuntime;
  private readonly ownerIdentityKey?: Uint8Array;
  private readonly appKeysFetchTimeoutMs: number;
  private readonly appKeysFastTimeoutMs: number;
  private readonly appKeysProfileIds = new Map<string, string>();

  private appKeysManager: AppKeysManager | null = null;
  private delegateManager: DelegateManager | null = null;
  private sessionManager: SessionManager | null = null;

  private appKeysInitPromise: Promise<void> | null = null;
  private delegateInitPromise: Promise<void> | null = null;
  private sessionManagerInitPromise: Promise<SessionManager> | null = null;

  private appKeysSubscriptionCleanup: Unsubscribe | null = null;
  private appKeysSubscriptionOwnerPubkey: string | null = null;
  private directMessageSubscriptionCleanup: Unsubscribe | null = null;
  private directMessageSubscriptionAuthors: string[] = [];
  private directMessageSubscriptionRecipient: string | null = null;
  private directMessageSubscriptionLastChangeMs = 0;
  private directMessageSubscriptionThrottleTimer: ReturnType<typeof setTimeout> | null =
    null;
  private messagePushAuthorCleanup: Unsubscribe | null = null;
  private sessionManagerRuntimeEventCleanup: Unsubscribe | null = null;
  private preparedPublishCleanup: Unsubscribe | null = null;
  private preparedPublishFlushPromise: Promise<void> | null = null;
  private readonly sessionManagerEmittedSubscriptions = new Map<
    string,
    Unsubscribe
  >();

  private readonly stateListeners = new Set<(state: NdrRuntimeState) => void>();
  private readonly sessionEventCallbacks = new Set<OnEventCallback>();

  private state: NdrRuntimeState = {
    ownerPubkey: null,
    currentDevicePubkey: null,
    registeredDevices: [],
    hasLocalAppKeys: false,
    lastAppKeysCreatedAt: 0,
    appKeysManagerReady: false,
    delegateManagerReady: false,
    sessionManagerReady: false,
    groupManagerReady: false,
    appKeysSubscriptionActive: false,
    isCurrentDeviceRegistered: false,
    hasKnownRegisteredDevices: false,
    noPreviousDevicesFound: true,
    requiresDeviceRegistration: false,
    canSendPrivateMessages: false,
  };

  constructor(options: NdrRuntimeOptions) {
    this.nostrSubscribe = options.nostrSubscribe;
    this.nostrPublish = options.nostrPublish;
    this.nostrFetch = options.nostrFetch;
    this.storage = options.storage || new InMemoryStorageAdapter();
    this.sessionStorage = options.sessionStorage || this.storage;
    this.groupStorage = options.groupStorage || this.sessionStorage;
    this.groupController = new SessionGroupRuntime({
      nostrSubscribe: this.nostrSubscribe,
      nostrPublish: this.nostrPublish,
      nostrFetch: this.nostrFetch,
      groupStorage: this.groupStorage,
      waitForSessionManager: (ownerPubkey) =>
        this.waitForSessionManager(ownerPubkey),
      getOwnerPubkey: () => this.state.ownerPubkey,
      getCurrentDevicePubkey: () => this.state.currentDevicePubkey,
      onReadyStateChange: (ready) => {
        this.syncState({
          groupManagerReady: ready,
        });
      },
    });
    this.ownerIdentityKey = options.ownerIdentityKey;
    this.appKeysFetchTimeoutMs =
      options.appKeysFetchTimeoutMs || DEFAULT_APP_KEYS_FETCH_TIMEOUT_MS;
    this.appKeysFastTimeoutMs =
      options.appKeysFastTimeoutMs || DEFAULT_APP_KEYS_FAST_TIMEOUT_MS;
  }

  getState(): NdrRuntimeState {
    return {
      ...this.state,
      registeredDevices: [...this.state.registeredDevices],
    };
  }

  onStateChange(listener: (state: NdrRuntimeState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onSessionEvent(callback: OnEventCallback): Unsubscribe {
    this.sessionEventCallbacks.add(callback);
    return () => {
      this.sessionEventCallbacks.delete(callback);
    };
  }

  getAppKeysManager(): AppKeysManager | null {
    return this.appKeysManager;
  }

  getDelegateManager(): DelegateManager | null {
    return this.delegateManager;
  }

  getSessionManager(): SessionManager | null {
    return this.sessionManager;
  }

  getGroupManager(): GroupManager | null {
    return this.groupController.getManager();
  }

  getDirectMessageSubscriptionAuthors(): string[] {
    return [...this.directMessageSubscriptionAuthors];
  }

  getSessionUserRecords(): SessionUserRecordsLike {
    return (
      (this.sessionManager?.getUserRecords() as unknown as SessionUserRecordsLike | undefined) ??
      new Map()
    );
  }

  getSessionMessagePushAuthorPubkeys(peerPubkey: string): string[] {
    return this.sessionManager?.getMessagePushAuthorPubkeys(peerPubkey) ?? [];
  }

  getKnownDeviceIdentityPubkeysForOwner(ownerPubkey: string): string[] {
    return this.sessionManager?.getKnownDeviceIdentityPubkeysForOwner(ownerPubkey) ?? [];
  }

  feedEvent(event: VerifiedEvent): boolean {
    return this.processReceivedEvent(event);
  }

  processReceivedEvent(event: VerifiedEvent): boolean {
    return this.feedSessionManagerEvent(event);
  }

  async initManagers(): Promise<void> {
    await Promise.all([this.initAppKeysManager(), this.initDelegateManager()]);
  }

  async initForOwner(ownerPubkey: string): Promise<SessionManager> {
    await this.initManagers();
    const manager = await this.initSessionManager(ownerPubkey);
    await this.initGroupManager(ownerPubkey);
    this.startAppKeysSubscription(ownerPubkey);
    return manager;
  }

  async waitForSessionManager(ownerPubkey?: string): Promise<SessionManager> {
    if (this.sessionManager) {
      return this.sessionManager;
    }

    if (!ownerPubkey) {
      throw new Error("Owner pubkey required to initialize SessionManager");
    }

    return this.initForOwner(ownerPubkey);
  }

  async waitForGroupManager(ownerPubkey?: string): Promise<GroupManager> {
    return this.groupController.waitForManager(ownerPubkey);
  }

  async initAppKeysManager(): Promise<void> {
    if (this.appKeysManager) return;
    if (this.appKeysInitPromise) return this.appKeysInitPromise;

    this.appKeysInitPromise = (async () => {
      const manager = new AppKeysManager({
        nostrPublish: this.nostrPublish,
        storage: this.storage,
        ownerIdentityKey: this.ownerIdentityKey,
      });
      await manager.init();
      this.appKeysManager = manager;
      const appKeys = manager.getAppKeys();
      this.syncState({
        appKeysManagerReady: true,
        registeredDevices: manager.getOwnDevices(),
        hasLocalAppKeys: !!(appKeys && appKeys.getAllDevices().length > 0),
      });
    })().finally(() => {
      this.appKeysInitPromise = null;
    });

    return this.appKeysInitPromise;
  }

  async initDelegateManager(): Promise<void> {
    if (this.delegateManager) return;
    if (this.delegateInitPromise) return this.delegateInitPromise;

    this.delegateInitPromise = (async () => {
      const manager = new DelegateManager({
        nostrSubscribe: this.nostrSubscribe,
        nostrPublish: this.nostrPublish,
        storage: this.storage,
      });
      await manager.init();
      this.delegateManager = manager;
      this.syncState({
        delegateManagerReady: true,
        currentDevicePubkey: manager.getIdentityPublicKey(),
        ownerPubkey: manager.getOwnerPublicKey(),
      });
    })().finally(() => {
      this.delegateInitPromise = null;
    });

    return this.delegateInitPromise;
  }

  async initSessionManager(ownerPubkey: string): Promise<SessionManager> {
    if (this.sessionManager) {
      if (this.state.ownerPubkey && this.state.ownerPubkey !== ownerPubkey) {
        throw new Error(
          `NdrRuntime already initialized for owner ${this.state.ownerPubkey}`,
        );
      }
      return this.sessionManager;
    }
    if (this.sessionManagerInitPromise) {
      return this.sessionManagerInitPromise;
    }

    this.sessionManagerInitPromise = (async () => {
      await this.initDelegateManager();
      if (!this.delegateManager) {
        throw new Error("DelegateManager not initialized");
      }

      await this.delegateManager.activate(ownerPubkey);
      const manager = this.delegateManager.createRuntimeSessionManager(
        this.sessionStorage,
      );
      this.sessionManager = manager;
      this.attachSessionManagerEvents(manager);
      await manager.init();
      await this.flushPreparedPublishes();
      this.messagePushAuthorCleanup?.();
      this.messagePushAuthorCleanup = manager.onMessagePushAuthorsChanged(() => {
        this.syncDirectMessageSubscription();
      });
      this.syncState({
        ownerPubkey,
        sessionManagerReady: true,
      });
      this.groupController.setSessionManager(manager, {
        bridgeSessionEvents: false,
      });
      this.syncDirectMessageSubscription();
      return manager;
    })()
      .catch((error) => {
        this.clearSessionManagerRuntime();
        this.messagePushAuthorCleanup?.();
        this.messagePushAuthorCleanup = null;
        this.sessionManager = null;
        this.groupController.setSessionManager(null);
        throw error;
      })
      .finally(() => {
        this.sessionManagerInitPromise = null;
      });

    return this.sessionManagerInitPromise;
  }

  async initGroupManager(ownerPubkey?: string): Promise<GroupManager> {
    return this.groupController.waitForManager(ownerPubkey);
  }

  onGroupEvent(callback: (event: GroupDecryptedEvent) => void): Unsubscribe {
    return this.groupController.onGroupEvent(callback);
  }

  async setupUser(userPubkey: string, ownerPubkey?: string): Promise<void> {
    const activeOwnerPubkey = this.resolveActiveOwnerPubkey(ownerPubkey);
    const manager = await this.waitForSessionManager(activeOwnerPubkey);
    if (userPubkey === activeOwnerPubkey) {
      await this.feedLocalAppKeysSnapshotToSessionManager(activeOwnerPubkey);
    }
    try {
      await manager.setupUser(userPubkey);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async sendEvent(
    recipientPubkey: string,
    event: Partial<Rumor>,
    ownerPubkey?: string,
  ): Promise<Rumor | undefined> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      return await manager.sendEvent(recipientPubkey, event);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async queuedMessageDiagnostics(
    innerEventId?: string,
    ownerPubkey?: string,
  ): Promise<QueuedMessageDiagnostic[]> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    return manager.queuedMessageDiagnostics(innerEventId);
  }

  async sendMessage(
    recipientPubkey: string,
    content: string,
    options: SendMessageOptions = {},
    ownerPubkey?: string,
  ): Promise<Rumor> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      return await manager.sendMessage(recipientPubkey, content, options);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async sendChatSettings(
    recipientPubkey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"],
    ownerPubkey?: string,
  ): Promise<Rumor> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      return await manager.sendChatSettings(recipientPubkey, messageTtlSeconds);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async setChatSettingsForPeer(
    peerPubkey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"],
    ownerPubkey?: string,
  ): Promise<Rumor> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      return await manager.setChatSettingsForPeer(peerPubkey, messageTtlSeconds);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async sendReceipt(
    recipientPubkey: string,
    receiptType: ReceiptType,
    messageIds: string[],
    ownerPubkey?: string,
  ): Promise<Rumor | undefined> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      return await manager.sendReceipt(recipientPubkey, receiptType, messageIds);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async sendTyping(
    recipientPubkey: string,
    ownerPubkey?: string,
  ): Promise<Rumor> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      return await manager.sendTyping(recipientPubkey);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async setDefaultExpiration(
    options: ExpirationOptions | undefined,
    ownerPubkey?: string,
  ): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    await manager.setDefaultExpiration(options);
  }

  async setExpirationForPeer(
    peerPubkey: string,
    options: ExpirationOptions | null | undefined,
    ownerPubkey?: string,
  ): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    await manager.setExpirationForPeer(peerPubkey, options);
  }

  async setExpirationForGroup(
    groupId: string,
    options: ExpirationOptions | null | undefined,
    ownerPubkey?: string,
  ): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    await manager.setExpirationForGroup(groupId, options);
  }

  async deleteChat(userPubkey: string, ownerPubkey?: string): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    try {
      await manager.deleteChat(userPubkey);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async resolveBaseAppKeys(
    ownerPubkey: string,
    timeoutMs: number = this.appKeysFetchTimeoutMs,
  ): Promise<AppKeys> {
    const initialTimeoutMs = Math.min(this.appKeysFastTimeoutMs, timeoutMs);
    try {
      const existingKeys = await AppKeys.waitFor(
        ownerPubkey,
        this.nostrSubscribe,
        initialTimeoutMs,
        this.ownerIdentityKey,
      );
      if (existingKeys) {
        return existingKeys;
      }
    } catch {
      // Ignore relay fetch failures and fall back to local state.
    }

    const localKeys = this.appKeysManager?.getAppKeys();
    if (localKeys && localKeys.getAllDevices().length > 0) {
      return cloneAppKeys(localKeys);
    }

    if (timeoutMs > initialTimeoutMs) {
      try {
        const remaining = Math.max(timeoutMs - initialTimeoutMs, 0);
        const existingKeys = await AppKeys.waitFor(
          ownerPubkey,
          this.nostrSubscribe,
          remaining,
          this.ownerIdentityKey,
        );
        if (existingKeys) {
          return existingKeys;
        }
      } catch {
        // Ignore relay fetch failures.
      }
    }

    return new AppKeys();
  }

  startAppKeysSubscription(ownerPubkey: string): void {
    if (
      this.appKeysSubscriptionCleanup &&
      this.appKeysSubscriptionOwnerPubkey === ownerPubkey
    ) {
      return;
    }

    this.stopAppKeysSubscription();
    this.appKeysSubscriptionOwnerPubkey = ownerPubkey;

    this.appKeysSubscriptionCleanup = this.nostrSubscribe(
      buildAppKeysFilter(ownerPubkey),
      async (event) => {
        if (event.pubkey !== ownerPubkey) return;
        try {
          const incomingAppKeys = AppKeys.fromEvent(event, this.ownerIdentityKey);
          await this.applyIncomingAppKeys(incomingAppKeys, event.created_at);
          this.feedSessionManagerEvent(event);
        } catch {
          // Ignore invalid AppKeys events.
        }
      },
    );

    this.syncState({
      ownerPubkey,
      appKeysSubscriptionActive: true,
    });
  }

  stopAppKeysSubscription(): void {
    this.appKeysSubscriptionCleanup?.();
    this.appKeysSubscriptionCleanup = null;
    this.appKeysSubscriptionOwnerPubkey = null;
    this.syncState({
      appKeysSubscriptionActive: false,
    });
  }

  private syncDirectMessageSubscription(): void {
    // The relay REQ for direct messages is filtered by author pubkeys, but
    // the double-ratchet rotates `theirCurrentNostrPublicKey` /
    // `theirNextNostrPublicKey` every step. Without throttling, every
    // received message recomputes a new author set and forces every relay
    // to replay all matching historical events — measured at 5–10 s of
    // sub churn during an active chat.
    //
    //   1. Identical author set → no-op.
    //   2. Newly added authors are subscribed immediately. They may already
    //      have relay events waiting, and delaying them can miss live delivery.
    //   3. Pure removals honour a 1.5 s trailing throttle so bursts of
    //      ratchet steps collapse into one relay REQ. If the throttle window
    //      has not elapsed we schedule a single trailing flush so stale
    //      authors are eventually dropped even if no other runtime activity
    //      comes along to call us again.
    const THROTTLE_MS = 1500;

    const nextAuthors = [
      ...new Set(this.sessionManager?.getAllMessagePushAuthorPubkeys() ?? []),
    ].sort();
    const nextRecipient = this.delegateManager?.getIdentityPublicKey() ?? null;

    if (
      nextAuthors.length === this.directMessageSubscriptionAuthors.length &&
      nextAuthors.every(
        (author, index) => author === this.directMessageSubscriptionAuthors[index],
      ) &&
      nextRecipient === this.directMessageSubscriptionRecipient
    ) {
      return;
    }

    const currentAuthors = this.directMessageSubscriptionAuthors;
    const addedAuthors = nextAuthors.filter(
      (author) => !currentAuthors.includes(author),
    );
    const now = Date.now();
    const elapsed = now - this.directMessageSubscriptionLastChangeMs;
    if (elapsed < THROTTLE_MS && addedAuthors.length === 0) {
      if (this.directMessageSubscriptionThrottleTimer === null) {
        this.directMessageSubscriptionThrottleTimer = setTimeout(() => {
          this.directMessageSubscriptionThrottleTimer = null;
          this.syncDirectMessageSubscription();
        }, THROTTLE_MS - elapsed);
      }
      return;
    }

    if (this.directMessageSubscriptionThrottleTimer !== null) {
      clearTimeout(this.directMessageSubscriptionThrottleTimer);
      this.directMessageSubscriptionThrottleTimer = null;
    }

    this.directMessageSubscriptionCleanup?.();
    this.directMessageSubscriptionCleanup = null;
    this.directMessageSubscriptionAuthors = nextAuthors;
    this.directMessageSubscriptionRecipient = nextRecipient;
    this.directMessageSubscriptionLastChangeMs = now;

    if (nextAuthors.length === 0 && !nextRecipient) {
      return;
    }

    const cleanups: Unsubscribe[] = [];
    if (nextAuthors.length > 0) {
      cleanups.push(
        this.nostrSubscribe(
          {
            kinds: [MESSAGE_EVENT_KIND],
            authors: nextAuthors,
          },
          (event) => {
            this.processReceivedEvent(event);
          },
        ),
      );
    }
    if (nextRecipient) {
      cleanups.push(
        this.nostrSubscribe(
          {
            kinds: [MESSAGE_EVENT_KIND],
            "#p": [nextRecipient],
          },
          (event) => {
            this.processReceivedEvent(event);
          },
        ),
      );
    }
    this.directMessageSubscriptionCleanup = () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }

  async refreshOwnAppKeysFromRelay(
    ownerPubkey: string,
    timeoutMs: number = this.appKeysFastTimeoutMs,
  ): Promise<boolean> {
    const nextSnapshot = await AppKeys.waitForSnapshot(
      ownerPubkey,
      this.nostrSubscribe,
      timeoutMs,
      this.ownerIdentityKey,
    );
    if (!nextSnapshot) {
      return false;
    }

    const update = await this.applyIncomingAppKeys(
      nextSnapshot.appKeys,
      nextSnapshot.createdAt,
    );
    return update !== "stale";
  }

  async prepareRegistration(
    options: PrepareRegistrationOptions,
  ): Promise<PreparedRegistration> {
    await this.initManagers();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }

    const baseKeys = await this.resolveBaseAppKeys(
      options.ownerPubkey,
      options.timeoutMs,
    );
    const appKeys = cloneAppKeys(baseKeys);

    const payload = this.buildRegistrationPayload(
      this.delegateManager,
      options,
    );
    appKeys.addDevice({
      identityPubkey: payload.identityPubkey,
      createdAt: now(),
    });
    if (payload.deviceLabel || payload.clientLabel) {
      appKeys.setDeviceLabels(payload.identityPubkey, payload);
    }

    return {
      ownerPubkey: options.ownerPubkey,
      appKeys,
      devices: appKeys.getAllDevices(),
      baseDevices: baseKeys.getAllDevices(),
      newDeviceIdentity: payload.identityPubkey,
    };
  }

  async prepareRegistrationForIdentity(
    options: PrepareRegistrationForIdentityOptions,
  ): Promise<PreparedRegistration> {
    await this.initAppKeysManager();

    const baseKeys = await this.resolveBaseAppKeys(
      options.ownerPubkey,
      options.timeoutMs,
    );
    const appKeys = cloneAppKeys(baseKeys);
    appKeys.addDevice({
      identityPubkey: options.identityPubkey,
      createdAt: now(),
    });
    if (options.deviceLabel || options.clientLabel) {
      appKeys.setDeviceLabels(options.identityPubkey, options);
    }

    return {
      ownerPubkey: options.ownerPubkey,
      appKeys,
      devices: appKeys.getAllDevices(),
      baseDevices: baseKeys.getAllDevices(),
      newDeviceIdentity: options.identityPubkey,
    };
  }

  async publishPreparedRegistration(
    prepared: PreparedRegistration,
  ): Promise<PublishPreparedRegistrationResult> {
    await this.initAppKeysManager();
    const relayConfirmationRequired =
      shouldRequireRelayRegistrationConfirmation({
        currentDevicePubkey: this.state.currentDevicePubkey,
        registeredDevices: prepared.baseDevices,
        hasLocalAppKeys: prepared.baseDevices.length > 0,
        appKeysManagerReady: this.state.appKeysManagerReady,
        sessionManagerReady: this.state.sessionManagerReady,
      });
    const publishedEvent = await this.publishAppKeys(prepared.appKeys, prepared.ownerPubkey);
    await this.appKeysManager?.setAppKeys(prepared.appKeys);
    this.feedSessionManagerEvent(publishedEvent);
    this.syncState({
      registeredDevices: prepared.devices,
      hasLocalAppKeys: prepared.devices.length > 0,
      lastAppKeysCreatedAt: publishedEvent.created_at ?? now(),
    });
    return {
      createdAt: publishedEvent.created_at ?? now(),
      relayConfirmationRequired,
    };
  }

  async prepareRevocation(
    options: PrepareRevocationOptions,
  ): Promise<PreparedRevocation> {
    const baseKeys = await this.resolveBaseAppKeys(
      options.ownerPubkey,
      options.timeoutMs,
    );
    const appKeys = cloneAppKeys(baseKeys);
    appKeys.removeDevice(options.identityPubkey);
    return {
      ownerPubkey: options.ownerPubkey,
      appKeys,
      devices: appKeys.getAllDevices(),
      revokedIdentity: options.identityPubkey,
    };
  }

  async publishPreparedRevocation(
    prepared: PreparedRevocation,
  ): Promise<number> {
    await this.initAppKeysManager();
    const publishedEvent = await this.publishAppKeys(prepared.appKeys, prepared.ownerPubkey);
    await this.appKeysManager?.setAppKeys(prepared.appKeys);
    this.feedSessionManagerEvent(publishedEvent);
    this.syncState({
      registeredDevices: prepared.devices,
      hasLocalAppKeys: prepared.devices.length > 0,
      lastAppKeysCreatedAt: publishedEvent.created_at ?? now(),
    });
    return publishedEvent.created_at ?? now();
  }

  async registerCurrentDevice(
    options: RegisterCurrentDeviceOptions,
  ): Promise<PublishPreparedRegistrationResult> {
    const prepared = await this.prepareRegistration(options);
    const result = await this.publishPreparedRegistration(prepared);
    if (result.relayConfirmationRequired) {
      await this.waitForDeviceRegistrationOnRelay(
        options.ownerPubkey,
        prepared.newDeviceIdentity,
        options.timeoutMs || this.appKeysFetchTimeoutMs,
      );
      await this.refreshOwnAppKeysFromRelay(
        options.ownerPubkey,
        options.timeoutMs || this.appKeysFastTimeoutMs,
      ).catch(() => {});
    }
    return {
      createdAt: result.createdAt,
      relayConfirmationRequired: result.relayConfirmationRequired,
    };
  }

  async registerDeviceIdentity(
    options: RegisterDeviceIdentityOptions,
  ): Promise<PublishPreparedRegistrationResult> {
    const prepared = await this.prepareRegistrationForIdentity(options);
    const result = await this.publishPreparedRegistration(prepared);
    if (result.relayConfirmationRequired) {
      await this.waitForDeviceRegistrationOnRelay(
        options.ownerPubkey,
        prepared.newDeviceIdentity,
        options.timeoutMs || this.appKeysFetchTimeoutMs,
      );
      await this.refreshOwnAppKeysFromRelay(
        options.ownerPubkey,
        options.timeoutMs || this.appKeysFastTimeoutMs,
      ).catch(() => {});
    }
    return result;
  }

  async revokeDevice(options: RevokeDeviceOptions): Promise<number> {
    const prepared = await this.prepareRevocation(options);
    return this.publishPreparedRevocation(prepared);
  }

  async ensureCurrentDeviceRegistered(
    ownerPubkey: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    await this.initManagers();
    if (this.state.isCurrentDeviceRegistered) {
      return false;
    }

    await this.registerCurrentDevice({
      ownerPubkey,
      timeoutMs,
    });
    return true;
  }

  async republishInvite(): Promise<void> {
    await this.initDelegateManager();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }
    await this.delegateManager.publishInvite();
  }

  async rotateInvite(): Promise<void> {
    await this.initDelegateManager();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }
    await this.delegateManager.rotateInvite();
  }

  async createLinkInvite(ownerPubkey?: string): Promise<Invite> {
    await this.initDelegateManager();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }
    const baseInvite = this.delegateManager.getInvite();
    if (!baseInvite) {
      throw new Error("DelegateManager invite not initialized");
    }
    const invite = Invite.deserialize(baseInvite.serialize());
    invite.purpose = "link";
    if (ownerPubkey) {
      invite.ownerPubkey = ownerPubkey;
    }
    return invite;
  }

  async acceptInvite(
    invite: Invite,
    options?: AcceptInviteOptions,
  ): Promise<AcceptInviteResult> {
    const ownerPubkey =
      options?.ownerPublicKey ||
      this.state.ownerPubkey ||
      invite.ownerPubkey ||
      invite.inviter;
    const manager = await this.waitForSessionManager(ownerPubkey);
    try {
      return await manager.acceptInvite(invite, options);
    } finally {
      await this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
  }

  async acceptLinkInvite(
    invite: Invite,
    ownerPubkey: string,
  ): Promise<AcceptInviteResult> {
    return this.acceptInvite(invite, {
      ownerPublicKey: ownerPubkey,
    });
  }

  async upsertGroup(group: GroupData, ownerPubkey?: string): Promise<void> {
    await this.groupController.upsertGroup(group, ownerPubkey);
  }

  async syncGroups(groups: GroupData[], ownerPubkey?: string): Promise<void> {
    await this.groupController.syncGroups(groups, ownerPubkey);
  }

  removeGroup(groupId: string): void {
    this.groupController.removeGroup(groupId);
  }

  async createGroup(
    name: string,
    memberOwnerPubkeys: string[],
    opts: { fanoutMetadata?: boolean; nowMs?: number } = {},
  ) {
    return this.groupController.createGroup(name, memberOwnerPubkeys, opts);
  }

  async sendGroupEvent(
    groupId: string,
    event: RuntimeGroupEvent,
    opts: SendGroupEventOptions = {},
  ) {
    return this.groupController.sendGroupEvent(groupId, event, opts);
  }

  async sendGroupMessage(
    groupId: string,
    message: string,
    opts: SendGroupEventOptions = {},
  ) {
    return this.groupController.sendGroupMessage(groupId, message, opts);
  }

  close(): void {
    this.stopAppKeysSubscription();
    this.messagePushAuthorCleanup?.();
    this.messagePushAuthorCleanup = null;
    this.directMessageSubscriptionCleanup?.();
    this.directMessageSubscriptionCleanup = null;
    this.directMessageSubscriptionAuthors = [];
    this.directMessageSubscriptionLastChangeMs = 0;
    if (this.directMessageSubscriptionThrottleTimer !== null) {
      clearTimeout(this.directMessageSubscriptionThrottleTimer);
      this.directMessageSubscriptionThrottleTimer = null;
    }
    this.clearSessionManagerRuntime();
    this.groupController.close();
    this.appKeysManager?.close();
    this.delegateManager?.close();
    this.sessionManager?.close();
    this.appKeysManager = null;
    this.delegateManager = null;
    this.sessionManager = null;
    this.appKeysInitPromise = null;
    this.delegateInitPromise = null;
    this.sessionManagerInitPromise = null;
    this.syncState({
      ownerPubkey: null,
      currentDevicePubkey: null,
      registeredDevices: [],
      hasLocalAppKeys: false,
      lastAppKeysCreatedAt: 0,
      appKeysManagerReady: false,
      delegateManagerReady: false,
      sessionManagerReady: false,
      groupManagerReady: false,
      appKeysSubscriptionActive: false,
    });
  }

  private attachSessionManagerEvents(manager: SessionManager): void {
    this.clearSessionManagerRuntime();
    this.sessionManagerRuntimeEventCleanup = manager.onRuntimeEvent((event) =>
      this.handleSessionManagerEvent(event)
    );
    this.preparedPublishCleanup = manager.onPreparedPublishesAvailable(() => {
      void this.flushPreparedPublishes();
    });
  }

  async retryPendingPublishes(): Promise<void> {
    await this.flushPreparedPublishes();
  }

  private async flushPreparedPublishes(): Promise<void> {
    if (this.preparedPublishFlushPromise) {
      return this.preparedPublishFlushPromise;
    }

    this.preparedPublishFlushPromise = (async () => {
      const attempted = new Set<string>();
      while (true) {
        const prepared = (this.sessionManager?.pendingPublishes?.() ?? [])
          .filter((publish) => !attempted.has(publish.id));
        if (prepared.length === 0) return;

        for (const publish of prepared) {
          attempted.add(publish.id);
          try {
            await this.nostrPublish(publish.event, publish.innerEventId);
            await this.sessionManager?.acknowledgePublish(publish.id);
          } catch (error) {
            await this.sessionManager?.publishFailed(publish.id, error).catch(() => {});
          }
        }
      }
    })().finally(() => {
      this.preparedPublishFlushPromise = null;
    });

    return this.preparedPublishFlushPromise;
  }

  private async handleSessionManagerEvent(
    event: SessionManagerEvent,
  ): Promise<void> {
    if (event.type === "decryptedMessage") {
      this.groupController.processSessionEvent(event.event, event.sender, event.meta);
      for (const callback of this.sessionEventCallbacks) {
        callback(event.event, event.sender, event.meta);
      }
      return;
    }

    if (event.type === "unsubscribe") {
      this.sessionManagerEmittedSubscriptions.get(event.subid)?.();
      this.sessionManagerEmittedSubscriptions.delete(event.subid);
      return;
    }

    this.sessionManagerEmittedSubscriptions.get(event.subid)?.();
    const cleanup = this.nostrSubscribe(event.filter, (received) => {
      this.feedSessionManagerEvent(received);
    });
    this.sessionManagerEmittedSubscriptions.set(event.subid, cleanup);
  }

  private feedSessionManagerEvent(event: VerifiedEvent): boolean {
    const handled = this.sessionManager?.feedEvent(event) ?? false;
    if (handled) {
      void this.flushPreparedPublishes();
      this.syncDirectMessageSubscription();
    }
    return handled;
  }

  private async feedLocalAppKeysSnapshotToSessionManager(ownerPubkey: string): Promise<boolean> {
    if (!this.ownerIdentityKey) {
      return false;
    }

    const appKeys = this.appKeysManager?.getAppKeys();
    if (!appKeys || appKeys.getAllDevices().length === 0) {
      return false;
    }

    const profileId = await this.ensureAppKeysProfileId(ownerPubkey);
    const signedEvent = finalizeEvent(
      appKeys.getEvent({
        ownerPrivateKey: this.ownerIdentityKey,
        ownerPubkey,
        profileId,
      }),
      this.ownerIdentityKey,
    ) as VerifiedEvent;
    if (signedEvent.pubkey !== ownerPubkey) {
      return false;
    }

    return this.feedSessionManagerEvent(signedEvent);
  }

  private clearSessionManagerRuntime(): void {
    this.sessionManagerRuntimeEventCleanup?.();
    this.sessionManagerRuntimeEventCleanup = null;
    this.preparedPublishCleanup?.();
    this.preparedPublishCleanup = null;
    for (const cleanup of this.sessionManagerEmittedSubscriptions.values()) {
      cleanup();
    }
    this.sessionManagerEmittedSubscriptions.clear();
  }

  private resolveActiveOwnerPubkey(ownerPubkey?: string): string {
    const resolvedOwnerPubkey =
      ownerPubkey ||
      this.state.ownerPubkey ||
      this.delegateManager?.getOwnerPublicKey() ||
      null;
    if (!resolvedOwnerPubkey) {
      throw new Error("Owner pubkey required to initialize SessionManager");
    }
    return resolvedOwnerPubkey;
  }

  private buildRegistrationPayload(
    delegateManager: DelegateManager,
    options: Pick<PrepareRegistrationOptions, "deviceLabel" | "clientLabel">,
  ): DelegatePayload {
    const payload = delegateManager.getRegistrationPayload();
    return {
      ...payload,
      ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
      ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
    };
  }

  private async applyIncomingAppKeys(
    incomingAppKeys: AppKeys,
    incomingCreatedAt: number,
  ): Promise<"advanced" | "stale" | "merged_equal_timestamp"> {
    await this.initAppKeysManager();
    const update = applyAppKeysSnapshot({
      currentAppKeys: this.appKeysManager?.getAppKeys(),
      currentCreatedAt: this.state.lastAppKeysCreatedAt,
      incomingAppKeys,
      incomingCreatedAt,
    });
    if (update.decision === "stale") {
      return update.decision;
    }

    await this.appKeysManager?.setAppKeys(update.appKeys);
    this.syncState({
      registeredDevices: update.appKeys.getAllDevices(),
      hasLocalAppKeys: update.appKeys.getAllDevices().length > 0,
      lastAppKeysCreatedAt: update.createdAt,
    });
    return update.decision;
  }

  private async ensureAppKeysProfileId(ownerPubkey: string): Promise<string> {
    const cached = this.appKeysProfileIds.get(ownerPubkey);
    if (cached) return cached;

    const key = `v1/app-keys-profile-id/${ownerPubkey}`;
    const stored = await this.storage.get<string>(key);
    if (stored) {
      this.appKeysProfileIds.set(ownerPubkey, stored);
      return stored;
    }

    const profileId = createAppKeysProfileId();
    await this.storage.put(key, profileId);
    this.appKeysProfileIds.set(ownerPubkey, profileId);
    return profileId;
  }

  private async publishAppKeys(appKeys: AppKeys, ownerPubkey: string) {
    const profileId = await this.ensureAppKeysProfileId(ownerPubkey);
    const createdAt = Math.max(now(), this.state.lastAppKeysCreatedAt + 1);
    return this.nostrPublish(appKeys.getEvent({
      ownerPrivateKey: this.ownerIdentityKey,
      ownerPubkey,
      profileId,
      createdAt,
    }));
  }

  private async waitForDeviceRegistrationOnRelay(
    ownerPubkey: string,
    devicePubkey: string,
    timeoutMs: number,
  ): Promise<void> {
    const appKeys = await AppKeys.waitFor(
      ownerPubkey,
      this.nostrSubscribe,
      timeoutMs,
      this.ownerIdentityKey,
    );
    const isAuthorized =
      appKeys
        ?.getAllDevices()
        .some((device) => device.identityPubkey === devicePubkey) ?? false;

    if (!isAuthorized) {
      throw new Error(
        `Relay AppKeys for ${ownerPubkey} do not include current device ${devicePubkey}`,
      );
    }
  }

  private syncState(
    patch: Partial<
      Omit<
        NdrRuntimeState,
        | "isCurrentDeviceRegistered"
        | "hasKnownRegisteredDevices"
        | "noPreviousDevicesFound"
        | "requiresDeviceRegistration"
        | "canSendPrivateMessages"
      >
    >,
  ): void {
    const nextState = {
      ...this.state,
      ...patch,
    };
    const derived = evaluateDeviceRegistrationState({
      currentDevicePubkey: nextState.currentDevicePubkey,
      registeredDevices: nextState.registeredDevices,
      hasLocalAppKeys: nextState.hasLocalAppKeys,
      appKeysManagerReady: nextState.appKeysManagerReady,
      sessionManagerReady: nextState.sessionManagerReady,
    });
    this.state = {
      ...nextState,
      ...derived,
    };
    for (const listener of this.stateListeners) {
      listener(this.getState());
    }
  }
}
