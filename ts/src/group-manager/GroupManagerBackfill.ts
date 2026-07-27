import { type VerifiedEvent } from "nostr-tools";
import { Group, type GroupDecryptedEvent } from "../GroupChannel.js";
import {
  applyMetadataUpdate,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  type GroupMetadata,
  type GroupRosterFact,
  validateMetadataCreation,
  validateMetadataUpdate,
} from "../GroupMeta.js";
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
} from "../MessageOrigin.js";
import {
  parseSenderKeyDistribution,
  type SenderKeyDistribution,
} from "../SenderKey.js";
import { type Rumor } from "../types.js";
import { GroupManagerOperations } from "./GroupManagerOperations.js";
import type { GroupManagerErrorContext } from "../GroupManager.js";

export abstract class GroupManagerBackfill extends GroupManagerOperations {
  managedGroupIds(): string[] {
    return Array.from(this.groups.keys()).sort();
  }

  knownSenderEventPubkeys(): string[] {
    return Array.from(this.senderEventToGroup.keys()).sort();
  }

  protected startOuterBackfill(addedAuthors: string[]): void {
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

  protected currentBackfillAuthors(candidateAuthors: string[]): string[] {
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

  protected async runOuterBackfillAttempt(
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

  protected async fetchOuterBackfill(authors: string[]): Promise<void> {
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

  protected openOuterBackfillSubscription(authors: string[]): void {
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

  protected clearOuterBackfills(): void {
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

  protected emitDecryptedEvents(events: GroupDecryptedEvent[]): void {
    if (!this.onDecryptedEvent) return;
    for (const event of events) {
      this.onDecryptedEvent(event);
    }
  }

  protected queuePendingSessionEvent(
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

  protected async handleIncomingMetadataEvent(
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

  protected buildMetadataEvent(
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

  protected async drainPendingSessionEvents(
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

  protected abstract handleIncomingSessionEventForKnownGroup(
    groupId: string,
    group: Group,
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
    distribution?: SenderKeyDistribution | null,
  ): Promise<GroupDecryptedEvent[]>;

  protected abstract refreshGroupSenderMappings(groupId: string): Promise<void>;

  protected abstract reportError(
    error: unknown,
    context: GroupManagerErrorContext,
  ): void;

  protected abstract sortOuterEvents(events: VerifiedEvent[]): VerifiedEvent[];
}
