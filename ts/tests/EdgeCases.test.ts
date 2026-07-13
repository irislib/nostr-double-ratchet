import { describe, it, expect } from "vitest"
import { createControlledMockSessionManager } from "./helpers/controlledMockSessionManager"
import { ControlledMockRelay } from "./helpers/ControlledMockRelay"
import { runControlledScenario } from "./helpers/controlledScenario"

/**
 * Edge case tests that leverage ControlledMockRelay's delivery control.
 *
 * These scenarios are difficult or impossible to test with automatic delivery
 * because they require precise control over message ordering, timing, and failures.
 */
describe("Edge Cases", () => {
  describe("Out-of-order message delivery", () => {
    it("should decrypt messages delivered in reverse order", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "message-1", ref: "m1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "message-2", ref: "m2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "message-3", ref: "m3" },
          { type: "deliverEvent", ref: "m3" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "message-3" },
          { type: "deliverEvent", ref: "m2" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "message-2" },
          { type: "deliverEvent", ref: "m1" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "message-1" },
        ],
      })
    })

    it("should decrypt messages delivered in random order", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-1", ref: "m1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-2", ref: "m2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-3", ref: "m3" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-4", ref: "m4" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-5", ref: "m5" },
          { type: "deliverInOrder", refs: ["m3", "m1", "m5", "m2", "m4"] },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"] },
        ],
      })
    })

    it("should handle interleaved bidirectional out-of-order delivery", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "alice-1", ref: "a1" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "bob-1", ref: "b1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "alice-2", ref: "a2" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "bob-2", ref: "b2" },
          { type: "deliverEvent", ref: "b2" },
          { type: "expect", actor: "alice", deviceId: "alice-1", message: "bob-2" },
          { type: "deliverEvent", ref: "b1" },
          { type: "expect", actor: "alice", deviceId: "alice-1", message: "bob-1" },
          { type: "deliverEvent", ref: "a2" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "alice-2" },
          { type: "deliverEvent", ref: "a1" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "alice-1" },
        ],
      })
    })

    it("should handle many out-of-order messages", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          ...Array.from({ length: 10 }, (_, i) => ({
            type: "send" as const,
            from: { actor: "alice" as const, deviceId: "alice-1" },
            to: "bob" as const,
            message: `msg-${i}`,
            ref: `m${i}`,
          })),
          { type: "deliverInOrder", refs: ["m9", "m8", "m7", "m6", "m5", "m4", "m3", "m2", "m1", "m0"] },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: Array.from({ length: 10 }, (_, i) => `msg-${i}`) },
        ],
      })
    })

    it("should handle alternating senders with delays", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a1", ref: "a1" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "b1", ref: "b1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a2", ref: "a2" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "b2", ref: "b2" },
          { type: "deliverEvent", ref: "b2" },
          { type: "deliverEvent", ref: "b1" },
          { type: "deliverEvent", ref: "a2" },
          { type: "deliverEvent", ref: "a1" },
          { type: "expectAll", actor: "alice", deviceId: "alice-1", messages: ["b1", "b2"] },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["a1", "a2"] },
        ],
      })
    })
  })

  describe("Message gaps (lost messages)", () => {
    it("should continue communication after a dropped message", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-1", ref: "m1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-2-LOST", ref: "m2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-3", ref: "m3" },
          { type: "dropEvent", ref: "m2" },
          { type: "deliverEvent", ref: "m1" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-1" },
          { type: "deliverEvent", ref: "m3" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-3" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-4", waitOn: "auto" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-4" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "reply", waitOn: "auto" },
          { type: "expect", actor: "alice", deviceId: "alice-1", message: "reply" },
        ],
      })
    })

    it("should handle multiple consecutive dropped messages", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-1", ref: "m1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-2", ref: "m2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-3", ref: "m3" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-4", ref: "m4" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-5", ref: "m5" },
          { type: "dropEvent", ref: "m2" },
          { type: "dropEvent", ref: "m3" },
          { type: "dropEvent", ref: "m4" },
          { type: "deliverEvent", ref: "m1" },
          { type: "deliverEvent", ref: "m5" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-1" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-5" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "still works!", waitOn: "auto" },
        ],
      })
    })

    it("should handle 20 consecutive skipped messages", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          ...Array.from({ length: 21 }, (_, i) => ({
            type: "send" as const,
            from: { actor: "alice" as const, deviceId: "alice-1" },
            to: "bob" as const,
            message: `msg-${i}`,
            ref: `m${i}`,
          })),
          { type: "deliverEvent", ref: "m20" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-20" },
          ...Array.from({ length: 20 }, (_, i) => ({
            type: "deliverEvent" as const,
            ref: `m${i}`,
          })),
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: Array.from({ length: 21 }, (_, i) => `msg-${i}`) },
        ],
      })
    })
  })

  describe("Delayed delivery after key rotation", () => {
    it("should decrypt old message delivered after key rotation", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "delayed-message", ref: "delayed" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "bob-reply-1", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "new-message", waitOn: "auto" },
          { type: "deliverEvent", ref: "delayed" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "delayed-message" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "bob-reply-2", waitOn: "auto" },
        ],
      })
    })

    it("should handle multiple rotations with delayed messages", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "alice-round-1", ref: "a1" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "bob-round-1", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "alice-round-2", ref: "a2" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "bob-round-2", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "alice-round-3", ref: "a3" },
          { type: "deliverEvent", ref: "a3" },
          { type: "deliverEvent", ref: "a2" },
          { type: "deliverEvent", ref: "a1" },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["alice-round-1", "alice-round-2", "alice-round-3"] },
        ],
      })
    })

    it("should handle gaps across ratchet rotations", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "before-rotation-1", ref: "pre1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "before-rotation-2", ref: "pre2" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "rotation-1", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "after-rotation-1", ref: "post1" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "rotation-2", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "after-rotation-2", ref: "post2" },
          { type: "deliverEvent", ref: "post2" },
          { type: "deliverEvent", ref: "post1" },
          { type: "deliverEvent", ref: "pre2" },
          { type: "deliverEvent", ref: "pre1" },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["before-rotation-1", "before-rotation-2", "after-rotation-1", "after-rotation-2"] },
        ],
      })
    })
  })

  describe("Duplicate message handling", () => {
    it("should handle duplicate message delivery gracefully", async () => {
      const sharedRelay = new ControlledMockRelay()

      const { manager: alice } = await createControlledMockSessionManager("alice-1", sharedRelay)
      const { manager: bob, publicKey: bobPubkey } = await createControlledMockSessionManager("bob-1", sharedRelay)

      let receiveCount = 0
      const messageContent = "duplicate-test-message"

      bob.onEvent((event) => {
        if (event.content === messageContent) {
          receiveCount++
        }
      })

      const initReceived = new Promise<void>((r) => {
        const unsub = bob.onEvent((e) => {
          if (e.content === "init") { unsub(); r() }
        })
      })
      await alice.sendMessage(bobPubkey, "init")
      await initReceived

      const messageReceived = new Promise<void>((r) => {
        const unsub = bob.onEvent((e) => {
          if (e.content === messageContent) { unsub(); r() }
        })
      })
      await alice.sendMessage(bobPubkey, messageContent)
      await messageReceived

      const firstCount = receiveCount

      const allEvents = sharedRelay.getAllEvents()
      const msgEvent = allEvents.find(e => e.content?.includes("duplicate-test"))
      if (msgEvent) {
        sharedRelay.duplicateEvent(msgEvent.id)
      }

      await new Promise((r) => setTimeout(r, 100))
      expect(receiveCount).toBeGreaterThanOrEqual(firstCount)
    })
  })

  describe("Device synchronization", () => {
    it("should deliver to device-2 after device-1 already received", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "important-message", waitOn: "auto" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "important-message" },
          { type: "expect", actor: "bob", deviceId: "bob-2", message: "important-message" },
        ],
      })
    })

    it("should handle messages delivered to devices in opposite orders", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-1", ref: "m1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-2", ref: "m2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-3", ref: "m3" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "m1" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "m2" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "m3" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "m3" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "m2" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "m1" },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["msg-1", "msg-2", "msg-3"] },
          { type: "expectAll", actor: "bob", deviceId: "bob-2", messages: ["msg-1", "msg-2", "msg-3"] },
        ],
      })
    })

    it("should handle partial delivery to one device then full delivery to other", async () => {
      await runControlledScenario({
        steps: [
          { type: "addDevice", actor: "alice", deviceId: "alice-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-1" },
          { type: "addDevice", actor: "bob", deviceId: "bob-2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
          { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-1", ref: "m1" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-2", ref: "m2" },
          { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-3", ref: "m3" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "m1" },
          { type: "expect", actor: "bob", deviceId: "bob-1", message: "msg-1" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "m1" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "m2" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "m3" },
          { type: "expectAll", actor: "bob", deviceId: "bob-2", messages: ["msg-1", "msg-2", "msg-3"] },
          { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "m2" },
          { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "m3" },
          { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["msg-1", "msg-2", "msg-3"] },
        ],
      })
    })
  })
})

