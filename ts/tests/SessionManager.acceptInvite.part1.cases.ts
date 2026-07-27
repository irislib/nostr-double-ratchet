import { describe, expect, it, vi } from "vitest"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type UnsignedEvent,
  type VerifiedEvent,
} from "nostr-tools"
import { AppKeys, isAppKeysEvent } from "../src/AppKeys"
import { Invite } from "../src/Invite"
import { generateEphemeralKeypair, generateSharedSecret, decryptInviteResponse } from "../src/inviteUtils"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { SessionManager } from "../src/SessionManager"
import { createMockSessionManager } from "./helpers/mockSessionManager"
import { MockRelay } from "./helpers/mockRelay"

function extractInviteForOwner(relay: MockRelay, ownerPubkey: string): Invite {
  const events = relay.getAllEvents()

  const appKeysEvent = events.find(
    (event) =>
      event.pubkey === ownerPubkey && isAppKeysEvent(event as VerifiedEvent)
  ) as VerifiedEvent | undefined
  if (!appKeysEvent) {
    throw new Error("No AppKeys event found for owner")
  }

  const appKeys = AppKeys.fromEvent(appKeysEvent)
  const deviceIdentity = appKeys.getAllDevices()[0]?.identityPubkey
  if (!deviceIdentity) {
    throw new Error("No device identity found in AppKeys")
  }

  const inviteEvent = events.find(
    (event) =>
      event.kind === 30078 &&
      event.pubkey === deviceIdentity &&
      event.tags.some((tag) => tag[0] === "l" && tag[1] === "double-ratchet/invites")
  ) as VerifiedEvent | undefined
  if (!inviteEvent) {
    throw new Error("No invite event found for device")
  }

  const invite = Invite.fromEvent(inviteEvent)
  invite.ownerPubkey = ownerPubkey
  return invite
}

describe("SessionManager.acceptInvite", () => {
const createRelaySubscribe = (relay: MockRelay) => (filter: Parameters<MockRelay["subscribe"]>[0], onEvent: Parameters<MockRelay["subscribe"]>[1]) => {
    const handle = relay.subscribe(filter, onEvent)
    return handle.close
  }

const createRelayPublish =
    (relay: MockRelay, signerSecretKey: Uint8Array) =>
    vi.fn(async (event: UnsignedEvent | VerifiedEvent) => {
      const signedEvent =
        "sig" in event && event.sig
          ? (event as VerifiedEvent)
          : (finalizeEvent(event as UnsignedEvent, signerSecretKey) as VerifiedEvent)
      relay.storeAndDeliver(signedEvent)
      return signedEvent as never
    })


it("establishes manager session from invite and routes under owner pubkey", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const alice = await createMockSessionManager("alice-device-1", relay)

    const invite = extractInviteForOwner(relay, bob.publicKey)

    const accepted = await alice.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    expect(accepted.ownerPublicKey).toBe(bob.publicKey)
    expect(accepted.deviceId).toBe(invite.deviceId || invite.inviter)

    const bobRecord = alice.manager.getUserRecords().get(bob.publicKey)
    expect(bobRecord).toBeDefined()
    expect(Array.from(bobRecord!.devices.keys())).toContain(accepted.deviceId)

    const text = `hello-from-accept-invite-${Date.now()}`
    const bobReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for Bob to receive accepted-invite message")),
        10_000
      )
      const unsubscribe = bob.manager.onEvent((event) => {
        if (event.content !== text) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await alice.manager.sendMessage(bob.publicKey, text)
    await bobReceived
  })

it("publishes a bootstrap event after accepting an invite", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const alice = await createMockSessionManager("alice-device-1", relay)

    const invite = extractInviteForOwner(relay, bob.publicKey)
    const messageEventCountBefore = relay
      .getAllEvents()
      .filter((event) => event.kind === 1060).length

    await alice.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    const messageEventsAfter = relay
      .getAllEvents()
      .filter((event) => event.kind === 1060)

    expect(messageEventsAfter.length).toBeGreaterThan(messageEventCountBefore)
  })

it("expands verified owner AppKeys and accepts sibling public invites when accepting an invite", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const alice = await createMockSessionManager("alice-device-1", relay)

    const bobSecondDeviceSecretKey = generateSecretKey()
    const bobSecondDevicePublicKey = getPublicKey(bobSecondDeviceSecretKey)
    const createdAt = Math.floor(Date.now() / 1000)
    const bobAppKeys = new AppKeys()
    bobAppKeys.addDevice({
      identityPubkey: bob.manager.getDeviceId(),
      createdAt,
    })
    bobAppKeys.addDevice({
      identityPubkey: bobSecondDevicePublicKey,
      createdAt: createdAt + 1,
    })
    relay.storeAndDeliver(
      finalizeEvent(
        bobAppKeys.getEvent({
          ownerPrivateKey: bob.secretKey,
          ownerPubkey: bob.publicKey,
        }),
        bob.secretKey
      ) as VerifiedEvent
    )

    const bobSecondInvite = Invite.createNew(
      bobSecondDevicePublicKey,
      bobSecondDevicePublicKey,
      1,
      { ownerPubkey: bob.publicKey }
    )
    relay.storeAndDeliver(
      finalizeEvent(bobSecondInvite.getEvent(), bobSecondDeviceSecretKey) as VerifiedEvent
    )

    const invite = extractInviteForOwner(relay, bob.publicKey)
    await alice.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    await vi.waitFor(() => {
      const bobRecord = alice.manager.getUserRecords().get(bob.publicKey)
      expect(bobRecord).toBeDefined()
      expect(
        bobRecord?.appKeys?.getAllDevices().map((device) => device.identityPubkey)
      ).toContain(bobSecondDevicePublicKey)

      const siblingDevice = bobRecord?.devices.get(bobSecondDevicePublicKey)
      expect(siblingDevice).toBeDefined()
      expect(
        Boolean(siblingDevice?.activeSession) ||
        (siblingDevice?.inactiveSessions.length ?? 0) > 0
      ).toBe(true)
    }, { timeout: 5_000 })
  }, 10_000)

