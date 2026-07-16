import { generateSecretKey, getPublicKey, nip44, finalizeEvent, VerifiedEvent, UnsignedEvent, getEventHash, validateEvent } from "nostr-tools";

import {
  SessionState,
  Header,
  Unsubscribe,
  EventCallback,
  MESSAGE_EVENT_KIND,
  Rumor,
} from "./types.js";
import { DUMMY_INNER_PUBKEY } from "./messageBuilders.js";
import { kdf, deepCopyState } from "./utils.js";

const MAX_SKIP = 1000;

/**
 * Double ratchet secure communication session over Nostr
 * 
 * Very similar to Signal's "Double Ratchet with header encryption"
 * https://signal.org/docs/specifications/doubleratchet/
 */
export class Session {
  private internalSubscriptions = new Map<number, EventCallback>();
  private currentInternalSubscriptionId = 0;
  public name: string;

  // 1. CHANNEL PUBLIC INTERFACE
  constructor(public state: SessionState) {
    this.name = Math.random().toString(36).substring(2, 6);
  }

  /**
   * Initializes a new secure communication session
   * @param theirEphemeralNostrPublicKey The ephemeral public key of the other party for the initial handshake
   * @param ourEphemeralNostrPrivateKey Our ephemeral private key for the initial handshake
   * @param isInitiator Whether we are initiating the conversation (true) or responding (false)
   * @param sharedSecret Initial shared secret for securing the first message chain
   * @param name Optional name for the session (for debugging)
   * @returns A new Session instance
   */
  static init(
    theirEphemeralNostrPublicKey: string,
    ourEphemeralNostrPrivateKey: Uint8Array,
    isInitiator: boolean,
    sharedSecret: Uint8Array,
    name?: string
  ): Session {
    const ourNextPrivateKey = generateSecretKey();
    
    let rootKey: Uint8Array;
    let sendingChainKey: Uint8Array | undefined;
    let ourCurrentNostrKey: { publicKey: string, privateKey: Uint8Array } | undefined;
    let ourNextNostrKey: { publicKey: string, privateKey: Uint8Array };
    
    if (isInitiator) {
      [rootKey, sendingChainKey] = kdf(sharedSecret, nip44.getConversationKey(ourNextPrivateKey, theirEphemeralNostrPublicKey), 2);
      ourCurrentNostrKey = { 
        publicKey: getPublicKey(ourEphemeralNostrPrivateKey), 
        privateKey: ourEphemeralNostrPrivateKey 
      };
      ourNextNostrKey = { 
        publicKey: getPublicKey(ourNextPrivateKey), 
        privateKey: ourNextPrivateKey 
      };
    } else {
      rootKey = sharedSecret;
      sendingChainKey = undefined;
      ourCurrentNostrKey = undefined;
      ourNextNostrKey = { 
        publicKey: getPublicKey(ourEphemeralNostrPrivateKey), 
        privateKey: ourEphemeralNostrPrivateKey 
      };
    }
    
    const state: SessionState = {
      rootKey,
      theirNextNostrPublicKey: theirEphemeralNostrPublicKey,
      ourCurrentNostrKey,
      ourNextNostrKey,
      receivingChainKey: undefined,
      sendingChainKey,
      sendingChainMessageNumber: 0,
      receivingChainMessageNumber: 0,
      previousSendingChainMessageCount: 0,
      skippedKeys: {},
    };

    const session = new Session(state);
    if (name) session.name = name;
    return session;
  }

  /**
   * Send a partial Nostr event through the encrypted session.
   * Message builders are responsible for chat-specific kinds, tags, and expiration policy.
   * @param event Partial inner event to send. Must be unsigned. Id will be generated if not provided.
   * @returns A verified Nostr event containing the encrypted message. You need to publish this event to the Nostr network.
   * @throws Error if we are not the initiator and trying to send the first message
   */
  sendEvent(
    event: Partial<UnsignedEvent>,
    outerTags: string[][] = [],
  ): {event: VerifiedEvent, innerEvent: Rumor} {
    if (!this.state.theirNextNostrPublicKey || !this.state.ourCurrentNostrKey) {
      throw new Error("we are not the initiator, so we can't send the first message");
    }

    if ("sig" in event) {
      throw new Error("Event must be unsigned " + JSON.stringify(event));
    }
    if (event.kind === undefined) {
      throw new Error("Event kind is required");
    }

    const now = Date.now()

    const rumor: Partial<Rumor> = {
      ...event,
      content: event.content || "",
      kind: event.kind,
      created_at: event.created_at || Math.floor(now / 1000),
      tags: (event.tags || []).map((tag) => [...tag]),
      pubkey: event.pubkey || DUMMY_INNER_PUBKEY,
    }

    rumor.id = getEventHash(rumor as Rumor);

    const [header, encryptedData] = this.ratchetEncrypt(JSON.stringify(rumor));
    
    const sharedSecret = nip44.getConversationKey(this.state.ourCurrentNostrKey.privateKey, this.state.theirNextNostrPublicKey);
    const encryptedHeader = nip44.encrypt(JSON.stringify(header), sharedSecret);
    
    const nostrEvent = finalizeEvent({
      content: encryptedData,
      kind: MESSAGE_EVENT_KIND,
      tags: [["header", encryptedHeader], ...outerTags.map((tag) => [...tag])],
      created_at: Math.floor(now / 1000)
    }, this.state.ourCurrentNostrKey.privateKey);

    return {event: nostrEvent, innerEvent: rumor as Rumor};
  }