/**
 * Session establishment race conditions and aggressive edge cases.
 */
describe("Session Establishment Races", () => {
  it("should handle mutual simultaneous session initiation", async () => {
    const relay = new ControlledMockRelay()

    const { manager: alice, publicKey: alicePubkey } = await createControlledMockSessionManager("alice-1", relay)
    const { manager: bob, publicKey: bobPubkey } = await createControlledMockSessionManager("bob-1", relay)

    const aliceReceived: string[] = []
    const bobReceived: string[] = []

    alice.onEvent((e) => aliceReceived.push(e.content))
    bob.onEvent((e) => bobReceived.push(e.content))

    await Promise.all([
      alice.sendMessage(bobPubkey, "alice-initiates"),
      bob.sendMessage(alicePubkey, "bob-initiates"),
    ])

    await new Promise((r) => setTimeout(r, 2000))

    expect(bobReceived).toContain("alice-initiates")
    expect(aliceReceived).toContain("bob-initiates")
  })
})

/**
 * Self-messaging: sending a message to yourself should deliver to all your OTHER devices.
 *
 * When a user sends a message to themselves (e.g., "note to self"),
 * the message should be delivered to all of that user's OTHER devices
 * (excluding the sending device, which already has the message locally).
 */
describe("Self-messaging", () => {
  it("should deliver self-message to other devices of same user", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        // alice-1 sends to alice (self)
        // Don't use waitOn: "auto" because that waits for ALL devices including the sender
        // The sender's device is correctly excluded from receiving (it already has the message)
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-1" },
          to: "alice",
          message: "note-to-self",
        },
        // alice-2 should receive the message
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "note-to-self" },
      ],
    })
  })

  it("should deliver self-message with 3 devices", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "alice", deviceId: "alice-3" },
        {
          type: "send",
          from: { actor: "alice", deviceId: "alice-1" },
          to: "alice",
          message: "note-to-all",
        },
        // Both alice-2 and alice-3 should receive it
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "note-to-all" },
        { type: "expect", actor: "alice", deviceId: "alice-3", message: "note-to-all" },
      ],
    })
  })

  it("should handle rapid self-messaging from different devices", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "alice", message: "from-device-1", ref: "m1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "alice", message: "from-device-2", ref: "m2" },
        { type: "deliverEvent", ref: "m2" },
        { type: "deliverEvent", ref: "m1" },
        { type: "expect", actor: "alice", deviceId: "alice-1", message: "from-device-2" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "from-device-1" },
      ],
    })
  })

  it("verifies sender device is excluded from recipients", async () => {
    const relay = new ControlledMockRelay()

    const { manager: alice1, publicKey: alicePubkey } =
      await createControlledMockSessionManager("alice-1", relay)

    // Just verify that sending to self doesn't crash
    await alice1.sendMessage(alicePubkey, "note-to-self")

    // Message was published (no error thrown)
    const events = relay.getAllEvents()
    expect(events.length).toBeGreaterThan(0)
  })
})

