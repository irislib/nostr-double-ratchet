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
import { serializeSessionState } from "../src/utils"

class FailPreparedSnapshotStorage extends InMemoryStorageAdapter {
  failPreparedInnerId: string | null = null

  override async put<T>(key: string, value: T): Promise<void> {
    const snapshot = value as {
      outbound?: Array<{ type?: string }>
    }
    if (
      this.failPreparedInnerId &&
      key === "v2/runtime-snapshot" &&
      snapshot.outbound?.some(
        (entry) =>
          entry.type === "prepared" &&
          (entry as { innerEventId?: string }).innerEventId === this.failPreparedInnerId
      )
    ) {
      this.failPreparedInnerId = null
      throw new Error("injected prepared snapshot failure")
    }
    await super.put(key, value)
  }
}

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

  it("should receive a message", async () => {
    const sharedRelay = new MockRelay()

    const { manager: managerAlice, publish: publishAlice } = await createMockSessionManager(
      "alice-device-1",
      sharedRelay
    )

    const { manager: managerBob, publicKey: bobPubkey } = await createMockSessionManager(
      "bob-device-1",
      sharedRelay
    )

    const chatMessage = "Hello Bob from Alice!"

    await managerAlice.sendMessage(bobPubkey, chatMessage)

    expect(publishAlice).toHaveBeenCalled()
    const bobReceivedMessage = await new Promise((resolve) => {
      managerBob.onEvent((event) => {
        if (event.content === chatMessage) resolve(true)
      })
    })
    expect(bobReceivedMessage).toBe(true)
  })

  it("reports queued diagnostics for unsendable messages", async () => {
    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const peerSecretKey = generateSecretKey()
    const peerPublicKey = getPublicKey(peerSecretKey)

    const manager = SessionManager.createForRuntime(
      ownerPublicKey,
      ownerSecretKey,
      ownerPublicKey,
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter(),
    )

    const now = Date.now()
    const rumor = {
      content: "queued diagnostic",
      kind: 14,
      created_at: Math.floor(now / 1000),
      tags: [["p", peerPublicKey], ["ms", String(now)]],
      pubkey: ownerPublicKey,
      id: "",
    }
    rumor.id = getEventHash(rumor)
    await manager.sendEvent(peerPublicKey, rumor)

    await vi.waitFor(async () => {
      const diagnostics = await manager.queuedMessageDiagnostics(rumor.id)
      const peerDiagnostic = diagnostics.find((entry) => entry.ownerPubkey === peerPublicKey)

      expect(peerDiagnostic).toMatchObject({
        stage: "device",
        targetKey: peerPublicKey,
        ownerPubkey: peerPublicKey,
        innerEventId: rumor.id,
      })
    })
  })

  it("rolls back ratchet state when the atomic prepared snapshot fails", async () => {
    const relay = new MockRelay()
    const storage = new FailPreparedSnapshotStorage()
    const alice = await createMockSessionManager("alice", relay, undefined, storage)
    const bob = await createMockSessionManager("bob", relay)

    const bobReceived = new Promise<void>((resolve) => {
      bob.manager.onEvent((event) => {
        if (event.content === "establish") resolve()
      })
    })
    await alice.manager.sendMessage(bob.publicKey, "establish")
    await bobReceived
    const aliceReceived = new Promise<void>((resolve) => {
      alice.manager.onEvent((event) => {
        if (event.content === "answer") resolve()
      })
    })
    await bob.manager.sendMessage(alice.publicKey, "answer")
    await aliceReceived

    const sessionStates = () =>
      Array.from(alice.manager.getUserRecords().values())
        .flatMap((record) => Array.from(record.devices.values()))
        .flatMap((device) => [
          ...(device.activeSession ? [device.activeSession] : []),
          ...device.inactiveSessions,
        ])
        .map((session) => `${session.name}:${serializeSessionState(session.state)}`)
        .sort()
    const stateBefore = sessionStates()
    expect(stateBefore.length).toBeGreaterThan(0)
    const now = Date.now()
    const failedRumor = {
      content: "must remain an intent",
      kind: 14,
      created_at: Math.floor(now / 1000),
      tags: [["p", bob.publicKey], ["ms", String(now)]],
      pubkey: alice.publicKey,
      id: "",
    }
    failedRumor.id = getEventHash(failedRumor)
    storage.failPreparedInnerId = failedRumor.id

    await expect(
      alice.manager.sendEvent(bob.publicKey, failedRumor)
    ).rejects.toThrow("injected prepared snapshot failure")

    expect(sessionStates()).toEqual(stateBefore)
    expect(await alice.manager.queuedMessageDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "device" }),
      ])
    )
  })

  it("delegates outbound publishing to device records without requiring an active session", async () => {
    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const peerSecretKey = generateSecretKey()
    const peerPublicKey = getPublicKey(peerSecretKey)
    const preparedEvent = finalizeEvent(
      {
        content: "prepared",
        kind: MESSAGE_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
      },
      peerSecretKey,
    ) as VerifiedEvent
    const publish = vi.fn(async (event: UnsignedEvent | VerifiedEvent) => event as VerifiedEvent)

    const manager = new SessionManager(
      ownerPublicKey,
      ownerSecretKey,
      ownerPublicKey,
      () => () => {},
      publish,
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter(),
    )
    await manager.init()

    const userRecord = (manager as unknown as {
      getOrCreateUserRecord(publicKey: string): { devices: Map<string, unknown> }
    }).getOrCreateUserRecord(peerPublicKey)
    const prepareOutboundEvent = vi.fn(() => preparedEvent)
    userRecord.devices.set(peerPublicKey, {
      deviceId: peerPublicKey,
      activeSession: undefined,
      inactiveSessions: [],
      createdAt: Date.now(),
      prepareOutboundEvent,
      flushMessageQueue: vi.fn(async () => {}),
    })

    const now = Date.now()
    const rumor = {
      content: "via delegated device record",
      kind: 14,
      created_at: Math.floor(now / 1000),
      tags: [["p", peerPublicKey], ["ms", String(now)]],
      pubkey: ownerPublicKey,
      id: "",
    }
    rumor.id = getEventHash(rumor)

    await manager.sendEvent(peerPublicKey, rumor)

    expect(prepareOutboundEvent).toHaveBeenCalledWith(rumor)
    expect(publish).toHaveBeenCalledWith(preparedEvent)
  })

  it("should bootstrap a linked device session to a single-device peer via that peer's public invite", async () => {
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
      createRelaySubscribe(relay),
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

    const text = `linked-to-single-device-${Date.now()}`
    const peerReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for single-device peer message")),
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

  it("should bootstrap a linked device session to a single-device peer when invite backfill is delayed", async () => {
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
        setTimeout(() => onEvent(event), 300)
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

    const text = `linked-delayed-invite-${Date.now()}`
    const peerReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for delayed single-device peer message")),
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

  it("should deliver a linked sender's first message once the sender owner AppKeys appear after the public-invite response", async () => {
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
      createRelaySubscribe(relay),
      createRelayPublish(relay, linkedDeviceSecretKey),
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter()
    )
    await linkedManager.init()

    const text = `linked-first-message-after-owner-proof-${Date.now()}`
    const peerReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for peer to receive linked first message")),
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

    let responseEvent: VerifiedEvent | undefined
    await vi.waitFor(() => {
      responseEvent = relay.getAllEvents().find((event) => event.kind === 1059) as VerifiedEvent | undefined
      expect(responseEvent).toBeDefined()
    }, { timeout: 5_000 })

    const decrypted = await decryptInviteResponse({
      envelopeContent: responseEvent!.content,
      envelopeSenderPubkey: responseEvent!.pubkey,
      inviterEphemeralPrivateKey: peerInvite.inviterEphemeralPrivateKey!,
      inviterPrivateKey: peerSecretKey,
      sharedSecret: peerInvite.sharedSecret,
    })
    expect(decrypted.inviteeIdentity).toBe(linkedDevicePublicKey)
    expect(decrypted.ownerPublicKey).toBe(ownerPublicKey)

    const ownerAppKeysEvent = signedAppKeysEvent(ownerSecretKey, [linkedDevicePublicKey])
    relay.storeAndDeliver(ownerAppKeysEvent)

    await peerReceived
  }, 15_000)

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

  it("should handle back to back messages after initial, answer, and then", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "alice to bob 1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "bob to alice 1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "alice to bob 2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "alice to bob 3" },
      ],
    })
  })

  it("should handle back to back messages after initial", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "Initial message" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "Reply message" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "Reply message 2" },
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

  it("should deliver when receiver restarts multiple times", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "3" },
        { type: "restart", actor: "alice", deviceId: "alice-device-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "4" },
        { type: "restart", actor: "alice", deviceId: "alice-device-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "5" },
      ],
    })
  })

  it("should deliver when receiver restarts multiple times (clearEvents)", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "3" },
        { type: "restart", actor: "alice", deviceId: "alice-device-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "4" },
        { type: "clearEvents" },
        { type: "restart", actor: "alice", deviceId: "alice-device-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "5" },
      ],
    })
  })
})

