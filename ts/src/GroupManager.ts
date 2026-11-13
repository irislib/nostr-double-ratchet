import { type VerifiedEvent } from "nostr-tools";
import {
  Group,
  type GroupDecryptedEvent,
  type PairwiseSend,
} from "./GroupChannel.js";
import { type GroupData } from "./GroupMeta.js";
import { OneToManyChannel } from "./OneToManyChannel.js";
import { type SenderKeyDistribution } from "./SenderKey.js";
import { type StorageAdapter } from "./StorageAdapter.js";
import { type NostrFetch, type NostrSubscribe, type Rumor } from "./types.js";
import { GroupManagerBackfill } from "./group-manager/GroupManagerBackfill.js";

export interface GroupManagerErrorContext {
  operation:
    | "upsertGroup"
    | "sendEvent"
    | "sendMessage"
    | "rotateSenderKey"
    | "requestSenderKeyRepair"
    | "respondToSenderKeyRepairRequest"
    | "handleIncomingSessionEvent"
    | "handleOuterEvent"
    | "syncOuterSubscription";
  groupId?: string;
  senderEventPubkey?: string;
  eventId?: string;
}

export interface GroupManagerOptions {
  groupDevicePubkeys?: (owners: readonly string[]) => string[];
  beforeConsume?: (event: GroupDecryptedEvent) => Promise<void>;
  onUnreadyDistribution?: (groupId: string, owner: string, author: string) => Promise<void>;
  ourOwnerPubkey: string;
  ourDevicePubkey: string;
  suppressLocalDeviceEcho?: boolean;
  storage?: StorageAdapter;
  oneToMany?: OneToManyChannel;
  nostrGroupSubscribe?: NostrSubscribe;
  nostrGroupFetch?: NostrFetch;
  nostrSubscribe?: NostrSubscribe;
  nostrFetch?: NostrFetch;
  onDecryptedEvent?: (event: GroupDecryptedEvent) => void;
  onError?: (error: unknown, context: GroupManagerErrorContext) => void;
  outerBackfillLookbackSeconds?: number;
  outerBackfillDurationMs?: number;
  outerBackfillRetryDelaysMs?: number[];
}

export interface CreateGroupOptions {
  /**
   * Sends metadata rumors to group members over pairwise sessions.
   * Required when `fanoutMetadata` is true (default).
   */
  sendPairwise?: PairwiseSend;
  /**
   * Controls whether createGroup should immediately fanout metadata to members.
   * Defaults to true.
   */
  fanoutMetadata?: boolean;
  /**
   * Optional timestamp override in milliseconds since epoch (for deterministic tests).
   */
  nowMs?: number;
}

export interface GroupMetadataFanoutResult {
  enabled: boolean;
  attempted: number;
  succeeded: string[];
  failed: string[];
}

export interface CreateGroupResult {
  group: GroupData;
  metadataRumor?: Rumor;
  fanout: GroupMetadataFanoutResult;
}

export class GroupManager extends GroupManagerBackfill {
  private readonly rejectedAuthors = new Map<string, {groupId:string; owner:string; author:string}>();

  /** Local receive readiness only; display metadata cannot release an inbox row. */
  privateDeliveryReadiness(groupId: string): string | undefined {
    const group = this.groups.get(groupId);
    if (!group) return undefined;
    return JSON.stringify([
      [...new Set(group.data.members)].sort(),
      [...(this.groupToSenderEvents.get(groupId) || [])].sort(),
    ]);
  }

  override async upsertGroup(data: GroupData): Promise<void> {
    await super.upsertGroup(data);
    await this.enqueueOperation(async () => {
      // Authenticated key controls can precede the app's local metadata restore.
      this.emitDecryptedEvents(await this.drainPendingSessionEvents(data.id));
    });
  }

  getGroup(groupId: string): GroupData | undefined {
    return this.groups.get(groupId)?.data;
  }

  groupForSenderEvent(senderEventPubkey: string): GroupData | undefined {
    const id = this.senderEventToGroup.get(senderEventPubkey);
    return id ? this.getGroup(id) : undefined;
  }

  protected async handleIncomingSessionEventForKnownGroup(
    groupId: string,
    group: Group,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
    distribution?: SenderKeyDistribution | null,
  ): Promise<GroupDecryptedEvent[]> {
    if (distribution?.senderEventPubkey && fromSenderDevicePubkey && event.pubkey === fromSenderDevicePubkey &&
        !group.data.members.includes(fromOwnerPubkey)) {
      const entry = {groupId, owner: fromOwnerPubkey, author: distribution.senderEventPubkey};
      this.rejectedAuthors.set(JSON.stringify(entry), entry);
      if (this.rejectedAuthors.size > 128) this.rejectedAuthors.delete(this.rejectedAuthors.keys().next().value!);
    }
    const drainedFromGroup = await group.handleIncomingSessionEvent(
      event,
      fromOwnerPubkey,
      fromSenderDevicePubkey,
    );

    await this.refreshGroupSenderMappings(groupId);
    const drainedFromManagerQueue = distribution?.senderEventPubkey &&
      this.senderEventToGroup.get(distribution.senderEventPubkey) === groupId
      ? await this.drainPendingOuterForSenderEvent(distribution.senderEventPubkey, group)
      : [];

    await this.syncOuterSubscription();

    return [...drainedFromGroup, ...drainedFromManagerQueue];
  }

