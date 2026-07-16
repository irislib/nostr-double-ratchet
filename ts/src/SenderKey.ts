import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import * as nip44 from "nostr-tools/nip44";

import { kdf } from "./utils.js";
import { base64Decode, base64Encode } from "./base64.js";

/**
 * Maximum number of message keys we will derive-and-cache to support out-of-order delivery.
 *
 * This mirrors the Rust implementation and is intentionally higher than the 1:1 ratchet MAX_SKIP.
 */
export const SENDER_KEY_MAX_SKIP = 10_000;

/** Bound the amount of cached skipped message keys to limit memory/CPU DoS. */
export const SENDER_KEY_MAX_STORED_SKIPPED_KEYS = 2_000;

const SENDER_KEY_KDF_SALT = new TextEncoder().encode("ndr-sender-key-v1");

export interface SenderKeyDistribution {
  groupId: string;
  keyId: number;
  /** Hex-encoded 32-byte chain key */
  chainKey: string;
  iteration: number;
  /** UNIX seconds */
  createdAt: number;
  /** Per-sender outer pubkey used to publish group messages */
  senderEventPubkey?: string;
}

export interface SenderKeyStateSerialized {
  keyId: number;
  /** Hex-encoded 32-byte chain key */
  chainKey: string;
  iteration: number;
  /** messageNumber -> hex-encoded 32-byte key */
  skippedMessageKeys?: Record<string, string>;
}

export interface SenderKeyBlindDecryptResult {
  keyId: number;
  messageNumber: number;
  plaintext: string;
}

interface SenderKeyBlindDecryptPlan extends SenderKeyBlindDecryptResult {
  nextState: SenderKeyState;
}

function deriveMessageKey(chainKey: Uint8Array): [Uint8Array, Uint8Array] {
  const [nextChainKey, messageKey] = kdf(chainKey, SENDER_KEY_KDF_SALT, 2);
  return [nextChainKey, messageKey];
}

function decryptWithMessageKeyBytes(
  messageKey: Uint8Array,
  ciphertextBytes: Uint8Array,
): string {
  const payload = base64Encode(ciphertextBytes);
  return nip44.v2.decrypt(payload, messageKey);
}

/**
 * Signal-style "sender key" state (symmetric chain) for efficient one-to-many group messages.
 *
 * A sender distributes a fresh SenderKeyDistribution to each group member over a 1:1 Double Ratchet
 * session (forward-secure), then publishes group messages once using OneToManyChannel.
 */
export class SenderKeyState {
  readonly keyId: number;
  private chainKey: Uint8Array;
  private iteration: number;
  private skippedMessageKeys: Map<number, Uint8Array>;

  constructor(keyId: number, chainKey: Uint8Array, iteration: number) {
    if (!Number.isInteger(keyId) || keyId < 0 || keyId > 0xffff_ffff) {
      throw new Error("Invalid keyId (expected u32)");
    }
    if (!(chainKey instanceof Uint8Array) || chainKey.length !== 32) {
      throw new Error("Invalid chainKey (expected 32 bytes)");
    }
    if (
      !Number.isInteger(iteration) ||
      iteration < 0 ||
      iteration > 0xffff_ffff
    ) {
      throw new Error("Invalid iteration (expected u32)");
    }

    this.keyId = keyId >>> 0;
    this.chainKey = new Uint8Array(chainKey);
    this.iteration = iteration >>> 0;
    this.skippedMessageKeys = new Map();
  }

  chainKeyBytes(): Uint8Array {
    return new Uint8Array(this.chainKey);
  }

  iterationNumber(): number {
    return this.iteration;
  }

  skippedLen(): number {
    return this.skippedMessageKeys.size;
  }

  encryptToBytes(plaintext: string): {
    messageNumber: number;
    ciphertext: Uint8Array;
  } {
    const messageNumber = this.iteration;
    const [nextChainKey, messageKey] = deriveMessageKey(this.chainKey);

    this.chainKey = nextChainKey;
    this.iteration = (this.iteration + 1) >>> 0;

    const payload = nip44.v2.encrypt(plaintext, messageKey);
    const ciphertext = base64Decode(payload);
    return { messageNumber, ciphertext };
  }

  encrypt(plaintext: string): { messageNumber: number; ciphertext: string } {
    const { messageNumber, ciphertext } = this.encryptToBytes(plaintext);
    return { messageNumber, ciphertext: base64Encode(ciphertext) };
  }

  decryptFromBytes(messageNumber: number, ciphertextBytes: Uint8Array): string {
    const msgNum = messageNumber >>> 0;

    // Old message: try cached skipped key.
    if (msgNum < this.iteration) {
      const messageKey = this.skippedMessageKeys.get(msgNum);
      if (!messageKey) {
        throw new Error("Missing skipped sender key message");
      }
      this.skippedMessageKeys.delete(msgNum);
      return decryptWithMessageKeyBytes(messageKey, ciphertextBytes);
    }

    // Fast-fail if the sender is too far ahead.
    const delta = (msgNum - this.iteration) >>> 0;
    if (delta > SENDER_KEY_MAX_SKIP) {
      throw new Error("TooManySkippedMessages");
    }

    // Derive and cache keys for skipped messages so we can decrypt out-of-order later.
    while (this.iteration < msgNum) {
      const [nextChainKey, messageKey] = deriveMessageKey(this.chainKey);
      this.chainKey = nextChainKey;
      this.skippedMessageKeys.set(this.iteration, messageKey);
      this.iteration = (this.iteration + 1) >>> 0;
    }

    // Now decrypt the current message using the next derived key.
    const [nextChainKey, messageKey] = deriveMessageKey(this.chainKey);
    this.chainKey = nextChainKey;
    this.iteration = (this.iteration + 1) >>> 0;

    // Prune skipped cache if it grows unbounded.
    this.pruneSkipped();

    return decryptWithMessageKeyBytes(messageKey, ciphertextBytes);
  }

