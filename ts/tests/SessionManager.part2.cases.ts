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


it("should flush a queued linked-device message once a delayed single-device invite bootstrap completes", async () => {
    const relay = new MockRelay()

    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const linkedDeviceSecretKey = generateSecretKey()
    const linkedDevicePublicKey = getPublicKey(linkedDeviceSecretKey)

    const peerSecretKey = generateSecretKey()
    const peerPublicKey = getPublicKey(peerSecretKey)
    const peerInvite = Invite.createNew(peerPublicKey, peerPublicKey, 1)

    relay.storeAndDeliver(
      finalizeEvent(peerInvite.getEvent(), peerSecretKey) as VerifiedEvent
    )

    const delayedSubscribe = (
      filter: Parameters<MockRelay["subscribe"]>[0],
      onEvent: Parameters<MockRelay["subscribe"]>[1]
    ) => {
      const handle = relay.subscribe(filter, (event) => {
        setTimeout(() => onEvent(event), 1500)
      })
      return handle.close
    }

    const peerManager = new SessionManager(
      peerPublicKey,
      peerSecretKey,
      peerPublicKey,
      createRelaySubscribe(relay),
      createRelayPublish(relay, peerSecretKey),
      peerPublicKey,
      {
        ephemeralKeypair: {
          publicKey: peerInvite.inviterEphemeralPublicKey,
          privateKey: peerInvite.inviterEphemeralPrivateKey!,
        },
        sharedSecret: peerInvite.sharedSecret,
      },
      new InMemoryStorageAdapter()
    )
    await peerManager.init()

    const linkedManager = new SessionManager(
      linkedDevicePublicKey,
      linkedDeviceSecretKey,
      linkedDevicePublicKey,
      delayedSubscribe,
      createRelayPublish(relay, linkedDeviceSecretKey),
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter()
    )
    await linkedManager.init()

    const ownerAppKeysEvent = signedAppKeysEvent(ownerSecretKey, [linkedDevicePublicKey])
    relay.storeAndDeliver(ownerAppKeysEvent)

    const text = `linked-queued-until-bootstrap-${Date.now()}`
    const peerReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for queued single-device peer message")),
        10_000
      )
      const unsubscribe = peerManager.onEvent((event) => {
        if (event.content !== text) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await linkedManager.sendMessage(peerPublicKey, text)
    await peerReceived
  })

it("should sync messages across multiple devices", async () => {
    const sharedRelay = new MockRelay()

    const { manager: aliceDevice1, secretKey: aliceSecretKey } =
      await createMockSessionManager("alice-device-1", sharedRelay)

    const { manager: aliceDevice2 } = await createMockSessionManager(
      "alice-device-2",
      sharedRelay,
      aliceSecretKey
    )

    const { manager: bobDevice1, publicKey: bobPubkey } = await createMockSessionManager(
      "bob-device-1",
      sharedRelay
    )

    const msg1 = "Hello Bob from Alice device 1"
    const msg2 = "Hello Bob from Alice device 2"

    // Register the event handler BEFORE sending to avoid missing events
    const bobReceivedMessages = new Promise<string[]>((resolve) => {
      const received: string[] = []
      bobDevice1.onEvent((event) => {
        if (event.content === msg1 || event.content === msg2) {
          received.push(event.content)
          if (received.length === 2) resolve(received)
        }
      })
    })

    await aliceDevice1.sendMessage(bobPubkey, msg1)
    await aliceDevice2.sendMessage(bobPubkey, msg2)

    const result = await bobReceivedMessages
    expect(result).toHaveLength(2)
    expect(result).toContain(msg1)
    expect(result).toContain(msg2)
  })

it("should deliver messages to all sender and recipient devices", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-device-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-2" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-1" },
          to: "bob",
          message: "alice broadcast",
          waitOn: "all-recipient-devices",
        },
        { type: "expect", actor: "alice", deviceId: "alice-device-2", message: "alice broadcast" },
        {
          type: "send",
          from: { actor: "bob", deviceId: "bob-device-2" },
          to: "alice",
          message: "bob broadcast",
          waitOn: "all-recipient-devices",
        },
        { type: "expect", actor: "bob", deviceId: "bob-device-1", message: "bob broadcast" },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "bob broadcast" },
        { type: "expect", actor: "alice", deviceId: "alice-device-2", message: "bob broadcast" },
      ],
    })
  })

