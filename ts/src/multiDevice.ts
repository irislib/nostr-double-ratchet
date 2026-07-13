import type { AppKeys, DeviceEntry } from "./AppKeys"
import type { InvitePurpose } from "./Invite"

export type AppKeysSnapshotDecision =
  | "advanced"
  | "stale"
  | "merged_equal_timestamp"

type MergeableAppKeys<T> = {
  merge: (other: T) => T
}

export interface AppKeysSnapshotUpdate<T> {
  decision: AppKeysSnapshotDecision
  appKeys: T
  createdAt: number
}

export interface KnownAppKeysSnapshot {
  ownerPubkey: string
  appKeys: AppKeys
  createdAt: number
}

export interface ApplyAppKeysSnapshotOptions<T extends MergeableAppKeys<T>> {
  currentAppKeys?: T | null
  currentCreatedAt?: number
  incomingAppKeys: T
  incomingCreatedAt: number
}

export function applyAppKeysSnapshot<T extends MergeableAppKeys<T>>(
  options: ApplyAppKeysSnapshotOptions<T>
): AppKeysSnapshotUpdate<T> {
  const {
    currentAppKeys,
    currentCreatedAt = 0,
    incomingAppKeys,
    incomingCreatedAt,
  } = options

  if (!currentAppKeys || incomingCreatedAt > currentCreatedAt) {
    return {
      decision: "advanced",
      appKeys: incomingAppKeys,
      createdAt: incomingCreatedAt,
    }
  }

  if (incomingCreatedAt < currentCreatedAt) {
    return {
      decision: "stale",
      appKeys: currentAppKeys,
      createdAt: currentCreatedAt,
    }
  }

  return {
    decision: "merged_equal_timestamp",
    appKeys: currentAppKeys.merge(incomingAppKeys),
    createdAt: currentCreatedAt,
  }
}

export interface DeviceRegistrationState {
  isCurrentDeviceRegistered: boolean
  hasKnownRegisteredDevices: boolean
  noPreviousDevicesFound: boolean
  requiresDeviceRegistration: boolean
  canSendPrivateMessages: boolean
}

export interface EvaluateDeviceRegistrationStateOptions {
  currentDevicePubkey?: string | null
  registeredDevices: Array<Pick<DeviceEntry, "identityPubkey">>
  hasLocalAppKeys?: boolean
  appKeysManagerReady?: boolean
  sessionManagerReady?: boolean
}

export function evaluateDeviceRegistrationState(
  options: EvaluateDeviceRegistrationStateOptions
): DeviceRegistrationState {
  const {
    currentDevicePubkey,
    registeredDevices,
    hasLocalAppKeys = false,
    appKeysManagerReady = false,
    sessionManagerReady = false,
  } = options

  const normalizedCurrent = currentDevicePubkey?.trim().toLowerCase() ?? null
  const isCurrentDeviceRegistered =
    normalizedCurrent !== null &&
    registeredDevices.some(
      (device) => device.identityPubkey.trim().toLowerCase() === normalizedCurrent
    )

  const hasKnownRegisteredDevices = registeredDevices.length > 0

  return {
    isCurrentDeviceRegistered,
    hasKnownRegisteredDevices,
    noPreviousDevicesFound: hasKnownRegisteredDevices === false,
    requiresDeviceRegistration:
      normalizedCurrent !== null && isCurrentDeviceRegistered === false,
    canSendPrivateMessages:
      appKeysManagerReady &&
      sessionManagerReady &&
      (hasLocalAppKeys || isCurrentDeviceRegistered || hasKnownRegisteredDevices),
  }
}

export function shouldRequireRelayRegistrationConfirmation(
  options: EvaluateDeviceRegistrationStateOptions
): boolean {
  const state = evaluateDeviceRegistrationState(options)
  return state.requiresDeviceRegistration && state.hasKnownRegisteredDevices
}

type SessionStateLike = {
  theirCurrentNostrPublicKey?: string
  theirNextNostrPublicKey?: string
}

