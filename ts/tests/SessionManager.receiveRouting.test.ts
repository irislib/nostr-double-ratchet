import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from "nostr-tools";
import { Session } from "../src/Session";
import { SessionManager } from "../src/SessionManager";
import { Invite } from "../src/Invite";
import { buildTextRumor } from "../src/messageBuilders";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { generateEphemeralKeypair, generateSharedSecret } from "../src/inviteUtils";
import type { StoredUserRecord } from "../src/session-manager/types";

class RoutingManager extends SessionManager {
  get localOwner(): string { return this.ownerPublicKey; }

  get pendingCount(): number { return this.pendingDirectMessages.size; }

  get invite(): Invite {
    return new Invite(this.inviteKeys.ephemeralKeypair.publicKey, this.inviteKeys.sharedSecret,
      this.ourPublicKey, this.inviteKeys.ephemeralKeypair.privateKey, this.deviceId);
  }

  receiveInviteResponse(event: VerifiedEvent): Promise<boolean> {
    return this.processInviteResponseEvent(event);
  }

  queuePreviousEvent(event: VerifiedEvent): void {
    this.queuePendingDirectMessage(event);
  }

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

async function manager(ownerPubkey?: string) {
  const key = generateSecretKey();
  const owner = getPublicKey(key);
  const manager = new RoutingManager(
    owner, key, owner, () => () => {},
    async (event) => event as VerifiedEvent,
    ownerPubkey ?? owner,
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
  it("keeps an established session when concurrent copies of its invite response finish", async () => {
    const receiver = await manager();
    const peerKey = generateSecretKey();
    const peerId = getPublicKey(peerKey);
    const { session: peer, event: response } = await receiver.invite.accept(peerId, peerKey);
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      const first = peer.sendEvent(buildTextRumor("first contact"), [["p", receiver.getDeviceId()]]).event;
      expect(receiver.processReceivedEvent(first)).toBe(false);
      await Promise.all([
        receiver.receiveInviteResponse(response),
        receiver.receiveInviteResponse(structuredClone(response)),
      ]);
      expect(received).toHaveBeenCalledTimes(1);
      const device = receiver.getUserRecords().get(peerId)!.devices.get(peerId)!;
      const reply = device.prepareOutboundEvent(buildTextRumor("reply to contact"));
      expect(reply).toBeDefined();
      expect(peer.receiveEvent(reply!)?.content).toBe("reply to contact");
    } finally {
      receiver.close();
    }
  });

  it("ignores another device's signed envelope without decrypting or retaining it", async () => {
    const owner = getPublicKey(generateSecretKey());
    const receiver = await manager(owner);
    const sibling = await manager(owner);
    const { alice, bob } = pair();
    receiver.installPeer(bob);
    const siblingSession = pair().bob;
    sibling.installPeer(siblingSession);
    const wrongDeviceAttempt = vi.spyOn(siblingSession, "receiveEvent");
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      const event = alice.sendEvent(
        { kind: 14, content: "one device's encrypted copy" },
        [["p", receiver.getDeviceId()]],
      ).event;
      expect(verifyEvent(event)).toBe(true);
      expect(sibling.processReceivedEvent(structuredClone(event))).toBe(true);
      expect(wrongDeviceAttempt).not.toHaveBeenCalled();
      expect(sibling.pendingCount).toBe(0);
      // Existing pending queues must also stop retrying a foreign recipient.
      sibling.queuePreviousEvent(event);
      sibling.retryPending();
      expect(wrongDeviceAttempt).not.toHaveBeenCalled();
      expect(sibling.pendingCount).toBe(0);
      expect(receiver.processReceivedEvent(event)).toBe(true);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ content: "one device's encrypted copy" }),
        expect.any(String), expect.any(Object),
      );
    } finally {
      receiver.close();
      sibling.close();
    }
  });

  it.each(["owner", "device", "multiple"])("retains %s recipient compatibility", async (alias) => {
    const receiver = await manager(getPublicKey(generateSecretKey()));
    const { alice, bob } = pair();
    receiver.installPeer(bob);
    const recipient = alias === "owner" ? receiver.localOwner : receiver.getDeviceId();
    const tags = alias === "multiple"
      ? [["p", getPublicKey(generateSecretKey())], ["p", recipient]]
      : [["p", recipient]];
    const received = vi.fn();
    receiver.onEvent(received);
    try {
      const event = alice.sendEvent({ kind: 14, content: alias }, tags).event;
      expect(receiver.processReceivedEvent(event)).toBe(true);
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ content: alias }),
        expect.any(String), expect.any(Object),
      );
    } finally {
      receiver.close();
    }
  });

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
