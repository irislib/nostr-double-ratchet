import { describe, it, expect } from "vitest"
import { runControlledScenario } from "./helpers/controlledScenario"

describe("Delegate Device Refresh Bug", () => {



describe("Invite acceptance bug after restart", () => {
    /**
     * Specific test for the bug where delegate accepts new invites
     * after restart instead of using existing sessions.
     *
     * This test specifically exercises the self-session path that
     * should use existing sessions, not create new invite acceptances.
     */
    it("should NOT create new invite acceptances for self after restart", async () => {
      await runControlledScenario({
        debug: true, // Enable debug to see what's happening
        steps: [
          // Setup
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDelegateDevice", actor: "alice", deviceId: "alice-delegate", mainDeviceId: "alice-main" },
          { type: "addDevice", actor: "bob", deviceId: "bob-main" },

          // Establish full session
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

          // Have delegate send to establish its session state
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "delegate-established",
            waitOn: "auto",
          },

          // Restart delegate
          { type: "close", actor: "alice", deviceId: "alice-delegate" },
          { type: "restart", actor: "alice", deviceId: "alice-delegate" },

          // This send should use EXISTING session for self-messaging
          // BUG: Instead it accepts new invites
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-delegate" },
            to: "bob",
            message: "after-restart-should-use-existing-session",
            waitOn: "auto",
          },

          // Verify main device received via existing session
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "after-restart-should-use-existing-session" },

          // Send another message to verify session is still working
          {
            type: "send",
            from: { actor: "bob", deviceId: "bob-main" },
            to: "alice",
            message: "bob-reply-after-delegate-restart",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-delegate", message: "bob-reply-after-delegate-restart" },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "bob-reply-after-delegate-restart" },
        ],
      })
    })
  })

describe("Bob's delegate refresh - sender copy to main device", () => {
    /**
     * Scenario:
     * 1. alice (main) -> bob (main)
     * 2. bob (main) -> alice (main)
     * 3. bob2 (delegate) -> alice (main)
     * 4. refresh bob2
     * 5. bob2 -> alice
     *
     * Expected bug: After bob2 refreshes, when bob2 sends to alice,
     * bob's main device should receive the sender copy but might not.
     */
    it("should deliver sender copy to bob-main when bob-delegate sends after refresh", async () => {
      await runControlledScenario({
        steps: [
          // Setup: Alice has main, Bob has main + delegate
          { type: "addDevice", actor: "alice", deviceId: "alice-main" },
          { type: "addDevice", actor: "bob", deviceId: "bob-main" },
          { type: "addDelegateDevice", actor: "bob", deviceId: "bob-delegate", mainDeviceId: "bob-main" },

          // Step 1: alice -> bob
          {
            type: "send",
            from: { actor: "alice", deviceId: "alice-main" },
            to: "bob",
            message: "alice-to-bob-1",
            waitOn: "auto",
          },
          { type: "expect", actor: "bob", deviceId: "bob-main", message: "alice-to-bob-1" },
          { type: "expect", actor: "bob", deviceId: "bob-delegate", message: "alice-to-bob-1" },

          // Step 2: bob -> alice
          {
            type: "send",
            from: { actor: "bob", deviceId: "bob-main" },
            to: "alice",
            message: "bob-to-alice-1",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "bob-to-alice-1" },

          // Step 3: bob-delegate -> alice (before refresh)
          {
            type: "send",
            from: { actor: "bob", deviceId: "bob-delegate" },
            to: "alice",
            message: "bob-delegate-to-alice-before-refresh",
            waitOn: "auto",
          },
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "bob-delegate-to-alice-before-refresh" },
          // bob-main should get sender copy
          { type: "expect", actor: "bob", deviceId: "bob-main", message: "bob-delegate-to-alice-before-refresh" },

          // Step 4: refresh bob-delegate
          { type: "close", actor: "bob", deviceId: "bob-delegate" },
          { type: "restart", actor: "bob", deviceId: "bob-delegate" },

          // Step 5: bob-delegate -> alice (after refresh)
          {
            type: "send",
            from: { actor: "bob", deviceId: "bob-delegate" },
            to: "alice",
            message: "bob-delegate-to-alice-after-refresh",
            waitOn: "auto",
          },
          // Alice should receive the message
          { type: "expect", actor: "alice", deviceId: "alice-main", message: "bob-delegate-to-alice-after-refresh" },
          // BUG: bob-main should receive sender copy but might not after delegate refresh
          { type: "expect", actor: "bob", deviceId: "bob-main", message: "bob-delegate-to-alice-after-refresh" },
        ],
      })
    })
  })
});
