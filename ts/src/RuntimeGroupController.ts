import {
  GroupManager,
  type CreateGroupResult,
  type GroupData,
  type GroupDecryptedEvent,
  GROUP_ROSTER_FACT_KIND,
  GROUP_INVITE_RUMOR_KIND,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
} from "./Group.js";
import { parseSenderKeyRepairRequestRumor, senderKeyRepairDefaultNextRetryAt } from "./SenderKeyRepair.js";
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
} from "./MessageOrigin.js";
import type { SessionManager } from "./SessionManager.js";
import { InMemoryStorageAdapter, type StorageAdapter } from "./StorageAdapter.js";
import {
  CHAT_MESSAGE_KIND,
  type NostrFetch,
  type NostrPublish,
  type NostrPublisherOptions,
  type NostrSubscribe,
  type Rumor,
  type Unsubscribe,
} from "./types.js";
import type { OnEventMeta } from "./session-manager/types.js";
import type { VerifiedEvent } from "nostr-tools";
import { createNostrPublisher } from "./publishing.js";
import { PRIVATE_GROUP_DELIVERY_KIND, parsePrivateGroupDelivery,
  privateGroupDeliverySenderStatus, previewPrivateGroupDelivery } from "./PrivateGroupDelivery.js";

export interface SendGroupEventOptions {
  nowMs?: number;
}

export interface RuntimeGroupEvent {
  kind: number;
  content: string;
  tags?: string[][];
}

interface SessionGroupRuntimeSharedOptions extends NostrPublisherOptions {
  nostrSubscribe: NostrSubscribe;
  nostrPublish: NostrPublish;
  nostrFetch?: NostrFetch;
  groupStorage?: StorageAdapter;
  onReadyStateChange?: (ready: boolean) => void;
}

interface SessionGroupRuntimeAttachedOptions extends SessionGroupRuntimeSharedOptions {
  sessionManager: SessionManager;
  ourOwnerPubkey: string;
  ourDevicePubkey: string;
}

interface SessionGroupRuntimeDeferredOptions extends SessionGroupRuntimeSharedOptions {
  waitForSessionManager: (ownerPubkey?: string) => Promise<SessionManager>;
  getOwnerPubkey: () => string | null;
  getCurrentDevicePubkey: () => string | null;
}

export type SessionGroupRuntimeOptions =
  | SessionGroupRuntimeAttachedOptions
  | SessionGroupRuntimeDeferredOptions;

export class SessionGroupRuntime {
  private readonly nostrSubscribe: NostrSubscribe;
  private readonly nostrPublish: NostrPublish;
  private readonly nostrFetch?: NostrFetch;
  private readonly groupStorage: StorageAdapter;
  private readonly waitForSessionManagerFn: (
    ownerPubkey?: string,
  ) => Promise<SessionManager>;
  private readonly getOwnerPubkey: () => string | null;
  private readonly getCurrentDevicePubkey: () => string | null;
  private readonly onReadyStateChange?: (ready: boolean) => void;

  private groupManager: GroupManager | null = null;
  private groupManagerInitPromise: Promise<GroupManager> | null = null;
  private sessionManager: SessionManager | null = null;
  private sessionBridgeCleanup: Unsubscribe | null = null;
  private privateDeliveryCleanup: Unsubscribe | null = null;
  private deliveryRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly committingPrivateEvents = new Set<string>();
  private readonly keyRepairAttempts = new Map<string, { count: number; nextAt: number }>();
  private readonly groupEventCallbacks = new Set<
    (event: GroupDecryptedEvent) => void | Promise<void>
  >();

  constructor(options: SessionGroupRuntimeOptions) {
    this.nostrSubscribe = options.nostrSubscribe;
    this.nostrPublish = createNostrPublisher(options.nostrPublish, options);
    this.nostrFetch = options.nostrFetch;
    this.groupStorage = options.groupStorage || new InMemoryStorageAdapter();
    if ("sessionManager" in options) {
      this.sessionManager = options.sessionManager;
      this.waitForSessionManagerFn = async () => options.sessionManager;
      this.getOwnerPubkey = () => options.ourOwnerPubkey;
      this.getCurrentDevicePubkey = () => options.ourDevicePubkey;
    } else {
      this.waitForSessionManagerFn = options.waitForSessionManager;
      this.getOwnerPubkey = options.getOwnerPubkey;
      this.getCurrentDevicePubkey = options.getCurrentDevicePubkey;
    }
    this.onReadyStateChange = options.onReadyStateChange;
  }

  getGroupManager(): GroupManager | null {
    return this.groupManager;
  }

  getManager(): GroupManager | null {
    return this.getGroupManager();
  }

