import { getEventHash, verifyEvent, type VerifiedEvent } from "nostr-tools";
import {
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
  type GroupData,
} from "./GroupMeta.js";
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
  type MessageOrigin,
} from "./MessageOrigin.js";
import { OneToManyChannel } from "./OneToManyChannel.js";
import { parseSenderKeyRepairRequestRumor } from "./SenderKeyRepair.js";
import type { SenderKeyStateSerialized } from "./SenderKey.js";
import { parseSenderKeyDistribution, SenderKeyState } from "./SenderKey.js";
import { type StorageAdapter } from "./StorageAdapter.js";
import { CHAT_MESSAGE_KIND, MESSAGE_EVENT_KIND, type Rumor } from "./types.js";
import { GroupSending } from "./group/GroupSending.js";
import { isHex32 } from "./group/groupInternals.js";

export type PairwiseSend = (
  recipientOwnerPubkey: string,
  rumor: Rumor,
) => Promise<void>;
export type PublishOuter = (
  outer: VerifiedEvent,
  innerEventId?: string,
) => Promise<unknown>;

export interface GroupOptions {
  data: GroupData;
  /** Owner pubkey for *this* device (group membership is expressed in owner pubkeys). */
  ourOwnerPubkey: string;
  /** Device identity pubkey for *this* device (used inside encrypted payloads). */
  ourDevicePubkey: string;
  storage?: StorageAdapter;
  oneToMany?: OneToManyChannel;
}

export interface GroupDecryptedEvent {
  groupId: string;
  senderEventPubkey: string;
  senderDevicePubkey: string;
  senderOwnerPubkey?: string;
  origin: MessageOrigin;
  isSelf: boolean;
  isCrossDeviceSelf: boolean;
  outerEventId: string;
  outerCreatedAt: number;
  keyId: number;
  messageNumber: number;
  inner: Rumor;
}

function getFirstTagValue(
  tags: string[][] | undefined,
  key: string,
): string | undefined {
  const t = tags?.find((tag) => tag[0] === key);
  return t?.[1];
}

/**
 * Signal-style efficient group messaging:
 *
 * - Each *device* has a per-group "sender event" pubkey (outer Nostr author).
 * - Each device uses a symmetric SenderKeyState chain for forward secrecy within that sender.
 * - Sender keys are distributed pairwise over 1:1 Double Ratchet sessions (forward secure).
 * - Group messages are published once using OneToManyChannel.
 *
 * This class is transport-agnostic:
 * - You provide `sendPairwise` for distributing keys over 1:1 sessions.
 * - You provide `publishOuter` for publishing the one-to-many outer events.
 * - You feed it incoming session rumors + outer events via the `handle…` methods.
 */

export class Group extends GroupSending {
  /**
   * Consume a sender-key distribution or repair request received through an
   * authenticated pairwise session.
   */
  async handleIncomingSessionEvent(
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
  ): Promise<GroupDecryptedEvent[]> {
    await this.init();

    if (!this.memberOwnerPubkeys.includes(fromOwnerPubkey)) {
      return [];
    }

    const gid = getFirstTagValue(event.tags, "l");
    if (gid !== this.groupId()) return [];

    if (event.kind === GROUP_SENDER_KEY_REPAIR_REQUEST_KIND) {
      const request = parseSenderKeyRepairRequestRumor(event);
      if (!request || request.groupId !== this.groupId()) return [];

      const senderDevicePubkey = fromSenderDevicePubkey;
      if (!senderDevicePubkey || !isHex32(senderDevicePubkey)) return [];
      if (isHex32(event.pubkey) && event.pubkey !== senderDevicePubkey)
        return [];

      const origin = classifyMessageOrigin({
        ourOwnerPubkey: this.ourOwnerPubkey,
        ourDevicePubkey: this.ourDevicePubkey,
        senderOwnerPubkey: fromOwnerPubkey,
        senderDevicePubkey,
      });

      return [
        {
          groupId: this.groupId(),
          senderEventPubkey: senderDevicePubkey,
          senderDevicePubkey,
          senderOwnerPubkey: fromOwnerPubkey,
          origin,
          isSelf: isSelfOrigin(origin),
          isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
          outerEventId: event.id,
          outerCreatedAt: event.created_at,
          keyId: request.keyId ?? 0,
          messageNumber: request.messageNumber ?? 0,
          inner: event,
        },
      ];
    }

    if (event.kind !== GROUP_SENDER_KEY_DISTRIBUTION_KIND) return [];

    const dist = parseSenderKeyDistribution(event.content);
    if (!dist) return [];
    if (dist.groupId !== this.groupId()) return [];

    const senderDevicePubkey = fromSenderDevicePubkey;
    if (!senderDevicePubkey || !isHex32(senderDevicePubkey)) return [];
    if (isHex32(event.pubkey) && event.pubkey !== senderDevicePubkey) return [];

    // Persist sender->owner mapping (for UI attribution).
    this.senderDeviceToOwner.set(senderDevicePubkey, fromOwnerPubkey);
    await this.storage.put(
      this.senderOwnerPubkeyKey(senderDevicePubkey),
      fromOwnerPubkey,
    );

    // Learn/update sender-event pubkey mapping (used to route outer messages).
    if (dist.senderEventPubkey && isHex32(dist.senderEventPubkey)) {
      this.setSenderEventMapping(senderDevicePubkey, dist.senderEventPubkey);
      await this.storage.put(
        this.senderEventPubkeyKey(senderDevicePubkey),
        dist.senderEventPubkey,
      );
    }

    // Store sender key state for this key id if we don't already have one.
    const existing = await this.storage.get<SenderKeyStateSerialized>(
      this.senderKeyStateKey(senderDevicePubkey, dist.keyId),
    );
    if (!existing) {
      const st = SenderKeyState.fromDistribution(dist);
      await this.saveSenderKeyState(senderDevicePubkey, st);
    }

    // If we have a sender-event pubkey, retry pending outer events for (senderEventPubkey,keyId).
    if (dist.senderEventPubkey && isHex32(dist.senderEventPubkey)) {
      return await this.drainPending(dist.senderEventPubkey, dist.keyId);
    }

    return [];
  }