it("includes the account owner pubkey in link invite responses from registered owner devices", async () => {
    const relay = new MockRelay()

    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const ownerDeviceSecretKey = generateSecretKey()
    const ownerDevicePublicKey = getPublicKey(ownerDeviceSecretKey)
    const linkedDeviceSecretKey = generateSecretKey()
    const linkedDevicePublicKey = getPublicKey(linkedDeviceSecretKey)

    const ownerManager = new SessionManager(
      ownerDevicePublicKey,
      ownerDeviceSecretKey,
      ownerDevicePublicKey,
      createRelaySubscribe(relay),
      createRelayPublish(relay, ownerSecretKey),
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter()
    )
    await ownerManager.init()

    const ownerAppKeys = new AppKeys()
    ownerAppKeys.addDevice({
      identityPubkey: ownerDevicePublicKey,
      createdAt: Math.floor(Date.now() / 1000),
    })
    relay.storeAndDeliver(
      finalizeEvent(
        ownerAppKeys.getEvent({
          ownerPrivateKey: ownerSecretKey,
          ownerPubkey: ownerPublicKey,
        }),
        ownerSecretKey
      ) as VerifiedEvent
    )

    const linkInvite = Invite.createNew(linkedDevicePublicKey, linkedDevicePublicKey, 1, {
      purpose: "link",
    })

    const accepted = await ownerManager.acceptInvite(linkInvite, {
      ownerPublicKey,
    })

    expect(accepted.ownerPublicKey).toBe(ownerPublicKey)
    expect(accepted.deviceId).toBe(linkedDevicePublicKey)

    const inviteResponseEvent = relay
      .getAllEvents()
      .find((event) => event.kind === 1059)
    expect(inviteResponseEvent).toBeDefined()

    const decrypted = await decryptInviteResponse({
      envelopeContent: inviteResponseEvent!.content,
      envelopeSenderPubkey: inviteResponseEvent!.pubkey,
      inviterEphemeralPrivateKey: linkInvite.inviterEphemeralPrivateKey!,
      inviterPrivateKey: linkedDeviceSecretKey,
      sharedSecret: linkInvite.sharedSecret,
    })

    expect(decrypted.inviteeIdentity).toBe(ownerDevicePublicKey)
    expect(decrypted.ownerPublicKey).toBe(ownerPublicKey)
  })

it("retries bootstrap publishes with a short future expiration window", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const alice = await createMockSessionManager("alice-device-1", relay)

    const invite = extractInviteForOwner(relay, bob.publicKey)

    await alice.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    const initialBootstrapEvents = relay
      .getAllEvents()
      .filter((event) => event.kind === 1060)
    expect(initialBootstrapEvents).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 2_100))

    const retriedBootstrapEvents = relay
      .getAllEvents()
      .filter((event) => event.kind === 1060)
    expect(retriedBootstrapEvents.length).toBeGreaterThanOrEqual(3)
  }, 10_000)

