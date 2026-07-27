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


it("ignores a replayed invite after the send-only session has been used", async () => {
    const relay = new MockRelay()

    const alice = await createMockSessionManager("alice-device-1", relay)
    const bob = await createMockSessionManager("bob-device-1", relay)

    const invite = extractInviteForOwner(relay, alice.publicKey)

    const firstAccepted = await bob.manager.acceptInvite(invite, {
      ownerPublicKey: alice.publicKey,
    })

    const text = `replayed-invite-ignore-${Date.now()}`
    const aliceReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for Alice to receive used-session message")),
        10_000,
      )
      const unsubscribe = alice.manager.onEvent((event) => {
        if (event.content !== text) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await bob.manager.sendMessage(alice.publicKey, text)
    await aliceReceived

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
  })

it("reuses a same-device response-only import instead of forking on a mutual chat invite", async () => {
    const relay = new MockRelay()

    const aliceSecretKey = generateSecretKey()
    const alicePublicKey = getPublicKey(aliceSecretKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const aliceInviteKeys = {
      ephemeralKeypair: generateEphemeralKeypair(),
      sharedSecret: generateSharedSecret(),
    }
    const bobInviteKeys = {
      ephemeralKeypair: generateEphemeralKeypair(),
      sharedSecret: generateSharedSecret(),
    }

    const alice = new SessionManager(
      alicePublicKey,
      aliceSecretKey,
      alicePublicKey,
      createRelaySubscribe(relay),
      createRelayPublish(relay, aliceSecretKey),
      alicePublicKey,
      aliceInviteKeys,
      new InMemoryStorageAdapter()
    )
    await alice.init()

    let shouldDropBootstrapUntilReverseAccept = true
    const bobPublish = vi.fn(async (event: UnsignedEvent | VerifiedEvent) => {
      const signedEvent =
        "sig" in event && event.sig
          ? (event as VerifiedEvent)
          : (finalizeEvent(event as UnsignedEvent, bobSecretKey) as VerifiedEvent)
      if (signedEvent.kind === 1060 && shouldDropBootstrapUntilReverseAccept) {
      } else {
        relay.storeAndDeliver(signedEvent)
      }
      return signedEvent as never
    })

    const bob = new SessionManager(
      bobPublicKey,
      bobSecretKey,
      bobPublicKey,
      createRelaySubscribe(relay),
      bobPublish,
      bobPublicKey,
      bobInviteKeys,
      new InMemoryStorageAdapter()
    )
    await bob.init()

    const aliceInvite = new Invite(
      aliceInviteKeys.ephemeralKeypair.publicKey,
      aliceInviteKeys.sharedSecret,
      alicePublicKey,
      aliceInviteKeys.ephemeralKeypair.privateKey,
      alicePublicKey,
      1
    )
    const bobInvite = new Invite(
      bobInviteKeys.ephemeralKeypair.publicKey,
      bobInviteKeys.sharedSecret,
      bobPublicKey,
      bobInviteKeys.ephemeralKeypair.privateKey,
      bobPublicKey,
      1
    )
    const bobDeviceId = bobInvite.deviceId || bobInvite.inviter

    await bob.acceptInvite(aliceInvite, {
      ownerPublicKey: alicePublicKey,
    })

    await vi.waitFor(() => {
      const bobRecord = alice.getUserRecords().get(bobPublicKey)
      const importedDeviceRecord = bobRecord?.devices.get(bobDeviceId)
      expect(importedDeviceRecord).toBeDefined()
      expect(importedDeviceRecord?.activeSession).toBeFalsy()
      expect((importedDeviceRecord?.inactiveSessions.length ?? 0) > 0).toBe(true)
    }, { timeout: 5_000 })

    const importedDeviceRecord = alice
      .getUserRecords()
      .get(bobPublicKey)
      ?.devices
      .get(bobDeviceId)
    const importedSession = importedDeviceRecord?.inactiveSessions[0]
    expect(importedSession).toBeDefined()

    const inviteResponsesBeforeReverseAccept = relay
      .getAllEvents()
      .filter((event) => event.kind === 1059).length

    const reverseAccepted = await alice.acceptInvite(bobInvite, {
      ownerPublicKey: bobPublicKey,
    })

    const inviteResponsesAfterReverseAccept = relay
      .getAllEvents()
      .filter((event) => event.kind === 1059).length
    expect(inviteResponsesAfterReverseAccept).toBe(inviteResponsesBeforeReverseAccept)
    expect(reverseAccepted.session).toBe(importedSession)

    shouldDropBootstrapUntilReverseAccept = false

    const bobToAlice = `mutual-same-device-bob-to-alice-${Date.now()}`
    const aliceReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for Alice to receive same-device mutual invite message")),
        10_000
      )
      const unsubscribe = alice.onEvent((event) => {
        if (event.content !== bobToAlice) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await bob.sendMessage(alicePublicKey, bobToAlice)
    await aliceReceived

    const aliceToBob = `mutual-same-device-alice-to-bob-${Date.now()}`
    const bobReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for Bob to receive same-device mutual invite reply")),
        10_000
      )
      const unsubscribe = bob.onEvent((event) => {
        if (event.content !== aliceToBob) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await alice.sendMessage(bobPublicKey, aliceToBob)
    await bobReceived
  }, 15_000)

it("includes our owner claim in invite responses even before this device is authorized in AppKeys", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const invite = Invite.createNew(bob.publicKey, bob.publicKey, 1)

    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const deviceSecretKey = generateSecretKey()
    const devicePublicKey = getPublicKey(deviceSecretKey)

    const alice = new SessionManager(
      devicePublicKey,
      deviceSecretKey,
      devicePublicKey,
      createRelaySubscribe(relay),
      createRelayPublish(relay, deviceSecretKey),
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter()
    )
    await alice.init()

    await alice.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    const responseEvent = relay
      .getAllEvents()
      .filter((event) => event.kind === 1059)
      .at(-1)
    expect(responseEvent).toBeDefined()

    const decrypted = await decryptInviteResponse({
      envelopeContent: responseEvent!.content,
      envelopeSenderPubkey: responseEvent!.pubkey,
      inviterEphemeralPrivateKey: invite.inviterEphemeralPrivateKey!,
      inviterPrivateKey: bob.secretKey,
      sharedSecret: invite.sharedSecret,
    })

    expect(decrypted.inviteeIdentity).toBe(devicePublicKey)
    expect(decrypted.ownerPublicKey).toBe(ownerPublicKey)
  })

it("includes our owner claim in invite responses once this device is authorized in AppKeys", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const alice = await createMockSessionManager("alice-device-1", relay)
    const invite = Invite.createNew(bob.publicKey, bob.publicKey, 1)

    await alice.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })

    const responseEvent = relay
      .getAllEvents()
      .filter((event) => event.kind === 1059)
      .at(-1)
    expect(responseEvent).toBeDefined()

    const decrypted = await decryptInviteResponse({
      envelopeContent: responseEvent!.content,
      envelopeSenderPubkey: responseEvent!.pubkey,
      inviterEphemeralPrivateKey: invite.inviterEphemeralPrivateKey!,
      inviterPrivateKey: bob.secretKey,
      sharedSecret: invite.sharedSecret,
    })

    const aliceDeviceIdentity = alice.appKeysManager.getOwnDevices()[0]?.identityPubkey
    expect(aliceDeviceIdentity).toBeTruthy()
    expect(decrypted.inviteeIdentity).toBe(aliceDeviceIdentity)
    expect(decrypted.ownerPublicKey).toBe(alice.publicKey)
  })

