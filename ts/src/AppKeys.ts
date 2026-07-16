import { Filter, VerifiedEvent, UnsignedEvent, getPublicKey, verifyEvent } from "nostr-tools"
import * as nip44 from "nostr-tools/nip44"
import {
  applyAppKeysSnapshot,
  type AppKeysSnapshotUpdate,
  type ApplyAppKeysSnapshotOptions,
} from "./multiDevice.js"
import { APP_KEYS_EVENT_KIND, NostrSubscribe, Unsubscribe } from "./types.js"

const now = () => Math.round(Date.now() / 1000)
export const APP_KEYS_SNAPSHOT_KIND = 37368
export const APP_KEYS_FACT_TYPE = "app_keys_roster_snapshot"
export const APP_KEYS_SCHEMA = 1
export const APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT = "encrypted_device_labels"
export const APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA = 1
export const APP_KEYS_OWNER_PUBKEY_FACT = "owner_pubkey"

export interface AppKeysEventOptions {
  ownerPrivateKey?: Uint8Array
  ownerPubkey?: string
  profileId?: string
  createdAt?: number
  heads?: string[]
}

export interface ParsedAppKeysSnapshot {
  profileId: string
  ownerPubkey: string
  appKeys: AppKeys
  createdAt: number
}

// Simplified tag format: ["device", identityPubkey, createdAt]
type DeviceTag = [
  type: "device",
  identityPubkey: string,
  createdAt: string,
]

const isDeviceTag = (tag: string[]): tag is DeviceTag =>
  tag.length >= 3 &&
  tag[0] === "device" &&
  typeof tag[1] === "string" &&
  typeof tag[2] === "string"

export function buildAppKeysFilter(authors?: string | string[]): Filter {
  const normalizedAuthors = Array.isArray(authors)
    ? authors.filter(Boolean)
    : authors ? [authors] : undefined

  return normalizedAuthors && normalizedAuthors.length > 0
    ? {
        kinds: [APP_KEYS_EVENT_KIND],
        authors: normalizedAuthors,
      }
    : {
        kinds: [APP_KEYS_EVENT_KIND],
      }
}

export function buildAppKeysDeviceAuthorizationFilter(identityPubkey: string): Filter {
  return {
    kinds: [APP_KEYS_EVENT_KIND],
    "#p": [requireHexPubkey(identityPubkey, "device")],
  }
}

export function isAppKeysEvent(
  event: Pick<VerifiedEvent, "kind" | "tags">
): boolean {
  if (event.kind !== APP_KEYS_SNAPSHOT_KIND) {
    return false
  }

  return event.tags.some(
    (tag) => tag[0] === "type" && tag[1] === APP_KEYS_FACT_TYPE
  )
}

/**
 * Device identity entry - contains only identity information.
 * identityPubkey serves as the device identifier.
 * Invite crypto material (ephemeral keys, shared secret) is in separate Invite events.
 */
export interface DeviceEntry {
  /** Identity public key - also serves as device identifier */
  identityPubkey: string
  createdAt: number
}

export interface DeviceLabels {
  deviceLabel?: string
  clientLabel?: string
  updatedAt: number
}

export interface AppKeysEncryptedDeviceLabelsPayload {
  schema: typeof APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA
  profileId: string
  secretEpoch: number
  labels: Record<string, string>
  updatedAt: number
}

interface DeviceLabelsEntry extends DeviceLabels {
  identityPubkey: string
}

interface EncryptedAppKeysContent {
  type: "app-keys-labels"
  v: 1
  deviceLabels: DeviceLabelsEntry[]
}

type LegacyDeviceLabelsEntry = Partial<{
  identityPubkey: unknown
  identity_pubkey: unknown
  deviceLabel: unknown
  device_label: unknown
  clientLabel: unknown
  client_label: unknown
  updatedAt: unknown
  updated_at: unknown
}>

type LegacyEncryptedAppKeysContent = Partial<{
  type: unknown
  v: unknown
  deviceLabels: unknown
  device_labels: unknown
}>

