import { getEventHash, verifyEvent, type VerifiedEvent } from "nostr-tools";
import {
  Group,
  type GroupDecryptedEvent,
  type PairwiseSend,
  type PublishOuter,
} from "../GroupChannel.js";
import {
  buildGroupRosterFactEvent,
  createGroupData,
  GROUP_ROSTER_FACT_KIND,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
  type GroupMetadata,
  type GroupRosterFact,
  isGroupRosterFactEvent,
  parseGroupRosterFactRumor,
} from "../GroupMeta.js";
import {
  parseSenderKeyRepairRequestRumor,
  type SenderKeyRepairRequest,
} from "../SenderKeyRepair.js";
import {
  parseSenderKeyDistribution,
  type SenderKeyDistribution,
} from "../SenderKey.js";
import { CHAT_MESSAGE_KIND, type Rumor } from "../types.js";
import { GroupManagerState } from "./GroupManagerState.js";
import type { CreateGroupOptions, CreateGroupResult } from "../GroupManager.js";
import {
  getFirstTagValue,
  groupMetadataFromRosterFact,
} from "./groupManagerInternals.js";

export abstract class GroupManagerOperations extends GroupManagerState {
  /**
   * Create and store a group, then fan its roster out over pairwise sessions
   * unless metadata fanout is explicitly disabled.
   */
  async createGroup(
    name: string,
    memberOwnerPubkeys: string[],
    opts: CreateGroupOptions = {},
  ): Promise<CreateGroupResult> {
    return this.enqueueOperation(async () => {
      const group = createGroupData(
        name,
        this.ourOwnerPubkey,
        memberOwnerPubkeys,
      );
      let existing = this.groups.get(group.id);
      if (!existing) {
        existing = new Group({
          data: group,
          ourOwnerPubkey: this.ourOwnerPubkey,
          ourDevicePubkey: this.ourDevicePubkey,
          storage: this.storage,
          oneToMany: this.oneToMany,
        });
        this.groups.set(group.id, existing);
      } else {
        existing.setData(group);
      }

      await this.refreshGroupSenderMappings(group.id);
      await this.syncOuterSubscription();

      const fanoutMetadata = opts.fanoutMetadata ?? true;
      if (!fanoutMetadata) {
        return {
          group,
          fanout: {
            enabled: false,
            attempted: 0,
            succeeded: [],
            failed: [],
          },
        };
      }

      if (!opts.sendPairwise) {
        throw new Error(
          "sendPairwise is required when fanoutMetadata is enabled",
        );
      }

      const nowMs = opts.nowMs ?? Date.now();
      const createdAt = Math.floor(nowMs / 1000);
      const metadataRumor: Rumor = {
        ...buildGroupRosterFactEvent(
          {
            ...group,
            createdAt: Math.floor(group.createdAt / 1000),
          },
          {
            signerPubkey: this.ourOwnerPubkey,
            revision: 1,
            createdBy: this.ourOwnerPubkey,
            updatedAt: createdAt,
            eventCreatedAt: createdAt,
            protocol: "sender_key_v1",
          },
        ),
        pubkey: this.ourOwnerPubkey,
        id: "",
      };
      metadataRumor.id = getEventHash(metadataRumor);

      const recipients = group.members;
      const deliveries = await Promise.allSettled(
        recipients.map(async (recipient) => {
          const rumorForRecipient: Rumor = {
            ...metadataRumor,
            tags: [...metadataRumor.tags, ["p", recipient]],
          };
          rumorForRecipient.id = getEventHash(rumorForRecipient);
          await opts.sendPairwise!(recipient, rumorForRecipient);
          return recipient;
        }),
      );

      const succeeded: string[] = [];
      const failed: string[] = [];
      for (let i = 0; i < deliveries.length; i += 1) {
        const result = deliveries[i]!;
        const recipient = recipients[i]!;
        if (result.status === "fulfilled") {
          succeeded.push(recipient);
        } else {
          failed.push(recipient);
        }
      }

      return {
        group,
        metadataRumor,
        fanout: {
          enabled: true,
          attempted: recipients.length,
          succeeded,
          failed,
        },
      };
    });
  }