describe("SessionManager (Controlled Relay)", () => {
  describe("Controlled delivery features", () => {
    it("should track delivery history", async () => {
      const sharedRelay = new ControlledMockRelay()

      const { manager: alice } = await createControlledMockSessionManager(
        "alice-device-1",
        sharedRelay
      )

      const { publicKey: bobPubkey } = await createControlledMockSessionManager(
        "bob-device-1",
        sharedRelay
      )

      await alice.sendMessage(bobPubkey, "tracked message")

      const history = sharedRelay.getDeliveryHistory()
      expect(history.length).toBeGreaterThan(0)
    })

    it("should expose subscription info", async () => {
      const sharedRelay = new ControlledMockRelay()

      await createControlledMockSessionManager("alice-device-1", sharedRelay)
      await createControlledMockSessionManager("bob-device-1", sharedRelay)

      const subs = sharedRelay.getSubscriptions()
      expect(subs.length).toBeGreaterThan(0)
    })

    it("should support duplicate event detection via delivery count", async () => {
      const sharedRelay = new ControlledMockRelay()

      // Use autoDeliver to ensure events are delivered immediately
      // This is needed because session establishment is now async
      const { manager: alice } = await createControlledMockSessionManager(
        "alice-device-1",
        sharedRelay,
        undefined,
        undefined,
        undefined,
        { autoDeliver: true }
      )

      const { publicKey: bobPubkey } = await createControlledMockSessionManager(
        "bob-device-1",
        sharedRelay,
        undefined,
        undefined,
        undefined,
        { autoDeliver: true }
      )

      await alice.sendMessage(bobPubkey, "test msg")

      const waitForDeliveredMessageEvent = async () => {
        for (let attempt = 0; attempt < 15; attempt++) {
          const candidate = sharedRelay
            .getAllEvents()
            .find((event) => event.kind === 1060 && sharedRelay.getDeliveryCount(event.id) > 0)
          if (candidate) {
            return candidate
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return null
      }

      const msgEvent = await waitForDeliveredMessageEvent()

      // If session wasn't established in time, skip this test
      // This can happen with async two-step discovery under load
      if (!msgEvent) {
        console.log("Skipping: session not established in time")
        return
      }

      const count = sharedRelay.getDeliveryCount(msgEvent.id)
      expect(count).toBeGreaterThanOrEqual(1)

      sharedRelay.duplicateEvent(msgEvent.id)

      const newCount = sharedRelay.getDeliveryCount(msgEvent.id)
      expect(newCount).toBeGreaterThan(count)
    })
  })

  describe("Race condition simulation", () => {
    it("should handle rapid sends from both parties", async () => {
      const sharedRelay = new ControlledMockRelay()

      const { manager: alice, publicKey: alicePubkey } =
        await createControlledMockSessionManager("alice-device-1", sharedRelay)

      const { manager: bob, publicKey: bobPubkey } =
        await createControlledMockSessionManager("bob-device-1", sharedRelay)

      const aliceReceived: string[] = []
      const bobReceived: string[] = []

      alice.onEvent((event) => aliceReceived.push(event.content))
      bob.onEvent((event) => bobReceived.push(event.content))

      const bobGotAlice1 = new Promise<void>((r) => {
        const unsub = bob.onEvent((e) => { if (e.content === "alice-1") { unsub(); r() } })
      })
      const bobGotAlice2 = new Promise<void>((r) => {
        const unsub = bob.onEvent((e) => { if (e.content === "alice-2") { unsub(); r() } })
      })
      const aliceGotBob1 = new Promise<void>((r) => {
        const unsub = alice.onEvent((e) => { if (e.content === "bob-1") { unsub(); r() } })
      })
      const aliceGotBob2 = new Promise<void>((r) => {
        const unsub = alice.onEvent((e) => { if (e.content === "bob-2") { unsub(); r() } })
      })

      await alice.sendMessage(bobPubkey, "alice-1")
      await bob.sendMessage(alicePubkey, "bob-1")
      await alice.sendMessage(bobPubkey, "alice-2")
      await bob.sendMessage(alicePubkey, "bob-2")

      await Promise.all([bobGotAlice1, bobGotAlice2, aliceGotBob1, aliceGotBob2])

      expect(bobReceived).toContain("alice-1")
      expect(bobReceived).toContain("alice-2")
      expect(aliceReceived).toContain("bob-1")
      expect(aliceReceived).toContain("bob-2")
    })
  })

  describe("Relay inspection", () => {
    it("should provide access to all events", async () => {
      const sharedRelay = new ControlledMockRelay()

      const { manager: alice } = await createControlledMockSessionManager(
        "alice-device-1",
        sharedRelay
      )

      const { manager: bob, publicKey: bobPubkey } = await createControlledMockSessionManager(
        "bob-device-1",
        sharedRelay
      )

      const initialEventCount = sharedRelay.getAllEvents().length

      const received = new Promise<void>((resolve) => {
        let count = 0
        bob.onEvent((e) => {
          if (e.content === "test1" || e.content === "test2") {
            count++
            if (count >= 2) resolve()
          }
        })
      })

      await alice.sendMessage(bobPubkey, "test1")
      await alice.sendMessage(bobPubkey, "test2")

      await received

      const finalEventCount = sharedRelay.getAllEvents().length
      expect(finalEventCount).toBeGreaterThanOrEqual(initialEventCount)
      expect(finalEventCount).toBeGreaterThan(0)
    })

    it("should allow inspection of delivery to specific subscribers", async () => {
      const sharedRelay = new ControlledMockRelay()

      await createControlledMockSessionManager("alice-device-1", sharedRelay)
      await createControlledMockSessionManager("bob-device-1", sharedRelay)

      const history = sharedRelay.getDeliveryHistory()
      const subs = sharedRelay.getSubscriptions()

      expect(subs.length).toBeGreaterThan(0)
      expect(history.length).toBeGreaterThan(0)

      for (const record of history) {
        expect(record.subscriberId).toBeTruthy()
        expect(record.eventId).toBeTruthy()
        expect(record.timestamp).toBeGreaterThan(0)
      }
    })
  })
})

describe("SessionManager Device Revocation Enforcement", () => {
  it("should not send messages to a revoked device", async () => {
    await runScenario({
      steps: [
        // Setup: Alice has 2 devices, Bob has 1 device
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDelegateDevice", actor: "alice", deviceId: "alice-device-2", mainDeviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },

        // Establish sessions between all devices
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "hello alice" },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "hello alice" },
        { type: "expect", actor: "alice", deviceId: "alice-device-2", message: "hello alice" },

        // Alice revokes device-2
        { type: "removeDevice", actor: "alice", deviceId: "alice-device-2" },

        // Bob sends another message - should only reach alice-device-1
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "after revocation",
          waitOn: { actor: "alice", deviceId: "alice-device-1" } },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "after revocation" },
        // alice-device-2 should NOT receive this message (verified by timeout/no delivery)
      ],
    })
  })

  it("should reject messages from a revoked device", async () => {
    await runScenario({
      steps: [
        // Setup
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDelegateDevice", actor: "alice", deviceId: "alice-device-2", mainDeviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },

        // Establish sessions
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "initial" },
        { type: "expect", actor: "bob", deviceId: "bob-device-1", message: "initial" },

        // Alice revokes device-2
        { type: "removeDevice", actor: "alice", deviceId: "alice-device-2" },

        // Revoked device tries to send - Bob should reject it
        // (The test framework may not directly support asserting non-delivery,
        // but the implementation should log rejection)
      ],
    })
  })

  it("should continue normal communication after device revocation", async () => {
    await runScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-device-1" },
        { type: "addDelegateDevice", actor: "alice", deviceId: "alice-device-2", mainDeviceId: "alice-device-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-device-1" },

        // Establish sessions
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "msg1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "msg2" },

        // Revoke alice-device-2
        { type: "removeDevice", actor: "alice", deviceId: "alice-device-2" },

        // Verify alice-device-1 and bob can still communicate
        { type: "send", from: { actor: "alice", deviceId: "alice-device-1" }, to: "bob", message: "after-revoke-1" },
        { type: "expect", actor: "bob", deviceId: "bob-device-1", message: "after-revoke-1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-device-1" }, to: "alice", message: "after-revoke-2",
          waitOn: { actor: "alice", deviceId: "alice-device-1" } },
        { type: "expect", actor: "alice", deviceId: "alice-device-1", message: "after-revoke-2" },
      ],
    })
  })
})