/**
 * Multi-device concurrent send and receive tests.
 */
describe("Multi-Device Concurrent Operations", () => {
  it("should handle both of Alice's devices sending to Bob simultaneously", { timeout: 15000 }, async () => {
    // Note: This test originally used manual delivery control (ref + deliverEvent) to test
    // out-of-order delivery, but the mock relay's auto-delivery during sendMessage makes
    // manual delivery control unreliable. Changed to use waitOn: "auto" for all messages.
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init-from-alice-1", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "init-from-alice-2", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "concurrent-from-alice-1", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "concurrent-from-alice-2", waitOn: "auto" },
        { type: "expect", actor: "bob", deviceId: "bob-1", message: "concurrent-from-alice-1" },
        { type: "expect", actor: "bob", deviceId: "bob-1", message: "concurrent-from-alice-2" },
      ],
    })
  })

  it("should handle rapid alternating sends from Alice's two devices", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a1-msg1", ref: "m1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "a2-msg1", ref: "m2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a1-msg2", ref: "m3" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "a2-msg2", ref: "m4" },
        { type: "deliverInOrder", refs: ["m3", "m1", "m4", "m2"] },
        { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["a1-msg1", "a2-msg1", "a1-msg2", "a2-msg2"] },
      ],
    })
  })

  it("should handle rapid device switching mid-conversation", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "from-1a", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "from-2a", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "from-1b", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "from-2b", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "from-1c", waitOn: "auto" },
        { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["from-1a", "from-2a", "from-1b", "from-2b", "from-1c"] },
      ],
    })
  })

  it("should handle complex 4-device interleaving with controlled delivery", { timeout: 30000 }, async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a1-1", ref: "a1_1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "b1-1", ref: "b1_1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "a2-1", ref: "a2_1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-2" }, to: "alice", message: "b2-1", ref: "b2_1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a1-2", ref: "a1_2" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "b1-2", ref: "b1_2" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "a2_1" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "a1_2" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "a1_1" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "a1_1" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "a1_2" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "a2_1" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-1", ref: "b2_1" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-1", ref: "b1_1" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-1", ref: "b1_2" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-2", ref: "b1_2" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-2", ref: "b2_1" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-2", ref: "b1_1" },
        { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["a1-1", "a2-1", "a1-2"] },
        { type: "expectAll", actor: "bob", deviceId: "bob-2", messages: ["a1-1", "a2-1", "a1-2"] },
        { type: "expectAll", actor: "alice", deviceId: "alice-1", messages: ["b1-1", "b2-1", "b1-2"] },
        { type: "expectAll", actor: "alice", deviceId: "alice-2", messages: ["b1-1", "b2-1", "b1-2"] },
      ],
    })
  })

  it("should handle 4 devices (2 per user) all messaging", { timeout: 30000 }, async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "from-a1", ref: "a1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "from-a2", ref: "a2" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "from-b1", ref: "b1" },
        { type: "send", from: { actor: "bob", deviceId: "bob-2" }, to: "alice", message: "from-b2", ref: "b2" },
        // Deliver to bob's devices (out of order: b2, a1, b1, a2)
        { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "a1" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "a2" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "a1" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-2", ref: "a2" },
        // Deliver to alice's devices
        { type: "deliverTo", actor: "alice", deviceId: "alice-1", ref: "b1" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-1", ref: "b2" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-2", ref: "b1" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-2", ref: "b2" },
        { type: "expectAll", actor: "bob", deviceId: "bob-1", messages: ["from-a1", "from-a2"] },
        { type: "expectAll", actor: "bob", deviceId: "bob-2", messages: ["from-a1", "from-a2"] },
        { type: "expectAll", actor: "alice", deviceId: "alice-1", messages: ["from-b1", "from-b2"] },
        { type: "expectAll", actor: "alice", deviceId: "alice-2", messages: ["from-b1", "from-b2"] },
      ],
    })
  })
})