  async waitForManager(ownerPubkey?: string): Promise<GroupManager> {
    if (this.groupManager) {
      return this.groupManager;
    }
    if (this.groupManagerInitPromise) {
      return this.groupManagerInitPromise;
    }

    this.groupManagerInitPromise = (async () => {
      const sessionManager = await this.waitForSessionManagerFn(ownerPubkey);
      const currentOwnerPubkey = this.getOwnerPubkey() || ownerPubkey;
      const currentDevicePubkey = this.getCurrentDevicePubkey();
      if (!currentOwnerPubkey || !currentDevicePubkey) {
        throw new Error(
          "Owner and current device pubkeys are required to initialize GroupManager",
        );
      }

      const groupManager = new GroupManager({
        ourOwnerPubkey: currentOwnerPubkey,
        ourDevicePubkey: currentDevicePubkey,
        storage: this.groupStorage,
        nostrSubscribe: this.nostrSubscribe,
        nostrFetch: this.nostrFetch,
        onDecryptedEvent: (event) => {
          if (!this.committingPrivateEvents.has(event.outerEventId)) void this.emitGroupEvent(event).catch(() => {});
        },
      });
      this.groupManager = groupManager;
      this.onReadyStateChange?.(true);
      this.setSessionManager(sessionManager);
      return groupManager;
    })().finally(() => {
      this.groupManagerInitPromise = null;
    });

    return this.groupManagerInitPromise;
  }

  async waitForGroupManager(ownerPubkey?: string): Promise<GroupManager> {
    return this.waitForManager(ownerPubkey);
  }

  onGroupEvent(callback: (event: GroupDecryptedEvent) => void | Promise<void>): Unsubscribe {
    this.groupEventCallbacks.add(callback);
    this.sessionManager?.notifyDurableSessionEventReadiness();
    return () => {
      this.groupEventCallbacks.delete(callback);
    };
  }

  setSessionManager(
    manager: SessionManager | null,
    options: { bridgeSessionEvents?: boolean } = {},
  ): void {
    const bridgeSessionEvents = options.bridgeSessionEvents ?? true;
    if (this.sessionManager === manager && this.sessionBridgeCleanup) {
      return;
    }

    this.clearSessionBridge();
    this.sessionManager = manager;
    if (manager && this.groupManager) {
      const groups = this.groupManager;
      this.privateDeliveryCleanup = manager.onDurableEvent([PRIVATE_GROUP_DELIVERY_KIND], async (event, sender, meta) => {
        const active = () => this.sessionManager === manager && this.groupManager === groups;
        if (!active()) throw new Error("Inactive group delivery handler");
        await this.processPrivateDelivery(event, meta?.senderOwnerPubkey || sender);
        if (!active()) throw new Error("Inactive group delivery handler");
      });
    }

    if (!manager || !this.groupManager || !bridgeSessionEvents) {
      return;
    }

    this.sessionBridgeCleanup = manager.onEvent((event, from, meta) => {
      this.processSessionEvent(event, from, meta);
    });
  }

  processSessionEvent(event: Rumor, from: string, meta?: OnEventMeta): void {
    const senderOwnerPubkey = meta?.senderOwnerPubkey || from;
    const senderDevicePubkey = meta?.senderDevicePubkey || event.pubkey;
    if (this.shouldEmitPairwiseGroupEvent(event, senderDevicePubkey)) {
      void this.emitGroupEvent(
        this.buildPairwiseGroupEvent(
          event,
          senderOwnerPubkey,
          senderDevicePubkey,
        ),
      ).catch(() => {});
    }
    const groups = this.groupManager;
    const sessions = this.sessionManager;
    void groups?.handleIncomingSessionEvent(
      event,
      senderOwnerPubkey,
      senderDevicePubkey,
    ).then(async () => {
      if (this.groupManager !== groups || this.sessionManager !== sessions) return;
      if (event.kind === GROUP_SENDER_KEY_REPAIR_REQUEST_KIND && event.pubkey === senderDevicePubkey) {
        const request = parseSenderKeyRepairRequestRumor(event);
        const group = request && groups?.getGroup(request.groupId);
        if (request && group?.members.includes(senderOwnerPubkey) && group.members.includes(this.getOwnerPubkey() || "") &&
            this.allowKeyRepair(JSON.stringify(["reply", group.id, senderOwnerPubkey]))) {
          await groups!.respondToSenderKeyRepairRequest(group.id, senderOwnerPubkey, request, {
            sendPairwise: async (recipient, rumor) => {
              if (this.groupManager !== groups || this.sessionManager !== sessions) throw new Error("Inactive group key repair");
              await sessions!.sendEvent(recipient, rumor, { includeLocalSiblings: false });
            },
          });
        }
      }
      if ([GROUP_INVITE_RUMOR_KIND, GROUP_ROSTER_FACT_KIND, GROUP_SENDER_KEY_DISTRIBUTION_KIND].includes(event.kind)) {
        sessions?.notifyDurableSessionEventReadiness();
      }
    }).catch(() => { /* Unapplied controls retain their ordinary retry backoff. */ });
  }

