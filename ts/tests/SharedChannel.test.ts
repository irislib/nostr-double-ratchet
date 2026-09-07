import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { SharedChannel, SHARED_CHANNEL_KIND } from "../src/SharedChannel";
import type { Rumor } from "../src/types";

function makeRumor(pubkey: string, content: string): Rumor {
  return {
    id: crypto.randomUUID(),
    kind: 10445,
    content,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
  };
}

describe("SharedChannel", () => {
  it("derives correct pubkey from secret", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    expect(channel.publicKey).toBe(getPublicKey(secret));
  });

  it("round-trips: createEvent then decryptEvent returns same Rumor", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const authorKey = generateSecretKey();
    const authorPub = getPublicKey(authorKey);

    const rumor = makeRumor(authorPub, "hello shared channel");
    const event = channel.createEvent(rumor);
    const decrypted = channel.decryptEvent(event);

    expect(decrypted.id).toBe(rumor.id);
    expect(decrypted.content).toBe("hello shared channel");
    expect(decrypted.pubkey).toBe(authorPub);
    expect(decrypted.kind).toBe(rumor.kind);
  });

  it("outer event has correct kind and pubkey", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const authorKey = generateSecretKey();
    const rumor = makeRumor(getPublicKey(authorKey), "test");

    const event = channel.createEvent(rumor);

    expect(event.kind).toBe(SHARED_CHANNEL_KIND);
    expect(event.pubkey).toBe(channel.publicKey);
    expect(event.tags).toEqual([["p", channel.publicKey]]);
  });

  it("isChannelEvent identifies channel events", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const rumor = makeRumor(getPublicKey(generateSecretKey()), "test");
    const event = channel.createEvent(rumor);

    expect(channel.isChannelEvent(event)).toBe(true);
  });

  it("isChannelEvent rejects events from different channel", () => {
    const secret1 = generateSecretKey();
    const secret2 = generateSecretKey();
    const channel1 = new SharedChannel(secret1);
    const channel2 = new SharedChannel(secret2);

    const rumor = makeRumor(getPublicKey(generateSecretKey()), "test");
    const event = channel1.createEvent(rumor);

    expect(channel2.isChannelEvent(event)).toBe(false);
  });

  it("isChannelEvent rejects events with wrong kind", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const rumor = makeRumor(getPublicKey(generateSecretKey()), "test");
    const event = channel.createEvent(rumor);

    const wrongKind = { ...event, kind: 1 };
    expect(channel.isChannelEvent(wrongKind)).toBe(false);
  });

  it("different secrets produce different channels", () => {
    const secret1 = generateSecretKey();
    const secret2 = generateSecretKey();
    const channel1 = new SharedChannel(secret1);
    const channel2 = new SharedChannel(secret2);

    expect(channel1.publicKey).not.toBe(channel2.publicKey);
  });

  it("different secrets cannot decrypt each other's events", () => {
    const secret1 = generateSecretKey();
    const secret2 = generateSecretKey();
    const channel1 = new SharedChannel(secret1);
    const channel2 = new SharedChannel(secret2);

    const rumor = makeRumor(getPublicKey(generateSecretKey()), "secret msg");
    const event = channel1.createEvent(rumor);

    expect(() => channel2.decryptEvent(event)).toThrow();
  });

  it("tampered content fails decryption", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const rumor = makeRumor(getPublicKey(generateSecretKey()), "original");
    const event = channel.createEvent(rumor);

    const tampered = { ...event, content: event.content + "x" };
    expect(() => channel.decryptEvent(tampered)).toThrow();
  });

  it("rejects captured ciphertext republished by an unrelated author", () => {
    const channel = new SharedChannel(generateSecretKey());
    const rumor = makeRumor(getPublicKey(generateSecretKey()), "private message");
    const original = channel.createEvent(rumor);
    const replay = finalizeEvent({
      kind: original.kind,
      content: original.content,
      tags: original.tags,
      created_at: original.created_at + 1,
    }, generateSecretKey());

    expect(() => channel.decryptEvent(replay)).toThrow("Invalid shared channel event");
    expect(channel.decryptEvent(original)).toEqual(rumor);
  });

  it("rejects channel ciphertext signed with an unexpected kind", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const original = channel.createEvent(
      makeRumor(getPublicKey(generateSecretKey()), "private message"),
    );
    const wrongKind = finalizeEvent({
      kind: 1,
      content: original.content,
      tags: original.tags,
      created_at: original.created_at,
    }, secret);

    expect(() => channel.decryptEvent(wrongKind)).toThrow("Invalid shared channel event");
  });

  it.each(["signature", "id", "timestamp"])(
    "rejects a tampered %s even when the original was already verified",
    (field) => {
      const channel = new SharedChannel(generateSecretKey());
      const original = channel.createEvent(
        makeRumor(getPublicKey(generateSecretKey()), "private message"),
      );
      const tampered = {
        ...original,
        ...(field === "signature" ? { sig: "00".repeat(64) } : {}),
        ...(field === "id" ? { id: "00".repeat(32) } : {}),
        ...(field === "timestamp" ? { created_at: original.created_at + 1 } : {}),
      };

      expect(() => channel.decryptEvent(tampered)).toThrow("Invalid shared channel event");
    },
  );

  it("same secret creates equivalent channel", () => {
    const secret = generateSecretKey();
    const channel1 = new SharedChannel(secret);
    const channel2 = new SharedChannel(secret);

    expect(channel1.publicKey).toBe(channel2.publicKey);

    const rumor = makeRumor(getPublicKey(generateSecretKey()), "shared");
    const event = channel1.createEvent(rumor);
    const decrypted = channel2.decryptEvent(event);

    expect(decrypted.content).toBe("shared");
  });

  it("preserves rumor tags through round-trip", () => {
    const secret = generateSecretKey();
    const channel = new SharedChannel(secret);
    const rumor: Rumor = {
      id: crypto.randomUUID(),
      kind: 10445,
      content: JSON.stringify({ inviteUrl: "https://example.com", groupId: "g1" }),
      pubkey: getPublicKey(generateSecretKey()),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", "someid"], ["p", "somepub"]],
    };

    const event = channel.createEvent(rumor);
    const decrypted = channel.decryptEvent(event);

    expect(decrypted.tags).toEqual(rumor.tags);
    expect(JSON.parse(decrypted.content)).toEqual({
      inviteUrl: "https://example.com",
      groupId: "g1",
    });
  });
});