  async sendMessage(
    groupId: string,
    message: string,
    opts: {
      sendPairwise: PairwiseSend;
      publishOuter: PublishOuter;
      nowMs?: number;
    },
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    return this.sendEvent(
      groupId,
      {
        kind: CHAT_MESSAGE_KIND,
        content: message,
      },
      opts,
    );
  }

  async sendEvent(
    groupId: string,
    event: { kind: number; content: string; tags?: string[][] },
    opts: {
      sendPairwise: PairwiseSend;
      publishOuter: PublishOuter;
      nowMs?: number;
    },
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    return this.enqueueOperation(async () => {
      const group = this.groups.get(groupId);
      if (!group) {
        throw new Error(`Unknown group: ${groupId}`);
      }

      try {
        const result = await group.sendEvent(event, opts);
        await this.refreshGroupSenderMappings(groupId);
        await this.syncOuterSubscription();
        return result;
      } catch (error) {
        this.reportError(error, { operation: "sendEvent", groupId });
        throw error;
      }
    });
  }

  async rotateSenderKey(
    groupId: string,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<SenderKeyDistribution> {
    return this.enqueueOperation(async () => {
      const group = this.groups.get(groupId);
      if (!group) {
        throw new Error(`Unknown group: ${groupId}`);
      }

      try {
        const result = await group.rotateSenderKey(opts);
        await this.refreshGroupSenderMappings(groupId);
        await this.syncOuterSubscription();
        return result;
      } catch (error) {
        this.reportError(error, { operation: "rotateSenderKey", groupId });
        throw error;
      }
    });
  }

  async requestSenderKeyRepair(
    groupId: string,
    request: SenderKeyRepairRequest,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<Rumor | null> {
    return this.enqueueOperation(async () => {
      const group = this.groups.get(groupId);
      if (!group) {
        throw new Error(`Unknown group: ${groupId}`);
      }

      try {
        return await group.requestSenderKeyRepair(request, opts);
      } catch (error) {
        this.reportError(error, {
          operation: "requestSenderKeyRepair",
          groupId,
        });
        throw error;
      }
    });
  }

  async respondToSenderKeyRepairRequest(
    groupId: string,
    requesterOwnerPubkey: string,
    request: SenderKeyRepairRequest,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<SenderKeyDistribution | null> {
    return this.enqueueOperation(async () => {
      const group = this.groups.get(groupId);
      if (!group) {
        throw new Error(`Unknown group: ${groupId}`);
      }

      try {
        const result = await group.respondToSenderKeyRepairRequest(
          requesterOwnerPubkey,
          request,
          opts,
        );
        await this.refreshGroupSenderMappings(groupId);
        await this.syncOuterSubscription();
        return result;
      } catch (error) {
        this.reportError(error, {
          operation: "respondToSenderKeyRepairRequest",
          groupId,
        });
        throw error;
      }
    });
  }

  senderKeyRepairRequestForOuterEvent(
    groupId: string,
    outer: VerifiedEvent,
    createdAtSeconds?: number,
    requiredRevision?: number,
  ): SenderKeyRepairRequest | null {
    const group = this.groups.get(groupId);
    if (!group) return null;
    return group.senderKeyRepairRequestForOuterEvent(
      outer,
      createdAtSeconds,
      requiredRevision,
    );
  }

  async handleIncomingSessionEvent(
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
  ): Promise<GroupDecryptedEvent[]> {
    return this.enqueueOperation(async () => {
      const taggedGroupId = getFirstTagValue(event.tags, "l");
      let groupId = taggedGroupId;
      let distribution: SenderKeyDistribution | null = null;
      let metadata: GroupMetadata | null = null;
      let rosterFact: GroupRosterFact | null = null;

      if (event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
        distribution = parseSenderKeyDistribution(event.content);
        if (distribution?.groupId) {
          groupId = distribution.groupId;
        }
      } else if (event.kind === GROUP_SENDER_KEY_REPAIR_REQUEST_KIND) {
        const request = parseSenderKeyRepairRequestRumor(event);
        if (request?.groupId) {
          groupId = request.groupId;
        }
      } else if (
        event.kind === GROUP_ROSTER_FACT_KIND &&
        isGroupRosterFactEvent(event)
      ) {
        try {
          rosterFact = parseGroupRosterFactRumor(event);
        } catch (error) {
          this.reportError(error, {
            operation: "handleIncomingSessionEvent",
            eventId: event.id,
          });
          return [];
        }
        groupId = rosterFact.groupId;
        metadata = groupMetadataFromRosterFact(rosterFact);
      }

      if (!groupId) return [];

      try {
        if (rosterFact) {
          const handled = await this.handleIncomingMetadataEvent(
            groupId,
            event,
            fromOwnerPubkey,
            fromSenderDevicePubkey,
            metadata,
            rosterFact,
          );
          const all = this.routeIncomingEvents(handled);
          this.emitDecryptedEvents(all);
          return all;
        }

        const group = this.groups.get(groupId);
        if (!group) {
          this.queuePendingSessionEvent(
            groupId,
            event,
            fromOwnerPubkey,
            fromSenderDevicePubkey,
          );
          return [];
        }

        const handled = await this.handleIncomingSessionEventForKnownGroup(
          groupId,
          group,
          event,
          fromOwnerPubkey,
          fromSenderDevicePubkey,
          distribution,
        );
        const all = this.routeIncomingEvents(handled);
        this.emitDecryptedEvents(all);
        return all;
      } catch (error) {
        this.reportError(error, {
          operation: "handleIncomingSessionEvent",
          groupId,
          eventId: event.id,
        });
        return [];
      }
    });
  }

  async handleOuterEvent(
    outer: VerifiedEvent,
  ): Promise<GroupDecryptedEvent | null> {
    return this.enqueueOperation(async () => {
      if (outer.kind !== this.oneToMany.outerEventKind()) return null;
      // Authenticate before either remembering the id or queueing the event.
      // Otherwise a forged wrapper can suppress the authentic event later.
      try {
        if (!verifyEvent(outer)) return null;
      } catch {
        return null;
      }
      if (this.hasSeenOuterEvent(outer.id)) return null;
      this.rememberOuterEvent(outer.id);

      const senderEventPubkey = outer.pubkey;
      const groupId = this.senderEventToGroup.get(senderEventPubkey);
      if (!groupId) {
        this.queuePendingOuter(senderEventPubkey, outer);
        return null;
      }

      const group = this.groups.get(groupId);
      if (!group) {
        this.queuePendingOuter(senderEventPubkey, outer);
        return null;
      }

      try {
        const decrypted = await group.handleOuterEvent(outer);
        if (decrypted && this.shouldDropLocalEcho(decrypted)) {
          return null;
        }
        if (decrypted) {
          this.emitDecryptedEvents([decrypted]);
        }
        return decrypted;
      } catch (error) {
        this.reportError(error, {
          operation: "handleOuterEvent",
          groupId,
          senderEventPubkey,
          eventId: outer.id,
        });
        return null;
      }
    });
  }

  async syncOuterSubscription(): Promise<void> {
    if (!this.nostrSubscribe && !this.nostrFetch) return;

    let authors = Array.from(this.senderEventToGroup.keys());
    if (this.suppressLocalDeviceEcho && authors.length > 0) {
      const localSenderEvents = await this.listLocalSenderEventPubkeys();
      authors = authors.filter((author) => !localSenderEvents.has(author));
    }
    authors.sort();
    const addedAuthors = authors.filter(
      (author) => !this.outerAuthors.includes(author),
    );
    const authorsKey = authors.join(",");
    if (authorsKey === this.outerAuthorsKey) return;

    try {
      this.outerUnsubscribe?.();
    } catch {
      // ignore teardown errors
    }
    this.outerUnsubscribe = null;
    this.outerAuthorsKey = authorsKey;
    this.outerAuthors = authors;

    if (authors.length === 0) return;

    if (!this.nostrSubscribe) {
      this.startOuterBackfill(addedAuthors);
      return;
    }

    try {
      this.outerUnsubscribe = this.nostrSubscribe(
        {
          kinds: [this.oneToMany.outerEventKind()],
          authors,
        },
        (event) => {
          void this.handleOuterEvent(event).catch((error) => {
            this.reportError(error, {
              operation: "handleOuterEvent",
              senderEventPubkey: event.pubkey,
              eventId: event.id,
            });
          });
        },
      );
      this.startOuterBackfill(addedAuthors);
    } catch (error) {
      this.reportError(error, { operation: "syncOuterSubscription" });
    }
  }
}
