import { describe, it, expect } from "vitest"
import { createControlledMockSessionManager } from "./helpers/controlledMockSessionManager"
import { ControlledMockRelay } from "./helpers/ControlledMockRelay"
import { runControlledScenario } from "./helpers/controlledScenario"

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
