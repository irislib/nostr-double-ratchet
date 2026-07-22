import { describe, it } from "vitest"
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

    it("should handle 20 consecutive skipped messages", { timeout: 15000 }, async () => {
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

})
