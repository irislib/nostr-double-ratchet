import { AppKeys, buildAppKeysFilter } from "../AppKeys.js";
import {
  SessionManager,
  type QueuedMessageDiagnostic,
  type SendMessageOptions,
} from "../SessionManager.js";
import {
  type ChatSettingsPayloadV1,
  type ExpirationOptions,
  MESSAGE_EVENT_KIND,
  type ReceiptType,
  type Rumor,
  type Unsubscribe,
} from "../types.js";
import { type VerifiedEvent } from "nostr-tools";
import { NdrRuntimeCore } from "./NdrRuntimeCore.js";
import type { NdrRuntimeState } from "../NdrRuntime.js";
import { cloneAppKeys } from "./runtimeInternals.js";

export abstract class NdrRuntimeMessaging extends NdrRuntimeCore {
  async sendEvent(
    recipientPubkey: string,
    event: Partial<Rumor>,
    ownerPubkey?: string,
  ): Promise<Rumor | undefined> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) => manager.sendEvent(recipientPubkey, event),
    );
  }

  async queuedMessageDiagnostics(
    innerEventId?: string,
    ownerPubkey?: string,
  ): Promise<QueuedMessageDiagnostic[]> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    return manager.queuedMessageDiagnostics(innerEventId);
  }

  async sendMessage(
    recipientPubkey: string,
    content: string,
    options: SendMessageOptions = {},
    ownerPubkey?: string,
  ): Promise<Rumor> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) => manager.sendMessage(recipientPubkey, content, options),
    );
  }

  async sendChatSettings(
    recipientPubkey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"],
    ownerPubkey?: string,
  ): Promise<Rumor> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) => manager.sendChatSettings(recipientPubkey, messageTtlSeconds),
    );
  }

  async setChatSettingsForPeer(
    peerPubkey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"],
    ownerPubkey?: string,
  ): Promise<Rumor> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) =>
        manager.setChatSettingsForPeer(peerPubkey, messageTtlSeconds),
    );
  }

  async sendReceipt(
    recipientPubkey: string,
    receiptType: ReceiptType,
    messageIds: string[],
    ownerPubkey?: string,
  ): Promise<Rumor | undefined> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) =>
        manager.sendReceipt(recipientPubkey, receiptType, messageIds),
    );
  }

  async sendTyping(
    recipientPubkey: string,
    ownerPubkey?: string,
  ): Promise<Rumor> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) => manager.sendTyping(recipientPubkey),
    );
  }

  async setDefaultExpiration(
    options: ExpirationOptions | undefined,
    ownerPubkey?: string,
  ): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    await manager.setDefaultExpiration(options);
  }

  async setExpirationForPeer(
    peerPubkey: string,
    options: ExpirationOptions | null | undefined,
    ownerPubkey?: string,
  ): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    await manager.setExpirationForPeer(peerPubkey, options);
  }

  async setExpirationForGroup(
    groupId: string,
    options: ExpirationOptions | null | undefined,
    ownerPubkey?: string,
  ): Promise<void> {
    const manager = await this.waitForSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
    );
    await manager.setExpirationForGroup(groupId, options);
  }

  async deleteChat(userPubkey: string, ownerPubkey?: string): Promise<void> {
    return this.withSessionManager(
      this.resolveActiveOwnerPubkey(ownerPubkey),
      (manager) => manager.deleteChat(userPubkey),
    );
  }

  async resolveBaseAppKeys(
    ownerPubkey: string,
    timeoutMs: number = this.appKeysFetchTimeoutMs,
  ): Promise<AppKeys> {
    const initialTimeoutMs = Math.min(this.appKeysFastTimeoutMs, timeoutMs);
    try {
      const existingKeys = await AppKeys.waitFor(
        ownerPubkey,
        this.nostrSubscribe,
        initialTimeoutMs,
        this.ownerIdentityKey,
      );
      if (existingKeys) {
        return existingKeys;
      }
    } catch {
      // Ignore relay fetch failures and fall back to local state.
    }

    const localKeys = this.appKeysManager?.getAppKeys();
    if (localKeys && localKeys.getAllDevices().length > 0) {
      return cloneAppKeys(localKeys);
    }

    if (timeoutMs > initialTimeoutMs) {
      try {
        const remaining = Math.max(timeoutMs - initialTimeoutMs, 0);
        const existingKeys = await AppKeys.waitFor(
          ownerPubkey,
          this.nostrSubscribe,
          remaining,
          this.ownerIdentityKey,
        );
        if (existingKeys) {
          return existingKeys;
        }
      } catch {
        // Ignore relay fetch failures.
      }
    }

    return new AppKeys();
  }

  startAppKeysSubscription(ownerPubkey: string): void {
    if (
      this.appKeysSubscriptionCleanup &&
      this.appKeysSubscriptionOwnerPubkey === ownerPubkey
    ) {
      return;
    }

    this.stopAppKeysSubscription();
    this.appKeysSubscriptionOwnerPubkey = ownerPubkey;

    this.appKeysSubscriptionCleanup = this.nostrSubscribe(
      buildAppKeysFilter(ownerPubkey),
      async (event) => {
        if (event.pubkey !== ownerPubkey) return;
        try {
          const incomingAppKeys = AppKeys.fromEvent(
            event,
            this.ownerIdentityKey,
          );
          await this.applyIncomingAppKeys(incomingAppKeys, event.created_at);
          this.feedSessionManagerEvent(event);
        } catch {
          // Ignore invalid AppKeys events.
        }
      },
    );

    this.syncState({
      ownerPubkey,
      appKeysSubscriptionActive: true,
    });
  }

  stopAppKeysSubscription(): void {
    this.appKeysSubscriptionCleanup?.();
    this.appKeysSubscriptionCleanup = null;
    this.appKeysSubscriptionOwnerPubkey = null;
    this.syncState({
      appKeysSubscriptionActive: false,
    });
  }

  protected syncDirectMessageSubscription(): void {
    // The relay REQ for direct messages is filtered by author pubkeys, but
    // the double-ratchet rotates `theirCurrentNostrPublicKey` /
    // `theirNextNostrPublicKey` every step. Without throttling, every
    // received message recomputes a new author set and forces every relay
    // to replay all matching historical events — measured at 5–10 s of
    // sub churn during an active chat.
    //
    //   1. Identical author set → no-op.
    //   2. Newly added authors are subscribed immediately. They may already
    //      have relay events waiting, and delaying them can miss live delivery.
    //   3. Pure removals honour a 1.5 s trailing throttle so bursts of
    //      ratchet steps collapse into one relay REQ. If the throttle window
    //      has not elapsed we schedule a single trailing flush so stale
    //      authors are eventually dropped even if no other runtime activity
    //      comes along to call us again.
    const THROTTLE_MS = 1500;

    const nextAuthors = [
      ...new Set(this.sessionManager?.getAllMessagePushAuthorPubkeys() ?? []),
    ].sort();
    const nextRecipient = this.delegateManager?.getIdentityPublicKey() ?? null;

    if (
      nextAuthors.length === this.directMessageSubscriptionAuthors.length &&
      nextAuthors.every(
        (author, index) =>
          author === this.directMessageSubscriptionAuthors[index],
      ) &&
      nextRecipient === this.directMessageSubscriptionRecipient
    ) {
      return;
    }

    const currentAuthors = this.directMessageSubscriptionAuthors;
    const addedAuthors = nextAuthors.filter(
      (author) => !currentAuthors.includes(author),
    );
    const now = Date.now();
    const elapsed = now - this.directMessageSubscriptionLastChangeMs;
    if (elapsed < THROTTLE_MS && addedAuthors.length === 0) {
      if (this.directMessageSubscriptionThrottleTimer === null) {
        this.directMessageSubscriptionThrottleTimer = setTimeout(() => {
          this.directMessageSubscriptionThrottleTimer = null;
          this.syncDirectMessageSubscription();
        }, THROTTLE_MS - elapsed);
      }
      return;
    }

    if (this.directMessageSubscriptionThrottleTimer !== null) {
      clearTimeout(this.directMessageSubscriptionThrottleTimer);
      this.directMessageSubscriptionThrottleTimer = null;
    }

    this.directMessageSubscriptionCleanup?.();
    this.directMessageSubscriptionCleanup = null;
    this.directMessageSubscriptionAuthors = nextAuthors;
    this.directMessageSubscriptionRecipient = nextRecipient;
    this.directMessageSubscriptionLastChangeMs = now;

    if (nextAuthors.length === 0 && !nextRecipient) {
      return;
    }

    const cleanups: Unsubscribe[] = [];
    if (nextAuthors.length > 0) {
      cleanups.push(
        this.nostrSubscribe(
          {
            kinds: [MESSAGE_EVENT_KIND],
            authors: nextAuthors,
          },
          (event) => {
            this.processReceivedEvent(event);
          },
        ),
      );
    }
    if (nextRecipient) {
      cleanups.push(
        this.nostrSubscribe(
          {
            kinds: [MESSAGE_EVENT_KIND],
            "#p": [nextRecipient],
          },
          (event) => {
            this.processReceivedEvent(event);
          },
        ),
      );
    }
    this.directMessageSubscriptionCleanup = () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }

  async refreshOwnAppKeysFromRelay(
    ownerPubkey: string,
    timeoutMs: number = this.appKeysFastTimeoutMs,
  ): Promise<boolean> {
    const nextSnapshot = await AppKeys.waitForSnapshot(
      ownerPubkey,
      this.nostrSubscribe,
      timeoutMs,
      this.ownerIdentityKey,
    );
    if (!nextSnapshot) {
      return false;
    }

    const update = await this.applyIncomingAppKeys(
      nextSnapshot.appKeys,
      nextSnapshot.createdAt,
    );
    return update !== "stale";
  }

  protected abstract feedSessionManagerEvent(event: VerifiedEvent): boolean;

  protected abstract resolveActiveOwnerPubkey(ownerPubkey?: string): string;

  protected abstract withSessionManager<T>(
    ownerPubkey: string,
    operation: (manager: SessionManager) => Promise<T>,
  ): Promise<T>;

  protected abstract applyIncomingAppKeys(
    incomingAppKeys: AppKeys,
    incomingCreatedAt: number,
  ): Promise<"advanced" | "stale" | "merged_equal_timestamp">;

  protected abstract syncState(
    patch: Partial<
      Omit<
        NdrRuntimeState,
        | "isCurrentDeviceRegistered"
        | "hasKnownRegisteredDevices"
        | "noPreviousDevicesFound"
        | "requiresDeviceRegistration"
        | "canSendPrivateMessages"
      >
    >,
  ): void;
}
