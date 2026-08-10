import { describe, it, expect } from "vitest"
import { generateSecretKey, getPublicKey, finalizeEvent, VerifiedEvent } from "nostr-tools"
import { MockRelay } from "./helpers/mockRelay"
import { createMockSessionManager } from "./helpers/mockSessionManager"
import { encryptInviteResponse } from "../src/inviteUtils"
import { AppKeys, isAppKeysEvent } from "../src/AppKeys"

const settleInviteResponse = () =>
  new Promise((resolve) => setTimeout(resolve, 100))

/**
 * Extract invite params (ephemeral key, shared secret, device identity) from relay
 * events for a given owner pubkey.
 */
function extractInviteParams(relay: MockRelay, ownerPubkey: string) {
  const events = relay.getAllEvents()

  // Find the AppKeys event for this owner → get device identity pubkeys
  const appKeysEvent = events.find(
    (e) =>
      e.pubkey === ownerPubkey && isAppKeysEvent(e as VerifiedEvent),
  )
  if (!appKeysEvent) throw new Error("No AppKeys event found")

  const appKeys = AppKeys.fromEvent(appKeysEvent as VerifiedEvent)
  const devices = appKeys.getAllDevices()
  if (devices.length === 0) throw new Error("No devices in AppKeys")

  const deviceIdentityPubkey = devices[0].identityPubkey

  // Find the Invite event published by this device
  const inviteEvent = events.find(
    (e) =>
      e.kind === 30078 &&
      e.pubkey === deviceIdentityPubkey &&
      e.tags.some((t) => t[0] === "l" && t[1] === "double-ratchet/invites"),
  )
  if (!inviteEvent) throw new Error("No Invite event found")

  const ephemeralPublicKey = inviteEvent.tags.find((t) => t[0] === "ephemeralKey")?.[1]
  const sharedSecret = inviteEvent.tags.find((t) => t[0] === "sharedSecret")?.[1]

  if (!ephemeralPublicKey || !sharedSecret) throw new Error("Missing invite params")

  return { ephemeralPublicKey, sharedSecret, deviceIdentityPubkey }
}

/**
 * Craft a complete signed invite response event that can be injected into a relay.
 */
async function craftInviteResponse(params: {
  responderPrivateKey: Uint8Array
  responderPublicKey: string
  inviterEphemeralPublicKey: string
  inviterIdentityPubkey: string
  sharedSecret: string
  claimedOwnerPublicKey: string
}): Promise<VerifiedEvent> {
  const sessionKey = generateSecretKey()
  const sessionPublicKey = getPublicKey(sessionKey)

  const result = await encryptInviteResponse({
    inviteeSessionPublicKey: sessionPublicKey,
    inviteeSessionPrivateKey: sessionKey,
    inviteePublicKey: params.responderPublicKey,
    inviteePrivateKey: params.responderPrivateKey,
    inviterPublicKey: params.inviterIdentityPubkey,
    inviterEphemeralPublicKey: params.inviterEphemeralPublicKey,
    sharedSecret: params.sharedSecret,
    ownerPublicKey: params.claimedOwnerPublicKey,
  })

  const signed = finalizeEvent(result.envelope, result.randomSenderPrivateKey)
  return signed as unknown as VerifiedEvent
}