it("installs a deferred invite response once the sender AppKeys become available", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const aliceOwner = await createMockSessionManager("alice-device-1", relay)
    const aliceLinked = await createMockSessionManager(
      "alice-device-2",
      relay,
      aliceOwner.secretKey
    )

    const invite = extractInviteForOwner(relay, bob.publicKey)

    // Simulate a real race where the invite response arrives before the sender's AppKeys
    // are fetchable from the relay.
    relay.clearEvents()

    await aliceLinked.manager.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })
    await new Promise((resolve) => setTimeout(resolve, 2200))

    const aliceLinkedIdentity = aliceLinked.appKeysManager
      .getOwnDevices()
      .at(-1)
      ?.identityPubkey
    expect(aliceLinkedIdentity).toBeTruthy()

    const bobRecordBeforeRetry = bob.manager.getUserRecords().get(aliceOwner.publicKey)
    expect(bobRecordBeforeRetry?.devices.has(aliceLinkedIdentity!)).not.toBe(true)

    const authorChanges = vi.fn()
    const unsubscribeAuthorChanges = bob.manager.onMessagePushAuthorsChanged(authorChanges)
    const initialAuthorChangeCalls = authorChanges.mock.calls.length

    await aliceLinked.appKeysManager.publish()

    await vi.waitFor(() => {
      const bobRecordAfterRetry = bob.manager.getUserRecords().get(aliceOwner.publicKey)
      expect(bobRecordAfterRetry).toBeDefined()
      const retriedDeviceRecord = bobRecordAfterRetry?.devices.get(aliceLinkedIdentity!)
      expect(retriedDeviceRecord).toBeDefined()
      expect(
        Boolean(retriedDeviceRecord?.activeSession) ||
        (retriedDeviceRecord?.inactiveSessions.length ?? 0) > 0
      ).toBe(true)
    }, { timeout: 5_000 })

    await vi.waitFor(() => {
      expect(authorChanges.mock.calls.length).toBeGreaterThan(initialAuthorChangeCalls)
    })
    unsubscribeAuthorChanges()
  }, 15_000)

