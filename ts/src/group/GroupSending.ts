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

  private assertCurrentRecipients(recipients: string[]): void {
    const current = this.senderKeyRecipientOwnerPubkeys();
    if (!current.includes(this.ourOwnerPubkey)) {
      throw new Error("Cannot send group messages or keys: local owner is not a member");
    }
    if (current.length !== recipients.length || current.some((member) => !recipients.includes(member))) {
      throw new Error("Group membership changed while preparing the send; retry with current members");
    }
  }

  private async flushSenderKeyDistributions(sendPairwise: PairwiseSend): Promise<void> {
    const snapshots = (await this.loadSenderKeyRepairSnapshots(this.ourDevicePubkey))
      .map((snapshot) => ({ ...snapshot }));
    let changed = false;
    for (const snapshot of snapshots) {
      // Older snapshots did not track handoff success; retry their original recipients once.
      const pending = snapshot.pendingRecipients ?? snapshot.recipients;
      if (!pending.length) continue;
      const recipients = pending.filter((recipient) =>
        snapshot.recipients.includes(recipient) && this.isMemberOwnerPubkey(recipient),
      );
      const dist = snapshot.distribution;
      const rumor = this.buildDistributionRumor(dist.createdAt, dist.createdAt * 1000, dist);
      const results = await Promise.allSettled(recipients.map((recipient) => sendPairwise(recipient, rumor)));
      snapshot.pendingRecipients = recipients.filter((_, index) => results[index].status === "rejected");
      changed = true;
    }
    if (changed) await this.saveSenderKeyRepairSnapshots(this.ourDevicePubkey, snapshots);
  }

  /**
   * Rotate our sender key (new keyId + chain key) and distribute it to group members.
   */
  async rotateSenderKey(opts: {
    sendPairwise: PairwiseSend;
    nowMs?: number;
  }): Promise<SenderKeyDistribution> {
    const recipients = this.senderKeyRecipientOwnerPubkeys();
    this.assertCurrentRecipients(recipients);
    await this.init();

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const { senderEventPubkey } = await this.ensureOurSenderEventKeys();
    const { state } = await this.ensureOurSenderKeyState(true);

    const dist = this.buildDistribution(nowSeconds, senderEventPubkey, state);

    // Include our owner so sibling devices on the same account can decrypt
    // subsequent outer messages in self-only and multi-device group chats.
    await this.recordSenderKeyRepairSnapshot(dist, recipients);
    this.assertCurrentRecipients(recipients);
    await this.flushSenderKeyDistributions(opts.sendPairwise);
    this.assertCurrentRecipients(recipients);

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
    const recipients = this.senderKeyRecipientOwnerPubkeys();
    this.assertCurrentRecipients(recipients);
    await this.init();

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const {
      senderEventSecretKey,
      senderEventPubkey,
      changed: senderEventKeysChanged,
    } = await this.ensureOurSenderEventKeys();
    let { state: senderKey, created: senderKeyCreated } =
      await this.ensureOurSenderKeyState(false);
    if (!senderKeyCreated && !await this.senderKeyMatchesRecipients(senderKey, senderEventPubkey, recipients)) {
      ({ state: senderKey, created: senderKeyCreated } = await this.ensureOurSenderKeyState(true));
    }

    // A membership change gets a fresh chain before any new ciphertext is sent.
    // Keep historical repair snapshots so eligible members can recover old messages.
    if (senderKeyCreated || senderEventKeysChanged) {
      const dist = this.buildDistribution(
        nowSeconds,
        senderEventPubkey,
        senderKey,
      );
      await this.recordSenderKeyRepairSnapshot(dist, recipients);
    }

    this.assertCurrentRecipients(recipients);
    await this.flushSenderKeyDistributions(opts.sendPairwise);
    this.assertCurrentRecipients(recipients);
    const inner = this.buildGroupInnerRumor(nowSeconds, nowMs, event);
    const innerJson = JSON.stringify(inner);
    const outer = this.oneToMany.encryptToOuterEvent(
      senderEventSecretKey,
      senderKey,
      innerJson,
      nowSeconds,
    );

    await this.saveSenderKeyState(this.ourDevicePubkey, senderKey);
    this.assertCurrentRecipients(recipients);
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
