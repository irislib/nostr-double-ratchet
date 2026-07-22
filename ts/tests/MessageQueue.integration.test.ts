import { describe, it, expect } from "vitest"
import { generateSecretKey, getPublicKey, finalizeEvent, VerifiedEvent } from "nostr-tools"
import { runControlledScenario } from "./helpers/controlledScenario"
import { createMockSessionManager } from "./helpers/mockSessionManager"
import { MockRelay } from "./helpers/mockRelay"
import { AppKeys } from "../src/AppKeys"
import { InMemoryStorageAdapter, StorageAdapter } from "../src/StorageAdapter"

type StoredQueueEntry = {
  targetKey: string
  event: { id?: string }
}

class FailFirstMessageQueuePutStorage extends InMemoryStorageAdapter {
  private failed = false

  async put<T = unknown>(key: string, value: T): Promise<void> {
    if (!this.failed && key.startsWith("v1/message-queue/")) {
      this.failed = true
      throw new Error("injected message-queue put failure")
    }
    await super.put(key, value)
  }
}

const countQueueEntries = async (
  storage: StorageAdapter,
  prefix: string,
  targetKey: string,
  eventId: string
): Promise<number> => {
  const keys = await storage.list(prefix)
  let count = 0
  for (const key of keys) {
    const entry = await storage.get<StoredQueueEntry>(key)
    if (entry?.targetKey === targetKey && entry.event?.id === eventId) {
      count += 1
    }
  }
  return count
}

const waitForDiscoveryQueueEntry = async (
  storage: StorageAdapter,
  targetKey: string,
  eventId: string,
): Promise<void> =>
  expect
    .poll(
      () => countQueueEntries(storage, "v1/discovery-queue/", targetKey, eventId),
      { interval: 10, timeout: 2_000 },
    )
    .toBeGreaterThan(0)

const publishAppKeys = (
  relay: MockRelay,
  ownerSecretKey: Uint8Array,
  ownerPublicKey: string,
  devicePubkeys: string[],
  createdAt: number,
) => {
  const appKeys = new AppKeys(
    devicePubkeys.map((identityPubkey, i) => ({
      identityPubkey,
      createdAt: i + 1,
    }))
  )
  const event = appKeys.getEvent({
    ownerPrivateKey: ownerSecretKey,
    ownerPubkey: ownerPublicKey,
    createdAt,
  })
  const signed = finalizeEvent(event, ownerSecretKey)
  relay.storeAndDeliver(signed as unknown as VerifiedEvent)
}

/**
 * Tests that the persistent MessageQueue + DiscoveryQueue survive crash/restart
 * and deliver queued messages once the session is (re-)established.
 */