  /**
   * Decrypt an incoming one-to-many outer event, or queue it until its sender
   * mapping and key state become available.
   */
  async handleOuterEvent(
    outer: VerifiedEvent,
  ): Promise<GroupDecryptedEvent | null> {
    await this.init();
    await this.purgeInactiveSenders();

    if (outer.kind !== MESSAGE_EVENT_KIND) return null;
    if (!verifyEvent(outer)) return null;

    let parsed: ReturnType<OneToManyChannel["parseOuterEvent"]>;
    try {
      parsed = this.oneToMany.parseOuterEvent(outer);
    } catch {
      return null;
    }

    const senderEventPubkey = outer.pubkey;
    const senderDevicePubkey = this.senderEventToDevice.get(senderEventPubkey);
    if (!senderDevicePubkey) {
      this.queuePending(
        senderEventPubkey,
        parsed.isHiddenCounterMessage() ? undefined : parsed.keyId,
        outer,
      );
      return null;
    }
    if (!this.isSenderDeviceActive(senderDevicePubkey)) {
      await this.removeSenderDeviceState(senderDevicePubkey);
      return null;
    }

    let plaintext = "";
    let keyId = parsed.keyId;
    let messageNumber = parsed.messageNumber;
    let nextState: SenderKeyState | null = null;

    if (parsed.isHiddenCounterMessage()) {
      const states = await this.loadSenderKeyStates(senderDevicePubkey);
      for (const state of states) {
        const candidate = SenderKeyState.fromJSON(state.toJSON());
        try {
          const decrypted = candidate.decryptBlindFromBytes(parsed.ciphertext);
          plaintext = decrypted.plaintext;
          keyId = decrypted.keyId;
          messageNumber = decrypted.messageNumber;
          nextState = candidate;
          break;
        } catch {
          // Try the next known sender key.
        }
      }
      if (!nextState) {
        this.queuePending(senderEventPubkey, undefined, outer);
        return null;
      }
    } else {
      const st = await this.loadSenderKeyState(
        senderDevicePubkey,
        parsed.keyId,
      );
      if (!st) {
        this.queuePending(senderEventPubkey, parsed.keyId, outer);
        return null;
      }

      nextState = SenderKeyState.fromJSON(st.toJSON());
      try {
        plaintext = nextState.decryptFromBytes(
          parsed.messageNumber,
          parsed.ciphertext,
        );
      } catch {
        return null;
      }
    }

    let inner: Rumor;
    try {
      inner = JSON.parse(plaintext) as Rumor;
    } catch {
      // Not a Nostr JSON event; wrap as a message-shaped rumor.
      inner = {
        kind: CHAT_MESSAGE_KIND,
        content: plaintext,
        created_at: outer.created_at,
        tags: [["l", this.groupId()]],
        pubkey: senderDevicePubkey,
        id: "",
      };
      inner.id = getEventHash(inner);
    }

    // Best-effort sanity: ensure this is the right group (encrypted, so shouldn't leak).
    const innerGid = getFirstTagValue(inner.tags, "l");
    if (innerGid && innerGid !== this.groupId()) {
      return null;
    }

    await this.saveSenderKeyState(senderDevicePubkey, nextState);

    const senderOwnerPubkey =
      this.senderDeviceToOwner.get(senderDevicePubkey) ||
      (await this.storage.get<string>(
        this.senderOwnerPubkeyKey(senderDevicePubkey),
      )) ||
      undefined;

    const origin = classifyMessageOrigin({
      ourOwnerPubkey: this.ourOwnerPubkey,
      ourDevicePubkey: this.ourDevicePubkey,
      senderOwnerPubkey,
      senderDevicePubkey,
    });

    return {
      groupId: this.groupId(),
      senderEventPubkey,
      senderDevicePubkey,
      senderOwnerPubkey,
      origin,
      isSelf: isSelfOrigin(origin),
      isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
      outerEventId: outer.id,
      outerCreatedAt: outer.created_at,
      keyId,
      messageNumber,
      inner,
    };
  }
}
