import type { NostrPublishContext } from "./types.js";
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
import { hexToBytes } from "@noble/hashes/utils";
import { type StorageAdapter } from "./StorageAdapter.js";
import { CHAT_MESSAGE_KIND, MESSAGE_EVENT_KIND, type Rumor, type NostrPublisherOptions } from "./types.js";
import { GroupSending } from "./group/GroupSending.js";
import { isHex32 } from "./group/groupInternals.js";

export type PairwiseSend = (
  recipientOwnerPubkey: string,
  rumor: Rumor,
) => Promise<void>;
export type PublishOuter = (
  outer: VerifiedEvent,
  innerEventId?: string,
  context?: NostrPublishContext,
) => Promise<unknown>;

export interface GroupOptions extends NostrPublisherOptions {
  groupDevicePubkeys?: (owners: readonly string[]) => string[];
  /** Persist idempotently by outerEventId before advancing receive state. A
   * crash after this callback but before its acknowledgement may replay it. */
  beforeConsume?: (event: GroupDecryptedEvent) => Promise<void>;
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
 * - The sender-key envelope stays inside separate recipient Double Ratchet deliveries.
 *
 * This class is transport-agnostic:
 * - You provide `sendPairwise` for distributing keys over 1:1 sessions.
 * - `publishOuter` is retained as an API parameter but is never used for group traffic.
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

    if (dist.senderEventPubkey && (dist.senderEventPubkey === senderDevicePubkey ||
        dist.senderEventPubkey === this.ourDevicePubkey || this.isMemberOwnerPubkey(dist.senderEventPubkey))) return [];
    const bound = dist.senderEventPubkey && this.senderEventToDevice.get(dist.senderEventPubkey);
    if (bound && bound !== senderDevicePubkey) return [];
    const drainKey = `${this.groupSenderPrefix(senderDevicePubkey)}/pending-key-drain/${dist.keyId >>> 0}`;
    const markDrain = () => this.storage.put(drainKey, true);
    // Persist sender->owner mapping (for UI attribution).
    this.senderDeviceToOwner.set(senderDevicePubkey, fromOwnerPubkey);
    await this.storage.put(
      this.senderOwnerPubkeyKey(senderDevicePubkey),
      fromOwnerPubkey,
    );

    // Learn/update sender-event pubkey mapping (used to route outer messages).
    let mappingChanged = false;
    if (dist.senderEventPubkey && isHex32(dist.senderEventPubkey)) {
      mappingChanged =
        this.senderDeviceToEvent.get(senderDevicePubkey) !== dist.senderEventPubkey ||
        this.senderEventToDevice.get(dist.senderEventPubkey) !== senderDevicePubkey;
      if (mappingChanged) await markDrain();
      await this.storage.put(
        this.senderEventPubkeyKey(senderDevicePubkey),
        dist.senderEventPubkey,
      );
      this.setSenderEventMapping(senderDevicePubkey, dist.senderEventPubkey);
    }

    // Store sender key state for this key id if we don't already have one.
    const existing = await this.storage.get<SenderKeyStateSerialized>(
      this.senderKeyStateKey(senderDevicePubkey, dist.keyId),
    );
    const originKey = this.senderKeyOriginKey(senderDevicePubkey, dist.keyId);
    let keyStateChanged = false;
    if (!existing) {
      const st = SenderKeyState.fromDistribution(dist);
      await markDrain();
      await this.saveSenderKeyState(senderDevicePubkey, st);
      await this.storage.put(originKey, { iteration: dist.iteration, chainKey: dist.chainKey });
      keyStateChanged = true;
    } else {
      // Copies of one distribution are made at different chain positions and
      // arrive in any order. An earlier copy opens the messages before the
      // first position this device learned.
      const origin = await this.storage.get<{ iteration: number; chainKey: string }>(originKey);
      // Complete an interrupted initial state/origin write without rewinding
      // a chain that has already consumed messages.
      if (!origin && existing.iteration === dist.iteration && existing.chainKey === dist.chainKey) {
        await markDrain();
        await this.storage.put(originKey, { iteration: dist.iteration, chainKey: dist.chainKey });
        keyStateChanged = true;
      }
      if (origin && typeof origin.chainKey === "string" && dist.iteration < origin.iteration) {
        let extended: SenderKeyState | undefined;
        try {
          const st = SenderKeyState.fromJSON(existing);
          if (st.extendBackwards(origin.iteration, hexToBytes(origin.chainKey), dist.iteration, hexToBytes(dist.chainKey))) extended = st;
        } catch {
          // A corrupt saved state or origin leaves the existing key as it is.
        }
        if (extended) {
          await markDrain();
          await this.saveSenderKeyState(senderDevicePubkey, extended);
          await this.storage.put(originKey, { iteration: dist.iteration, chainKey: dist.chainKey });
          keyStateChanged = true;
        }
      }
    }
    await this.rememberReceivedSenderKeyPreference(
      senderDevicePubkey, dist.keyId, dist.createdAt,
    );

