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
});
