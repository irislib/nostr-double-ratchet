import {
  AppKeys,
  applyAppKeysSnapshotPreservingLabels,
  createAppKeysProfileId,
  type DeviceEntry,
} from "./AppKeys.js";
import { DelegateManager, type DelegatePayload } from "./AppKeysManager.js";
import {
  evaluateDeviceRegistrationState,
  type DeviceRegistrationState,
} from "./multiDevice.js";
import { SessionManager, type SessionManagerEvent } from "./SessionManager.js";
import { type StorageAdapter } from "./StorageAdapter.js";
import {
  type NostrFetch,
  type NostrPublish,
  type NostrSubscribe,
} from "./types.js";
import { finalizeEvent, type VerifiedEvent } from "nostr-tools";
import { NdrRuntimeRegistration } from "./ndr-runtime/NdrRuntimeRegistration.js";
import { now } from "./ndr-runtime/runtimeInternals.js";

export type { QueuedMessageDiagnostic } from "./SessionManager.js";
export type {
  RuntimeGroupEvent,
  SendGroupEventOptions,
} from "./RuntimeGroupController.js";

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

export class NdrRuntime extends NdrRuntimeRegistration {
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
    this.clearSessionManagerEvents();
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

  protected attachSessionManagerEvents(manager: SessionManager): void {
    this.clearSessionManagerEvents();
    this.sessionManagerEventsAvailableCleanup = manager.onEventsAvailable(
      () => {
        void this.flushSessionManagerEvents().catch(() => {});
      },
    );
    void this.flushSessionManagerEvents().catch(() => {});
  }

  protected async flushSessionManagerEvents(): Promise<void> {
    // Dispatch in order, without letting a relay acknowledgement hold up
    // subscriptions or decrypted messages. Explicit callers still await I/O.
    const manager = this.sessionManager;
    while (this.sessionManager === manager) {
      for (const event of manager?.drainEvents() ?? []) {
        const pending = Promise.resolve()
          .then(() => {
            if (this.sessionManager === manager) {
              return this.handleSessionManagerEvent(event);
            }
          })
          .finally(() => this.pendingSessionManagerEvents.delete(pending));
        this.pendingSessionManagerEvents.add(pending);
      }
      if (this.pendingSessionManagerEvents.size === 0) return;
      await Promise.all(this.pendingSessionManagerEvents);
    }
  }

  protected async handleSessionManagerEvent(
    event: SessionManagerEvent,
  ): Promise<void> {
    if (event.type === "decryptedMessage") {
      this.groupController.processSessionEvent(
        event.event,
        event.sender,
        event.meta,
      );
      for (const callback of this.sessionEventCallbacks) {
        callback(event.event, event.sender, event.meta);
      }
      return;
    }

    if (event.type === "publish") {
      await this.nostrPublish(event.event, event.innerEventId);
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

  protected feedSessionManagerEvent(event: VerifiedEvent): boolean {
    const handled = this.sessionManager?.feedEvent(event) ?? false;
    if (handled) {
      void this.flushSessionManagerEvents().catch(() => {});
      this.syncDirectMessageSubscription();
    }
    return handled;
  }

  protected async feedLocalAppKeysSnapshotToSessionManager(
    ownerPubkey: string,
  ): Promise<boolean> {
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

  protected clearSessionManagerEvents(): void {
    this.sessionManagerEventsAvailableCleanup?.();
    this.sessionManagerEventsAvailableCleanup = null;
    for (const cleanup of this.sessionManagerEmittedSubscriptions.values()) {
      cleanup();
    }
    this.sessionManagerEmittedSubscriptions.clear();
    this.pendingSessionManagerEvents.clear();
  }

  protected resolveActiveOwnerPubkey(ownerPubkey?: string): string {
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

  protected async withSessionManager<T>(
    ownerPubkey: string,
    operation: (manager: SessionManager) => Promise<T>,
  ): Promise<T> {
    const manager = await this.waitForSessionManager(ownerPubkey);
    try {
      return await operation(manager);
    } finally {
      await this.flushSessionManagerEvents();
      this.syncDirectMessageSubscription();
    }
  }

  protected buildRegistrationPayload(
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

  protected async applyIncomingAppKeys(
    incomingAppKeys: AppKeys,
    incomingCreatedAt: number,
  ): Promise<"advanced" | "stale" | "merged_equal_timestamp"> {
    await this.initAppKeysManager();
    const update = applyAppKeysSnapshotPreservingLabels({
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

  protected async ensureAppKeysProfileId(ownerPubkey: string): Promise<string> {
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

  protected async publishAppKeys(appKeys: AppKeys, ownerPubkey: string) {
    const profileId = await this.ensureAppKeysProfileId(ownerPubkey);
    const createdAt = Math.max(now(), this.state.lastAppKeysCreatedAt + 1);
    return this.nostrPublish(
      appKeys.getEvent({
        ownerPrivateKey: this.ownerIdentityKey,
        ownerPubkey,
        profileId,
        createdAt,
      }),
    );
  }

  protected async waitForDeviceRegistrationOnRelay(
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

  protected syncState(
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