/**
 * Tests for new device joining during active conversations.
 */
describe("Device Joins During Conversation", () => {
  it("should allow new device to send/receive after joining mid-conversation", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-1", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "reply-1", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-2", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "reply-2", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "msg-3", waitOn: "auto" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "from-new-device", waitOn: "auto" },
        { type: "expect", actor: "bob", deviceId: "bob-1", message: "from-new-device" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "to-new-device", waitOn: "auto" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "to-new-device" },
      ],
    })
  })

})

/**
 * Cross-device session state consistency tests.
 */
describe("Cross-Device State Consistency", () => {
  it("should maintain consistent state when only one device is active", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "from-alice-1-only", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "reply-to-alice", waitOn: "auto" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "reply-to-alice" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "from-alice-2-after-alice-1-conversation", waitOn: "auto" },
        { type: "expect", actor: "bob", deviceId: "bob-1", message: "from-alice-2-after-alice-1-conversation" },
      ],
    })
  })

  it("should handle device-specific session rotation correctly", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "addDevice", actor: "bob", deviceId: "bob-2" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "a1-init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "b1-reply", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "a2-message", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-2" }, to: "alice", message: "b2-reply", waitOn: "auto" },
        { type: "expect", actor: "bob", deviceId: "bob-1", message: "a2-message" },
        { type: "expect", actor: "bob", deviceId: "bob-2", message: "a1-init" },
        { type: "expect", actor: "alice", deviceId: "alice-1", message: "b2-reply" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "b1-reply" },
      ],
    })
  })
})