  protected async refreshGroupSenderMappings(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;

    let nextSenderEvents: string[];
    try {
      nextSenderEvents = await group.listSenderEventPubkeys();
    } catch (error) {
      this.reportError(error, { operation: "upsertGroup", groupId });
      return;
    }

    const next = new Set(nextSenderEvents);
    const prev = this.groupToSenderEvents.get(groupId) || new Set<string>();

    for (const senderEventPubkey of prev) {
      if (next.has(senderEventPubkey)) continue;
      const mappedGroupId = this.senderEventToGroup.get(senderEventPubkey);
      if (mappedGroupId === groupId) {
        this.senderEventToGroup.delete(senderEventPubkey);
      }
      this.pendingOuterBySenderEvent.delete(senderEventPubkey);
    }

    for (const senderEventPubkey of next) {
      this.senderEventToGroup.set(senderEventPubkey, groupId);
    }

    this.groupToSenderEvents.set(groupId, next);
    for (const [key, hint] of this.rejectedAuthors) {
      if (hint.groupId !== groupId || !group.data.members.includes(hint.owner)) continue;
      if (!next.has(hint.author)) await this.onUnreadyDistribution?.(groupId, hint.owner, hint.author);
      this.rejectedAuthors.delete(key);
    }
  }

  protected queuePendingOuter(
    senderEventPubkey: string,
    outer: VerifiedEvent,
  ): void {
    const pending = this.pendingOuterBySenderEvent.get(senderEventPubkey) || [];
    if (pending.length >= this.maxPendingPerSenderEvent) {
      pending.shift();
    }
    pending.push(outer);
    this.pendingOuterBySenderEvent.set(senderEventPubkey, pending);
  }

  protected async drainPendingOuterForSenderEvent(
    senderEventPubkey: string,
    group: Group,
  ): Promise<GroupDecryptedEvent[]> {
    const pending = this.pendingOuterBySenderEvent.get(senderEventPubkey);
    if (!pending || pending.length === 0) return [];
    this.pendingOuterBySenderEvent.delete(senderEventPubkey);

    const withMessageNumber = pending
      .map((outer) => {
        try {
          const parsed = this.oneToMany.parseOuterEvent(outer);
          return { outer, messageNumber: parsed.messageNumber };
        } catch {
          return { outer, messageNumber: 0 };
        }
      })
      .sort((a, b) => a.messageNumber - b.messageNumber);

    const decrypted: GroupDecryptedEvent[] = [];
    for (const { outer } of withMessageNumber) {
      const event = await group.handleOuterEvent(outer);
      if (event) decrypted.push(event);
    }
    return decrypted;
  }

  protected reportError(
    error: unknown,
    context: GroupManagerErrorContext,
  ): void {
    this.onError?.(error, context);
  }

  protected shouldDropLocalEcho(event: GroupDecryptedEvent): boolean {
    return this.suppressLocalDeviceEcho && event.origin === "local-device";
  }

  protected routeIncomingEvents(
    events: GroupDecryptedEvent[],
  ): GroupDecryptedEvent[] {
    if (!this.suppressLocalDeviceEcho) return events;
    return events.filter((event) => !this.shouldDropLocalEcho(event));
  }

  protected async listLocalSenderEventPubkeys(): Promise<Set<string>> {
    const local = new Set<string>();
    await Promise.allSettled(
      Array.from(this.groups.values()).map(async (group) => {
        const senderEventPubkey = await group.getSenderEventPubkeyForDevice(
          this.ourDevicePubkey,
        );
        if (senderEventPubkey) {
          local.add(senderEventPubkey);
        }
      }),
    );
    return local;
  }

  protected normalizeRetryDelays(delays: number[]): number[] {
    const normalized = Array.from(
      new Set(
        delays
          .filter((delay) => Number.isFinite(delay) && delay >= 0)
          .map((delay) => Math.floor(delay)),
      ),
    ).sort((a, b) => a - b);
    return normalized.length > 0 ? normalized : [0];
  }

  protected hasSeenOuterEvent(eventId: string): boolean {
    return this.seenOuterEventIds.has(eventId);
  }

  protected rememberOuterEvent(eventId: string): void {
    if (this.seenOuterEventIds.has(eventId)) return;
    this.seenOuterEventIds.add(eventId);
    this.seenOuterEventOrder.push(eventId);

    while (this.seenOuterEventOrder.length > this.maxSeenOuterEventIds) {
      const oldest = this.seenOuterEventOrder.shift();
      if (oldest) {
        this.seenOuterEventIds.delete(oldest);
      }
    }
  }

  protected sortOuterEvents(events: VerifiedEvent[]): VerifiedEvent[] {
    const authorCounts = new Map<string, number>();
    for (const event of events) {
      authorCounts.set(event.pubkey, (authorCounts.get(event.pubkey) ?? 0) + 1);
    }

    return events
      .map((event) => {
        let keyId = 0;
        let messageNumber = 0;
        if (authorCounts.get(event.pubkey)! > 1) {
          try {
            const parsed = this.oneToMany.parseOuterEvent(event);
            keyId = parsed.keyId;
            messageNumber = parsed.messageNumber;
          } catch {
            // ignore malformed content in ordering
          }
        }
        return { event, keyId, messageNumber };
      })
      .sort((a, b) => {
        if (a.event.pubkey !== b.event.pubkey) {
          return a.event.pubkey.localeCompare(b.event.pubkey);
        }

        if (a.keyId !== b.keyId) return a.keyId - b.keyId;
        if (a.messageNumber !== b.messageNumber) {
          return a.messageNumber - b.messageNumber;
        }
        if (a.event.created_at !== b.event.created_at) {
          return a.event.created_at - b.event.created_at;
        }
        return a.event.id.localeCompare(b.event.id);
      })
      .map(({ event }) => event);
  }
}