it("installs a deferred owner-claimed invite response once the claimed owner AppKeys authorize the device", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device-1", relay)
    const invite = extractInviteForOwner(relay, bob.publicKey)

    const ownerSecretKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerSecretKey)
    const deviceSecretKey = generateSecretKey()
    const devicePublicKey = getPublicKey(deviceSecretKey)

    const alice = new SessionManager(
      devicePublicKey,
      deviceSecretKey,
      devicePublicKey,
      createRelaySubscribe(relay),
      createRelayPublish(relay, deviceSecretKey),
      ownerPublicKey,
      {
        ephemeralKeypair: generateEphemeralKeypair(),
        sharedSecret: generateSharedSecret(),
      },
      new InMemoryStorageAdapter()
    )
    await alice.init()

    await alice.acceptInvite(invite, {
      ownerPublicKey: bob.publicKey,
    })
    await new Promise((resolve) => setTimeout(resolve, 2_200))

    const bobRecordBeforeRetry = bob.manager.getUserRecords().get(ownerPublicKey)
    expect(bobRecordBeforeRetry?.devices.has(devicePublicKey)).not.toBe(true)

    const aliceAppKeys = new AppKeys()
    aliceAppKeys.addDevice({
      identityPubkey: devicePublicKey,
      createdAt: Math.floor(Date.now() / 1000),
    })
    relay.storeAndDeliver(
      finalizeEvent(
        aliceAppKeys.getEvent({
          ownerPrivateKey: ownerSecretKey,
          ownerPubkey: ownerPublicKey,
        }),
        ownerSecretKey
      ) as VerifiedEvent
    )

    await vi.waitFor(() => {
      const bobRecordAfterRetry = bob.manager.getUserRecords().get(ownerPublicKey)
      expect(bobRecordAfterRetry).toBeDefined()
      const retriedDeviceRecord = bobRecordAfterRetry?.devices.get(devicePublicKey)
      expect(retriedDeviceRecord).toBeDefined()
      expect(
        Boolean(retriedDeviceRecord?.activeSession) ||
        (retriedDeviceRecord?.inactiveSessions.length ?? 0) > 0
      ).toBe(true)
    }, { timeout: 5_000 })
  }, 15_000)
});
