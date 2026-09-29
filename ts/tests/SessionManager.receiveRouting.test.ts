import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { Session } from "../src/Session";
import { SessionManager } from "../src/SessionManager";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { generateEphemeralKeypair, generateSharedSecret } from "../src/inviteUtils";
import type { StoredUserRecord } from "../src/session-manager/types";

class RoutingManager extends SessionManager {
  retryPending(): void {
    this.retryPendingDirectMessages();
  }

  async snapshotPeer(owner: string): Promise<StoredUserRecord> {
    await this.storeUserRecord(owner);
    return structuredClone((await this.storage.get<StoredUserRecord>(`v1/user/${owner}`))!);
  }

  async restorePeer(owner: string, data: StoredUserRecord): Promise<void> {
    await this.storeUserRecord(owner);
    await this.storage.put(`v1/user/${owner}`, data);
    await this.loadUserRecord(owner);
  }

  installPeer(session: Session): string {
    const owner = getPublicKey(generateSecretKey());
    this.getOrCreateUserRecord(owner).ensureDevice(owner).installSession(
      session, false, { persist: false },
    );
    return owner;
  }
}

async function manager() {
  const key = generateSecretKey();
  const owner = getPublicKey(key);
  const manager = new RoutingManager(
    owner, key, owner, () => () => {},
    async (event) => event as VerifiedEvent,
    owner,
    { ephemeralKeypair: generateEphemeralKeypair(), sharedSecret: generateSharedSecret() },
    new InMemoryStorageAdapter(),
  );
  await manager.init();
  return manager;
}

function pair() {
  const alice = generateSecretKey();
  const bob = generateSecretKey();
  const secret = generateSecretKey();
  return {
    alice: Session.init(getPublicKey(bob), alice, true, secret),
    bob: Session.init(getPublicKey(alice), bob, false, secret),
  };
}

describe("incoming session routing", () => {
  it("tries the known author before unrelated cold handshakes", async () => {
    const receiver = await manager();
    const unrelated = Array.from({ length: 100 }, () => pair().alice);
    for (const session of unrelated) receiver.installPeer(session);
    const attempts = unrelated.map((session) => vi.spyOn(session, "receiveEvent"));
    const { alice, bob } = pair();
    receiver.installPeer(bob);
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      const event = alice.sendEvent({
        kind: 14, content: "last peer's first message",
      }).event;
      expect(receiver.processReceivedEvent(event)).toBe(true);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ content: "last peer's first message" }),
        expect.any(String), expect.any(Object),
      );
      expect(attempts.reduce((total, attempt) => total + attempt.mock.calls.length, 0)).toBe(0);
      // Overlapping subscriptions recreate the event object for the same signed envelope.
      const replayHandled = receiver.processReceivedEvent(structuredClone(event));
      expect(attempts.reduce((total, attempt) => total + attempt.mock.calls.length, 0)).toBe(0);
      expect(replayHandled).toBe(true);
      expect(received).toHaveBeenCalledTimes(1);
    } finally {
      receiver.close();
    }
  });

  it("retains unknown-author fallback when a matching candidate cannot decrypt", async () => {
    const receiver = await manager();
    const { alice, bob } = pair();
    const unrelated = pair().alice;
    unrelated.state.theirNextNostrPublicKey = alice.state.ourCurrentNostrKey!.publicKey;
    receiver.installPeer(unrelated);
    // An imported receive-only session may not yet know the peer's header author.
    bob.state.theirNextNostrPublicKey = undefined;
    receiver.installPeer(bob);
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      const event = alice.sendEvent({ kind: 14, content: "unknown author" }).event;
      expect(receiver.processReceivedEvent(event)).toBe(true);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ content: "unknown author" }),
        expect.any(String), expect.any(Object),
      );
    } finally {
      receiver.close();
    }
  });

  it("retries an undeciphered envelope after its session becomes available", async () => {
    const receiver = await manager();
    receiver.installPeer(pair().alice);
    const { alice, bob } = pair();
    const event = alice.sendEvent({ kind: 14, content: "waiting for session" }).event;
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      expect(receiver.processReceivedEvent(event)).toBe(false);
      expect(receiver.processReceivedEvent(structuredClone(event))).toBe(false);
      expect(received).not.toHaveBeenCalled();
      receiver.installPeer(bob);
      receiver.retryPending();
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ content: "waiting for session" }),
        expect.any(String), expect.any(Object),
      );
      expect(receiver.processReceivedEvent(structuredClone(event))).toBe(true);
      expect(received).toHaveBeenCalledTimes(1);
    } finally {
      receiver.close();
    }
  });


  it("replays envelopes into a restored ratchet instead of retaining the old dedup epoch", async () => {
    const receiver = await manager();
    const { alice, bob } = pair();
    const owner = receiver.installPeer(bob);
    const before = await receiver.snapshotPeer(owner);
    const first = alice.sendEvent({ kind: 14, content: "before restore" }).event;
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      expect(receiver.processReceivedEvent(first)).toBe(true);
      await receiver.restorePeer(owner, before);
      expect(receiver.processReceivedEvent(structuredClone(first))).toBe(true);
      expect(received).toHaveBeenCalledTimes(2);
      const next = alice.sendEvent({ kind: 14, content: "after restore" }).event;
      expect(receiver.processReceivedEvent(next)).toBe(true);
      expect(received).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: "after restore" }),
        expect.any(String), expect.any(Object),
      );
    } finally {
      receiver.close();
    }
  });

});
