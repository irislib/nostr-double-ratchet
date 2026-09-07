import { getPublicKey } from "nostr-tools";
import {
  AppKeys,
  createAppKeysProfileId,
  DeviceEntry,
  DeviceLabels,
} from "./AppKeys.js";
import { NostrSubscribe, NostrPublish, type NostrPublisherOptions } from "./types.js";
import { createNostrPublisher } from "./publishing.js";
import { StorageAdapter, InMemoryStorageAdapter } from "./StorageAdapter.js";

export interface DelegatePayload {
  identityPubkey: string;
  deviceLabel?: string;
  clientLabel?: string;
}

/**
 * Options for AppKeysManager (authority for AppKeys)
 */
export interface AppKeysManagerOptions extends NostrPublisherOptions {
  nostrPublish: NostrPublish;
  storage?: StorageAdapter;
  ownerIdentityKey?: Uint8Array;
  ownerPubkey?: string;
}

/**
 * Options for DelegateManager (device identity)
 */
export interface DelegateManagerOptions extends NostrPublisherOptions {
  nostrSubscribe: NostrSubscribe;
  nostrPublish: NostrPublish;
  storage?: StorageAdapter;
}

/**
 * AppKeysManager - Authority for AppKeys.
 * Manages local AppKeys and publishes to relays.
 * Does NOT have device identity (no Invite, no SessionManager creation).
 */
export class AppKeysManager {
  private readonly nostrPublish: NostrPublish;
  private readonly storage: StorageAdapter;
  private readonly ownerIdentityKey?: Uint8Array;
  private readonly ownerPubkey?: string;

  private appKeys: AppKeys | null = null;
  private appKeysProfileId: string | null = null;
  private lastPublishedAppKeysCreatedAt = 0;
  private initialized = false;

  private readonly storageVersion = "3";
  private get versionPrefix(): string {
    return `v${this.storageVersion}`;
  }

  constructor(options: AppKeysManagerOptions) {
    this.nostrPublish = createNostrPublisher(options.nostrPublish, options);
    this.storage = options.storage || new InMemoryStorageAdapter();
    this.ownerIdentityKey = options.ownerIdentityKey;
    const keyPubkey = options.ownerIdentityKey
      ? getPublicKey(options.ownerIdentityKey)
      : undefined;
    if (options.ownerPubkey && keyPubkey && options.ownerPubkey !== keyPubkey) {
      throw new Error(
        "AppKeysManager ownerPubkey does not match ownerIdentityKey",
      );
    }
    this.ownerPubkey = options.ownerPubkey ?? keyPubkey;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Load local only - no auto-subscribe, no auto-publish, no auto-merge
    this.appKeys = await this.loadAppKeys();
    if (!this.appKeys) {
      this.appKeys = new AppKeys();
    }
  }

  getAppKeys(): AppKeys | null {
    return this.appKeys;
  }

  getOwnDevices(): DeviceEntry[] {
    return this.appKeys?.getAllDevices() || [];
  }

  /**
   * Add a device to the AppKeys.
   * Only adds identity info - the device publishes its own Invite separately.
   * This is a local-only operation - call publish() to publish to relays.
   */
  addDevice(payload: DelegatePayload): void {
    if (!this.appKeys) {
      this.appKeys = new AppKeys();
    }

    const device: DeviceEntry = {
      identityPubkey: payload.identityPubkey,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.appKeys.addDevice(device);
    if (payload.deviceLabel || payload.clientLabel) {
      this.appKeys.setDeviceLabels(payload.identityPubkey, {
        deviceLabel: payload.deviceLabel,
        clientLabel: payload.clientLabel,
      });
    }
    this.saveAppKeys(this.appKeys).catch(() => {});
  }

  setDeviceLabels(
    identityPubkey: string,
    labels: {
      deviceLabel?: string;
      clientLabel?: string;
    },
  ): void {
    if (!this.appKeys) {
      this.appKeys = new AppKeys();
    }

    this.appKeys.setDeviceLabels(identityPubkey, labels);
    this.saveAppKeys(this.appKeys).catch(() => {});
  }

  getDeviceLabels(identityPubkey: string): DeviceLabels | undefined {
    return this.appKeys?.getDeviceLabels(identityPubkey);
  }

  /**
   * Revoke a device from the AppKeys.
   * This is a local-only operation - call publish() to publish to relays.
   */
  revokeDevice(identityPubkey: string): void {
    if (!this.appKeys) return;

    this.appKeys.removeDevice(identityPubkey);
    this.saveAppKeys(this.appKeys).catch(() => {});
  }

  /**
   * Publish the current AppKeys to relays.
   * This is the only way to publish - addDevice/revokeDevice are local-only.
   */
  async publish(): Promise<void> {
    if (!this.appKeys) {
      this.appKeys = new AppKeys();
    }

    const ownerPubkey = this.ownerPubkey;
    if (!ownerPubkey) {
      throw new Error("Owner pubkey is required to publish AppKeys");
    }
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      this.lastPublishedAppKeysCreatedAt + 1,
    );
    const event = this.appKeys.getEvent({
      ownerPrivateKey: this.ownerIdentityKey,
      ownerPubkey,
      ...(ownerPubkey
        ? { profileId: await this.ensureAppKeysProfileId(ownerPubkey) }
        : {}),
      createdAt,
    });
    const published = await this.nostrPublish(event);
    this.lastPublishedAppKeysCreatedAt = published.created_at ?? createdAt;
  }

  /**
   * Replace the local AppKeys with the given list and save to storage.
   * Used for authority transfer - receive list from another device, then call publish().
   */
  async setAppKeys(list: AppKeys): Promise<void> {
    this.appKeys = list;
    await this.saveAppKeys(list);
  }

  /**
   * Cleanup resources. Currently a no-op but kept for API consistency.
   */
  close(): void {
    // No-op - no subscriptions to clean up
  }

  private appKeysKey(): string {
    return `${this.versionPrefix}/app-keys-manager/app-keys`;
  }

  private appKeysProfileIdKey(ownerPubkey: string): string {
    return `${this.versionPrefix}/app-keys-manager/profile-id/${ownerPubkey}`;
  }

  private async ensureAppKeysProfileId(ownerPubkey: string): Promise<string> {
    if (this.appKeysProfileId) return this.appKeysProfileId;
    const key = this.appKeysProfileIdKey(ownerPubkey);
    const stored = await this.storage.get<string>(key);
    if (stored) {
      this.appKeysProfileId = stored;
      return stored;
    }
    const profileId = createAppKeysProfileId();
    await this.storage.put(key, profileId);
    this.appKeysProfileId = profileId;
    return profileId;
  }

  private async loadAppKeys(): Promise<AppKeys | null> {
    const data = await this.storage.get<string>(this.appKeysKey());
    if (!data) return null;
    try {
      return AppKeys.deserialize(data);
    } catch {
      return null;
    }
  }

  private async saveAppKeys(list: AppKeys): Promise<void> {
    await this.storage.put(this.appKeysKey(), list.serialize());
  }
}

export { DelegateManager } from "./app-keys/DelegateManager.js";
