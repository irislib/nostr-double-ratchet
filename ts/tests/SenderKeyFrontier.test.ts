import { afterEach, describe, expect, it, vi } from "vitest";
import * as nip44 from "nostr-tools/nip44";
import { SenderKeyState } from "../src/SenderKey.js";

afterEach(() => vi.restoreAllMocks());

function withRetainedKeys() {
  const chainKey = new Uint8Array(32).fill(7);
  const skippedMessageKeys = Object.fromEntries(
    Array.from({ length: 2_000 }, (_, n) => [String(n), "ab".repeat(32)]),
  );
  return {
    sender: new SenderKeyState(7, chainKey, 2_000),
    receiver: SenderKeyState.fromJSON({
      keyId: 7,
      chainKey: "07".repeat(32),
      iteration: 2_000,
      skippedMessageKeys,
    }),
  };
}

describe("SenderKeyState current-position frontier", () => {
  it("authenticates once before preserving all retained skipped keys in a pure plan", () => {
    const { sender, receiver } = withRetainedKeys();
    const message = sender.encryptToBytes("fresh");
    const before = receiver.toJSON();
    const decrypt = vi.spyOn(nip44.v2, "decrypt");

    const plan = receiver.planDecryptFrontier(message.ciphertext);

    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(plan).not.toBeNull();
    expect(plan!.plaintext).toBe("fresh");
    expect(plan!.keyId).toBe(7);
    expect(plan!.messageNumber).toBe(2_000);
    expect(plan!.nextState.iterationNumber()).toBe(2_001);
    expect(plan!.nextState.toJSON().skippedMessageKeys).toEqual(before.skippedMessageKeys);
    expect(receiver.toJSON()).toEqual(before);
  });

  it("does not scan or serialize retained keys on a forged current-position miss", () => {
    const { sender, receiver } = withRetainedKeys();
    const message = sender.encryptToBytes("fresh");
    const forged = new Uint8Array(message.ciphertext);
    forged[forged.length - 1] ^= 1;
    const before = receiver.toJSON();
    const serialize = vi.spyOn(receiver, "toJSON");
    const decrypt = vi.spyOn(nip44.v2, "decrypt");

    expect(receiver.planDecryptFrontier(forged)).toBeNull();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(serialize).not.toHaveBeenCalled();
    serialize.mockRestore();
    expect(receiver.toJSON()).toEqual(before);
    expect(receiver.planDecryptFrontier(message.ciphertext)?.plaintext).toBe("fresh");
  });

  it("leaves a later position and skipped-message recovery to the existing fallback", () => {
    const key = new Uint8Array(32).fill(9);
    const sender = new SenderKeyState(1, key, 0);
    const receiver = new SenderKeyState(1, key, 0);
    const old = sender.encryptToBytes("old");
    const ahead = sender.encryptToBytes("ahead");
    const before = receiver.toJSON();
    const decrypt = vi.spyOn(nip44.v2, "decrypt");

    expect(receiver.planDecryptFrontier(ahead.ciphertext)).toBeNull();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(receiver.toJSON()).toEqual(before);
    expect(receiver.decryptBlindFromBytes(ahead.ciphertext).plaintext).toBe("ahead");
    const withSkipped = receiver.toJSON();
    expect(receiver.planDecryptFrontier(old.ciphertext)).toBeNull();
    expect(receiver.toJSON()).toEqual(withSkipped);
    expect(receiver.decryptBlindFromBytes(old.ciphertext).plaintext).toBe("old");
    expect(receiver.skippedLen()).toBe(0);
  });

  it("rejects exhausted counter state before cryptographic work without mutation", () => {
    const receiver = new SenderKeyState(1, new Uint8Array(32).fill(9), 0xffff_ffff);
    const before = receiver.toJSON();
    const decrypt = vi.spyOn(nip44.v2, "decrypt");
    expect(receiver.planDecryptFrontier(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    expect(receiver.toJSON()).toEqual(before);
  });
});