describe("MessageQueue crash recovery", () => {
  it("queued message delivers after sender restart", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-main" },
        { type: "addDevice", actor: "bob", deviceId: "bob-main" },

        // Establish session
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-main" },
          to: "bob",
          message: "init",
          waitOn: "auto",
        },
        {
          type: "send",
          from: { actor: "bob", deviceId: "bob-main" },
          to: "alice",
          message: "ack",
          waitOn: "auto",
        },

        // Queue a message without waiting for delivery
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-main" },
          to: "bob",
          message: "before-crash",
        },

        // Crash & restart alice
        { type: "close", actor: "alice", deviceId: "alice-main" },
        { type: "restart", actor: "alice", deviceId: "alice-main" },

        // Let everything flush
        { type: "deliverAll" },

        // Bob should get the message that was queued before the crash
        { type: "expect", actor: "bob", deviceId: "bob-main", message: "before-crash" },
      ],
    })
  })

  it("queued message delivers after recipient restart", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-main" },
        { type: "addDevice", actor: "bob", deviceId: "bob-main" },

        // Establish session
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-main" },
          to: "bob",
          message: "init",
          waitOn: "auto",
        },
        {
          type: "send",
          from: { actor: "bob", deviceId: "bob-main" },
          to: "alice",
          message: "ack",
          waitOn: "auto",
        },

        // Close bob (simulate crash)
        { type: "close", actor: "bob", deviceId: "bob-main" },

        // Alice sends while bob is offline
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-main" },
          to: "bob",
          message: "while-bob-offline",
        },

        // Bob comes back
        { type: "restart", actor: "bob", deviceId: "bob-main" },

        // Flush
        { type: "deliverAll" },

        // Bob should receive the message
        { type: "expect", actor: "bob", deviceId: "bob-main", message: "while-bob-offline" },
      ],
    })
  })

  it("message queued before any session survives sender restart", async () => {
    await runControlledScenario({
      steps: [
        // Only add alice — bob doesn't exist yet so discovery can't find anything
        { type: "addDevice", actor: "alice", deviceId: "alice-main" },

        // Send when bob has no device — message goes to discoveryQueue with no
        // possibility of session establishment (bob's AppKeys aren't on the relay)
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-main" },
          to: "bob",
          message: "no-session-yet",
        },

        // Crash & restart alice (queue must survive via storage)
        { type: "close", actor: "alice", deviceId: "alice-main" },
        { type: "restart", actor: "alice", deviceId: "alice-main" },

        // NOW bob comes online — his AppKeys + Invite appear on the relay
        { type: "addDevice", actor: "bob", deviceId: "bob-main" },

        // Flush everything — alice discovers bob, establishes session, drains queue
        { type: "deliverAll" },

        // Bob should receive the pre-session message
        { type: "expect", actor: "bob", deviceId: "bob-main", message: "no-session-yet" },
      ],
    })
  })

  it("keeps discovery entries when expansion to message queue partially fails", async () => {
    const relay = new MockRelay()
    const aliceStorage = new FailFirstMessageQueuePutStorage()
    const alice = await createMockSessionManager("alice-main", relay, undefined, aliceStorage)

    const bobSecret = generateSecretKey()
    const bobPubkey = getPublicKey(bobSecret)
    publishAppKeys(relay, bobSecret, bobPubkey, [], 1)
    const message = "retry-after-partial-expansion-failure"
    const rumor = await alice.manager.sendMessage(bobPubkey, message)
    const rumorId = rumor.id

    await waitForDiscoveryQueueEntry(aliceStorage, bobPubkey, rumorId)

    const bob = await createMockSessionManager("bob-main", relay, bobSecret)
    const bobReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for retried delivery")),
        5000
      )
      bob.manager.onEvent((event) => {
        if (event.content === message) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    // First expansion attempt consumes the injected storage failure.
    await new Promise((r) => setTimeout(r, 250))
    expect(
      await countQueueEntries(aliceStorage, "v1/discovery-queue/", bobPubkey, rumorId)
    ).toBeGreaterThan(0)

    // Trigger a second AppKeys cycle to retry expansion and flush.
    await bob.appKeysManager.publish()
    await bobReceived
  })

  it("revocation replacement purges queued entries for removed devices", async () => {
    const relay = new MockRelay()
    const storage = new InMemoryStorageAdapter()
    const alice = await createMockSessionManager("alice-main", relay, undefined, storage)

    const bobOwnerSecret = generateSecretKey()
    const bobOwnerPubkey = getPublicKey(bobOwnerSecret)
    const bobDevice1 = getPublicKey(generateSecretKey())
    const bobDevice2 = getPublicKey(generateSecretKey())
    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [], 1)

    const rumor = await alice.manager.sendMessage(
      bobOwnerPubkey,
      "queued-pre-revoke-known-appkeys"
    )
    const rumorId = rumor.id

    await waitForDiscoveryQueueEntry(storage, bobOwnerPubkey, rumorId)

    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [bobDevice1, bobDevice2], 2)
    await new Promise((r) => setTimeout(r, 120))

    expect(
      await countQueueEntries(storage, "v1/message-queue/", bobDevice1, rumorId)
    ).toBeGreaterThan(0)
    expect(
      await countQueueEntries(storage, "v1/message-queue/", bobDevice2, rumorId)
    ).toBeGreaterThan(0)

    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [bobDevice1], 3)
    await new Promise((r) => setTimeout(r, 120))

    expect(await countQueueEntries(storage, "v1/message-queue/", bobDevice2, rumorId)).toBe(0)
    expect(
      await countQueueEntries(storage, "v1/message-queue/", bobDevice1, rumorId)
    ).toBeGreaterThan(0)
  })

  it("transient expansion failure then revocation keeps retry path only for authorized devices", async () => {
    const relay = new MockRelay()
    const aliceStorage = new FailFirstMessageQueuePutStorage()
    const alice = await createMockSessionManager("alice-main", relay, undefined, aliceStorage)

    const bobOwnerSecret = generateSecretKey()
    const bobOwnerPubkey = getPublicKey(bobOwnerSecret)
    const bobDevice1 = getPublicKey(generateSecretKey())
    const bobDevice2 = getPublicKey(generateSecretKey())
    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [], 1)

    const rumor = await alice.manager.sendMessage(
      bobOwnerPubkey,
      "queued-before-revocation-during-retry"
    )
    const rumorId = rumor.id

    await waitForDiscoveryQueueEntry(aliceStorage, bobOwnerPubkey, rumorId)

    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [bobDevice1, bobDevice2], 2)
    await new Promise((r) => setTimeout(r, 120))

    expect(
      await countQueueEntries(aliceStorage, "v1/discovery-queue/", bobOwnerPubkey, rumorId)
    ).toBeGreaterThan(0)

    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [bobDevice1], 3)
    await new Promise((r) => setTimeout(r, 120))
    publishAppKeys(relay, bobOwnerSecret, bobOwnerPubkey, [bobDevice1], 4)
    await new Promise((r) => setTimeout(r, 120))

    expect(await countQueueEntries(aliceStorage, "v1/message-queue/", bobDevice2, rumorId)).toBe(0)
    expect(
      await countQueueEntries(aliceStorage, "v1/message-queue/", bobDevice1, rumorId)
    ).toBeGreaterThan(0)
  })
})