type SessionLike = {
  state?: SessionStateLike | null
}

type SessionDeviceLike = {
  activeSession?: SessionLike | null
  inactiveSessions?: Array<SessionLike | null>
}

type SessionAppKeysLike = {
  getAllDevices?: () => Array<{
    identityPubkey?: string | null
  }>
}

export type SessionUserRecordLike = {
  devices?: Map<string, SessionDeviceLike>
  appKeys?: SessionAppKeysLike | null
}

export type SessionUserRecordsLike = Map<string, SessionUserRecordLike>

export function isOwnDevicePubkey(
  pubkey: string,
  ownerPubkey: string,
  identityPubkey: string | null,
  devices: DeviceEntry[]
): boolean {
  if (!pubkey) return false
  if (pubkey === ownerPubkey) return true
  if (identityPubkey && pubkey === identityPubkey) return true
  return devices.some((device) => device.identityPubkey === pubkey)
}

export function isOwnDeviceEvent(
  eventPubkey: string,
  sessionPubkey: string,
  ownerPubkey: string,
  identityPubkey: string | null,
  devices: DeviceEntry[]
): boolean {
  return (
    isOwnDevicePubkey(eventPubkey, ownerPubkey, identityPubkey, devices) ||
    isOwnDevicePubkey(sessionPubkey, ownerPubkey, identityPubkey, devices)
  )
}

export function hasExistingSessionWithRecipient(
  userRecords: SessionUserRecordsLike | null | undefined,
  recipientPubkey: string
): boolean {
  if (!userRecords || !recipientPubkey) return false

  for (const [recordPubkey, userRecord] of userRecords.entries()) {
    const devices = userRecord?.devices
    if (!devices) continue

    for (const device of devices.values()) {
      const sessions = [device.activeSession, ...(device.inactiveSessions ?? [])]
      for (const session of sessions) {
        if (!session) continue
        const state = session.state
        if (!state) continue

        if (
          recordPubkey === recipientPubkey ||
          state.theirCurrentNostrPublicKey === recipientPubkey ||
          state.theirNextNostrPublicKey === recipientPubkey
        ) {
          return true
        }
      }
    }
  }

  return false
}

export function resolveSessionPubkeyToOwner(
  userRecords: SessionUserRecordsLike | null | undefined,
  pubkey: string
): string {
  if (!userRecords || !pubkey) return pubkey

  for (const [recordPubkey, userRecord] of userRecords.entries()) {
    if (recordPubkey === pubkey) {
      return recordPubkey
    }

    const devices = userRecord?.devices
    if (devices?.has(pubkey)) {
      return recordPubkey
    }

    const appKeyDevices = userRecord?.appKeys?.getAllDevices?.() ?? []
    if (appKeyDevices.some((device) => device.identityPubkey === pubkey)) {
      return recordPubkey
    }

    if (!devices) continue

    for (const device of devices.values()) {
      const sessions = [device.activeSession, ...(device.inactiveSessions ?? [])]
      for (const session of sessions) {
        if (!session) continue
        const state = session.state
        if (!state) continue

        if (
          state.theirCurrentNostrPublicKey === pubkey ||
          state.theirNextNostrPublicKey === pubkey
        ) {
          return recordPubkey
        }
      }
    }
  }

  return pubkey
}

export type RumorLike = {
  pubkey: string
  tags?: string[][]
}

function firstTagValue(tags: string[][] | undefined, name: string): string | undefined {
  return tags?.find((tag) => tag[0] === name)?.[1]
}

export function resolveRumorPeerPubkey(options: {
  ownerPubkey: string
  rumor: RumorLike
  senderPubkey?: string | null
}): string | undefined {
  const normalizedOwner = options.ownerPubkey.trim().toLowerCase()
  const normalizedRumorPubkey = options.rumor.pubkey.trim().toLowerCase()
  const normalizedSenderPubkey = options.senderPubkey?.trim().toLowerCase()

  if (
    normalizedRumorPubkey === normalizedOwner ||
    normalizedSenderPubkey === normalizedOwner
  ) {
    return firstTagValue(options.rumor.tags, "p")
  }

  return options.rumor.pubkey
}