  planDecryptBlind(ciphertextBytes: Uint8Array): SenderKeyBlindDecryptPlan {
    for (const [
      messageNumber,
      messageKey,
    ] of this.skippedMessageKeys.entries()) {
      try {
        const plaintext = decryptWithMessageKeyBytes(
          messageKey,
          ciphertextBytes,
        );
        const nextState = SenderKeyState.fromJSON(this.toJSON());
        nextState.skippedMessageKeys.delete(messageNumber);
        return {
          nextState,
          keyId: this.keyId,
          messageNumber,
          plaintext,
        };
      } catch {
        // Try the next cached key.
      }
    }

    const nextState = SenderKeyState.fromJSON(this.toJSON());
    const maxMessageNumber = Math.min(
      0xffff_ffff,
      this.iteration + SENDER_KEY_MAX_SKIP,
    );

    while (nextState.iteration <= maxMessageNumber) {
      const messageNumber = nextState.iteration;
      const [nextChainKey, messageKey] = deriveMessageKey(nextState.chainKey);
      nextState.chainKey = nextChainKey;
      if (nextState.iteration === 0xffff_ffff) {
        throw new Error("sender-key iteration overflow");
      }
      nextState.iteration = (nextState.iteration + 1) >>> 0;

      try {
        const plaintext = decryptWithMessageKeyBytes(
          messageKey,
          ciphertextBytes,
        );
        nextState.pruneSkipped();
        return {
          nextState,
          keyId: this.keyId,
          messageNumber,
          plaintext,
        };
      } catch {
        nextState.skippedMessageKeys.set(messageNumber, messageKey);
      }
    }

    throw new Error("sender-key blind decrypt failed");
  }

  decryptBlindFromBytes(
    ciphertextBytes: Uint8Array,
  ): SenderKeyBlindDecryptResult {
    const plan = this.planDecryptBlind(ciphertextBytes);
    this.replaceWith(plan.nextState);
    return {
      keyId: plan.keyId,
      messageNumber: plan.messageNumber,
      plaintext: plan.plaintext,
    };
  }

  decrypt(messageNumber: number, ciphertext: string): string {
    const msgNum = messageNumber >>> 0;

    // Preserve Rust behavior: reject far-ahead message numbers without requiring a well-formed
    // ciphertext. This avoids turning a skip-limit error into a base64 error.
    if (msgNum >= this.iteration) {
      const delta = (msgNum - this.iteration) >>> 0;
      if (delta > SENDER_KEY_MAX_SKIP) {
        throw new Error("TooManySkippedMessages");
      }
    }

    const ciphertextBytes = base64Decode(ciphertext);
    return this.decryptFromBytes(msgNum, ciphertextBytes);
  }

  toJSON(): SenderKeyStateSerialized {
    const skipped: Record<string, string> = {};
    for (const [k, v] of this.skippedMessageKeys.entries()) {
      skipped[String(k)] = bytesToHex(v);
    }

    return {
      keyId: this.keyId,
      chainKey: bytesToHex(this.chainKey),
      iteration: this.iteration,
      skippedMessageKeys: Object.keys(skipped).length ? skipped : undefined,
    };
  }

  static fromJSON(data: SenderKeyStateSerialized): SenderKeyState {
    const state = new SenderKeyState(
      data.keyId,
      hexToBytes(data.chainKey),
      data.iteration,
    );
    if (data.skippedMessageKeys) {
      for (const [k, v] of Object.entries(data.skippedMessageKeys)) {
        const n = Number.parseInt(k, 10);
        if (!Number.isFinite(n)) continue;
        const keyBytes = hexToBytes(v);
        if (keyBytes.length !== 32) continue;
        state.skippedMessageKeys.set(n >>> 0, keyBytes);
      }
    }
    return state;
  }

  static fromDistribution(dist: SenderKeyDistribution): SenderKeyState {
    return new SenderKeyState(
      dist.keyId,
      hexToBytes(dist.chainKey),
      dist.iteration,
    );
  }

  private replaceWith(other: SenderKeyState): void {
    this.chainKey = new Uint8Array(other.chainKey);
    this.iteration = other.iteration;
    this.skippedMessageKeys = new Map(
      Array.from(other.skippedMessageKeys.entries()).map(([k, v]) => [
        k,
        new Uint8Array(v),
      ]),
    );
  }

  private pruneSkipped(): void {
    if (this.skippedMessageKeys.size <= SENDER_KEY_MAX_STORED_SKIPPED_KEYS) {
      return;
    }

    const keys = Array.from(this.skippedMessageKeys.keys()).sort(
      (a, b) => a - b,
    );
    const toRemove =
      this.skippedMessageKeys.size - SENDER_KEY_MAX_STORED_SKIPPED_KEYS;
    for (const k of keys.slice(0, toRemove)) {
      this.skippedMessageKeys.delete(k);
    }
  }
}
