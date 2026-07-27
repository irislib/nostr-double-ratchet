import { type Filter, type VerifiedEvent, getPublicKey } from "nostr-tools";
import { APP_KEYS_EVENT_KIND } from "../types.js";
import type { AppKeys } from "../AppKeys.js";

export const now = () => Math.round(Date.now() / 1000);

export const APP_KEYS_SNAPSHOT_KIND = 37368;

export const APP_KEYS_FACT_TYPE = "app_keys_roster_snapshot";

export const APP_KEYS_SCHEMA = 1;

export const APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT = "encrypted_device_labels";

export const APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA = 1;

export const APP_KEYS_OWNER_PUBKEY_FACT = "owner_pubkey";

export interface AppKeysEventOptions {
  ownerPrivateKey?: Uint8Array;
  ownerPubkey?: string;
  profileId?: string;
  createdAt?: number;
  heads?: string[];
}

export interface ParsedAppKeysSnapshot {
  profileId: string;
  ownerPubkey: string;
  appKeys: AppKeys;
  createdAt: number;
}

export type DeviceTag = [
  type: "device",
  identityPubkey: string,
  createdAt: string,
];

export const isDeviceTag = (tag: string[]): tag is DeviceTag =>
  tag.length >= 3 &&
  tag[0] === "device" &&
  typeof tag[1] === "string" &&
  typeof tag[2] === "string";

export function buildAppKeysFilter(authors?: string | string[]): Filter {
  const normalizedAuthors = Array.isArray(authors)
    ? authors.filter(Boolean)
    : authors
      ? [authors]
      : undefined;

  return normalizedAuthors && normalizedAuthors.length > 0
    ? {
        kinds: [APP_KEYS_EVENT_KIND],
        authors: normalizedAuthors,
      }
    : {
        kinds: [APP_KEYS_EVENT_KIND],
      };
}

export function buildAppKeysDeviceAuthorizationFilter(
  identityPubkey: string,
): Filter {
  return {
    kinds: [APP_KEYS_EVENT_KIND],
    "#p": [requireHexPubkey(identityPubkey, "device")],
  };
}

export function isAppKeysEvent(
  event: Pick<VerifiedEvent, "kind" | "tags">,
): boolean {
  if (event.kind !== APP_KEYS_SNAPSHOT_KIND) {
    return false;
  }

  return event.tags.some(
    (tag) => tag[0] === "type" && tag[1] === APP_KEYS_FACT_TYPE,
  );
}

/**
 * Device identity entry. The identity pubkey is also its stable identifier;
 * ephemeral invite material is carried separately.
 */
export interface DeviceEntry {
  /** Identity public key - also serves as device identifier */
  identityPubkey: string;
  createdAt: number;
}

/** Optional owner-encrypted presentation labels for a device. */
export interface DeviceLabels {
  deviceLabel?: string;
  clientLabel?: string;
  updatedAt: number;
}

export interface AppKeysEncryptedDeviceLabelsPayload {
  schema: typeof APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA;
  profileId: string;
  secretEpoch: number;
  labels: Record<string, string>;
  updatedAt: number;
}

export interface DeviceLabelsEntry extends DeviceLabels {
  identityPubkey: string;
}

export interface EncryptedAppKeysContent {
  type: "app-keys-labels";
  v: 1;
  deviceLabels: DeviceLabelsEntry[];
}

export type LegacyDeviceLabelsEntry = Partial<{
  identityPubkey: unknown;
  identity_pubkey: unknown;
  deviceLabel: unknown;
  device_label: unknown;
  clientLabel: unknown;
  client_label: unknown;
  updatedAt: unknown;
  updated_at: unknown;
}>;

export type LegacyEncryptedAppKeysContent = Partial<{
  type: unknown;
  v: unknown;
  deviceLabels: unknown;
  device_labels: unknown;
}>;

export const normalizeDeviceLabelsEntry = (
  value: unknown,
): DeviceLabelsEntry | null => {
  if (!value || typeof value !== "object") return null;
  const entry = value as LegacyDeviceLabelsEntry;
  const identityPubkey = entry.identityPubkey ?? entry.identity_pubkey;
  const updatedAt = entry.updatedAt ?? entry.updated_at;
  const deviceLabel = entry.deviceLabel ?? entry.device_label;
  const clientLabel = entry.clientLabel ?? entry.client_label;

  if (typeof identityPubkey !== "string" || typeof updatedAt !== "number") {
    return null;
  }
  if (deviceLabel !== undefined && typeof deviceLabel !== "string") {
    return null;
  }
  if (clientLabel !== undefined && typeof clientLabel !== "string") {
    return null;
  }

  return {
    identityPubkey,
    updatedAt,
    ...(deviceLabel !== undefined ? { deviceLabel } : {}),
    ...(clientLabel !== undefined ? { clientLabel } : {}),
  };
};

