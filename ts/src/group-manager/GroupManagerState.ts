import { type VerifiedEvent } from "nostr-tools";
import { Group, type GroupDecryptedEvent } from "../GroupChannel.js";
import {
  type GroupData,
  type GroupMetadata,
  type GroupRosterFact,
} from "../GroupMeta.js";
import type { SenderKeyDistribution } from "../SenderKey.js";
import { OneToManyChannel } from "../OneToManyChannel.js";
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "../StorageAdapter.js";
import {
  type NostrFetch,
  type NostrSubscribe,
  type Rumor,
  type Unsubscribe,
} from "../types.js";
import type {
  GroupManagerErrorContext,
  GroupManagerOptions,
} from "../GroupManager.js";
import type { PendingSessionEvent } from "./groupManagerInternals.js";

export abstract class GroupManagerState {
  protected readonly ourOwnerPubkey: string;

  protected readonly ourDevicePubkey: string;

  protected readonly storage: StorageAdapter;

  protected readonly oneToMany: OneToManyChannel;

  protected readonly nostrSubscribe?: NostrSubscribe;

  protected readonly nostrFetch?: NostrFetch;

  protected readonly onDecryptedEvent?: (event: GroupDecryptedEvent) => void;

  protected readonly onError?: (
    error: unknown,
    context: GroupManagerErrorContext,
  ) => void;

  protected readonly suppressLocalDeviceEcho: boolean;

  protected readonly outerBackfillLookbackSeconds: number;

  protected readonly outerBackfillDurationMs: number;

  protected readonly outerBackfillRetryDelaysMs: number[];

  protected readonly groups = new Map<string, Group>();

  protected readonly senderEventToGroup = new Map<string, string>();

  protected readonly groupToSenderEvents = new Map<string, Set<string>>();

  protected readonly pendingOuterBySenderEvent = new Map<
    string,
    VerifiedEvent[]
  >();

  protected readonly pendingSessionByGroup = new Map<
    string,
    PendingSessionEvent[]
  >();

  protected readonly seenOuterEventIds = new Set<string>();

  protected readonly seenOuterEventOrder: string[] = [];

  protected outerUnsubscribe: Unsubscribe | null = null;

  protected outerAuthorsKey = "";

  protected outerAuthors: string[] = [];

  protected readonly outerBackfillUnsubscribes = new Set<Unsubscribe>();

  protected readonly outerBackfillTimers = new Set<
    ReturnType<typeof setTimeout>
  >();

  protected readonly maxPendingPerSenderEvent = 128;

  protected readonly maxSeenOuterEventIds = 4096;

  protected operationQueue: Promise<void> = Promise.resolve();

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

  protected enqueueOperation<T>(action: () => Promise<T>): Promise<T> {
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

  abstract syncOuterSubscription(): Promise<void>;

  protected abstract clearOuterBackfills(): void;

  protected abstract refreshGroupSenderMappings(groupId: string): Promise<void>;

  protected abstract normalizeRetryDelays(delays: number[]): number[];

  protected abstract startOuterBackfill(addedAuthors: string[]): void;

  protected abstract emitDecryptedEvents(events: GroupDecryptedEvent[]): void;

  protected abstract queuePendingSessionEvent(
    groupId: string,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
  ): void;

  protected abstract handleIncomingMetadataEvent(
    groupId: string,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
    metadata?: GroupMetadata | null,
    rosterFact?: GroupRosterFact | null,
  ): Promise<GroupDecryptedEvent[]>;

  protected abstract handleIncomingSessionEventForKnownGroup(
    groupId: string,
    group: Group,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
    distribution?: SenderKeyDistribution | null,
  ): Promise<GroupDecryptedEvent[]>;

  protected abstract queuePendingOuter(
    senderEventPubkey: string,
    outer: VerifiedEvent,
  ): void;

  protected abstract reportError(
    error: unknown,
    context: GroupManagerErrorContext,
  ): void;

  protected abstract shouldDropLocalEcho(event: GroupDecryptedEvent): boolean;

  protected abstract routeIncomingEvents(
    events: GroupDecryptedEvent[],
  ): GroupDecryptedEvent[];

  protected abstract listLocalSenderEventPubkeys(): Promise<Set<string>>;

  protected abstract hasSeenOuterEvent(eventId: string): boolean;

  protected abstract rememberOuterEvent(eventId: string): void;
}