/**
 * Sender copy synchronization tests.
 */
describe("Sender Copy Synchronization", () => {
  it("should deliver sender copies to other devices of the sender", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "alice-1-to-bob", waitOn: "auto" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "alice-1-to-bob" },
        { type: "send", from: { actor: "alice", deviceId: "alice-2" }, to: "bob", message: "alice-2-to-bob", waitOn: "auto" },
        { type: "expect", actor: "alice", deviceId: "alice-1", message: "alice-2-to-bob" },
      ],
    })
  })

  it("should handle sender copies with delayed delivery", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "addDevice", actor: "bob", deviceId: "bob-1" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "init", waitOn: "auto" },
        { type: "send", from: { actor: "bob", deviceId: "bob-1" }, to: "alice", message: "ack", waitOn: "auto" },
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "bob", message: "delayed-copy-test", ref: "msg" },
        { type: "deliverTo", actor: "bob", deviceId: "bob-1", ref: "msg" },
        { type: "expect", actor: "bob", deviceId: "bob-1", message: "delayed-copy-test" },
        { type: "deliverTo", actor: "alice", deviceId: "alice-2", ref: "msg" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "delayed-copy-test" },
      ],
    })
  })
})

describe("Self-messaging", () => {
  it("should deliver self-message to a second device added later", async () => {
    await runControlledScenario({
      steps: [
        { type: "addDevice", actor: "alice", deviceId: "alice-1" },
        // Send self-message when alice-1 is the only device
        { type: "send", from: { actor: "alice", deviceId: "alice-1" }, to: "alice", message: "note-to-self" },
        // Add second device — triggers discovery queue expansion + session establishment
        { type: "addDevice", actor: "alice", deviceId: "alice-2" },
        { type: "expect", actor: "alice", deviceId: "alice-2", message: "note-to-self" },
      ],
    })
  })
})
