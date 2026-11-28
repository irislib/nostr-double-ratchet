import { afterEach, describe, expect, it, vi } from "vitest";
import * as nip44 from "nostr-tools/nip44";
import { SenderKeyState, SENDER_KEY_MAX_SKIP } from "../src/SenderKey.js";

afterEach(() => vi.restoreAllMocks());

describe("blind sender-key trial work", () => {
  it("decodes and decrypts only the authenticated match, retaining skipped recovery", () => {
    const key = new Uint8Array(32).fill(7);
    const sender = new SenderKeyState(9, key, 0);
    const receiver = new SenderKeyState(9, key, 0);
    const messages = Array.from({ length: 17 }, (_, i) => sender.encryptToBytes("message-" + i));
    const decrypt = vi.spyOn(nip44.v2, "decrypt");
    expect(receiver.decryptBlindFromBytes(messages[16].ciphertext).plaintext).toBe("message-16");
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(receiver.decryptBlindFromBytes(messages[0].ciphertext).plaintext).toBe("message-0");
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(receiver.skippedLen()).toBe(15);
  });
  it("rejects every unauthenticated trial without decoding or consuming state", () => {
    const sender = new SenderKeyState(9, new Uint8Array(32).fill(8), 0);
    const receiver = new SenderKeyState(9, new Uint8Array(32).fill(7), 0);
    const ciphertext = sender.encryptToBytes("foreign key").ciphertext;
    const before = receiver.toJSON();
    const decrypt = vi.spyOn(nip44.v2, "decrypt");
    expect(() => receiver.planDecryptBlind(ciphertext)).toThrow("blind decrypt failed");
    expect(decrypt).not.toHaveBeenCalled();
    expect(receiver.toJSON()).toEqual(before);
  });
  it("keeps the full existing search distance and rejects the next position", () => {
    const key = new Uint8Array(32).fill(6);
    const sender = new SenderKeyState(9, key, 0);
    const receiver = new SenderKeyState(9, key, 0);
    for (let i = 0; i < SENDER_KEY_MAX_SKIP; i++) sender.encryptToBytes("advance");
    const boundary = sender.encryptToBytes("boundary");
    const beyond = sender.encryptToBytes("beyond");
    expect(() => receiver.planDecryptBlind(beyond.ciphertext)).toThrow("blind decrypt failed");
    expect(receiver.iterationNumber()).toBe(0);
    expect(receiver.decryptBlindFromBytes(boundary.ciphertext)).toMatchObject({
      messageNumber: SENDER_KEY_MAX_SKIP, plaintext: "boundary" });
  });
});

it("matches the original two-output KDF byte for byte over a chain", async () => {
  const { kdf } = await import("../src/utils.js");
  const { bytesToHex } = await import("@noble/hashes/utils");
  const { base64Encode } = await import("../src/base64.js");
  const salt = new TextEncoder().encode("ndr-sender-key-v1");
  let chain = new Uint8Array(32).fill(5);
  const sender = new SenderKeyState(1, chain, 0);
  for (let i = 0; i < 64; i++) {
    const [next, message] = kdf(chain, salt, 2);
    const encrypted = sender.encryptToBytes("vector-" + i);
    expect(sender.toJSON().chainKey).toBe(bytesToHex(next));
    expect(nip44.v2.decrypt(base64Encode(encrypted.ciphertext), message)).toBe("vector-" + i);
    chain = next;
  }
});

it.each([1, 32, 33, 255, 65536])("accepts canonical NIP-44 at %i bytes and rejects tampered bytes", async size => {
  const { senderKeyTrial } = await import("../src/group/SenderKeyTrial.js");
  const { base64Decode } = await import("../src/base64.js");
  const key = new Uint8Array(32).fill(7);
  const plaintext = "a".repeat(size);
  const ciphertext = base64Decode(nip44.v2.encrypt(plaintext, key));
  expect(senderKeyTrial(ciphertext)(key)).toBe(plaintext);
  for (const position of [1, 33, ciphertext.length - 1]) {
    const forged = new Uint8Array(ciphertext);
    forged[position] ^= 1;
    expect(senderKeyTrial(forged)(key)).toBeNull();
  }
  const badVersion = new Uint8Array(ciphertext);
  badVersion[0] = 3;
  expect(() => senderKeyTrial(badVersion)).toThrow("Invalid sender-key NIP-44 payload");
});
