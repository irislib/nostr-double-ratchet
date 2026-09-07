import { verifyEvent, type VerifiedEvent } from "nostr-tools";
import {
  buildSenderKeyRepairRequestRumor,
  type SenderKeyRepairRequest,
} from "../SenderKeyRepair.js";
import type { SenderKeyDistribution } from "../SenderKey.js";
import { CHAT_MESSAGE_KIND, MESSAGE_EVENT_KIND, type Rumor, type NostrPublish } from "../types.js";
import { createNostrPublisher } from "../publishing.js";
import { GroupSenderKeys } from "./GroupSenderKeys.js";
import type { PairwiseSend, PublishOuter } from "../GroupChannel.js";

export abstract class GroupSending extends GroupSenderKeys {
  protected senderKeyRecipientOwnerPubkeys(): string[] {
    return Array.from(
      new Set(
        this.memberOwnerPubkeys.filter(
          (pubkey) => typeof pubkey === "string" && pubkey.length > 0,
        ),
      ),
    );
  }

  /**
   * Rotate our sender key (new keyId + chain key) and distribute it to group members.
   */
  async rotateSenderKey(opts: {
    sendPairwise: PairwiseSend;
    nowMs?: number;
  }): Promise<SenderKeyDistribution> {
    await this.init();

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const { senderEventPubkey } = await this.ensureOurSenderEventKeys();
    const { state } = await this.ensureOurSenderKeyState(true);

    const dist = this.buildDistribution(nowSeconds, senderEventPubkey, state);
    const rumor = this.buildDistributionRumor(nowSeconds, nowMs, dist);

    // Include our owner so sibling devices on the same account can decrypt
    // subsequent outer messages in self-only and multi-device group chats.
    const recipients = this.senderKeyRecipientOwnerPubkeys();
    await this.recordSenderKeyRepairSnapshot(dist, recipients);
    await Promise.allSettled(
      recipients.map((pk) => opts.sendPairwise(pk, rumor)),
    );

    return dist;
  }

  /**
   * Send an inner group event over one-to-many transport.
   * Ensures and distributes sender keys, then publishes exactly one outer event.
   */
  async sendEvent(
    event: { kind: number; content: string; tags?: string[][] },
    opts: {
      sendPairwise: PairwiseSend;
      publishOuter: PublishOuter;
      nowMs?: number;
    },
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    await this.init();

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const {
      senderEventSecretKey,
      senderEventPubkey,
      changed: senderEventKeysChanged,
    } = await this.ensureOurSenderEventKeys();
    const { state: senderKey, created: senderKeyCreated } =
      await this.ensureOurSenderKeyState(false);

    // Distribute if we just created the sender key, or if our sender-event pubkey changed.
    if (senderKeyCreated || senderEventKeysChanged) {
      const dist = this.buildDistribution(
        nowSeconds,
        senderEventPubkey,
        senderKey,
      );
      const rumor = this.buildDistributionRumor(nowSeconds, nowMs, dist);
      const recipients = this.senderKeyRecipientOwnerPubkeys();
      await this.recordSenderKeyRepairSnapshot(dist, recipients);
      await Promise.allSettled(
        recipients.map((pk) => opts.sendPairwise(pk, rumor)),
      );
    }

    const inner = this.buildGroupInnerRumor(nowSeconds, nowMs, event);
    const innerJson = JSON.stringify(inner);
    const outer = this.oneToMany.encryptToOuterEvent(
      senderEventSecretKey,
      senderKey,
      innerJson,
      nowSeconds,
    );

    await this.saveSenderKeyState(this.ourDevicePubkey, senderKey);
    await createNostrPublisher(
      opts.publishOuter as NostrPublish,
      this.publicationOptions,
    )(outer, inner.id);

    return { outer, inner };
  }

  /** Send a regular group chat message (kind 14). */
  async sendMessage(
    message: string,
    opts: {
      sendPairwise: PairwiseSend;
      publishOuter: PublishOuter;
      nowMs?: number;
    },
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    return this.sendEvent(
      {
        kind: CHAT_MESSAGE_KIND,
        content: message,
      },
      opts,
    );
  }

  senderKeyRepairRequestForOuterEvent(
    outer: VerifiedEvent,
    createdAtSeconds: number = Math.floor(Date.now() / 1000),
    requiredRevision?: number,
  ): SenderKeyRepairRequest | null {
    if (outer.kind !== MESSAGE_EVENT_KIND) return null;
    if (!verifyEvent(outer)) return null;

    try {
      const parsed = this.oneToMany.parseOuterEvent(outer);
      return {
        groupId: this.groupId(),
        senderEventPubkey: outer.pubkey,
        ...(parsed.isHiddenCounterMessage()
          ? {}
          : {
              keyId: parsed.keyId,
              messageNumber: parsed.messageNumber,
            }),
        ...(requiredRevision !== undefined
          ? { requiredRevision: Math.max(0, Math.floor(requiredRevision)) }
          : {}),
        createdAt: Math.max(0, Math.floor(createdAtSeconds)),
      };
    } catch {
      return null;
    }
  }

  async requestSenderKeyRepair(
    request: SenderKeyRepairRequest,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<Rumor | null> {
    await this.init();

    if (request.groupId !== this.groupId()) return null;
    if (!this.isMemberOwnerPubkey(this.ourOwnerPubkey)) return null;

    const rumor = buildSenderKeyRepairRequestRumor(
      request,
      this.ourDevicePubkey,
      opts.nowMs,
    );
    const recipients = this.senderKeyRecipientOwnerPubkeys();
    await Promise.allSettled(
      recipients.map((pk) => opts.sendPairwise(pk, rumor)),
    );
    return rumor;
  }

  async respondToSenderKeyRepairRequest(
    requesterOwnerPubkey: string,
    request: SenderKeyRepairRequest,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<SenderKeyDistribution | null> {
    await this.init();

    const distributions = await this.repairDistributionsFor(
      requesterOwnerPubkey,
      request,
    );
    if (distributions.length === 0) return null;

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    for (const dist of distributions) {
      const rumor = this.buildDistributionRumor(nowSeconds, nowMs, dist);
      await opts.sendPairwise(requesterOwnerPubkey, rumor);
    }
    return distributions[0]!;
  }
}
