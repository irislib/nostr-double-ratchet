import { getPublicKey, finalizeEvent } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { Rumor, NostrEvent, SHARED_CHANNEL_KIND } from "./types.js";

export { SHARED_CHANNEL_KIND };

/**
 * A shared NIP-44 encrypted channel derived from a secret key.
 * All participants who know the secret can publish and read events.
 * Inner content is Rumors identifying the real author.
 */
export class SharedChannel {
  readonly publicKey: string;
  private secretKey: Uint8Array;
  private conversationKey: Uint8Array;

  constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
    this.publicKey = getPublicKey(secretKey);
    this.conversationKey = nip44.v2.utils.getConversationKey(
      secretKey,
      this.publicKey
    );
  }

  /** Encrypt a Rumor and return a signed outer event ready for publishing */
  createEvent(rumor: Rumor) {
    const json = JSON.stringify(rumor);
    const encrypted = nip44.v2.encrypt(json, this.conversationKey);
    return finalizeEvent(
      {
        kind: SHARED_CHANNEL_KIND,
        content: encrypted,
        tags: [["p", this.publicKey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.secretKey
    );
  }

  /** Decrypt an outer event and return the inner Rumor */
  decryptEvent(event: NostrEvent): Rumor {
    const json = nip44.v2.decrypt(event.content, this.conversationKey);
    return JSON.parse(json) as Rumor;
  }

  /** Check if an event belongs to this channel */
  isChannelEvent(event: NostrEvent): boolean {
    return (
      event.pubkey === this.publicKey && event.kind === SHARED_CHANNEL_KIND
    );
  }
}
