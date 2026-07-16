import type { AppKeys } from "../AppKeys.js"
import type { Filter, UnsignedEvent, VerifiedEvent } from "nostr-tools"
import type { MessageQueue } from "../MessageQueue.js"
import type { Session } from "../Session.js"
import type {
  IdentityKey,
  Rumor,
  Unsubscribe,
} from "../types.js"
import type { MessageOrigin } from "../MessageOrigin.js"

export type OnEventMeta = {
  fromDeviceId?: string
  outerEventId?: string
  senderOwnerPubkey?: string
  senderDevicePubkey?: string
  origin?: MessageOrigin
  isSelf?: boolean
  isCrossDeviceSelf?: boolean
}

export type OnEventCallback = (event: Rumor, from: string, meta?: OnEventMeta) => void

export interface InviteCredentials {
  ephemeralKeypair: { publicKey: string; privateKey: Uint8Array }
  sharedSecret: string
}

export interface DeviceRecord {
  deviceId: string
  activeSession?: Session
  inactiveSessions: Session[]
  createdAt: number
  prepareOutboundEvent(rumor: Rumor): VerifiedEvent | undefined
}

export interface UserRecord {
  publicKey: string
  devices: Map<string, DeviceRecord>
  appKeys?: AppKeys
  appKeysCreatedAt: number
}

export interface AcceptInviteOptions {
  ownerPublicKey?: string
}

export interface AcceptInviteResult {
  ownerPublicKey: string
  deviceId: string
  session: Session
}

export interface StoredSessionEntry {
  name: string
  state: string
}

export interface StoredDeviceRecord {
  deviceId: string
  activeSession: StoredSessionEntry | null
  inactiveSessions: StoredSessionEntry[]
  createdAt: number
}

export interface StoredUserRecord {
  publicKey: string
  devices: StoredDeviceRecord[]
  appKeys?: string
  appKeysCreatedAt?: number
}

export type UserSetupState =
  | "new"
  | "fetching-appkeys"
  | "appkeys-known"
  | "ready"
  | "stale"

export type DeviceSetupState =
  | "new"
  | "waiting-for-invite"
  | "accepting-invite"
  | "session-ready"
  | "stale"
  | "revoked"

export type SessionManagerEvent =
  | {
      type: "subscribe"
      subid: string
      filter: Filter
    }
  | {
      type: "unsubscribe"
      subid: string
    }
  | {
      type: "publish"
      event: UnsignedEvent | VerifiedEvent
      innerEventId?: string
    }
  | {
      type: "decryptedMessage"
      event: Rumor
      sender: string
      senderDevice?: string
      meta: OnEventMeta
    }

export type SessionManagerEventsAvailableCallback = () => void | Promise<void>

export interface NostrFacade {
  subscribe(
    subid: string,
    filter: Filter,
    onEvent?: (event: VerifiedEvent) => void,
  ): Unsubscribe
  publish(event: UnsignedEvent | VerifiedEvent, innerEventId?: string): Promise<void>
}

export interface DeviceRecordUserHooks {
  isDeviceAuthorized(deviceId: string): boolean
  onDeviceRumor(deviceId: string, rumor: Rumor, outerEvent?: VerifiedEvent): void
  onDeviceDirty(): void
}

export interface DeviceRecordDeps {
  ownerPubkey: string
  user: DeviceRecordUserHooks
  nostr: NostrFacade
  messageQueue: MessageQueue
  ourDeviceId: string
  ourOwnerPubkey: string
  identityKey: IdentityKey
  createdAt?: number
}

export interface UserRecordManagerHooks {
  updateDelegateMapping(ownerPubkey: string, appKeys: AppKeys): void
  removeDelegateMapping(deviceId: string): void
  handleDeviceRumor(
    ownerPubkey: string,
    deviceId: string,
    rumor: Rumor,
    outerEvent?: VerifiedEvent,
  ): void
  persistUserRecord(ownerPubkey: string): void
}

export interface UserRecordDeps {
  manager: UserRecordManagerHooks
  nostr: NostrFacade
  messageQueue: MessageQueue
  discoveryQueue: MessageQueue
  ourDeviceId: string
  ourOwnerPubkey: string
  identityKey: IdentityKey
}

export type { Unsubscribe }
