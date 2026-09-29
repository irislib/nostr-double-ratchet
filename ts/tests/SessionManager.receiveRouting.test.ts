import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { Session } from "../src/Session";
import { SessionManager } from "../src/SessionManager";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { generateEphemeralKeypair, generateSharedSecret } from "../src/inviteUtils";

class RoutingManager extends SessionManager {
  installPeer(session: Session): void {
    const owner = getPublicKey(generateSecretKey());
    this.getOrCreateUserRecord(owner).ensureDevice(owner).installSession(
      session, false, { persist: false },
    );
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
  const secret = generateSharedSecret();
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
});
