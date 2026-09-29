import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { Session } from "../src/Session";
import { SessionManager } from "../src/SessionManager";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { buildTextRumor } from "../src/messageBuilders";
import { generateEphemeralKeypair, generateSharedSecret } from "../src/inviteUtils";

class FailingSessionStorage extends InMemoryStorageAdapter {
  failedKey?: string;

  override async put<T>(key: string, value: T): Promise<void> {
    if (key === this.failedKey) throw new Error("session storage unavailable");
    await super.put(key, value);
  }
}

class DurableSender extends SessionManager {
  async installPeer(peerId: string, session: Session): Promise<void> {
    this.getOrCreateUserRecord(peerId).ensureDevice(peerId).installSession(
      session, false, { persist: false },
    );
    await this.storeUserRecord(peerId);
  }

  queuedFor(peerId: string) {
    return this.messageQueue.getForTarget(peerId);
  }

  retryPeer(peerId: string): Promise<void> {
    return this.flushMessageQueue(peerId);
  }
}

describe("direct send durability", () => {
  it("retains the message without publishing when the updated ratchet cannot be saved", async () => {
    const senderKey = generateSecretKey();
    const peerKey = generateSecretKey();
    const senderId = getPublicKey(senderKey);
    const peerId = getPublicKey(peerKey);
    const secret = generateSecretKey();
    const senderSession = Session.init(peerId, senderKey, true, secret);
    const peerSession = Session.init(senderId, peerKey, false, secret);
    const storage = new FailingSessionStorage();
    const received: string[] = [];
    const sender = new DurableSender(
      senderId, senderKey, senderId, () => () => {},
      async (event) => {
        if (event.kind === 1060) received.push(peerSession.receiveEvent(event as VerifiedEvent)!.content);
        return event as VerifiedEvent;
      },
      senderId,
      { ephemeralKeypair: generateEphemeralKeypair(), sharedSecret: generateSharedSecret() },
      storage,
    );
    try {
      await sender.init();
      await sender.installPeer(peerId, senderSession);
      storage.failedKey = `v1/user/${peerId}`;
      const message = buildTextRumor("save before sending");
      await expect(sender.sendEvent(peerId, message, { includeLocalSiblings: false }))
        .rejects.toThrow("session storage unavailable");
      expect(received).toEqual([]);
      expect((await sender.queuedFor(peerId)).map((entry) => entry.event.id)).toEqual([message.id]);

      storage.failedKey = undefined;
      await sender.retryPeer(peerId);
      expect(received).toEqual([message.content]);
      expect(await sender.queuedFor(peerId)).toEqual([]);
    } finally {
      sender.close();
    }
  });
});
