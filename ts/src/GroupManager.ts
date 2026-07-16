import { getEventHash, type VerifiedEvent } from "nostr-tools";

import {
  Group,
  type GroupDecryptedEvent,
  type PairwiseSend,
  type PublishOuter,
} from "./GroupChannel.js";
import {
  applyMetadataUpdate,
  buildGroupRosterFactEvent,
  createGroupData,
  GROUP_ROSTER_FACT_KIND,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
  type GroupData,
  type GroupMetadata,
  type GroupRosterFact,
  isGroupRosterFactEvent,
  parseGroupRosterFactRumor,
  validateMetadataCreation,
  validateMetadataUpdate,
} from "./GroupMeta.js";
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
} from "./MessageOrigin.js";
import { OneToManyChannel } from "./OneToManyChannel.js";
import {
  parseSenderKeyRepairRequestRumor,
  type SenderKeyRepairRequest,
} from "./SenderKeyRepair.js";
import type { SenderKeyDistribution } from "./SenderKey.js";
import { InMemoryStorageAdapter, type StorageAdapter } from "./StorageAdapter.js";
import {
  CHAT_MESSAGE_KIND,
  type NostrFetch,
  type NostrSubscribe,
  type Rumor,
  type Unsubscribe,
} from "./types.js";

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
  ourOwnerPubkey: string;
  ourDevicePubkey: string;
  suppressLocalDeviceEcho?: boolean;
  storage?: StorageAdapter;
  oneToMany?: OneToManyChannel;
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

function getFirstTagValue(
  tags: string[][] | undefined,
  key: string,
): string | undefined {
  const t = tags?.find((tag) => tag[0] === key);
  return t?.[1];
}

function isHex32(value: string): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function parseSenderKeyDistribution(
  content: string,
): SenderKeyDistribution | null {
  try {
    const d = JSON.parse(content) as Partial<SenderKeyDistribution>;
    if (!d || typeof d !== "object") return null;
    if (typeof d.groupId !== "string") return null;
    if (
      typeof d.keyId !== "number" ||
      !Number.isInteger(d.keyId) ||
      d.keyId < 0
    )
      return null;
    if (typeof d.chainKey !== "string" || !/^[0-9a-f]{64}$/i.test(d.chainKey))
      return null;
    if (
      typeof d.iteration !== "number" ||
      !Number.isInteger(d.iteration) ||
      d.iteration < 0
    )
      return null;
    if (
      typeof d.createdAt !== "number" ||
      !Number.isInteger(d.createdAt) ||
      d.createdAt < 0
    )
      return null;
    if (
      d.senderEventPubkey !== undefined &&
      typeof d.senderEventPubkey !== "string"
    )
      return null;
    return d as SenderKeyDistribution;
  } catch {
    return null;
  }
}

function groupMetadataFromRosterFact(fact: GroupRosterFact): GroupMetadata {
  return {
    id: fact.group.id,
    name: fact.group.name,
    members: fact.group.members,
    admins: fact.group.admins,
    ...(fact.group.description && { description: fact.group.description }),
    ...(fact.group.picture && { picture: fact.group.picture }),
  };
}

interface PendingSessionEvent {
  event: Rumor;
  fromOwnerPubkey: string;
  fromSenderDevicePubkey?: string;
}

export class GroupManager {
  private readonly ourOwnerPubkey: string;
  private readonly ourDevicePubkey: string;
  private readonly storage: StorageAdapter;
  private readonly oneToMany: OneToManyChannel;
  private readonly nostrSubscribe?: NostrSubscribe;
  private readonly nostrFetch?: NostrFetch;
  private readonly onDecryptedEvent?: (event: GroupDecryptedEvent) => void;
  private readonly onError?: (
    error: unknown,
    context: GroupManagerErrorContext,
  ) => void;
  private readonly suppressLocalDeviceEcho: boolean;
  private readonly outerBackfillLookbackSeconds: number;
  private readonly outerBackfillDurationMs: number;
  private readonly outerBackfillRetryDelaysMs: number[];

