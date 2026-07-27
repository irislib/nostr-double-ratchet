import { describe, expect, it, vi } from "vitest"
import {
  finalizeEvent,
  type Filter,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  type UnsignedEvent,
  type VerifiedEvent,
} from "nostr-tools"
import { AppKeys } from "../src/AppKeys"
import { NdrRuntime } from "../src/NdrRuntime"
import { InMemoryStorageAdapter, type StorageAdapter } from "../src/StorageAdapter"
import {
  CHAT_MESSAGE_KIND,
  INVITE_RESPONSE_KIND,
  type NostrPublish,
  type NostrSubscribe,
  type Rumor,
} from "../src/types"
import { MockRelay } from "./helpers/mockRelay"

const tick = async (ms = 0) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const createSubscribe = (relay: MockRelay): NostrSubscribe => {
  return (filter, onEvent) => relay.subscribe(filter, onEvent).close
}

const createRuntime = (options: {
  relay: MockRelay
  ownerPrivateKey?: Uint8Array
  storage?: StorageAdapter
  appKeysDelayMs?: number
  publishDelayMs?: number
  onPublish?: (
    event: UnsignedEvent | VerifiedEvent,
    innerEventId?: string,
  ) => void
}) => {
  const {
    relay,
    ownerPrivateKey,
    storage,
    appKeysDelayMs = 0,
    publishDelayMs = 0,
    onPublish,
  } = options
  const deliver = (event: VerifiedEvent, delayMs: number) => {
    if (delayMs > 0) {
      setTimeout(() => {
        relay.storeAndDeliver(event)
      }, delayMs)
      return
    }
    relay.storeAndDeliver(event)
  }
  const publish = (async (
    event: UnsignedEvent | VerifiedEvent,
    innerEventId?: string,
  ) => {
    onPublish?.(event, innerEventId)
    if ("sig" in event && event.sig) {
      deliver(event as VerifiedEvent, publishDelayMs)
      return event as VerifiedEvent
    }

    if (!ownerPrivateKey) {
      throw new Error("Cannot sign unsigned event without owner private key")
    }

    const signedEvent = finalizeEvent(event, ownerPrivateKey) as VerifiedEvent
    deliver(signedEvent, Math.max(appKeysDelayMs, publishDelayMs))
    return signedEvent
  }) as NostrPublish

  return new NdrRuntime({
    nostrSubscribe: createSubscribe(relay),
    nostrPublish: publish,
    storage,
    appKeysFastTimeoutMs: 25,
    appKeysFetchTimeoutMs: 50,
  })
}

describe("NdrRuntime", () => {



it("exposes direct-message helper wrappers on the runtime surface", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const runtime = createRuntime({
      relay,
      ownerPrivateKey,
    })
    await runtime.initForOwner(ownerPubkey)

    const manager = await runtime.waitForSessionManager(ownerPubkey)
    const sendEventRumor = {
      id: "reaction-id",
      pubkey: ownerPubkey,
      kind: 7,
      content: "🔥",
      created_at: 1,
      tags: [["e", "message-id"]],
    }
    const sendMessageRumor = {
      id: "message-id",
      pubkey: ownerPubkey,
      kind: 14,
      content: "hello runtime",
      created_at: 1,
      tags: [["p", "peer"]],
    }
    const sendTypingRumor = {
      id: "typing-id",
      pubkey: ownerPubkey,
      kind: 25,
      content: "typing",
      created_at: 1,
      tags: [["p", "peer"]],
    }
    const sendReceiptRumor = {
      id: "receipt-id",
      pubkey: ownerPubkey,
      kind: 15,
      content: "seen",
      created_at: 1,
      tags: [["e", "message-id"]],
    }

    const setupUserSpy = vi.spyOn(manager, "setupUser").mockResolvedValue()
    const sendEventSpy = vi
      .spyOn(manager, "sendEvent")
      .mockResolvedValue(sendEventRumor)
    const sendMessageSpy = vi
      .spyOn(manager, "sendMessage")
      .mockResolvedValue(sendMessageRumor)
    const sendTypingSpy = vi
      .spyOn(manager, "sendTyping")
      .mockResolvedValue(sendTypingRumor)
    const sendReceiptSpy = vi
      .spyOn(manager, "sendReceipt")
      .mockResolvedValue(sendReceiptRumor)

    await runtime.setupUser("peer")
    expect(setupUserSpy).toHaveBeenCalledWith("peer")

    await expect(runtime.sendEvent("peer", sendEventRumor)).resolves.toBe(
      sendEventRumor,
    )
    expect(sendEventSpy).toHaveBeenCalledWith("peer", sendEventRumor)

    await expect(runtime.sendMessage("peer", "hello runtime")).resolves.toBe(
      sendMessageRumor,
    )
    expect(sendMessageSpy).toHaveBeenCalledWith("peer", "hello runtime", {})

    await expect(runtime.sendTyping("peer")).resolves.toBe(sendTypingRumor)
    expect(sendTypingSpy).toHaveBeenCalledWith("peer")

    await expect(
      runtime.sendReceipt("peer", "seen", ["message-id"]),
    ).resolves.toBe(sendReceiptRumor)
    expect(sendReceiptSpy).toHaveBeenCalledWith("peer", "seen", ["message-id"])

    const runtimeInternals = runtime as unknown as {
      flushSessionManagerEvents(): Promise<void>
      syncDirectMessageSubscription(): void
    }
    const flushSpy = vi.spyOn(runtimeInternals, "flushSessionManagerEvents")
    const syncSpy = vi.spyOn(runtimeInternals, "syncDirectMessageSubscription")
    const sendError = new Error("send failed")
    sendMessageSpy.mockRejectedValueOnce(sendError)

    await expect(runtime.sendMessage("peer", "failed send")).rejects.toBe(sendError)
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledTimes(1)
  })
});
