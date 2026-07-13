import { AppKeys } from "../AppKeys"
import { Session } from "../Session"
import { deserializeSessionState } from "../utils"
import type {
  StoredSessionEntry,
  StoredUserRecord,
} from "./types"
import type { UserRecordActor } from "./UserRecordActor"

export type HydrateUserRecordInput = {
  publicKey: string
  data: StoredUserRecord
  getOrCreateUserRecord(publicKey: string): UserRecordActor
  rememberDelegate(deviceId: string, ownerPubkey: string): void
  rememberProcessedInviteResponse(eventId: string): void
}

export function hydrateUserRecord(input: HydrateUserRecordInput): void {
  const {
    data,
    publicKey,
    getOrCreateUserRecord,
    rememberDelegate,
    rememberProcessedInviteResponse,
  } = input

  const userRecord = getOrCreateUserRecord(publicKey)
  userRecord.close()
  userRecord.devices.clear()

  const appKeys = deserializeAppKeys(data.appKeys)
  userRecord.setAppKeys(appKeys, validTimestamp(data.appKeysCreatedAt))
  rebuildDelegateMapping(publicKey, appKeys, rememberDelegate)

  for (const deviceData of data.devices) {
    try {
      const device = userRecord.ensureDevice(deviceData.deviceId, deviceData.createdAt)

      for (const session of deviceData.inactiveSessions
        .map((entry) => deserializeStoredSession(entry, rememberProcessedInviteResponse))
        .reverse()
      ) {
        device.installSession(session, true, { persist: false })
      }

      if (deviceData.activeSession) {
        device.installSession(
          deserializeStoredSession(deviceData.activeSession, rememberProcessedInviteResponse),
          false,
          { persist: false },
        )
      }
    } catch {
      // Ignore corrupted session entries while keeping the rest of the user record.
    }
  }
}

function validTimestamp(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function deserializeAppKeys(serialized?: string): AppKeys | undefined {
  if (!serialized) return undefined
  try {
    return AppKeys.deserialize(serialized)
  } catch {
    return undefined
  }
}

function rebuildDelegateMapping(
  ownerPubkey: string,
  appKeys: AppKeys | undefined,
  rememberDelegate: HydrateUserRecordInput["rememberDelegate"],
): void {
  if (!appKeys) return
  for (const device of appKeys.getAllDevices()) {
    if (device.identityPubkey) {
      rememberDelegate(device.identityPubkey, ownerPubkey)
    }
  }
}

function deserializeStoredSession(
  entry: StoredSessionEntry,
  rememberProcessedInviteResponse: HydrateUserRecordInput["rememberProcessedInviteResponse"],
): Session {
  const session = new Session(deserializeSessionState(entry.state))
  session.name = entry.name
  rememberProcessedInviteResponse(entry.name)
  return session
}