export function resolveConversationCandidatePubkeys(options: {
  ownerPubkey: string
  rumor: RumorLike
  senderPubkey: string
}): string[] {
  const owner = options.ownerPubkey.trim().toLowerCase()
  const sender = options.senderPubkey.trim().toLowerCase()
  const rumorAuthor = options.rumor.pubkey.trim().toLowerCase()
  const pTagPubkey = firstTagValue(options.rumor.tags, "p")?.trim().toLowerCase()

  const isSelfTargetedRumor =
    (rumorAuthor === owner || sender === owner) &&
    (pTagPubkey == null || pTagPubkey.length === 0 || pTagPubkey === owner)

  const candidates: string[] = []
  const addCandidate = (candidate?: string | null) => {
    const normalized = candidate?.trim().toLowerCase()
    if (!normalized || candidates.includes(normalized)) return
    candidates.push(normalized)
  }

  if (isSelfTargetedRumor) {
    if (rumorAuthor !== owner) addCandidate(rumorAuthor)
    if (sender !== owner) addCandidate(sender)
    addCandidate(owner)
    return candidates
  }

  addCandidate(
    resolveRumorPeerPubkey({
      ownerPubkey: owner,
      rumor: options.rumor,
      senderPubkey: sender,
    })
  )
  addCandidate(sender)
  return candidates
}

export interface InviteOwnerRoutingResolution {
  ownerPublicKey: string
  claimedOwnerPublicKey: string
  verifiedWithAppKeys: boolean
  usedLinkBootstrapException: boolean
  fellBackToDeviceIdentity: boolean
}

export function resolveInviteOwnerRouting(options: {
  devicePubkey: string
  claimedOwnerPublicKey?: string | null
  invitePurpose?: InvitePurpose
  currentOwnerPublicKey: string
  appKeys?: {
    getAllDevices: () => Array<Pick<DeviceEntry, "identityPubkey">>
  } | null
}): InviteOwnerRoutingResolution {
  const devicePubkey = options.devicePubkey.trim().toLowerCase()
  const claimedOwnerPublicKey =
    options.claimedOwnerPublicKey?.trim().toLowerCase() || devicePubkey

  if (claimedOwnerPublicKey === devicePubkey) {
    return {
      ownerPublicKey: devicePubkey,
      claimedOwnerPublicKey,
      verifiedWithAppKeys: claimedOwnerPublicKey === devicePubkey,
      usedLinkBootstrapException: false,
      fellBackToDeviceIdentity: false,
    }
  }

  const verifiedWithAppKeys =
    options.appKeys?.getAllDevices().some((device) => device.identityPubkey === devicePubkey) ??
    false
  if (verifiedWithAppKeys) {
    return {
      ownerPublicKey: claimedOwnerPublicKey,
      claimedOwnerPublicKey,
      verifiedWithAppKeys: true,
      usedLinkBootstrapException: false,
      fellBackToDeviceIdentity: false,
    }
  }

  const usedLinkBootstrapException =
    options.invitePurpose === "link" &&
    claimedOwnerPublicKey === options.currentOwnerPublicKey.trim().toLowerCase()
  if (usedLinkBootstrapException) {
    return {
      ownerPublicKey: claimedOwnerPublicKey,
      claimedOwnerPublicKey,
      verifiedWithAppKeys: false,
      usedLinkBootstrapException: true,
      fellBackToDeviceIdentity: false,
    }
  }

  return {
    ownerPublicKey: devicePubkey,
    claimedOwnerPublicKey,
    verifiedWithAppKeys: false,
    usedLinkBootstrapException: false,
    fellBackToDeviceIdentity: true,
  }
}