it("should fan out a linked sender's first reply to a peer's newly linked device", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-1" },
          to: "bob",
          message: "seed existing chat",
          waitOn: "all-recipient-devices",
        },
        { type: "addDevice", actor: "alice", deviceId: "alice-device-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-2" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-1" },
          to: "bob",
          message: "bootstrap newly linked devices",
          waitOn: "all-recipient-devices",
        },
        {
          type: "send",
          from: { actor: "bob", deviceId: "bob-device-2" },
          to: "alice",
          message: "linked first reply",
          waitOn: "all-recipient-devices",
        },
        { type: "expect", actor: "bob", deviceId: "bob-device-1", message: "linked first reply" },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "linked first reply" },
        { type: "expect", actor: "alice", deviceId: "alice-device-2", message: "linked first reply" },
      ],
    })
  })

it("should self-sync an existing peer chat to a newly linked sibling after link", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-1" },
          to: "bob",
          message: "seed existing chat",
          waitOn: "all-recipient-devices",
        },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-2" },
        {
          type: "send",
          from: { actor: "bob", deviceId: "bob-device-1" },
          to: "alice",
          message: "owner reply after link",
          waitOn: "all-recipient-devices",
        },
        { type: "expect", actor: "bob", deviceId: "bob-device-2", message: "owner reply after link" },
      ],
    })
  })

it("should fan out from an existing sibling sender after the peer links a new device", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-device-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-1" },
          to: "bob",
          message: "seed existing chat",
          waitOn: "all-recipient-devices",
        },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-2" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-2" },
          to: "bob",
          message: "existing sibling sender after peer link",
          waitOn: "all-recipient-devices",
        },
        {
          type: "expect",
          actor: "bob",
          deviceId: "bob-device-2",
          message: "existing sibling sender after peer link",
        },
      ],
    })
  })

it("fetchAppKeys preserves same-second device additions even when an older snapshot arrives later", async () => {
    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const baseDeviceSecret = generateSecretKey()
    const baseDevicePubkey = getPublicKey(baseDeviceSecret)
    const linkedDeviceSecret = generateSecretKey()
    const linkedDevicePubkey = getPublicKey(linkedDeviceSecret)
    const createdAt = Math.floor(Date.now() / 1000)

    const oldEvent = signedAppKeysEvent(ownerSecretKey, [baseDevicePubkey], createdAt)

    const newEvent = signedAppKeysEvent(ownerSecretKey, [baseDevicePubkey, linkedDevicePubkey], createdAt)

    const subscribe = (_filter: unknown, onEvent: (event: typeof oldEvent) => void) => {
      setTimeout(() => onEvent(newEvent), 0)
      setTimeout(() => onEvent(oldEvent), 1)
      return () => {}
    }

    const manager = new (await import("../src/SessionManager")).SessionManager(
      ownerPublicKey,
      ownerSecretKey,
      ownerPublicKey,
      subscribe as never,
      async (event) => event as never,
      ownerPublicKey,
      {
        ephemeralKeypair: {
          publicKey: getPublicKey(generateSecretKey()),
          privateKey: generateSecretKey(),
        },
        sharedSecret: "0".repeat(64),
      }
    )

    const fetched = await (manager as any).fetchAppKeys(ownerPublicKey, 20)
    const devicePubkeys = fetched?.getAllDevices().map((device: {identityPubkey: string}) => device.identityPubkey) ?? []

    expect(devicePubkeys).toContain(baseDevicePubkey)
    expect(devicePubkeys).toContain(linkedDevicePubkey)
  })