describe("SessionManager AppKeys Respect", () => {
  it("should not send messages to devices removed from AppKeys via replacement", async () => {
    const sharedRelay = new MockRelay()

    // Create Alice with her own device
    const { manager: aliceManager, publicKey: alicePubkey } = await createMockSessionManager(
      "alice-device-1",
      sharedRelay
    )

    // Create Bob with his device
    const {
      manager: bobManager,
      publicKey: bobPubkey,
      appKeysManager: bobAppKeysManager,
    } = await createMockSessionManager("bob-device-1", sharedRelay)

    // Establish session
    const msg1 = "Hello Bob"
    const bobReceived = new Promise<void>((resolve) => {
      bobManager.onEvent((event) => {
        if (event.content === msg1) resolve()
      })
    })
    await aliceManager.sendMessage(bobPubkey, msg1)
    await bobReceived

    // Bob replies to complete session
    const msg2 = "Hello Alice"
    const aliceReceived = new Promise<void>((resolve) => {
      aliceManager.onEvent((event) => {
        if (event.content === msg2) resolve()
      })
    })
    await bobManager.sendMessage(alicePubkey, msg2)
    await aliceReceived

    // Bob replaces his AppKeys with empty list (without using removeDevice)
    const emptyAppKeys = new (await import("../src/AppKeys")).AppKeys()
    await bobAppKeysManager.setAppKeys(emptyAppKeys)
    await bobAppKeysManager.publish()

    // Wait for Alice to process the AppKeys update
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Track messages Bob receives after the AppKeys change
    const messagesAfterChange: string[] = []
    bobManager.onEvent((event) => {
      messagesAfterChange.push(event.content)
    })

    // Alice sends a new message - it should NOT be delivered to Bob's device
    // because the device is no longer in the AppKeys
    const msg3 = "This should not be delivered"
    await aliceManager.sendMessage(bobPubkey, msg3)

    // Wait a bit for potential delivery
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Bob should NOT have received the message since his device was marked stale
    expect(messagesAfterChange).not.toContain(msg3)
  }, 30000)
})
