import { describe, it, expect } from "vitest"
import { createControlledMockSessionManager } from "./helpers/controlledMockSessionManager"
import { ControlledMockRelay } from "./helpers/ControlledMockRelay"
import { runControlledScenario } from "./helpers/controlledScenario"
import { MESSAGE_EVENT_KIND } from "../src/types"

describe("Edge Cases", () => {
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

      const initialized = new Promise<void>((r) => {
        const unsub = bob.onEvent((e) => {
          if (e.content === "init") { unsub(); r() }
        })
      })

      await alice.sendMessage(bobPubkey, "init")
      await initialized

      const existingEventIds = new Set(
        sharedRelay.getAllEvents().map((event) => event.id),
      )
      const received = new Promise<void>((r) => {
        const unsub = bob.onEvent((e) => {
          if (e.content === messageContent) { unsub(); r() }
        })
      })

      await alice.sendMessage(bobPubkey, messageContent)
      await received

      const firstCount = receiveCount
      const messageEvent = sharedRelay.getAllEvents().find(
        (event) =>
          event.kind === MESSAGE_EVENT_KIND && !existingEventIds.has(event.id),
      )
      expect(firstCount).toBe(1)
      expect(messageEvent).toBeDefined()

      const deliveriesBeforeDuplicate = sharedRelay.getDeliveryCount(messageEvent!.id)
      sharedRelay.duplicateEvent(messageEvent!.id)
      expect(sharedRelay.getDeliveryCount(messageEvent!.id)).toBeGreaterThan(
        deliveriesBeforeDuplicate,
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(receiveCount).toBe(firstCount)
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