it("fetchAppKeys prefers the newest distinct-timestamp snapshot when older AppKeys arrive later", async () => {
    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const baseDeviceSecret = generateSecretKey()
    const baseDevicePubkey = getPublicKey(baseDeviceSecret)
    const linkedDeviceSecret = generateSecretKey()
    const linkedDevicePubkey = getPublicKey(linkedDeviceSecret)
    const createdAt = Math.floor(Date.now() / 1000)

    const oldEvent = signedAppKeysEvent(ownerSecretKey, [baseDevicePubkey], createdAt)

    const newEvent = signedAppKeysEvent(ownerSecretKey, [baseDevicePubkey, linkedDevicePubkey], createdAt + 1)

    const subscribe = (_filter: unknown, onEvent: (event: typeof oldEvent) => void) => {
      setTimeout(() => onEvent(newEvent), 0)
      setTimeout(() => onEvent(oldEvent), 1)
      return () => {}
    }

    const manager = new (await import("../src/SessionManager")).SessionManager(
      ownerPublicKey,
      ownerSecretKey,
      ownerPublicKey,
      subscribe as never,
      async (event) => event as never,
      ownerPublicKey,
      {
        ephemeralKeypair: {
          publicKey: getPublicKey(generateSecretKey()),
          privateKey: generateSecretKey(),
        },
        sharedSecret: "0".repeat(64),
      }
    )

    const fetched = await (manager as any).fetchAppKeys(ownerPublicKey, 20)
    const devicePubkeys =
      fetched?.getAllDevices().map((device: { identityPubkey: string }) => device.identityPubkey) ?? []

    expect(devicePubkeys).toContain(baseDevicePubkey)
    expect(devicePubkeys).toContain(linkedDevicePubkey)
  })

it("should deliver self-sent messages to other online devices", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-device-2" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-1" },
          to: "alice",
          message: "alice-self-1",
          waitOn: { actor: "alice", deviceId: "alice-device-2" },
        },
        { type: "expect", actor: "alice", deviceId: "alice-device-2", message: "alice-self-1" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-device-2" },
          to: "alice",
          message: "alice-self-2",
          waitOn: { actor: "alice", deviceId: "alice-device-1" },
        },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "alice-self-2" },
      ],
    })
  })

it("should fan out interleaved multi-device messages", async () => {
    const aliceDevice1 = { actor: "alice", deviceId: "alice-device-1" } as const
    const aliceDevice2 = { actor: "alice", deviceId: "alice-device-2" } as const
    const bobDevice1 = { actor: "bob", deviceId: "bob-device-1" } as const
    const bobDevice2 = { actor: "bob", deviceId: "bob-device-2" } as const

    const toBob1 = "a1->bob #1"
    const toAlice1 = "b1->alice"
    const aliceSelf = "a2->alice"
    const bobSelf = "b2->bob"
    const toBob2 = "a1->bob #2"

    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-device-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-2" },
        { type: "send", from: aliceDevice1, to: "bob", message: toBob1, waitOn: "all-recipient-devices" },
        { type: "send", from: bobDevice1, to: "alice", message: toAlice1, waitOn: "all-recipient-devices" },
        { type: "send", from: aliceDevice2, to: "alice", message: aliceSelf, waitOn: { actor: "alice", deviceId: "alice-device-1" } },
        { type: "send", from: bobDevice2, to: "bob", message: bobSelf, waitOn: { actor: "bob", deviceId: "bob-device-1" } },
        { type: "send", from: aliceDevice1, to: "bob", message: toBob2, waitOn: "all-recipient-devices" },
        { type: "expectAll", actor: "alice", deviceId: "alice-device-1", messages: [toAlice1, aliceSelf] },
        { type: "expectAll", actor: "alice", deviceId: "alice-device-2", messages: [toBob1, toAlice1, toBob2] },
        { type: "expectAll", actor: "bob", deviceId: "bob-device-1", messages: [toBob1, bobSelf, toBob2] },
        { type: "expectAll", actor: "bob", deviceId: "bob-device-2", messages: [toBob1, toAlice1, toBob2] },
      ],
    })
  })

it("should persist sessions across manager restarts", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "Initial message" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "Reply message" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "Reply message 2" },
        { type: "restart", actor: "alice", deviceId: "alice-device-1" },
        { type: "restart", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "Message after restart" },
        { type: "expect", actor: "bob", deviceId: "bob-device-1", message: "Message after restart" },
      ],
    })
  })
});