  async upsertGroup(group: GroupData, ownerPubkey?: string): Promise<void> {
    const manager = await this.waitForManager(ownerPubkey);
    const before = manager.privateDeliveryReadiness(group.id);
    await manager.upsertGroup(group);
    if (before !== manager.privateDeliveryReadiness(group.id) && this.groupManager === manager) {
      this.sessionManager?.notifyDurableSessionEventReadiness();
    }
    await this.flushPrivateDeliveries();
  }

  async syncGroups(groups: GroupData[], ownerPubkey?: string): Promise<void> {
    const manager = await this.waitForManager(ownerPubkey);
    const nextGroupIds = new Set(groups.map((group) => group.id));
    let readinessChanged = false;
    for (const group of groups) {
      const before = manager.privateDeliveryReadiness(group.id);
      await manager.upsertGroup(group);
      readinessChanged ||= before !== manager.privateDeliveryReadiness(group.id);
    }
    for (const groupId of manager.managedGroupIds()) {
      if (!nextGroupIds.has(groupId)) manager.removeGroup(groupId);
    }
    if (readinessChanged && this.groupManager === manager) this.sessionManager?.notifyDurableSessionEventReadiness();
    await this.flushPrivateDeliveries();
  }

  removeGroup(groupId: string): void {
    this.groupManager?.removeGroup(groupId);
  }

  async createGroup(
    name: string,
    memberOwnerPubkeys: string[],
    opts: { fanoutMetadata?: boolean; nowMs?: number } = {},
  ): Promise<CreateGroupResult> {
    const groupManager = await this.waitForManager();
    return groupManager.createGroup(name, memberOwnerPubkeys, {
      fanoutMetadata: opts.fanoutMetadata,
      nowMs: opts.nowMs,
      sendPairwise: async (recipientOwnerPubkey, rumor) => {
        const manager = await this.waitForSessionManagerFn();
        await manager.sendEvent(recipientOwnerPubkey, rumor, { includeLocalSiblings: false });
      },
    });
  }

  async sendGroupEvent(
    groupId: string,
    event: RuntimeGroupEvent,
    opts: SendGroupEventOptions = {},
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    const groupManager = await this.waitForManager();
    const result = await groupManager.sendEvent(groupId, event, {
      nowMs: opts.nowMs,
      sendPairwise: async (recipientOwnerPubkey, rumor) => {
        const manager = await this.waitForSessionManagerFn();
        await manager.sendEvent(recipientOwnerPubkey, rumor, { includeLocalSiblings: false });
      },
      publishOuter: this.nostrPublish,
    });
    await this.flushPrivateDeliveries();
    return result;
  }

  async sendGroupMessage(
    groupId: string,
    message: string,
    opts: SendGroupEventOptions = {},
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    return this.sendGroupEvent(
      groupId,
      {
        kind: CHAT_MESSAGE_KIND,
        content: message,
      },
      opts,
    );
  }

  close(): void {
    this.clearSessionBridge();
    clearTimeout(this.deliveryRetryTimer);
    this.deliveryRetryTimer = undefined;
    this.groupManager?.destroy();
    this.groupManager = null;
    this.groupManagerInitPromise = null;
    this.sessionManager = null;
    this.keyRepairAttempts.clear();
    this.onReadyStateChange?.(false);
  }

  private clearSessionBridge(): void {
    this.privateDeliveryCleanup?.();
    this.privateDeliveryCleanup = null;
    this.sessionBridgeCleanup?.();
    this.sessionBridgeCleanup = null;
  }

  private shouldEmitPairwiseGroupEvent(
    event: Rumor,
    senderDevicePubkey: string,
  ): boolean {
    if (!event.tags?.some((tag) => tag[0] === "l" && typeof tag[1] === "string")) {
      return false;
    }
    if (
      event.kind === PRIVATE_GROUP_DELIVERY_KIND ||
      event.kind === GROUP_ROSTER_FACT_KIND ||
      event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND ||
      event.kind === GROUP_SENDER_KEY_REPAIR_REQUEST_KIND
    ) {
      return false;
    }
    return event.pubkey === senderDevicePubkey;
  }