it("lets an unregistered same-owner device receive the inviter reply after sending first", async () => {
    const relay = new MockRelay()

    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const invite = Invite.createNew(ownerPublicKey, ownerPublicKey, 1, {
      ownerPubkey: ownerPublicKey,
    })

    const ownerPublish = createRelayPublish(relay, ownerSecretKey)
    const ownerManager = new SessionManager(
      ownerPublicKey,
      ownerSecretKey,
      ownerPublicKey,
      createRelaySubscribe(relay),
      ownerPublish,
      ownerPublicKey,
      {
        ephemeralKeypair: {
          publicKey: invite.inviterEphemeralPublicKey,
          privateKey: invite.inviterEphemeralPrivateKey!,
        },
        sharedSecret: invite.sharedSecret,
      },
      new InMemoryStorageAdapter()
    )
    await ownerManager.init()

    const ownerAppKeys = new AppKeys()
    ownerAppKeys.addDevice({ identityPubkey: ownerPublicKey, createdAt: Math.floor(Date.now() / 1000) })
    relay.storeAndDeliver(
      finalizeEvent(
        ownerAppKeys.getEvent({
          ownerPrivateKey: ownerSecretKey,
          ownerPubkey: ownerPublicKey,
        }),
        ownerSecretKey
      ) as VerifiedEvent
    )

    const webDeviceSecretKey = generateSecretKey()
    const webDevicePublicKey = getPublicKey(webDeviceSecretKey)
    const webManager = new SessionManager(
      webDevicePublicKey,
      webDeviceSecretKey,
      webDevicePublicKey,
      createRelaySubscribe(relay),
      createRelayPublish(relay, webDeviceSecretKey),
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter()
    )
    await webManager.init()

    const accepted = await webManager.acceptInvite(invite, {
      ownerPublicKey,
    })
    expect(accepted.ownerPublicKey).toBe(ownerPublicKey)
    expect(accepted.deviceId).toBe(ownerPublicKey)

    const firstMessage = `first-from-unregistered-${Date.now()}`
    const ownerReceivedFrom = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for owner to receive first self-chat message")),
        10_000
      )
      const unsubscribe = ownerManager.onEvent((event, fromPubkey) => {
        if (event.content !== firstMessage) return
        clearTimeout(timeout)
        unsubscribe()
        resolve(fromPubkey)
      })
    })

    await webManager.sendMessage(ownerPublicKey, firstMessage)
    const replyTarget = await ownerReceivedFrom

    const replyMessage = `reply-to-unregistered-${Date.now()}`
    const webReceivedReply = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for unregistered device to receive inviter reply")),
        10_000
      )
      const unsubscribe = webManager.onEvent((event) => {
        if (event.content !== replyMessage) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await ownerManager.sendMessage(replyTarget, replyMessage)
    await webReceivedReply
  })

it("accepts link invite for owner even before new device appears in owner AppKeys", async () => {
    const relay = new MockRelay()

    const owner = await createMockSessionManager("owner-device-1", relay)
    const newDevicePubkey = getPublicKey(generateSecretKey())

    const invite = Invite.createNew(newDevicePubkey, newDevicePubkey, 1, {
      purpose: "link",
      ownerPubkey: owner.publicKey,
    })

    const accepted = await owner.manager.acceptInvite(invite, {
      ownerPublicKey: owner.publicKey,
    })

    expect(accepted.ownerPublicKey).toBe(owner.publicKey)
    expect(accepted.deviceId).toBe(newDevicePubkey)

    const ownerRecord = owner.manager.getUserRecords().get(owner.publicKey)
    expect(ownerRecord).toBeDefined()
    expect(Array.from(ownerRecord!.devices.keys())).toContain(newDevicePubkey)

    const bootstrapEvents = relay
      .getAllEvents()
      .filter((event) => event.kind === 1060)
    expect(bootstrapEvents.length).toBeGreaterThan(0)
  })

it("falls back to inviter device identity when chat owner claim is not authorized by AppKeys", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const alice = await createMockSessionManager("alice-device-1", relay)
    const unknownBobDevicePubkey = getPublicKey(generateSecretKey())

    const invite = Invite.createNew(unknownBobDevicePubkey, unknownBobDevicePubkey, 1, {
      purpose: "chat",
      ownerPubkey: bob.publicKey,
    })

    const accepted = await alice.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    expect(accepted.ownerPublicKey).toBe(unknownBobDevicePubkey)
    expect(accepted.deviceId).toBe(unknownBobDevicePubkey)

    const bobRecord = alice.manager.getUserRecords().get(bob.publicKey)
    const bobRecordHasUnknownDevice =
      !!bobRecord &&
      Array.from(bobRecord.devices.values()).some(
        (device) => device.deviceId === unknownBobDevicePubkey
      )
    expect(bobRecordHasUnknownDevice).toBe(false)

    const fallbackRecord = alice.manager.getUserRecords().get(unknownBobDevicePubkey)
    expect(fallbackRecord).toBeDefined()
    expect(Array.from(fallbackRecord!.devices.keys())).toContain(unknownBobDevicePubkey)
  })

it("ignores a replayed invite once the initial accept bootstrap has used the session", async () => {
    const relay = new MockRelay()

    const alice = await createMockSessionManager("alice-device-1", relay)
    const bob = await createMockSessionManager("bob-device-1", relay)

    const invite = extractInviteForOwner(relay, alice.publicKey)

    const firstAccepted = await bob.manager.acceptInvite(invite, {
      ownerPublicKey: alice.publicKey,
    })
    const deviceRecord = bob.manager
      .getUserRecords()
      .get(alice.publicKey)
      ?.devices
      .get(firstAccepted.deviceId)
    expect(deviceRecord?.activeSession).toBe(firstAccepted.session)

    const inviteResponsesBeforeReplay = relay
      .getAllEvents()
      .filter((event) => event.kind === 1059).length

    const replayedAccepted = await bob.manager.acceptInvite(invite, {
      ownerPublicKey: alice.publicKey,
    })

    const inviteResponsesAfterReplay = relay
      .getAllEvents()
      .filter((event) => event.kind === 1059).length
    expect(inviteResponsesAfterReplay).toBe(inviteResponsesBeforeReplay)
    expect(replayedAccepted.session).toBe(firstAccepted.session)
    expect(deviceRecord?.activeSession).toBe(firstAccepted.session)
  })
});
