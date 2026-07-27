import { describe, it, expect, vi } from "vitest"
import { createMockSessionManager } from "./helpers/mockSessionManager"
import { createControlledMockSessionManager } from "./helpers/controlledMockSessionManager"
import { MockRelay } from "./helpers/mockRelay"
import { ControlledMockRelay } from "./helpers/ControlledMockRelay"
import { runScenario } from "./helpers/scenario"
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type UnsignedEvent, type VerifiedEvent } from "nostr-tools"
import { Invite } from "../src/Invite"
import { decryptInviteResponse, generateEphemeralKeypair, generateSharedSecret } from "../src/inviteUtils"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { SessionManager } from "../src/SessionManager"
import { MESSAGE_EVENT_KIND } from "../src/types"
import { AppKeys } from "../src/AppKeys"

type DeviceRecordSnapshot = { inactiveSessions: unknown[] }

const signedAppKeysEvent = (
  ownerSecretKey: Uint8Array,
  devicePubkeys: string[],
  createdAt = Math.floor(Date.now() / 1000),
): VerifiedEvent =>
  finalizeEvent(
    new AppKeys(
      devicePubkeys.map((identityPubkey) => ({ identityPubkey, createdAt }))
    ).getEvent({
      ownerPrivateKey: ownerSecretKey,
      ownerPubkey: getPublicKey(ownerSecretKey),
      createdAt,
    }),
    ownerSecretKey
  ) as VerifiedEvent

const extractDeviceRecords = (manager: unknown): DeviceRecordSnapshot[] => {
  const internal = manager as {
    userRecords?: Map<string, { devices: Map<string, DeviceRecordSnapshot> }>
  }
  if (!internal.userRecords) return []
  return Array.from(internal.userRecords.values()).flatMap((record) =>
    Array.from(record.devices.values())
  )
}

describe("SessionManager", () => {
const createRelaySubscribe = (relay: MockRelay) => (
    filter: Parameters<MockRelay["subscribe"]>[0],
    onEvent: Parameters<MockRelay["subscribe"]>[1]
  ) => {
    const handle = relay.subscribe(filter, onEvent)
    return handle.close
  }

const createRelayPublish =
    (relay: MockRelay, signerSecretKey: Uint8Array) =>
    async (event: UnsignedEvent | VerifiedEvent) => {
      const signedEvent =
        "sig" in event && event.sig
          ? (event as VerifiedEvent)
          : (finalizeEvent(event as UnsignedEvent, signerSecretKey) as VerifiedEvent)
      relay.storeAndDeliver(signedEvent)
      return signedEvent as never
    }


it("should resume communication after restart with stored sessions", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "hello from alice" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "hey alice 1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "hey alice 2" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "hey alice 3" },
        { type: "close", actor: "bob", deviceId: "bob-device-1" },
        { type: "restart", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "hey alice after restart" },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "hey alice after restart" },
      ],
    })
  })

it("should deliver alice's message after bob restarts", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "alice to bob 1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "bob to alice 1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "alice to bob 2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "alice to bob 3" },
        { type: "restart", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "bob after restart" },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "bob after restart" },
      ],
    })
  })

it("should not accumulate additional sessions after restart", async () => {
    const sharedRelay = new MockRelay()

    const {
      manager: aliceManager,
      secretKey: aliceSecretKey,
      publicKey: alicePubkey,
      mockStorage: aliceStorage,
    } = await createMockSessionManager("alice-device-1", sharedRelay)

    const {
      manager: bobManager,
      secretKey: bobSecretKey,
      publicKey: bobPubkey,
      mockStorage: bobStorage,
    } = await createMockSessionManager("bob-device-1", sharedRelay)

    const [msg1, msg2] = ["hello bob", "hello alice"]

    const messagesReceivedBob = new Promise<void>((resolve) => {
      bobManager.onEvent((event) => {
        if (event.content === msg1) {
          resolve()
        }
      })
    })

    const messagesReceivedAlice = new Promise<void>((resolve) => {
      aliceManager.onEvent((event) => {
        if (event.content === msg2) {
          resolve()
        }
      })
    })

    await aliceManager.sendMessage(bobPubkey, msg1)
    await bobManager.sendMessage(alicePubkey, msg2)

    await Promise.all([messagesReceivedBob, messagesReceivedAlice])

    aliceManager.close()
    bobManager.close()

    const { manager: aliceManagerRestart } = await createMockSessionManager(
      "alice-device-1",
      sharedRelay,
      aliceSecretKey,
      aliceStorage
    )

    const { manager: bobManagerRestart } = await createMockSessionManager(
      "bob-device-1",
      sharedRelay,
      bobSecretKey,
      bobStorage
    )

    const afterRestartMessage = "after restart"

    const bobReveivedMessages = new Promise<void>((resolve) => {
      bobManagerRestart.onEvent((event) => {
        if (event.content === afterRestartMessage) {
          resolve()
        }
      })
    })

    await aliceManagerRestart.sendMessage(bobPubkey, "after restart")
    await bobReveivedMessages

    const aliceDeviceRecords = extractDeviceRecords(aliceManagerRestart)
    const bobDeviceRecords = extractDeviceRecords(bobManagerRestart)

    ;[...aliceDeviceRecords, ...bobDeviceRecords].forEach((record) => {
      expect(record.inactiveSessions.length).toBeLessThanOrEqual(1)
    })
  })
});