  private readonly groups = new Map<string, Group>();
  private readonly senderEventToGroup = new Map<string, string>();
  private readonly groupToSenderEvents = new Map<string, Set<string>>();
  private readonly pendingOuterBySenderEvent = new Map<
    string,
    VerifiedEvent[]
  >();
  private readonly pendingSessionByGroup = new Map<
    string,
    PendingSessionEvent[]
  >();
  private readonly seenOuterEventIds = new Set<string>();
  private readonly seenOuterEventOrder: string[] = [];

  private outerUnsubscribe: Unsubscribe | null = null;
  private outerAuthorsKey = "";
  private outerAuthors: string[] = [];
  private readonly outerBackfillUnsubscribes = new Set<Unsubscribe>();
  private readonly outerBackfillTimers = new Set<
    ReturnType<typeof setTimeout>
  >();
  private readonly maxPendingPerSenderEvent = 128;
  private readonly maxSeenOuterEventIds = 4096;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(opts: GroupManagerOptions) {
    this.ourOwnerPubkey = opts.ourOwnerPubkey;
    this.ourDevicePubkey = opts.ourDevicePubkey;
    this.storage = opts.storage || new InMemoryStorageAdapter();
    this.oneToMany = opts.oneToMany || OneToManyChannel.default();
    this.nostrSubscribe = opts.nostrSubscribe;
    this.nostrFetch = opts.nostrFetch;
    this.onDecryptedEvent = opts.onDecryptedEvent;
    this.onError = opts.onError;
    this.suppressLocalDeviceEcho = opts.suppressLocalDeviceEcho ?? true;
    this.outerBackfillLookbackSeconds =
      opts.outerBackfillLookbackSeconds ?? 3600;
    this.outerBackfillDurationMs = opts.outerBackfillDurationMs ?? 2000;
    this.outerBackfillRetryDelaysMs = this.normalizeRetryDelays(
      opts.outerBackfillRetryDelaysMs ?? [0, 500, 1500],
    );
  }

  private enqueueOperation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    const result = previous.catch(() => undefined).then(action);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async upsertGroup(data: GroupData): Promise<void> {
    await this.enqueueOperation(async () => {
      const groupId = data.id;
      let group = this.groups.get(groupId);
      if (!group) {
        group = new Group({
          data,
          ourOwnerPubkey: this.ourOwnerPubkey,
          ourDevicePubkey: this.ourDevicePubkey,
          storage: this.storage,
          oneToMany: this.oneToMany,
        });
        this.groups.set(groupId, group);
      } else {
        group.setData(data);
      }

      await this.refreshGroupSenderMappings(groupId);
      await this.syncOuterSubscription();
    });
  }

  removeGroup(groupId: string): void {
    this.groups.delete(groupId);
    this.pendingSessionByGroup.delete(groupId);

    const senderEvents = this.groupToSenderEvents.get(groupId);
    if (senderEvents) {
      for (const senderEventPubkey of senderEvents) {
        const mappedGroupId = this.senderEventToGroup.get(senderEventPubkey);
        if (mappedGroupId === groupId) {
          this.senderEventToGroup.delete(senderEventPubkey);
        }
        this.pendingOuterBySenderEvent.delete(senderEventPubkey);
      }
    }
    this.groupToSenderEvents.delete(groupId);

    void this.syncOuterSubscription();
  }

  destroy(): void {
    try {
      this.outerUnsubscribe?.();
    } catch {
      // ignore teardown errors
    }
    this.outerUnsubscribe = null;
    this.outerAuthorsKey = "";
    this.outerAuthors = [];
    this.clearOuterBackfills();

    this.groups.clear();
    this.senderEventToGroup.clear();
    this.groupToSenderEvents.clear();
    this.pendingOuterBySenderEvent.clear();
    this.pendingSessionByGroup.clear();
    this.seenOuterEventIds.clear();
    this.seenOuterEventOrder.length = 0;
  }

