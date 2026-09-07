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

    const bobReceivedMessage = new Promise((resolve) => {
      managerBob.onEvent((event) => {
        if (event.content === chatMessage) resolve(true)
      })
    })
    await managerAlice.sendMessage(bobPubkey, chatMessage)
    expect(publishAlice).toHaveBeenCalled()
    expect(await bobReceivedMessage).toBe(true)
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
    expect(publish).toHaveBeenCalledWith(preparedEvent, rumor.id)
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
});