  /**
   * Subscribe to rumors decrypted by receiveEvent().
   * @param callback Function to be called when a message is received
   * @returns Unsubscribe function to stop receiving messages
   */
  onEvent(callback: EventCallback): Unsubscribe {
    const id = this.currentInternalSubscriptionId++
    this.internalSubscriptions.set(id, callback)
    return () => this.internalSubscriptions.delete(id)
  }

  /**
   * Stop local receiveEvent() callbacks.
   */
  close() {
    this.internalSubscriptions.clear();
  }

  // 2. RATCHET FUNCTIONS
  private ratchetEncrypt(plaintext: string): [Header, string] {
    const [newSendingChainKey, messageKey] = kdf(this.state.sendingChainKey!, new Uint8Array([1]), 2);
    this.state.sendingChainKey = newSendingChainKey;
    const header: Header = {
      number: this.state.sendingChainMessageNumber++,
      nextPublicKey: this.state.ourNextNostrKey.publicKey,
      previousChainLength: this.state.previousSendingChainMessageCount
    };
    return [header, nip44.encrypt(plaintext, messageKey)];
  }

  private ratchetDecrypt(header: Header, ciphertext: string, nostrSender: string): string {
    const plaintext = this.trySkippedMessageKeys(header, ciphertext, nostrSender);
    if (plaintext) return plaintext;

    this.skipMessageKeys(header.number, nostrSender);
    
    const [newReceivingChainKey, messageKey] = kdf(this.state.receivingChainKey!, new Uint8Array([1]), 2);
    this.state.receivingChainKey = newReceivingChainKey;
    this.state.receivingChainMessageNumber++;

    return nip44.decrypt(ciphertext, messageKey);
  }

  private ratchetStep() {
    this.state.previousSendingChainMessageCount = this.state.sendingChainMessageNumber;
    this.state.sendingChainMessageNumber = 0;
    this.state.receivingChainMessageNumber = 0;

    const conversationKey1 = nip44.getConversationKey(this.state.ourNextNostrKey.privateKey, this.state.theirNextNostrPublicKey!);
    const [theirRootKey, receivingChainKey] = kdf(this.state.rootKey, conversationKey1, 2);

    this.state.receivingChainKey = receivingChainKey;

    this.state.ourCurrentNostrKey = this.state.ourNextNostrKey;
    const ourNextSecretKey = generateSecretKey();
    this.state.ourNextNostrKey = {
      publicKey: getPublicKey(ourNextSecretKey),
      privateKey: ourNextSecretKey
    };

    const conversationKey2 = nip44.getConversationKey(this.state.ourNextNostrKey.privateKey, this.state.theirNextNostrPublicKey!);
    const [rootKey, sendingChainKey] = kdf(theirRootKey, conversationKey2, 2);
    this.state.rootKey = rootKey;
    this.state.sendingChainKey = sendingChainKey;
  }

  // 3. MESSAGE KEY FUNCTIONS
  private skipMessageKeys(until: number, nostrSender: string) {
    if (until <= this.state.receivingChainMessageNumber) return

    if (until > this.state.receivingChainMessageNumber + MAX_SKIP) {
      throw new Error("Too many skipped messages");
    }

    if (!this.state.skippedKeys[nostrSender]) {
      this.state.skippedKeys[nostrSender] = {
        headerKeys: [],
        messageKeys: {}
      };
      
      // Store header keys
      if (this.state.ourCurrentNostrKey) {
        const currentSecret = nip44.getConversationKey(this.state.ourCurrentNostrKey.privateKey, nostrSender);
        if (!this.state.skippedKeys[nostrSender].headerKeys.includes(currentSecret)) {
          this.state.skippedKeys[nostrSender].headerKeys.push(currentSecret);
        }
      }
      const nextSecret = nip44.getConversationKey(this.state.ourNextNostrKey.privateKey, nostrSender);
      if (!this.state.skippedKeys[nostrSender].headerKeys.includes(nextSecret)) {
        this.state.skippedKeys[nostrSender].headerKeys.push(nextSecret);
      }
    }

    while (this.state.receivingChainMessageNumber < until) {
      const [newReceivingChainKey, messageKey] = kdf(this.state.receivingChainKey!, new Uint8Array([1]), 2);
      this.state.receivingChainKey = newReceivingChainKey;
      this.state.skippedKeys[nostrSender].messageKeys[this.state.receivingChainMessageNumber] = messageKey;
      this.state.receivingChainMessageNumber++;
    }
  }

