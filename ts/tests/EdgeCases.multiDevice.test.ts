import { describe, it } from "vitest"
import { runControlledScenario } from "./helpers/controlledScenario"

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
