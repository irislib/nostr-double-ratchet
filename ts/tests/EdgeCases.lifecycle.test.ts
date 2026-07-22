import { describe, it } from "vitest"
import { runControlledScenario } from "./helpers/controlledScenario"

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