  private buildPairwiseGroupEvent(
    event: Rumor,
    senderOwnerPubkey: string,
    senderDevicePubkey: string,
  ): GroupDecryptedEvent {
    const groupId = event.tags?.find((tag) => tag[0] === "l")?.[1] || "";
    const origin = classifyMessageOrigin({
      ourOwnerPubkey: this.getOwnerPubkey() || "",
      ourDevicePubkey: this.getCurrentDevicePubkey() || undefined,
      senderOwnerPubkey,
      senderDevicePubkey,
    });

    return {
      groupId,
      senderEventPubkey: senderDevicePubkey,
      senderDevicePubkey,
      senderOwnerPubkey,
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

  private async emitGroupEvent(event: GroupDecryptedEvent): Promise<void> {
    for (const callback of this.groupEventCallbacks) await callback(event);
  }

  private async flushPrivateDeliveries(): Promise<void> {
    clearTimeout(this.deliveryRetryTimer);
    this.deliveryRetryTimer = undefined;
    const manager = this.groupManager;
    if (!manager) return;
    let pending = true;
    try {
      pending = await manager.flushPrivateDeliveries(async (recipient, rumor) => {
        if (this.groupManager !== manager) throw new Error("Inactive group fanout");
        const sessions = await this.waitForSessionManagerFn();
        if (this.groupManager !== manager) throw new Error("Inactive group fanout");
        await sessions.sendEvent(recipient, rumor, { includeLocalSiblings: false });
      });
    } finally {
      if (pending && this.groupManager === manager) {
        this.deliveryRetryTimer = setTimeout(() => { void this.flushPrivateDeliveries().catch(() => {}); }, 5000);
        this.deliveryRetryTimer.unref?.();
      }
    }
  }

  private async processPrivateDelivery(rumor: Rumor, senderOwnerPubkey: string): Promise<void> {
    const outer = parsePrivateGroupDelivery(rumor);
    if (!outer) return;
    const manager = this.groupManager;
    if (!manager) throw new Error("Group delivery waits for group state");
    const group = manager.groupForSenderEvent(outer.pubkey);
    if (!group) {
      await this.requestMissingGroupKey(manager, rumor, outer, senderOwnerPubkey);
      throw new Error("Group delivery waits for sender keys");
    }
    const opts = { storage: this.groupStorage, ourOwnerPubkey: this.getOwnerPubkey()!,
      ourDevicePubkey: this.getCurrentDevicePubkey()!, group, event: outer, senderOwnerPubkey };
    const status = await privateGroupDeliverySenderStatus(opts);
    if (status === "rejected") return;
    if (status !== "authorized") throw new Error("Group delivery waits for authenticated sender mapping");
    const cacheKey = `v1/private-group-delivery/${opts.ourOwnerPubkey}/${outer.id}`;
    let decrypted = await this.groupStorage.get<GroupDecryptedEvent>(cacheKey);
    if (!decrypted) {
      decrypted = await previewPrivateGroupDelivery(opts) || undefined;
      if (!decrypted) {
        await this.requestMissingGroupKey(manager, rumor, outer, senderOwnerPubkey);
        throw new Error("Group delivery waits for decryption keys");
      }
      await this.groupStorage.put(cacheKey, decrypted);
    }
    // The saved receive ratchet retains 21113 until application persistence succeeds.
    if (!this.groupEventCallbacks.size) throw new Error("Group delivery waits for application handler");
    await this.emitGroupEvent(decrypted);
    this.committingPrivateEvents.add(outer.id);
    try { await manager.handleOuterEvent(outer); }
    finally { this.committingPrivateEvents.delete(outer.id); }
  }

  private allowKeyRepair(key: string): boolean {
    const now = Math.floor(Date.now() / 1000), previous = this.keyRepairAttempts.get(key);
    if (previous && now < previous.nextAt) return false;
    const count = (previous?.count || 0) + 1;
    this.keyRepairAttempts.delete(key);
    this.keyRepairAttempts.set(key, { count, nextAt: senderKeyRepairDefaultNextRetryAt(now, count) });
    if (this.keyRepairAttempts.size > 512) this.keyRepairAttempts.delete(this.keyRepairAttempts.keys().next().value!);
    return true;
  }

  private async requestMissingGroupKey(manager: GroupManager, rumor: Rumor, outer: VerifiedEvent, sender: string): Promise<void> {
    const groupId = rumor.tags.find(tag => tag[0] === "l")?.[1];
    const group = groupId && manager.getGroup(groupId), sessions = this.sessionManager;
    if (!group || !sessions || !group.members.includes(sender) || !group.members.includes(this.getOwnerPubkey() || "")) return;
    const request = manager.senderKeyRepairRequestForOuterEvent(group.id, outer);
    if (!request || !this.allowKeyRepair(JSON.stringify(["request", group.id, sender]))) return;
    await manager.requestSenderKeyRepair(group.id, request, {
      sendPairwise: async (recipient, repair) => {
        // Ask only the authenticated sender of this ratchet delivery, never other members.
        if (recipient !== sender) return;
        if (this.groupManager !== manager || this.sessionManager !== sessions) throw new Error("Inactive group key repair");
        await sessions.sendEvent(recipient, repair, { includeLocalSiblings: false });
      },
    });
  }
}

export { SessionGroupRuntime as RuntimeGroupController };
