import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";

import { MESSAGE_EVENT_KIND } from "./types.js";
import { base64Decode, base64Encode } from "./base64.js";
import { SenderKeyState } from "./SenderKey.js";

/**
 * Parsed one-to-many outer payload.
 *
 * New outer content is: base64(nip44_ciphertext_bytes)
 *
 * Legacy no-header outers with base64(keyId_be || messageNumber_be || ciphertext) still parse.
 */
export class OneToManyMessage {
  constructor(
    public readonly keyId: number,
    public readonly messageNumber: number,
    public readonly ciphertext: Uint8Array,
    public readonly encryptedHeader?: string,
  ) {}

  isHiddenCounterMessage(): boolean {
    return this.encryptedHeader !== undefined;
  }

  decrypt(state: SenderKeyState): string {
    if (this.isHiddenCounterMessage()) {
      return state.decryptBlindFromBytes(this.ciphertext).plaintext;
    }
    return state.decryptFromBytes(this.messageNumber, this.ciphertext);
  }
}

/**
 * A lightweight helper for "one-to-many" publishing:
 *
 * - Outer Nostr event is authored by a sender-controlled pubkey (eg per-group sender keypair).
 * - New outer content hides sender-key counters and carries only base64 ciphertext bytes.
 * - Ciphertext bytes are produced/consumed by SenderKeyState.
 */
export class OneToManyChannel {
  private readonly outerKind: number;

  constructor(outerKind: number = MESSAGE_EVENT_KIND) {
    this.outerKind = outerKind;
  }

  static default(): OneToManyChannel {
    return new OneToManyChannel(MESSAGE_EVENT_KIND);
  }

  outerEventKind(): number {
    return this.outerKind;
  }

  buildOuterContent(
    _keyId: number,
    _messageNumber: number,
    ciphertextBytes: Uint8Array,
  ): string {
    return this.buildHiddenOuterContent(ciphertextBytes);
  }

  buildHiddenOuterContent(ciphertextBytes: Uint8Array): string {
    return base64Encode(ciphertextBytes);
  }

  buildLegacyOuterContent(
    keyId: number,
    messageNumber: number,
    ciphertextBytes: Uint8Array,
  ): string {
    const payload = new Uint8Array(8 + ciphertextBytes.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, keyId >>> 0, false);
    view.setUint32(4, messageNumber >>> 0, false);
    payload.set(ciphertextBytes, 8);
    return base64Encode(payload);
  }

  parseOuterContent(content: string): OneToManyMessage {
    const ciphertext = base64Decode(content);
    return new OneToManyMessage(0, 0, ciphertext, "");
  }

  parseLegacyOuterContent(content: string): OneToManyMessage {
    const bytes = base64Decode(content);
    if (bytes.length < 8) {
      throw new Error("one-to-many payload too short");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const keyId = view.getUint32(0, false);
    const messageNumber = view.getUint32(4, false);
    const ciphertext = bytes.subarray(8);
    return new OneToManyMessage(keyId, messageNumber, ciphertext);
  }

  parseOuterEvent(event: VerifiedEvent): OneToManyMessage {
    if (event.kind !== this.outerKind) {
      throw new Error(
        `unexpected kind ${event.kind}, expected ${this.outerKind}`,
      );
    }
    if (!verifyEvent(event)) {
      throw new Error("invalid outer event signature");
    }

    const encryptedHeader = getFirstTagValue(event.tags, "header");
    if (encryptedHeader !== undefined) {
      return new OneToManyMessage(
        0,
        0,
        base64Decode(event.content),
        encryptedHeader,
      );
    }

    return this.parseLegacyOuterContent(event.content);
  }

  encryptToOuterEvent(
    senderEventSecretKey: Uint8Array,
    senderKey: SenderKeyState,
    innerPlaintext: string,
    createdAt: number,
  ): VerifiedEvent {
    const { messageNumber, ciphertext } =
      senderKey.encryptToBytes(innerPlaintext);
    const content = this.buildOuterContent(
      senderKey.keyId,
      messageNumber,
      ciphertext,
    );

    const template: EventTemplate = {
      kind: this.outerKind,
      content,
      tags: [["header", encryptedCoverHeader(senderEventSecretKey)]],
      created_at: createdAt,
    };

    return finalizeEvent(template, senderEventSecretKey);
  }
}

function encryptedCoverHeader(senderEventSecretKey: Uint8Array): string {
  const senderEventPubkey = getPublicKey(senderEventSecretKey);
  const conversationKey = nip44.getConversationKey(
    senderEventSecretKey,
    senderEventPubkey,
  );
  return nip44.encrypt(
    JSON.stringify({
      v: 1,
      type: "sender-key-cover",
    }),
    conversationKey,
  );
}

function getFirstTagValue(
  tags: string[][] | undefined,
  key: string,
): string | undefined {
  return tags?.find((tag) => tag[0] === key)?.[1];
}