const normalizeDeviceLabelsEntry = (value: unknown): DeviceLabelsEntry | null => {
  if (!value || typeof value !== "object") return null
  const entry = value as LegacyDeviceLabelsEntry
  const identityPubkey = entry.identityPubkey ?? entry.identity_pubkey
  const updatedAt = entry.updatedAt ?? entry.updated_at
  const deviceLabel = entry.deviceLabel ?? entry.device_label
  const clientLabel = entry.clientLabel ?? entry.client_label

  if (typeof identityPubkey !== "string" || typeof updatedAt !== "number") {
    return null
  }
  if (deviceLabel !== undefined && typeof deviceLabel !== "string") {
    return null
  }
  if (clientLabel !== undefined && typeof clientLabel !== "string") {
    return null
  }

  return {
    identityPubkey,
    updatedAt,
    ...(deviceLabel !== undefined ? { deviceLabel } : {}),
    ...(clientLabel !== undefined ? { clientLabel } : {}),
  }
}

export function buildAppKeysSnapshotFilter(
  authors?: string | string[]
): Filter {
  return buildAppKeysFilter(authors)
}

export function encryptedDeviceLabelPayloadsFromAppKeysSnapshotEvent(
  event: Pick<VerifiedEvent, "tags">
): string[] {
  return tagValues(event.tags, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT)
}

function tagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((tag) => tag[0] === name)
    .map((tag) => tag[1]?.trim() ?? "")
    .filter(Boolean)
}

function normalizeEventIds(value: string[] | undefined): string[] {
  return (value ?? [])
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[0-9a-f]{64}$/.test(item))
    .sort()
}

function firstTagValue(tags: string[][], name: string): string | undefined {
  return tagValues(tags, name)[0]
}

function requireTagValue(tags: string[][], name: string): string {
  const value = firstTagValue(tags, name)
  if (!value) throw new Error(`AppKeys roster missing ${name}`)
  return value
}

function normalizeHexPubkey(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null
}

function requireHexPubkey(value: string, label: string): string {
  const normalized = normalizeHexPubkey(value)
  if (!normalized) throw new Error(`AppKeys ${label} pubkey must be 64-char hex`)
  return normalized
}

function requireInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`AppKeys ${label} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`AppKeys ${label} is too large`)
  return parsed
}

function profileIdFromTags(tags: string[][]): string {
  const profileId = tags
    .find((tag) => tag[0] === "i" && tag[2] === "subject")
    ?.at(1)
    ?.trim()
  if (
    !profileId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)
  ) {
    throw new Error("AppKeys roster missing profile subject")
  }
  return profileId.toLowerCase()
}

function canonicalProfileId(profileId: string): string {
  const normalized = profileId.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("AppKeys profile id must be a UUID")
  }
  return normalized
}

export function createAppKeysProfileId(): string {
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("Secure random source is not available")
  }
  if (crypto.randomUUID) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function normalizeAppKeysEventOptions(
  input?: Uint8Array | AppKeysEventOptions
): Required<Pick<AppKeysEventOptions, "createdAt" | "heads">>
  & Omit<AppKeysEventOptions, "createdAt" | "heads"> {
  if (input instanceof Uint8Array) {
    return {
      ownerPrivateKey: input,
      ownerPubkey: getPublicKey(input),
      profileId: undefined,
      createdAt: now(),
      heads: [],
    }
  }
  const ownerPrivateKey = input?.ownerPrivateKey
  return {
    ownerPrivateKey,
    ownerPubkey: input?.ownerPubkey ?? (ownerPrivateKey ? getPublicKey(ownerPrivateKey) : undefined),
    profileId: input?.profileId,
    createdAt: input?.createdAt ?? now(),
    heads: input?.heads ?? [],
  }
}

function factTag(predicate: string, ...values: string[]): string[] {
  return [predicate, ...values]
}

function canonicalizeSnapshotTags(tags: string[][]): string[][] {
  const unique = new Map(tags.map((tag) => [JSON.stringify(tag), tag]))
  return [...unique.values()].sort((left, right) => {
    const len = Math.max(left.length, right.length)
    for (let index = 0; index < len; index += 1) {
      const diff = (left[index] ?? "").localeCompare(right[index] ?? "")
      if (diff !== 0) return diff
    }
    return 0
  })
}

function buildAppKeysFactSnapshotTags(
  profileId: string,
  facts: string[][],
  heads: string[] = [],
): string[][] {
  const pubkeys = new Set<string>()
  for (const fact of facts) {
    for (const value of fact.slice(1)) {
      const pubkey = normalizeHexPubkey(value)
      if (pubkey) pubkeys.add(pubkey)
    }
  }
  return canonicalizeSnapshotTags([
    ["d", profileId],
    ["i", profileId, "subject"],
    ...normalizeEventIds(heads).map((head) => ["e", head, "", "head"]),
    ...[...pubkeys].sort().map((pubkey) => ["p", pubkey]),
    ...facts,
  ])
}

export function isAppKeysSnapshotEvent(
  event: Pick<VerifiedEvent, "kind" | "tags">
): boolean {
  return event.kind === APP_KEYS_SNAPSHOT_KIND
    && tagValues(event.tags, "type").includes(APP_KEYS_FACT_TYPE)
}

export function resolveAppKeysOwnerForDevice(
  event: VerifiedEvent,
  identityPubkey: string,
  ownerPrivateKey?: Uint8Array
): string | null {
  const normalizedDevicePubkey = requireHexPubkey(identityPubkey, "device")
  const appKeys = AppKeys.fromEvent(event, ownerPrivateKey)
  return appKeys.getDevice(normalizedDevicePubkey) ? event.pubkey : null
}

/**
 * Manages the owner's current device roster as a kind 37368 fact snapshot.
 * Single atomic event containing all device invites for a user.
 * Uses union merge strategy for conflict resolution.
 */
export class AppKeys {
  private devices: Map<string, DeviceEntry> = new Map()
  private deviceLabels: Map<string, DeviceLabels> = new Map()

  constructor(devices: DeviceEntry[] = [], deviceLabels: DeviceLabelsEntry[] = []) {
    devices.forEach((device) => this.devices.set(device.identityPubkey, device))
    deviceLabels.forEach(({ identityPubkey, ...labels }) => {
      this.deviceLabels.set(identityPubkey, labels)
    })
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
    }
  }

  addDevice(device: DeviceEntry): void {
    if (!this.devices.has(device.identityPubkey)) {
      this.devices.set(device.identityPubkey, device)
    }
  }

  removeDevice(identityPubkey: string): void {
    this.devices.delete(identityPubkey)
    this.deviceLabels.delete(identityPubkey)
  }

  getDevice(identityPubkey: string): DeviceEntry | undefined {
    return this.devices.get(identityPubkey)
  }

  getAllDevices(): DeviceEntry[] {
    return Array.from(this.devices.values())
  }

  setDeviceLabels(
    identityPubkey: string,
    labels: {
      deviceLabel?: string
      clientLabel?: string
    },
    updatedAt = now()
  ): void {
    this.deviceLabels.set(identityPubkey, {
      deviceLabel: labels.deviceLabel,
      clientLabel: labels.clientLabel,
      updatedAt,
    })
  }

  getDeviceLabels(identityPubkey: string): DeviceLabels | undefined {
    return this.deviceLabels.get(identityPubkey)
  }

  getAllDeviceLabels(): DeviceLabelsEntry[] {
    return Array.from(this.deviceLabels.entries()).map(([identityPubkey, labels]) => ({
      identityPubkey,
      ...labels,
    }))
  }

  private getEncryptedContent(ownerPrivateKey?: Uint8Array): string {
    const deviceLabels = this.getAllDeviceLabels().filter(({ identityPubkey }) =>
      this.devices.has(identityPubkey)
    )

    if (deviceLabels.length === 0) {
      return ""
    }

    if (!ownerPrivateKey) {
      return ""
    }

    const ownerPublicKey = getPublicKey(ownerPrivateKey)
    const conversationKey = nip44.v2.utils.getConversationKey(
      ownerPrivateKey,
      ownerPublicKey
    )
    const plaintext: EncryptedAppKeysContent = {
      type: "app-keys-labels",
      v: 1,
      deviceLabels,
    }

    return nip44.v2.encrypt(JSON.stringify(plaintext), conversationKey)
  }

  private loadEncryptedContent(content: string, ownerPrivateKey: Uint8Array): void {
    if (!content) return

    const ownerPublicKey = getPublicKey(ownerPrivateKey)
    const conversationKey = nip44.v2.utils.getConversationKey(
      ownerPrivateKey,
      ownerPublicKey
    )
    const decrypted = nip44.v2.decrypt(content, conversationKey)
    const payload = JSON.parse(decrypted) as LegacyEncryptedAppKeysContent

    if (payload.type !== "app-keys-labels" || payload.v !== 1) {
      throw new Error("Unsupported AppKeys label payload")
    }

    const rawLabelEntries = Array.isArray(payload.deviceLabels)
      ? payload.deviceLabels
      : Array.isArray(payload.device_labels) ? payload.device_labels : []
    const labelEntries = rawLabelEntries
      .map(normalizeDeviceLabelsEntry)
      .filter((entry): entry is DeviceLabelsEntry => entry !== null)

    this.deviceLabels.clear()
    labelEntries.forEach(({ identityPubkey, ...labels }) => {
      if (this.devices.has(identityPubkey)) {
        this.deviceLabels.set(identityPubkey, labels)
      }
    })
  }

  getEvent(options: Uint8Array | AppKeysEventOptions): UnsignedEvent {
    const normalized = normalizeAppKeysEventOptions(options)
    const profileId = canonicalProfileId(normalized.profileId ?? createAppKeysProfileId())
    const ownerPubkey = normalized.ownerPubkey
      ? requireHexPubkey(normalized.ownerPubkey, "owner")
      : undefined
    if (!ownerPubkey) {
      throw new Error("AppKeys roster owner pubkey is required")
    }
    const facts = [
      factTag("type", APP_KEYS_FACT_TYPE),
      factTag("schema", String(APP_KEYS_SCHEMA)),
      factTag(APP_KEYS_OWNER_PUBKEY_FACT, ownerPubkey),
      ...this.getAllDevices()
        .slice()
        .sort((left, right) => (
          left.createdAt - right.createdAt
          || left.identityPubkey.localeCompare(right.identityPubkey)
        ))
        .map((device) => factTag(
          "device",
          device.identityPubkey.trim().toLowerCase(),
          String(device.createdAt),
        )),
    ]
    const encryptedLabels = this.getEncryptedContent(normalized.ownerPrivateKey)
    if (encryptedLabels) {
      facts.push(factTag(APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT, encryptedLabels))
    }

    return {
      kind: APP_KEYS_SNAPSHOT_KIND,
      pubkey: "", // Signer will set this
      content: "",
      created_at: normalized.createdAt,
      tags: buildAppKeysFactSnapshotTags(profileId, facts, normalized.heads),
    }
  }

  static fromEvent(event: VerifiedEvent, ownerPrivateKey?: Uint8Array): AppKeys {
    if (!event.sig) {
      throw new Error("Event is not signed")
    }
    if (!verifyEvent(event)) {
      throw new Error("Event signature is invalid")
    }
    if (!isAppKeysSnapshotEvent(event)) {
      throw new Error("Event is not an AppKeys roster snapshot")
    }
    if (event.content !== "") {
      throw new Error("AppKeys roster snapshot content must be empty")
    }
    const schema = requireInteger(requireTagValue(event.tags, "schema"), "schema")
    if (schema !== APP_KEYS_SCHEMA) {
      throw new Error(`Unsupported AppKeys roster schema ${schema}`)
    }
    const ownerPubkey = requireHexPubkey(
      requireTagValue(event.tags, APP_KEYS_OWNER_PUBKEY_FACT),
      "owner"
    )
    if (ownerPubkey !== event.pubkey) {
      throw new Error("AppKeys roster owner signer mismatch")
    }
    profileIdFromTags(event.tags)

    const devices = event.tags
      .filter(isDeviceTag)
      .map(([, identityPubkey, createdAt]) => ({
        identityPubkey: identityPubkey.trim().toLowerCase(),
        createdAt: parseInt(createdAt, 10) || event.created_at,
      }))

    const appKeys = new AppKeys(devices)
    const encryptedLabels = firstTagValue(event.tags, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT)
    if (ownerPrivateKey && encryptedLabels) {
      appKeys.loadEncryptedContent(encryptedLabels, ownerPrivateKey)
    }

    return appKeys
  }

  static fromAppKeysSnapshotEvent(
    event: VerifiedEvent,
    ownerPrivateKey?: Uint8Array
  ): ParsedAppKeysSnapshot {
    const appKeys = AppKeys.fromEvent(event, ownerPrivateKey)
    const ownerPubkey =
      firstTagValue(event.tags, APP_KEYS_OWNER_PUBKEY_FACT) ?? event.pubkey
    return {
      profileId: profileIdFromTags(event.tags),
      ownerPubkey: requireHexPubkey(ownerPubkey, "owner"),
      appKeys,
      createdAt: event.created_at,
    }
  }

  serialize(): string {
    return JSON.stringify({
      devices: this.getAllDevices(),
      deviceLabels: this.getAllDeviceLabels(),
    })
  }

  static deserialize(json: string): AppKeys {
    const data = JSON.parse(json) as {
      devices: DeviceEntry[]
      deviceLabels?: DeviceLabelsEntry[]
    }
    return new AppKeys(data.devices, data.deviceLabels || [])
  }

  merge(other: AppKeys): AppKeys {
    // Merge devices, preferring the one with earlier createdAt for same identityPubkey
    const mergedDevices = [...this.devices.values(), ...other.devices.values()]
      .reduce((map, device) => {
        const existing = map.get(device.identityPubkey)
        if (!existing || device.createdAt < existing.createdAt) {
          map.set(device.identityPubkey, device)
        }
        return map
      }, new Map<string, DeviceEntry>())

    const mergedLabels = [...this.deviceLabels.entries(), ...other.deviceLabels.entries()]
      .reduce((map, [identityPubkey, labels]) => {
        const existing = map.get(identityPubkey)
        if (!existing || labels.updatedAt > existing.updatedAt) {
          map.set(identityPubkey, labels)
        }
        return map
      }, new Map<string, DeviceLabels>())

    const mergedDeviceKeys = new Set(mergedDevices.keys())
    const deviceLabels = Array.from(mergedLabels.entries())
      .filter(([identityPubkey]) => mergedDeviceKeys.has(identityPubkey))
      .map(([identityPubkey, labels]) => ({
        identityPubkey,
        ...labels,
      }))

    return new AppKeys(Array.from(mergedDevices.values()), deviceLabels)
  }

  /**
   * Subscribe to AppKeys events from a user.
   * Similar to Invite.fromUser pattern.
   */
  static fromUser(
    user: string,
    subscribe: NostrSubscribe,
    onAppKeysList: (appKeys: AppKeys) => void,
    ownerPrivateKey?: Uint8Array
  ): Unsubscribe {
    return subscribe(
      buildAppKeysFilter(user),
      (event) => {
        if (event.pubkey !== user) return
        try {
          const appKeys = AppKeys.fromEvent(event, ownerPrivateKey)
          onAppKeysList(appKeys)
        } catch {
          // Invalid event
        }
      }
    )
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
    ownerPrivateKey?: Uint8Array
  ): Promise<AppKeys | null> {
    return AppKeys.waitForSnapshot(user, subscribe, timeoutMs, ownerPrivateKey).then(
      (snapshot) => snapshot?.appKeys ?? null
    )
  }

  static waitForSnapshot(
    user: string,
    subscribe: NostrSubscribe,
    timeoutMs = 500,
    ownerPrivateKey?: Uint8Array
  ): Promise<{ appKeys: AppKeys; createdAt: number } | null> {
    return new Promise((resolve) => {
      let latest: { list: AppKeys; createdAt: number } | null = null

      setTimeout(() => {
        unsubscribe()
        resolve(latest ? { appKeys: latest.list, createdAt: latest.createdAt } : null)
      }, timeoutMs)

      const unsubscribe = subscribe(
        buildAppKeysFilter(user),
        (event) => {
          if (event.pubkey !== user) return
          try {
            const list = AppKeys.fromEvent(event, ownerPrivateKey)
            const next = applyAppKeysSnapshot({
              currentAppKeys: latest?.list,
              currentCreatedAt: latest?.createdAt,
              incomingAppKeys: list,
              incomingCreatedAt: event.created_at,
            })
            if (next.decision === "stale") {
              return
            }
            latest = { list: next.appKeys, createdAt: next.createdAt }
          } catch {
            // Invalid event
          }
        }
      )
    })
  }
}

export function applyAppKeysSnapshotPreservingLabels(
  options: ApplyAppKeysSnapshotOptions<AppKeys>
): AppKeysSnapshotUpdate<AppKeys> {
  const update = applyAppKeysSnapshot(options)
  if (update.decision !== "advanced" || !options.currentAppKeys) {
    return update
  }

  const labels = options.currentAppKeys.merge(options.incomingAppKeys)
  const appKeys = new AppKeys(update.appKeys.getAllDevices())
  for (const device of appKeys.getAllDevices()) {
    const entry = labels.getDeviceLabels(device.identityPubkey)
    if (entry) {
      appKeys.setDeviceLabels(device.identityPubkey, entry, entry.updatedAt)
    }
  }
  return { ...update, appKeys }
}