  private trySkippedMessageKeys(header: Header, ciphertext: string, nostrSender: string): string | null {
    const skippedKeys = this.state.skippedKeys[nostrSender];
    if (!skippedKeys) return null;

    const messageKey = skippedKeys.messageKeys[header.number];
    if (!messageKey) return null;

    delete skippedKeys.messageKeys[header.number];
    
    // Clean up if no more skipped messages
    if (Object.keys(skippedKeys.messageKeys).length === 0) {
      delete this.state.skippedKeys[nostrSender];
    }
    
    return nip44.decrypt(ciphertext, messageKey);
  }

  // 4. NOSTR EVENT HANDLING
  private decryptHeader(event: { tags: string[][]; pubkey: string }): [Header, boolean, boolean] {
    const encryptedHeader = event.tags.find(([key]) => key === "header")?.[1];
    if (!encryptedHeader) {
      throw new Error("Missing encrypted header");
    }
    if (
      this.state.ourCurrentNostrKey &&
      (!this.state.theirCurrentNostrPublicKey ||
        event.pubkey === this.state.theirCurrentNostrPublicKey ||
        event.pubkey === this.state.theirNextNostrPublicKey)
    ) {
      const currentSecret = nip44.getConversationKey(this.state.ourCurrentNostrKey.privateKey, event.pubkey);
      try {
        const header = JSON.parse(nip44.decrypt(encryptedHeader, currentSecret)) as Header;
        return [header, false, false];
      } catch {
        // Decryption with currentSecret failed, try with nextSecret
      }
    }

    if (
      !this.state.theirNextNostrPublicKey ||
      event.pubkey === this.state.theirNextNostrPublicKey
    ) {
      const nextSecret = nip44.getConversationKey(this.state.ourNextNostrKey.privateKey, event.pubkey);
      try {
        const header = JSON.parse(nip44.decrypt(encryptedHeader, nextSecret)) as Header;
        return [header, true, false];
      } catch {
        // Decryption with nextSecret also failed
      }
    }

    const skippedKeys = this.state.skippedKeys[event.pubkey];
    if (skippedKeys?.headerKeys) {
      for (const key of skippedKeys.headerKeys) {
        try {
          const header = JSON.parse(nip44.decrypt(encryptedHeader, key)) as Header;
          return [header, false, true];
        } catch {
          // Decryption failed, try next secret
        }
      }
    }

    throw new Error("Failed to decrypt header with current and skipped header keys");
  }


  receiveEvent(e: VerifiedEvent): Rumor | undefined {
    const snapshot = deepCopyState(this.state);

    try {
      const [header, shouldRatchet, isSkipped] = this.decryptHeader(e);
      if (!isSkipped && this.state.theirNextNostrPublicKey !== header.nextPublicKey) {
        this.state.theirCurrentNostrPublicKey = this.state.theirNextNostrPublicKey;
        this.state.theirNextNostrPublicKey = header.nextPublicKey;
      }

      if (!isSkipped) {
        if (shouldRatchet) {
          this.skipMessageKeys(header.previousChainLength, e.pubkey);
          this.ratchetStep();
        }
      } else {
        if (!this.state.skippedKeys[e.pubkey]?.messageKeys[header.number]) {
          return;
        }
      }

      const text = this.ratchetDecrypt(header, e.content, e.pubkey);
      const innerEvent = JSON.parse(text);

      if (!validateEvent(innerEvent)) {
        this.state = snapshot;
        return;
      }
      // The `id` field is derived; don't trust the sender-provided value.
      innerEvent.id = getEventHash(innerEvent);

      this.internalSubscriptions.forEach(callback => callback(innerEvent, e));
      return innerEvent
    } catch (error) {
      this.state = snapshot;
      if (error instanceof Error) {
        if (error.message.includes("Failed to decrypt header")) {
          return undefined;
        }

        if (error.message === "invalid MAC") {
          // Duplicate or stale ciphertexts can hit decrypt() again after a state restore.
          // nip44 throws "invalid MAC" in that case, but the message has already been handled.
          return undefined;
        }
      }
      throw error;
    }
  }
}
