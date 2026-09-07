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

import { tick, createSubscribe, createRuntime } from "./helpers/runtime"

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