describe("Hostile invite acceptance", () => {
  it("rejects fraudulent owner claim when AppKeys exist", async () => {
    const relay = new MockRelay()

    // Bob (inviter) and Alice (legitimate user with AppKeys on relay)
    const bob = await createMockSessionManager("bob-device", relay)
    const alice = await createMockSessionManager("alice-device", relay)

    // Eve: random attacker keypair (not in anyone's AppKeys)
    const evePrivateKey = generateSecretKey()
    const evePublicKey = getPublicKey(evePrivateKey)

    const bobInvite = extractInviteParams(relay, bob.publicKey)

    // Eve crafts invite response claiming ownerPublicKey = alice
    const fraudulentEvent = await craftInviteResponse({
      responderPrivateKey: evePrivateKey,
      responderPublicKey: evePublicKey,
      inviterEphemeralPublicKey: bobInvite.ephemeralPublicKey,
      inviterIdentityPubkey: bobInvite.deviceIdentityPubkey,
      sharedSecret: bobInvite.sharedSecret,
      claimedOwnerPublicKey: alice.publicKey,
    })

    relay.storeAndDeliver(fraudulentEvent)

    await settleInviteResponse()

    // Eve's device should NOT appear under Alice's user record
    const records = bob.manager.getUserRecords()
    const aliceRecord = records.get(alice.publicKey)
    const aliceDevices = aliceRecord ? Array.from(aliceRecord.devices.values()) : []
    expect(aliceDevices.some((d) => d.deviceId === evePublicKey)).toBe(false)

    bob.manager.close()
    alice.manager.close()
  }, 10000)

  it("rejects when no AppKeys exist and not single-device", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device", relay)

    const evePrivateKey = generateSecretKey()
    const evePublicKey = getPublicKey(evePrivateKey)

    // Random pubkey with no AppKeys anywhere
    const nonExistentPubkey = getPublicKey(generateSecretKey())

    const bobInvite = extractInviteParams(relay, bob.publicKey)

    // Eve claims nonExistentPubkey as owner, but Eve's identity !== nonExistentPubkey
    const fraudulentEvent = await craftInviteResponse({
      responderPrivateKey: evePrivateKey,
      responderPublicKey: evePublicKey,
      inviterEphemeralPublicKey: bobInvite.ephemeralPublicKey,
      inviterIdentityPubkey: bobInvite.deviceIdentityPubkey,
      sharedSecret: bobInvite.sharedSecret,
      claimedOwnerPublicKey: nonExistentPubkey,
    })

    relay.storeAndDeliver(fraudulentEvent)

    // The test SessionManager's AppKeys discovery window is 50 ms.
    await settleInviteResponse()

    const records = bob.manager.getUserRecords()
    const record = records.get(nonExistentPubkey)
    const hasEveDevice = record
      ? Array.from(record.devices.values()).some((d) => d.deviceId === evePublicKey)
      : false
    expect(hasEveDevice).toBe(false)

    bob.manager.close()
  }, 10000)

  it("accepts legitimate single-device user", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device", relay)

    // Carol: raw keypair, identity === owner, no AppKeys needed
    const carolPrivateKey = generateSecretKey()
    const carolPublicKey = getPublicKey(carolPrivateKey)

    const bobInvite = extractInviteParams(relay, bob.publicKey)

    // Carol's inviteeIdentity === claimedOwner → single-device bypass
    const legitimateEvent = await craftInviteResponse({
      responderPrivateKey: carolPrivateKey,
      responderPublicKey: carolPublicKey,
      inviterEphemeralPublicKey: bobInvite.ephemeralPublicKey,
      inviterIdentityPubkey: bobInvite.deviceIdentityPubkey,
      sharedSecret: bobInvite.sharedSecret,
      claimedOwnerPublicKey: carolPublicKey,
    })

    relay.storeAndDeliver(legitimateEvent)

    // After AppKeys discovery expires, the single-device check passes.
    await settleInviteResponse()

    const records = bob.manager.getUserRecords()
    const carolRecord = records.get(carolPublicKey)
    expect(carolRecord).toBeDefined()
    const carolDevices = Array.from(carolRecord!.devices.values())
    expect(carolDevices.some((d) => d.deviceId === carolPublicKey)).toBe(true)

    bob.manager.close()
  }, 10000)

  it("attributes sessions to actual owner, not impersonation target", async () => {
    const relay = new MockRelay()

    const bob = await createMockSessionManager("bob-device", relay)
    const alice = await createMockSessionManager("alice-device", relay)

    // Eve establishes a legitimate session as herself (single-device)
    const evePrivateKey = generateSecretKey()
    const evePublicKey = getPublicKey(evePrivateKey)

    const bobInvite = extractInviteParams(relay, bob.publicKey)

    const eveEvent = await craftInviteResponse({
      responderPrivateKey: evePrivateKey,
      responderPublicKey: evePublicKey,
      inviterEphemeralPublicKey: bobInvite.ephemeralPublicKey,
      inviterIdentityPubkey: bobInvite.deviceIdentityPubkey,
      sharedSecret: bobInvite.sharedSecret,
      claimedOwnerPublicKey: evePublicKey, // Eve honestly claims herself
    })

    relay.storeAndDeliver(eveEvent)

    await settleInviteResponse()

    const records = bob.manager.getUserRecords()

    // Eve's session is under her own pubkey
    const eveRecord = records.get(evePublicKey)
    expect(eveRecord).toBeDefined()
    expect(
      Array.from(eveRecord!.devices.values()).some((d) => d.deviceId === evePublicKey),
    ).toBe(true)

    // Eve's device does NOT appear under Alice's record
    const aliceRecord = records.get(alice.publicKey)
    if (aliceRecord) {
      expect(
        Array.from(aliceRecord.devices.values()).some((d) => d.deviceId === evePublicKey),
      ).toBe(false)
    }

    bob.manager.close()
    alice.manager.close()
  }, 10000)

})
