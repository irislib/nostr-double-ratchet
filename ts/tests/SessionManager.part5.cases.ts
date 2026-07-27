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
});