export function buildAppKeysSnapshotFilter(
  authors?: string | string[],
): Filter {
  return buildAppKeysFilter(authors);
}

export function encryptedDeviceLabelPayloadsFromAppKeysSnapshotEvent(
  event: Pick<VerifiedEvent, "tags">,
): string[] {
  return tagValues(event.tags, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT);
}

export function tagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((tag) => tag[0] === name)
    .map((tag) => tag[1]?.trim() ?? "")
    .filter(Boolean);
}

export function normalizeEventIds(value: string[] | undefined): string[] {
  return (value ?? [])
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[0-9a-f]{64}$/.test(item))
    .sort();
}

export function firstTagValue(
  tags: string[][],
  name: string,
): string | undefined {
  return tagValues(tags, name)[0];
}

export function requireTagValue(tags: string[][], name: string): string {
  const value = firstTagValue(tags, name);
  if (!value) throw new Error(`AppKeys roster missing ${name}`);
  return value;
}

export function normalizeHexPubkey(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

export function requireHexPubkey(value: string, label: string): string {
  const normalized = normalizeHexPubkey(value);
  if (!normalized)
    throw new Error(`AppKeys ${label} pubkey must be 64-char hex`);
  return normalized;
}

export function requireInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(`AppKeys ${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`AppKeys ${label} is too large`);
  return parsed;
}

export function profileIdFromTags(tags: string[][]): string {
  const profileId = tags
    .find((tag) => tag[0] === "i" && tag[2] === "subject")
    ?.at(1)
    ?.trim();
  if (
    !profileId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      profileId,
    )
  ) {
    throw new Error("AppKeys roster missing profile subject");
  }
  return profileId.toLowerCase();
}

export function canonicalProfileId(profileId: string): string {
  const normalized = profileId.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw new Error("AppKeys profile id must be a UUID");
  }
  return normalized;
}

export function createAppKeysProfileId(): string {
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("Secure random source is not available");
  }
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeAppKeysEventOptions(
  input?: Uint8Array | AppKeysEventOptions,
): Required<Pick<AppKeysEventOptions, "createdAt" | "heads">> &
  Omit<AppKeysEventOptions, "createdAt" | "heads"> {
  if (input instanceof Uint8Array) {
    return {
      ownerPrivateKey: input,
      ownerPubkey: getPublicKey(input),
      profileId: undefined,
      createdAt: now(),
      heads: [],
    };
  }
  const ownerPrivateKey = input?.ownerPrivateKey;
  return {
    ownerPrivateKey,
    ownerPubkey:
      input?.ownerPubkey ??
      (ownerPrivateKey ? getPublicKey(ownerPrivateKey) : undefined),
    profileId: input?.profileId,
    createdAt: input?.createdAt ?? now(),
    heads: input?.heads ?? [],
  };
}

export function factTag(predicate: string, ...values: string[]): string[] {
  return [predicate, ...values];
}

export function canonicalizeSnapshotTags(tags: string[][]): string[][] {
  const unique = new Map(tags.map((tag) => [JSON.stringify(tag), tag]));
  return [...unique.values()].sort((left, right) => {
    const len = Math.max(left.length, right.length);
    for (let index = 0; index < len; index += 1) {
      const diff = (left[index] ?? "").localeCompare(right[index] ?? "");
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

export function buildAppKeysFactSnapshotTags(
  profileId: string,
  facts: string[][],
  heads: string[] = [],
): string[][] {
  const pubkeys = new Set<string>();
  for (const fact of facts) {
    for (const value of fact.slice(1)) {
      const pubkey = normalizeHexPubkey(value);
      if (pubkey) pubkeys.add(pubkey);
    }
  }
  return canonicalizeSnapshotTags([
    ["d", profileId],
    ["i", profileId, "subject"],
    ...normalizeEventIds(heads).map((head) => ["e", head, "", "head"]),
    ...[...pubkeys].sort().map((pubkey) => ["p", pubkey]),
    ...facts,
  ]);
}

export function isAppKeysSnapshotEvent(
  event: Pick<VerifiedEvent, "kind" | "tags">,
): boolean {
  return (
    event.kind === APP_KEYS_SNAPSHOT_KIND &&
    tagValues(event.tags, "type").includes(APP_KEYS_FACT_TYPE)
  );
}
