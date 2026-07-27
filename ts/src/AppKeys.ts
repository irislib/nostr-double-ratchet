import {
  type VerifiedEvent,
  type UnsignedEvent,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import {
  applyAppKeysSnapshot,
  type AppKeysSnapshotUpdate,
  type ApplyAppKeysSnapshotOptions,
} from "./multiDevice.js";
import { type NostrSubscribe, type Unsubscribe } from "./types.js";
import {
  APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
  APP_KEYS_FACT_TYPE,
  APP_KEYS_OWNER_PUBKEY_FACT,
  APP_KEYS_SCHEMA,
  APP_KEYS_SNAPSHOT_KIND,
  buildAppKeysFactSnapshotTags,
  buildAppKeysFilter,
  canonicalProfileId,
  createAppKeysProfileId,
  factTag,
  firstTagValue,
  isAppKeysSnapshotEvent,
  isDeviceTag,
  normalizeAppKeysEventOptions,
  normalizeDeviceLabelsEntry,
  now,
  profileIdFromTags,
  requireHexPubkey,
  requireInteger,
  requireTagValue,
  type AppKeysEventOptions,
  type DeviceEntry,
  type DeviceLabels,
  type DeviceLabelsEntry,
  type EncryptedAppKeysContent,
  type LegacyEncryptedAppKeysContent,
  type ParsedAppKeysSnapshot,
} from "./app-keys/AppKeysEvents.js";

export {
  APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
  APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA,
  APP_KEYS_FACT_TYPE,
  APP_KEYS_OWNER_PUBKEY_FACT,
  APP_KEYS_SCHEMA,
  APP_KEYS_SNAPSHOT_KIND,
  buildAppKeysDeviceAuthorizationFilter,
  buildAppKeysFilter,
  buildAppKeysSnapshotFilter,
  createAppKeysProfileId,
  encryptedDeviceLabelPayloadsFromAppKeysSnapshotEvent,
  isAppKeysEvent,
  isAppKeysSnapshotEvent,
} from "./app-keys/AppKeysEvents.js";
export type {
  AppKeysEncryptedDeviceLabelsPayload,
  AppKeysEventOptions,
  DeviceEntry,
  DeviceLabels,
  ParsedAppKeysSnapshot,
} from "./app-keys/AppKeysEvents.js";

export function resolveAppKeysOwnerForDevice(
  event: VerifiedEvent,
  identityPubkey: string,
  ownerPrivateKey?: Uint8Array,
): string | null {
  const normalizedDevicePubkey = requireHexPubkey(identityPubkey, "device");
  const appKeys = AppKeys.fromEvent(event, ownerPrivateKey);
  return appKeys.getDevice(normalizedDevicePubkey) ? event.pubkey : null;
}

/**
 * Manages the owner's current device roster as a kind 37368 fact snapshot.
 * Single atomic event containing all device invites for a user.
 * Uses union merge strategy for conflict resolution.
 */
export class AppKeys {
  private devices: Map<string, DeviceEntry> = new Map();
  private deviceLabels: Map<string, DeviceLabels> = new Map();

  constructor(
    devices: DeviceEntry[] = [],
    deviceLabels: DeviceLabelsEntry[] = [],
  ) {
    devices.forEach((device) =>
      this.devices.set(device.identityPubkey, device),
    );
    deviceLabels.forEach(({ identityPubkey, ...labels }) => {
      this.deviceLabels.set(identityPubkey, labels);
    });
  }

  /**
   * Creates a new device identity entry.
   * Note: This only creates the identity entry. The device must separately
   * create and publish its own Invite event with ephemeral keys.
   */
  createDeviceEntry(identityPubkey: string): DeviceEntry {
    return {
      identityPubkey,
      createdAt: now(),
    };
  }

  addDevice(device: DeviceEntry): void {
    if (!this.devices.has(device.identityPubkey)) {
      this.devices.set(device.identityPubkey, device);
    }
  }

  removeDevice(identityPubkey: string): void {
    this.devices.delete(identityPubkey);
    this.deviceLabels.delete(identityPubkey);
  }

  getDevice(identityPubkey: string): DeviceEntry | undefined {
    return this.devices.get(identityPubkey);
  }

  getAllDevices(): DeviceEntry[] {
    return Array.from(this.devices.values());
  }

  setDeviceLabels(
    identityPubkey: string,
    labels: {
      deviceLabel?: string;
      clientLabel?: string;
    },
    updatedAt = now(),
  ): void {
    this.deviceLabels.set(identityPubkey, {
      deviceLabel: labels.deviceLabel,
      clientLabel: labels.clientLabel,
      updatedAt,
    });
  }

  getDeviceLabels(identityPubkey: string): DeviceLabels | undefined {
    return this.deviceLabels.get(identityPubkey);
  }

  getAllDeviceLabels(): DeviceLabelsEntry[] {
    return Array.from(this.deviceLabels.entries()).map(
      ([identityPubkey, labels]) => ({
        identityPubkey,
        ...labels,
      }),
    );
  }

  private getEncryptedContent(ownerPrivateKey?: Uint8Array): string {
    const deviceLabels = this.getAllDeviceLabels().filter(
      ({ identityPubkey }) => this.devices.has(identityPubkey),
    );

    if (deviceLabels.length === 0) {
      return "";
    }

    if (!ownerPrivateKey) {
      return "";
    }

    const ownerPublicKey = getPublicKey(ownerPrivateKey);
    const conversationKey = nip44.v2.utils.getConversationKey(
      ownerPrivateKey,
      ownerPublicKey,
    );
    const plaintext: EncryptedAppKeysContent = {
      type: "app-keys-labels",
      v: 1,
      deviceLabels,
    };

    return nip44.v2.encrypt(JSON.stringify(plaintext), conversationKey);
  }

  private loadEncryptedContent(
    content: string,
    ownerPrivateKey: Uint8Array,
  ): void {
    if (!content) return;

    const ownerPublicKey = getPublicKey(ownerPrivateKey);
    const conversationKey = nip44.v2.utils.getConversationKey(
      ownerPrivateKey,
      ownerPublicKey,
    );
    const decrypted = nip44.v2.decrypt(content, conversationKey);
    const payload = JSON.parse(decrypted) as LegacyEncryptedAppKeysContent;

    if (payload.type !== "app-keys-labels" || payload.v !== 1) {
      throw new Error("Unsupported AppKeys label payload");
    }

    const rawLabelEntries = Array.isArray(payload.deviceLabels)
      ? payload.deviceLabels
      : Array.isArray(payload.device_labels)
        ? payload.device_labels
        : [];
    const labelEntries = rawLabelEntries
      .map(normalizeDeviceLabelsEntry)
      .filter((entry): entry is DeviceLabelsEntry => entry !== null);

    this.deviceLabels.clear();
    labelEntries.forEach(({ identityPubkey, ...labels }) => {
      if (this.devices.has(identityPubkey)) {
        this.deviceLabels.set(identityPubkey, labels);
      }
    });
  }

  getEvent(options: Uint8Array | AppKeysEventOptions): UnsignedEvent {
    const normalized = normalizeAppKeysEventOptions(options);
    const profileId = canonicalProfileId(
      normalized.profileId ?? createAppKeysProfileId(),
    );
    const ownerPubkey = normalized.ownerPubkey
      ? requireHexPubkey(normalized.ownerPubkey, "owner")
      : undefined;
    if (!ownerPubkey) {
      throw new Error("AppKeys roster owner pubkey is required");
    }
    const facts = [
      factTag("type", APP_KEYS_FACT_TYPE),
      factTag("schema", String(APP_KEYS_SCHEMA)),
      factTag(APP_KEYS_OWNER_PUBKEY_FACT, ownerPubkey),
      ...this.getAllDevices()
        .slice()
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            left.identityPubkey.localeCompare(right.identityPubkey),
        )
        .map((device) =>
          factTag(
            "device",
            device.identityPubkey.trim().toLowerCase(),
            String(device.createdAt),
          ),
        ),
    ];
    const encryptedLabels = this.getEncryptedContent(
      normalized.ownerPrivateKey,
    );
    if (encryptedLabels) {
      facts.push(
        factTag(APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT, encryptedLabels),
      );
    }

    return {
      kind: APP_KEYS_SNAPSHOT_KIND,
      pubkey: "", // Signer will set this
      content: "",
      created_at: normalized.createdAt,
      tags: buildAppKeysFactSnapshotTags(profileId, facts, normalized.heads),
    };
  }

  static fromEvent(
    event: VerifiedEvent,
    ownerPrivateKey?: Uint8Array,
  ): AppKeys {
    if (!event.sig) {
      throw new Error("Event is not signed");
    }
    if (!verifyEvent(event)) {
      throw new Error("Event signature is invalid");
    }
    if (!isAppKeysSnapshotEvent(event)) {
      throw new Error("Event is not an AppKeys roster snapshot");
    }
    if (event.content !== "") {
      throw new Error("AppKeys roster snapshot content must be empty");
    }
    const schema = requireInteger(
      requireTagValue(event.tags, "schema"),
      "schema",
    );
    if (schema !== APP_KEYS_SCHEMA) {
      throw new Error(`Unsupported AppKeys roster schema ${schema}`);
    }
    const ownerPubkey = requireHexPubkey(
      requireTagValue(event.tags, APP_KEYS_OWNER_PUBKEY_FACT),
      "owner",
    );
    if (ownerPubkey !== event.pubkey) {
      throw new Error("AppKeys roster owner signer mismatch");
    }
    profileIdFromTags(event.tags);

    const devices = event.tags
      .filter(isDeviceTag)
      .map(([, identityPubkey, createdAt]) => ({
        identityPubkey: identityPubkey.trim().toLowerCase(),
        createdAt: parseInt(createdAt, 10) || event.created_at,
      }));

    const appKeys = new AppKeys(devices);
    const encryptedLabels = firstTagValue(
      event.tags,
      APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
    );
    if (ownerPrivateKey && encryptedLabels) {
      appKeys.loadEncryptedContent(encryptedLabels, ownerPrivateKey);
    }

    return appKeys;
  }

  static fromAppKeysSnapshotEvent(
    event: VerifiedEvent,
    ownerPrivateKey?: Uint8Array,
  ): ParsedAppKeysSnapshot {
    const appKeys = AppKeys.fromEvent(event, ownerPrivateKey);
    const ownerPubkey =
      firstTagValue(event.tags, APP_KEYS_OWNER_PUBKEY_FACT) ?? event.pubkey;
    return {
      profileId: profileIdFromTags(event.tags),
      ownerPubkey: requireHexPubkey(ownerPubkey, "owner"),
      appKeys,
      createdAt: event.created_at,
    };
  }

  serialize(): string {
    return JSON.stringify({
      devices: this.getAllDevices(),
      deviceLabels: this.getAllDeviceLabels(),
    });
  }

  static deserialize(json: string): AppKeys {
    const data = JSON.parse(json) as {
      devices: DeviceEntry[];
      deviceLabels?: DeviceLabelsEntry[];
    };
    return new AppKeys(data.devices, data.deviceLabels || []);
  }

  merge(other: AppKeys): AppKeys {
    // Merge devices, preferring the one with earlier createdAt for same identityPubkey
    const mergedDevices = [
      ...this.devices.values(),
      ...other.devices.values(),
    ].reduce((map, device) => {
      const existing = map.get(device.identityPubkey);
      if (!existing || device.createdAt < existing.createdAt) {
        map.set(device.identityPubkey, device);
      }
      return map;
    }, new Map<string, DeviceEntry>());

    const mergedLabels = [
      ...this.deviceLabels.entries(),
      ...other.deviceLabels.entries(),
    ].reduce((map, [identityPubkey, labels]) => {
      const existing = map.get(identityPubkey);
      if (!existing || labels.updatedAt > existing.updatedAt) {
        map.set(identityPubkey, labels);
      }
      return map;
    }, new Map<string, DeviceLabels>());

    const mergedDeviceKeys = new Set(mergedDevices.keys());
    const deviceLabels = Array.from(mergedLabels.entries())
      .filter(([identityPubkey]) => mergedDeviceKeys.has(identityPubkey))
      .map(([identityPubkey, labels]) => ({
        identityPubkey,
        ...labels,
      }));

    return new AppKeys(Array.from(mergedDevices.values()), deviceLabels);
  }

  /**
   * Subscribe to AppKeys events from a user.
   * Similar to Invite.fromUser pattern.
   */
  static fromUser(
    user: string,
    subscribe: NostrSubscribe,
    onAppKeysList: (appKeys: AppKeys) => void,
    ownerPrivateKey?: Uint8Array,
  ): Unsubscribe {
    return subscribe(buildAppKeysFilter(user), (event) => {
      if (event.pubkey !== user) return;
      try {
        const appKeys = AppKeys.fromEvent(event, ownerPrivateKey);
        onAppKeysList(appKeys);
      } catch {
        // Invalid event
      }
    });
  }

  /**
   * Wait for AppKeys from a user with timeout.
   * Returns the most recent AppKeys received within the timeout, or null.
   * Note: Uses the most recent event by created_at, not merging, since
   * device revocation is determined by absence from the list.
   */
  static waitFor(
    user: string,
    subscribe: NostrSubscribe,
    timeoutMs = 500,
    ownerPrivateKey?: Uint8Array,
  ): Promise<AppKeys | null> {
    return AppKeys.waitForSnapshot(
      user,
      subscribe,
      timeoutMs,
      ownerPrivateKey,
    ).then((snapshot) => snapshot?.appKeys ?? null);
  }

  static waitForSnapshot(
    user: string,
    subscribe: NostrSubscribe,
    timeoutMs = 500,
    ownerPrivateKey?: Uint8Array,
  ): Promise<{ appKeys: AppKeys; createdAt: number } | null> {
    return new Promise((resolve) => {
      let latest: { list: AppKeys; createdAt: number } | null = null;

      setTimeout(() => {
        unsubscribe();
        resolve(
          latest ? { appKeys: latest.list, createdAt: latest.createdAt } : null,
        );
      }, timeoutMs);

      const unsubscribe = subscribe(buildAppKeysFilter(user), (event) => {
        if (event.pubkey !== user) return;
        try {
          const list = AppKeys.fromEvent(event, ownerPrivateKey);
          const next = applyAppKeysSnapshot({
            currentAppKeys: latest?.list,
            currentCreatedAt: latest?.createdAt,
            incomingAppKeys: list,
            incomingCreatedAt: event.created_at,
          });
          if (next.decision === "stale") {
            return;
          }
          latest = { list: next.appKeys, createdAt: next.createdAt };
        } catch {
          // Invalid event
        }
      });
    });
  }
}

export function applyAppKeysSnapshotPreservingLabels(
  options: ApplyAppKeysSnapshotOptions<AppKeys>,
): AppKeysSnapshotUpdate<AppKeys> {
  const update = applyAppKeysSnapshot(options);
  if (update.decision !== "advanced" || !options.currentAppKeys) {
    return update;
  }

  const labels = options.currentAppKeys.merge(options.incomingAppKeys);
  const appKeys = new AppKeys(update.appKeys.getAllDevices());
  for (const device of appKeys.getAllDevices()) {
    const entry = labels.getDeviceLabels(device.identityPubkey);
    if (entry) {
      appKeys.setDeviceLabels(device.identityPubkey, entry, entry.updatedAt);
    }
  }
  return { ...update, appKeys };
}