    // Clean duplicates still skip scanning. A persisted unfinished drain survives
    // partial storage writes, failed application callbacks and process restart.
    if (dist.senderEventPubkey && isHex32(dist.senderEventPubkey) &&
        (mappingChanged || keyStateChanged || await this.storage.get(drainKey))) {
      const recovered = await this.drainPending(dist.senderEventPubkey, dist.keyId);
      await this.storage.del(drainKey);
      return recovered;
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
      await this.queuePending(
        senderEventPubkey,
        parsed.isHiddenCounterMessage() ? undefined : parsed.keyId,
        outer,
      );
      return null;
    }
    // The local sending chain has already advanced past its own relay echoes.
    if (senderDevicePubkey === this.ourDevicePubkey &&
        await this.storage.get(this.senderEventSecretKeyKey(senderDevicePubkey))) return null;
    if (!this.isSenderDeviceActive(senderDevicePubkey)) {
      await this.removeSenderDeviceState(senderDevicePubkey);
      return null;
    }

    const pending = await this.pendingOuter.find(senderEventPubkey,
      parsed.isHiddenCounterMessage() ? undefined : parsed.keyId, outer.id);
    const delivered = pending?.event.delivered;
    if (pending && delivered) {
      const saved = await this.loadSenderKeyState(senderDevicePubkey, delivered.keyId);
      if (saved && saved.iterationNumber() > delivered.messageNumber &&
          !saved.toJSON().skippedMessageKeys?.[String(delivered.messageNumber)]) {
        // Authentication and the application callback completed before the
        // consuming state write. A failed deletion must not re-decrypt forever.
        await this.pendingOuter.remove(pending.key, pending.event);
        return null;
      }
    }

    if (await this.consumedOuter.has(outer.id)) {
      if (pending) await this.pendingOuter.remove(pending.key, pending.event);
      return null;
    }

    let plaintext = "";
    let keyId = parsed.keyId;
    let messageNumber = parsed.messageNumber;
    let nextState: SenderKeyState | null = null;
    let needsReceivedKeyHint = false;

    if (parsed.isHiddenCounterMessage()) {
      const preferred = await this.loadPreferredReceivedSenderKeyState(senderDevicePubkey);
      needsReceivedKeyHint = !preferred;
      let plan = preferred?.planDecryptFrontier(parsed.ciphertext) ?? null;
      if (!plan) {
        // A frontier miss is not an invalid message. Preserve skipped-key and
        // older-epoch recovery, probing remaining key frontiers before scanning.
        const loaded = await this.loadSenderKeyStates(senderDevicePubkey);
        const ordered = preferred
          ? [preferred, ...loaded.filter((state) => state.keyId !== preferred.keyId)]
          : loaded;
        if (ordered.length > 1) {
          for (const state of ordered) {
            if (preferred && state.keyId === preferred.keyId) continue;
            plan = state.planDecryptFrontier(parsed.ciphertext);
            if (plan) break;
          }
        }
        if (!plan) {
          for (const state of ordered) {
            try {
              plan = state.planDecryptBlind(parsed.ciphertext);
              break;
            } catch {
              // Try the next known sender key.
            }
          }
        }
      }
      if (!plan) {
        await this.queuePending(senderEventPubkey, undefined, outer);
        return null;
      }
      plaintext = plan.plaintext;
      keyId = plan.keyId;
      messageNumber = plan.messageNumber;
      nextState = plan.nextState;
    } else {
      const st = await this.loadSenderKeyState(
        senderDevicePubkey,
        parsed.keyId,
      );
      if (!st) {
        await this.queuePending(senderEventPubkey, parsed.keyId, outer);
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

    const decrypted = {
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
    if (delivered && (delivered.keyId !== keyId || delivered.messageNumber !== messageNumber)) {
      throw new Error("Pending delivery does not match authenticated ciphertext");
    }
    if (!delivered) {
      await this.beforeConsume?.(decrypted);
      if (pending) await this.pendingOuter.acknowledge(pending.key, pending.event, { keyId, messageNumber });
    }
    await this.saveSenderKeyState(senderDevicePubkey, nextState);
    await this.consumedOuter.remember(outer.id);
    if (pending) await this.pendingOuter.remove(pending.key, pending.event);
    if (needsReceivedKeyHint) await this.rememberReceivedSenderKeyPreference(senderDevicePubkey, keyId);
    return decrypted;
  }
}
