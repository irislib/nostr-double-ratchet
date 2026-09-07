import { AppKeys } from "../AppKeys.js";
import { AppKeysManager, DelegateManager } from "../AppKeysManager.js";
import { GroupManager, type GroupDecryptedEvent } from "../Group.js";
import {
  type AppKeysSnapshotDecision,
  type KnownAppKeysSnapshot,
  type SessionUserRecordsLike,
} from "../multiDevice.js";
import { SessionManager, type OnEventCallback } from "../SessionManager.js";
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "../StorageAdapter.js";
import {
  type NostrFetch,
  type NostrPublish,
  type NostrSubscribe,
  type Unsubscribe,
} from "../types.js";
import { type VerifiedEvent } from "nostr-tools";
import { SessionGroupRuntime } from "../RuntimeGroupController.js";
import { createNostrPublisher } from "../publishing.js";
import type { NdrRuntimeOptions, NdrRuntimeState } from "../NdrRuntime.js";
import {
  cloneAppKeys,
  DEFAULT_APP_KEYS_FAST_TIMEOUT_MS,
  DEFAULT_APP_KEYS_FETCH_TIMEOUT_MS,
} from "./runtimeInternals.js";

export abstract class NdrRuntimeCore {
  protected readonly nostrSubscribe: NostrSubscribe;

  protected readonly nostrPublish: NostrPublish;

  protected readonly nostrFetch?: NostrFetch;

  protected readonly storage: StorageAdapter;

  protected readonly sessionStorage: StorageAdapter;

  protected readonly groupStorage: StorageAdapter;

  protected readonly groupController: SessionGroupRuntime;

  protected readonly ownerIdentityKey?: Uint8Array;

  protected readonly appKeysFetchTimeoutMs: number;

  protected readonly appKeysFastTimeoutMs: number;

  protected readonly appKeysProfileIds = new Map<string, string>();

  protected appKeysManager: AppKeysManager | null = null;

  protected delegateManager: DelegateManager | null = null;

  protected sessionManager: SessionManager | null = null;

  protected appKeysInitPromise: Promise<void> | null = null;

  protected delegateInitPromise: Promise<void> | null = null;

  protected sessionManagerInitPromise: Promise<SessionManager> | null = null;

  protected appKeysSubscriptionCleanup: Unsubscribe | null = null;

  protected appKeysSubscriptionOwnerPubkey: string | null = null;

  protected directMessageSubscriptionCleanup: Unsubscribe | null = null;

  protected directMessageSubscriptionAuthors: string[] = [];

  protected directMessageSubscriptionRecipient: string | null = null;

  protected directMessageSubscriptionLastChangeMs = 0;

  protected directMessageSubscriptionThrottleTimer: ReturnType<
    typeof setTimeout
  > | null = null;

  protected messagePushAuthorCleanup: Unsubscribe | null = null;

  protected sessionManagerEventsAvailableCleanup: Unsubscribe | null = null;

  protected readonly pendingSessionManagerEvents = new Set<Promise<void>>();

  protected readonly sessionManagerEmittedSubscriptions = new Map<
    string,
    Unsubscribe
  >();

  protected readonly stateListeners = new Set<
    (state: NdrRuntimeState) => void
  >();

  protected readonly sessionEventCallbacks = new Set<OnEventCallback>();

  protected state: NdrRuntimeState = {
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
    this.nostrPublish = createNostrPublisher(options.nostrPublish, options);
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
      (this.sessionManager?.getUserRecords() as unknown as
        | SessionUserRecordsLike
        | undefined) ?? new Map()
    );
  }

  getKnownAppKeysSnapshots(): KnownAppKeysSnapshot[] {
    const snapshots = new Map(
      (this.sessionManager?.getKnownAppKeysSnapshots() ?? []).map(
        (snapshot) => [snapshot.ownerPubkey, snapshot],
      ),
    );
    const ownerPubkey = this.state.ownerPubkey;
    const ownAppKeys = this.appKeysManager?.getAppKeys();
    if (ownerPubkey && ownAppKeys) {
      snapshots.set(ownerPubkey, {
        ownerPubkey,
        appKeys: new AppKeys(
          ownAppKeys.getAllDevices().map((device) => ({ ...device })),
        ),
        createdAt: this.state.lastAppKeysCreatedAt,
      });
    }
    return Array.from(snapshots.values()).sort((left, right) =>
      left.ownerPubkey.localeCompare(right.ownerPubkey),
    );
  }

  async applyTrustedAppKeysSnapshot(
    snapshot: KnownAppKeysSnapshot,
  ): Promise<AppKeysSnapshotDecision> {
    const ownerPubkey = this.state.ownerPubkey;
    if (!ownerPubkey) {
      throw new Error("Owner pubkey required to apply AppKeys snapshot");
    }
    const incoming = cloneAppKeys(snapshot.appKeys);
    const manager = await this.waitForSessionManager(ownerPubkey);
    let decision: AppKeysSnapshotDecision;

    if (snapshot.ownerPubkey === ownerPubkey) {
      decision = await this.applyIncomingAppKeys(incoming, snapshot.createdAt);
      const effective = this.appKeysManager?.getAppKeys();
      if (effective) {
        await manager.applyTrustedAppKeysSnapshot({
          ownerPubkey,
          appKeys: cloneAppKeys(effective),
          createdAt: this.state.lastAppKeysCreatedAt,
        });
      }
    } else {
      decision = await manager.applyTrustedAppKeysSnapshot({
        ...snapshot,
        appKeys: incoming,
      });
    }

    await this.flushSessionManagerEvents();
    this.syncDirectMessageSubscription();
    return decision;
  }

  getSessionMessagePushAuthorPubkeys(peerPubkey: string): string[] {
    return this.sessionManager?.getMessagePushAuthorPubkeys(peerPubkey) ?? [];
  }

  getKnownDeviceIdentityPubkeysForOwner(ownerPubkey: string): string[] {
    return (
      this.sessionManager?.getKnownDeviceIdentityPubkeysForOwner(ownerPubkey) ??
      []
    );
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
      await this.flushSessionManagerEvents();
      this.messagePushAuthorCleanup?.();
      this.messagePushAuthorCleanup = manager.onMessagePushAuthorsChanged(
        () => {
          this.syncDirectMessageSubscription();
        },
      );
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
        this.clearSessionManagerEvents();
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
      await this.flushSessionManagerEvents();
      this.syncDirectMessageSubscription();
    }
  }

  abstract startAppKeysSubscription(ownerPubkey: string): void;

  protected abstract syncDirectMessageSubscription(): void;

  protected abstract attachSessionManagerEvents(manager: SessionManager): void;

  protected abstract flushSessionManagerEvents(): Promise<void>;

  protected abstract feedSessionManagerEvent(event: VerifiedEvent): boolean;

  protected abstract feedLocalAppKeysSnapshotToSessionManager(
    ownerPubkey: string,
  ): Promise<boolean>;

  protected abstract clearSessionManagerEvents(): void;

  protected abstract resolveActiveOwnerPubkey(ownerPubkey?: string): string;

  protected abstract applyIncomingAppKeys(
    incomingAppKeys: AppKeys,
    incomingCreatedAt: number,
  ): Promise<"advanced" | "stale" | "merged_equal_timestamp">;

  protected abstract syncState(
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
  ): void;
}
