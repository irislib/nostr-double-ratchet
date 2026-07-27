import { describe, it, expect } from "vitest"
import { runControlledScenario } from "./helpers/controlledScenario"

describe("Delegate Device Refresh Bug", () => {



describe("Basic delegate restart functionality", () => {
    /**
     * Sanity check: delegate device should work normally after restart
     * if everything is implemented correctly.
     */
    it("should allow delegate device to receive messages after restart", async () => {
      await runControlledScenario({
        steps: [
          // Setup: Alice has main + delegate, Bob has main
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
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

          // Verify delegate received the ack
          { type: "expect", actor: "alice", deviceId: "alice-delegate", message: "ack" },

          // Exchange more messages to confirm everything works
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "from-delegate-before-restart",
            waitOn: "auto",
          },
          { type: "expect", actor: "bob", deviceId: "bob-main", message: "from-delegate-before-restart" },

          // Now restart the delegate device (simulating browser refresh)
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // Bob sends a message - delegate should receive it
          {
            type: "send",
            from: { actor: "bob", deviceId: "bob-main" },
            to: "alice",
            message: "after-delegate-restart",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-delegate", message: "after-delegate-restart" },
        ],
      })
    })

    it("should allow delegate device to send messages after restart", async () => {
      await runControlledScenario({
        steps: [
          // Setup: Alice has main + delegate, Bob has main
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
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

          // Verify delegate works before restart
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-before-restart",
            waitOn: "auto",
          },
          { type: "expect", actor: "bob", deviceId: "bob-main", message: "delegate-before-restart" },

          // Restart the delegate device
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // Delegate sends after restart - this is where the bug manifests
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-after-restart",
            waitOn: "auto",
          },
          { type: "expect", actor: "bob", deviceId: "bob-main", message: "delegate-after-restart" },
        ],
      })
    })
  })

describe("Self-messaging after delegate restart (BUG SCENARIO)", () => {
    /**
     * Core bug scenario: After delegate restart, when it sends a message,
     * the main device should receive a sender copy through the existing session.
     *
     * BUG: Instead, the delegate accepts new invites for self-messaging,
     * breaking the sender copy functionality.
     */
    it("should deliver sender copies to main device when delegate sends after restart", async () => {
      await runControlledScenario({
        steps: [
          // Setup: Alice has main + delegate, Bob has main
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
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

          // Verify sender copy works BEFORE restart
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-msg-before-restart",
            waitOn: "auto",
          },
          // Main should get sender copy
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "delegate-msg-before-restart" },

          // Restart the delegate device
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // Delegate sends AFTER restart
          // BUG: This triggers re-initialization and the delegate starts accepting
          // new invites instead of using existing sessions
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-msg-after-restart",
            waitOn: "auto",
          },

          // Main device should still receive sender copy through existing session
          // BUG: This likely fails because delegate accepted new invite instead
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "delegate-msg-after-restart" },
        ],
      })
    })

    /**
     * Extended scenario: Multiple messages after restart
     * Tests if the session becomes permanently broken or just the first message.
     */
    it("should continue delivering sender copies for subsequent messages after restart", async () => {
      await runControlledScenario({
        steps: [
          // Setup
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
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

          // Restart delegate
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // Send multiple messages after restart
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "post-restart-1",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "post-restart-1" },

          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "post-restart-2",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "post-restart-2" },

          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "post-restart-3",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "post-restart-3" },
        ],
      })
    })
  })

describe("Bidirectional communication after delegate restart", () => {
    /**
     * Test that the main device can still message the delegate after restart.
     */
    it("should allow main device to reach delegate after delegate restart", async () => {
      await runControlledScenario({
        steps: [
          // Setup
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
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

          // Restart delegate
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // Main device sends - delegate should get sender copy
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-main" },
            to: "bob",
            message: "main-after-delegate-restart",
            waitOn: "auto",
          },
          // Delegate should receive the sender copy from main
          { type: "expect", actor: "alice", deviceId: "alice-delegate", message: "main-after-delegate-restart" },
        ],
      })
    })

    /**
     * Test full bidirectional communication after restart.
     * Alternating sends between main and delegate.
     */
    it("should support alternating sends between main and delegate after restart", async () => {
      await runControlledScenario({
        steps: [
          // Setup
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
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

          // Restart delegate
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // Alternating sends
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-1",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "delegate-1" },

          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-main" },
            to: "bob",
            message: "main-1",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-delegate", message: "main-1" },

          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-2",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "delegate-2" },
        ],
      })
    })
  })

describe("Multiple delegate devices with restart", () => {
    /**
     * Test scenario with two delegate devices where one restarts.
     * BUG: After restart, the second delegate may not receive messages
     * from the restarted delegate.
     */
    // TODO: This test exposes a bug where sender copies to sibling delegates don't work
    // after a device restart. When delegate-1 restarts and sends a message to Bob,
    // delegate-2 doesn't receive the sender copy because the sibling session between
    // delegate-1 and delegate-2 isn't properly restored after restart.
    // Root cause: Complex interaction between sibling device sessions and session restoration.
    it("should allow communication between two delegates after one restarts", async () => {
      await runControlledScenario({
        steps: [
          // Setup: Alice main + 2 delegates
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate-1", mainDeviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate-2", mainDeviceId: "alice-main" },
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

          // Verify both delegates work before restart
          { type: "expect", actor: "alice", deviceId: "alice-delegate-1", message: "ack" },
          { type: "expect", actor: "alice", deviceId: "alice-delegate-2", message: "ack" },

          // Restart delegate-1
          { type: "close", actor: "alice", deviceId: "alice-delegate-1" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate-1" },

          // Restarted delegate sends - other delegate should get sender copy
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate-1" },
            to: "bob",
            message: "from-restarted-delegate",
            waitOn: "auto",
          },

          // BUG SCENARIO: delegate-2 may not receive this if delegate-1
          // started accepting new invites after restart
          { type: "expect", actor: "alice", deviceId: "alice-delegate-2", message: "from-restarted-delegate" },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "from-restarted-delegate" },
        ],
      })
    })
  })
});
