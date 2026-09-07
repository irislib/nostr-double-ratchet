import { describe, expect, it } from "vitest";
import {
  parseSenderKeyDistribution,
  SenderKeyState,
  SENDER_KEY_MAX_SKIP,
} from "../src/SenderKey";

const validDistribution = {
  groupId: "group",
  keyId: 1,
  chainKey: "ab".repeat(32),
  iteration: 2,
  createdAt: 3,
  senderEventPubkey: "cd".repeat(32),
};

describe("parseSenderKeyDistribution", () => {
  it("accepts a valid distribution", () => {
    expect(parseSenderKeyDistribution(JSON.stringify(validDistribution)))
      .toEqual(validDistribution);
  });

  it.each([
    ["non-object JSON", null],
    ["missing group", { ...validDistribution, groupId: undefined }],
    ["fractional key id", { ...validDistribution, keyId: 1.5 }],
    ["invalid chain key", { ...validDistribution, chainKey: "ab" }],
    ["negative iteration", { ...validDistribution, iteration: -1 }],
    ["fractional timestamp", { ...validDistribution, createdAt: 3.5 }],
    ["non-string sender key", { ...validDistribution, senderEventPubkey: 4 }],
  ])("rejects %s", (_label, value) => {
    expect(parseSenderKeyDistribution(JSON.stringify(value))).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseSenderKeyDistribution("{")).toBeNull();
  });
});

describe("SenderKeyState", () => {
  it("round-trips plaintext (bytes API)", () => {
    const keyId = 123;
    const chainKey = new Uint8Array(32).fill(7);

    const sender = new SenderKeyState(keyId, chainKey, 0);
    const receiver = new SenderKeyState(keyId, chainKey, 0);

    const { messageNumber, ciphertext } = sender.encryptToBytes("hello");
    expect(messageNumber).toBe(0);

    const plaintext = receiver.decryptFromBytes(messageNumber, ciphertext);
    expect(plaintext).toBe("hello");
  });

  it("supports out-of-order decryption with skipped key cache", () => {
    const keyId = 123;
    const chainKey = new Uint8Array(32).fill(7);

    const sender = new SenderKeyState(keyId, chainKey, 0);
    const receiver = new SenderKeyState(keyId, chainKey, 0);

    const m0 = sender.encryptToBytes("m0");
    const m1 = sender.encryptToBytes("m1");

    // Deliver second message first.
    expect(receiver.decryptFromBytes(m1.messageNumber, m1.ciphertext)).toBe("m1");
    expect(receiver.skippedLen()).toBeGreaterThan(0);
    expect(receiver.decryptFromBytes(m0.messageNumber, m0.ciphertext)).toBe("m0");
    expect(receiver.skippedLen()).toBe(0);
  });

  it("rejects messages too far ahead", () => {
    const keyId = 123;
    const chainKey = new Uint8Array(32).fill(7);
    const receiver = new SenderKeyState(keyId, chainKey, 0);

    expect(() =>
      receiver.decryptFromBytes(SENDER_KEY_MAX_SKIP + 1, new Uint8Array([1, 2, 3]))
    ).toThrow();
  });

  it.each(["current", "ahead", "skipped"])(
    "preserves receive state when a %s message fails authentication",
    (position) => {
      const chainKey = new Uint8Array(32).fill(7);
      const sender = new SenderKeyState(123, chainKey, 0);
      const receiver = new SenderKeyState(123, chainKey, 0);
      const first = sender.encryptToBytes("first");
      const second = sender.encryptToBytes("second");
      if (position === "skipped") {
        expect(receiver.decryptFromBytes(second.messageNumber, second.ciphertext))
          .toBe("second");
      }
      const message = position === "ahead" ? second : first;
      const tampered = new Uint8Array(message.ciphertext);
      tampered[tampered.length - 1] ^= 1;
      const before = receiver.toJSON();

      expect(() => receiver.decryptFromBytes(message.messageNumber, tampered))
        .toThrow("invalid MAC");
      expect(receiver.toJSON()).toEqual(before);
      expect(receiver.decryptFromBytes(message.messageNumber, message.ciphertext))
        .toBe(position === "ahead" ? "second" : "first");
    },
  );

  it.each([-1, 0x1_0000_0000, 0.5, NaN, Infinity])(
    "rejects invalid message number %s without consuming a key",
    (messageNumber) => {
      const chainKey = new Uint8Array(32).fill(7);
      const sender = new SenderKeyState(123, chainKey, 0);
      const receiver = new SenderKeyState(123, chainKey, 0);
      const message = sender.encrypt("hello");
      const before = receiver.toJSON();

      expect(() => receiver.decrypt(messageNumber, message.ciphertext))
        .toThrow("Invalid messageNumber");
      expect(receiver.toJSON()).toEqual(before);
      expect(receiver.decrypt(message.messageNumber, message.ciphertext))
        .toBe("hello");
    },
  );

  it("does not advance the sending chain when encryption fails", () => {
    const sender = new SenderKeyState(123, new Uint8Array(32).fill(7), 0);
    const before = sender.toJSON();

    expect(() => sender.encryptToBytes("")).toThrow();
    expect(sender.toJSON()).toEqual(before);
  });

  it("rejects sender-key counter overflow without changing state", () => {
    const chainKey = new Uint8Array(32).fill(7);
    const sender = new SenderKeyState(123, chainKey, 0xffff_ffff);
    const before = sender.toJSON();
    const message = new SenderKeyState(123, chainKey, 0).encryptToBytes("last");

    expect(() => sender.encryptToBytes("overflow")).toThrow("overflow");
    expect(sender.toJSON()).toEqual(before);
    expect(() => sender.decryptFromBytes(0xffff_ffff, message.ciphertext))
      .toThrow("overflow");
    expect(sender.toJSON()).toEqual(before);
  });
});