  /**
   * High-level helper for app flows:
   * - Creates local group data and stores it in this manager.
   * - By default, fans out group roster facts to members over pairwise sessions.
   *
   * Note: `createGroupData` remains pure/local-only. Use this method when you want
   * creation + delivery in one step.
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
      } else if (event.kind === GROUP_ROSTER_FACT_KIND && isGroupRosterFactEvent(event)) {
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

  managedGroupIds(): string[] {
    return Array.from(this.groups.keys()).sort();
  }

  knownSenderEventPubkeys(): string[] {
    return Array.from(this.senderEventToGroup.keys()).sort();
  }

  private startOuterBackfill(addedAuthors: string[]): void {
    if ((!this.nostrSubscribe && !this.nostrFetch) || addedAuthors.length === 0)
      return;
    if (this.outerBackfillLookbackSeconds <= 0) return;
    if (!this.nostrFetch && this.outerBackfillDurationMs <= 0) return;

    for (const delayMs of this.outerBackfillRetryDelaysMs) {
      if (delayMs <= 0) {
        void this.runOuterBackfillAttempt(addedAuthors);
        continue;
      }

      const timer = setTimeout(() => {
        this.outerBackfillTimers.delete(timer);
        void this.runOuterBackfillAttempt(addedAuthors);
      }, delayMs);
      this.outerBackfillTimers.add(timer);
    }
  }

  private currentBackfillAuthors(candidateAuthors: string[]): string[] {
    const authors = Array.from(
      new Set(
        candidateAuthors.filter(
          (author) =>
            author &&
            this.senderEventToGroup.has(author) &&
            this.outerAuthors.includes(author),
        ),
      ),
    ).sort();
    return authors;
  }

  private async runOuterBackfillAttempt(
    candidateAuthors: string[],
  ): Promise<void> {
    const authors = this.currentBackfillAuthors(candidateAuthors);
    if (authors.length === 0) return;

    if (this.nostrFetch) {
      await this.fetchOuterBackfill(authors);
      return;
    }

    this.openOuterBackfillSubscription(authors);
  }

  private async fetchOuterBackfill(authors: string[]): Promise<void> {
    if (!this.nostrFetch) return;

    const since = Math.max(
      0,
      Math.floor(Date.now() / 1000) - this.outerBackfillLookbackSeconds,
    );

    try {
      const events = await this.nostrFetch({
        kinds: [this.oneToMany.outerEventKind()],
        authors,
        since,
      });
      for (const event of this.sortOuterEvents(events)) {
        await this.handleOuterEvent(event).catch((error) => {
          this.reportError(error, {
            operation: "handleOuterEvent",
            senderEventPubkey: event.pubkey,
            eventId: event.id,
          });
        });
      }
    } catch (error) {
      this.reportError(error, { operation: "syncOuterSubscription" });
    }
  }

  private openOuterBackfillSubscription(authors: string[]): void {
    if (!this.nostrSubscribe) return;

    const since = Math.max(
      0,
      Math.floor(Date.now() / 1000) - this.outerBackfillLookbackSeconds,
    );

    try {
      const unsubscribe = this.nostrSubscribe(
        {
          kinds: [this.oneToMany.outerEventKind()],
          authors,
          since,
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

      this.outerBackfillUnsubscribes.add(unsubscribe);
      const timer = setTimeout(() => {
        this.outerBackfillTimers.delete(timer);
        this.outerBackfillUnsubscribes.delete(unsubscribe);
        try {
          unsubscribe();
        } catch {
          // ignore teardown errors
        }
      }, this.outerBackfillDurationMs);
      this.outerBackfillTimers.add(timer);
    } catch (error) {
      this.reportError(error, { operation: "syncOuterSubscription" });
    }
  }

  private clearOuterBackfills(): void {
    for (const timer of this.outerBackfillTimers) {
      clearTimeout(timer);
    }
    this.outerBackfillTimers.clear();

    for (const unsubscribe of this.outerBackfillUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        // ignore teardown errors
      }
    }
    this.outerBackfillUnsubscribes.clear();
  }

  private emitDecryptedEvents(events: GroupDecryptedEvent[]): void {
    if (!this.onDecryptedEvent) return;
    for (const event of events) {
      this.onDecryptedEvent(event);
    }
  }

  private queuePendingSessionEvent(
    groupId: string,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
  ): void {
    const pending = this.pendingSessionByGroup.get(groupId) || [];
    pending.push({
      event,
      fromOwnerPubkey,
      fromSenderDevicePubkey,
    });
    this.pendingSessionByGroup.set(groupId, pending);
  }

  private async handleIncomingMetadataEvent(
    groupId: string,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
    metadata?: GroupMetadata | null,
    rosterFact?: GroupRosterFact | null,
  ): Promise<GroupDecryptedEvent[]> {
    const parsed = metadata;
    if (!parsed) return [];

    const synthetic = this.buildMetadataEvent(
      groupId,
      event,
      fromOwnerPubkey,
      fromSenderDevicePubkey,
    );

    const existing = this.groups.get(groupId);
    if (existing) {
      const result = validateMetadataUpdate(
        existing.data,
        parsed,
        fromOwnerPubkey,
        this.ourOwnerPubkey,
      );
      if (result === "reject") {
        return [];
      }
      if (result === "removed") {
        this.removeGroup(groupId);
        return [synthetic];
      }

      existing.setData(applyMetadataUpdate(existing.data, parsed));
    } else {
      if (
        !validateMetadataCreation(parsed, fromOwnerPubkey, this.ourOwnerPubkey)
      ) {
        return [];
      }

      const group = new Group({
        data: {
          id: parsed.id,
          name: parsed.name,
          members: parsed.members,
          admins: parsed.admins,
          createdAt: rosterFact
            ? rosterFact.group.createdAt * 1000
            : event.created_at * 1000,
          ...(parsed.description ? { description: parsed.description } : {}),
          ...(parsed.picture ? { picture: parsed.picture } : {}),
          accepted: false,
        },
        ourOwnerPubkey: this.ourOwnerPubkey,
        ourDevicePubkey: this.ourDevicePubkey,
        storage: this.storage,
        oneToMany: this.oneToMany,
      });
      this.groups.set(groupId, group);
    }

    await this.refreshGroupSenderMappings(groupId);
    await this.syncOuterSubscription();

    const drained = await this.drainPendingSessionEvents(groupId);
    return [synthetic, ...drained];
  }

  private buildMetadataEvent(
    groupId: string,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
  ): GroupDecryptedEvent {
    const senderDevicePubkey = fromSenderDevicePubkey || event.pubkey;
    const origin = classifyMessageOrigin({
      ourOwnerPubkey: this.ourOwnerPubkey,
      ourDevicePubkey: this.ourDevicePubkey,
      senderOwnerPubkey: fromOwnerPubkey,
      senderDevicePubkey,
    });

    return {
      groupId,
      senderEventPubkey: senderDevicePubkey,
      senderDevicePubkey,
      senderOwnerPubkey: fromOwnerPubkey,
      origin,
      isSelf: isSelfOrigin(origin),
      isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
      outerEventId: event.id,
      outerCreatedAt: event.created_at,
      keyId: 0,
      messageNumber: 0,
      inner: event,
    };
  }

  private async drainPendingSessionEvents(
    groupId: string,
  ): Promise<GroupDecryptedEvent[]> {
    const pending = this.pendingSessionByGroup.get(groupId);
    if (!pending || pending.length === 0) {
      return [];
    }
    this.pendingSessionByGroup.delete(groupId);

    const group = this.groups.get(groupId);
    if (!group) {
      return [];
    }

    const drained: GroupDecryptedEvent[] = [];
    for (const queued of pending) {
      const distribution =
        queued.event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND
          ? parseSenderKeyDistribution(queued.event.content)
          : null;
      drained.push(
        ...(await this.handleIncomingSessionEventForKnownGroup(
          groupId,
          group,
          queued.event,
          queued.fromOwnerPubkey,
          queued.fromSenderDevicePubkey,
          distribution,
        )),
      );
    }

    return drained;
  }

  private async handleIncomingSessionEventForKnownGroup(
    groupId: string,
    group: Group,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
    distribution?: SenderKeyDistribution | null,
  ): Promise<GroupDecryptedEvent[]> {
    const drainedFromGroup = await group.handleIncomingSessionEvent(
      event,
      fromOwnerPubkey,
      fromSenderDevicePubkey,
    );

    const drainedFromManagerQueue: GroupDecryptedEvent[] = [];
    if (
      distribution?.senderEventPubkey &&
      isHex32(distribution.senderEventPubkey)
    ) {
      this.bindSenderEventToGroup(groupId, distribution.senderEventPubkey);
      const drained = await this.drainPendingOuterForSenderEvent(
        distribution.senderEventPubkey,
        group,
      );
      drainedFromManagerQueue.push(...drained);
    }

    await this.refreshGroupSenderMappings(groupId);
    await this.syncOuterSubscription();

    return [...drainedFromGroup, ...drainedFromManagerQueue];
  }

  private bindSenderEventToGroup(
    groupId: string,
    senderEventPubkey: string,
  ): void {
    this.senderEventToGroup.set(senderEventPubkey, groupId);
    const current = this.groupToSenderEvents.get(groupId) || new Set<string>();
    current.add(senderEventPubkey);
    this.groupToSenderEvents.set(groupId, current);
  }

  private async refreshGroupSenderMappings(groupId: string): Promise<void> {
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
  }

  private queuePendingOuter(
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

  private async drainPendingOuterForSenderEvent(
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

  private reportError(error: unknown, context: GroupManagerErrorContext): void {
    this.onError?.(error, context);
  }

  private shouldDropLocalEcho(event: GroupDecryptedEvent): boolean {
    return this.suppressLocalDeviceEcho && event.origin === "local-device";
  }

  private routeIncomingEvents(
    events: GroupDecryptedEvent[],
  ): GroupDecryptedEvent[] {
    if (!this.suppressLocalDeviceEcho) return events;
    return events.filter((event) => !this.shouldDropLocalEcho(event));
  }

  private async listLocalSenderEventPubkeys(): Promise<Set<string>> {
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

  private normalizeRetryDelays(delays: number[]): number[] {
    const normalized = Array.from(
      new Set(
        delays
          .filter((delay) => Number.isFinite(delay) && delay >= 0)
          .map((delay) => Math.floor(delay)),
      ),
    ).sort((a, b) => a - b);
    return normalized.length > 0 ? normalized : [0];
  }

  private hasSeenOuterEvent(eventId: string): boolean {
    return this.seenOuterEventIds.has(eventId);
  }

  private rememberOuterEvent(eventId: string): void {
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

  private sortOuterEvents(events: VerifiedEvent[]): VerifiedEvent[] {
    return [...events].sort((a, b) => {
      if (a.pubkey !== b.pubkey) return a.pubkey.localeCompare(b.pubkey);

      let aKeyId = 0;
      let bKeyId = 0;
      let aMessageNumber = 0;
      let bMessageNumber = 0;
      try {
        const parsed = this.oneToMany.parseOuterEvent(a);
        aKeyId = parsed.keyId;
        aMessageNumber = parsed.messageNumber;
      } catch {
        // ignore malformed content in ordering
      }
      try {
        const parsed = this.oneToMany.parseOuterEvent(b);
        bKeyId = parsed.keyId;
        bMessageNumber = parsed.messageNumber;
      } catch {
        // ignore malformed content in ordering
      }

      if (aKeyId !== bKeyId) return aKeyId - bKeyId;
      if (aMessageNumber !== bMessageNumber)
        return aMessageNumber - bMessageNumber;
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.id.localeCompare(b.id);
    });
  }
}
