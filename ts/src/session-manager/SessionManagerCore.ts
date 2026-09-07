import {
  IdentityKey,
  NostrSubscribe,
  NostrPublish,
  type NostrPublisherOptions,
  Unsubscribe,
  INVITE_RESPONSE_KIND,
} from "../types.js";
import { StorageAdapter, InMemoryStorageAdapter } from "../StorageAdapter.js";
import { MessageQueue } from "../MessageQueue.js";
import { AppKeys } from "../AppKeys.js";
import { type VerifiedEvent } from "nostr-tools";
import { DeviceRecordActor } from "./DeviceRecordActor.js";
import { ExpirationSettings } from "./expirationSettings.js";
import { UserRecordActor } from "./UserRecordActor.js";
import { UserRecordStorage } from "./userRecordStorage.js";
import { createNostrPublisher } from "../publishing.js";
import type {
  AcceptInviteResult,
  InviteCredentials,
  NostrFacade,
  OnEventCallback,
  SessionManagerEvent,
  SessionManagerEventsAvailableCallback,
} from "./types.js";
import type { PendingInviteResponse } from "./managerInternals.js";

export abstract class SessionManagerCore {
  protected readonly storageVersion = "1";

  protected readonly versionPrefix: string;

  protected deviceId: string;

  protected storage: StorageAdapter;

  protected legacyNostrSubscribe?: NostrSubscribe;

  protected legacyNostrPublish?: NostrPublish;

  protected identityKey: IdentityKey;

  protected ourPublicKey: string;

  protected ownerPublicKey: string;

  protected nostrFacade: NostrFacade;

  protected inviteKeys: InviteCredentials;

  protected userRecords: Map<string, UserRecordActor> = new Map();

  protected messageQueue!: MessageQueue;

  protected discoveryQueue!: MessageQueue;

  protected delegateToOwner: Map<string, string> = new Map();

  protected processedInviteResponses: Set<string> = new Set();

  protected pendingInviteResponses: Map<string, PendingInviteResponse> =
    new Map();

  protected pendingDirectMessages: Map<string, VerifiedEvent> = new Map();

  protected inviteAcceptPromises: Map<string, Promise<AcceptInviteResult>> =
    new Map();

  protected expirationSettings!: ExpirationSettings;

  protected userRecordStorage!: UserRecordStorage;

  protected autoAdoptChatSettings: boolean = true;

  protected userSetupPromises: Map<string, Promise<void>> = new Map();

  protected bootstrapRetryTimeouts: Set<ReturnType<typeof setTimeout>> =
    new Set();

  protected ourInviteResponseSubscription: Unsubscribe | null = null;

  protected legacyRuntimeSubscriptions: Map<string, Unsubscribe> = new Map();

  protected legacyDirectMessageSubscription: Unsubscribe | null = null;

  protected legacyDirectMessageAuthors: string[] = [];

  protected internalSubscriptions: Set<OnEventCallback> = new Set();

  protected messagePushAuthorCallbacks: Set<() => void> = new Set();

  protected eventsAvailableCallbacks: Set<SessionManagerEventsAvailableCallback> =
    new Set();

  protected emittedEvents: SessionManagerEvent[] = [];

  protected initialized: boolean = false;

  constructor(
    ourPublicKey: string,
    identityKey: IdentityKey,
    deviceId: string,
    nostrSubscribe: NostrSubscribe,
    nostrPublish: NostrPublish,
    ownerPublicKey: string,
    inviteKeys: InviteCredentials,
    storage?: StorageAdapter,
    publicationOptions?: NostrPublisherOptions,
  ) {
    this.userRecords = new Map();
    this.legacyNostrSubscribe = nostrSubscribe;
    this.legacyNostrPublish = createNostrPublisher(nostrPublish, publicationOptions);
    this.ourPublicKey = ourPublicKey;
    this.identityKey = identityKey;
    this.deviceId = deviceId;
    this.ownerPublicKey = ownerPublicKey;
    this.inviteKeys = inviteKeys;
    this.storage = storage || new InMemoryStorageAdapter();
    this.versionPrefix = `v${this.storageVersion}`;
    this.messageQueue = new MessageQueue(this.storage, "v1/message-queue/");
    this.discoveryQueue = new MessageQueue(this.storage, "v1/discovery-queue/");
    this.expirationSettings = new ExpirationSettings(
      this.storage,
      this.versionPrefix,
    );
    this.userRecordStorage = new UserRecordStorage(
      this.storage,
      this.versionPrefix,
    );
    this.nostrFacade = {
      subscribe: (subid, filter, onEvent) =>
        this.emitSubscribe(subid, filter, onEvent),
      publish: (event, innerEventId) => this.emitPublish(event, innerEventId),
    };
  }

  onEventsAvailable(
    callback: SessionManagerEventsAvailableCallback,
  ): Unsubscribe {
    this.eventsAvailableCallbacks.add(callback);
    return () => {
      this.eventsAvailableCallbacks.delete(callback);
    };
  }

  drainEvents(): SessionManagerEvent[] {
    const events = this.emittedEvents;
    this.emittedEvents = [];
    return events;
  }

  hasPendingEvents(): boolean {
    return this.emittedEvents.length > 0;
  }

  protected async emitEvent(event: SessionManagerEvent): Promise<void> {
    this.emittedEvents.push(event);
    const legacy = this.handleLegacyEmittedEvent(event);
    const handoffs: Promise<void>[] = legacy ? [legacy] : [];
    for (const callback of this.eventsAvailableCallbacks) {
      try {
        const pending = callback();
        if (pending) {
          if (event.type === "publish") handoffs.push(pending);
          else void pending.catch(() => {});
        }
      } catch (error) {
        if (event.type === "publish") handoffs.push(Promise.reject(error));
        // Other event observers do not acknowledge durable handoff.
      }
    }
    // Publish observers acknowledge local durable handoff, never relay receipt.
    // Keep retry rows until the host has safely accepted their envelopes.
    await Promise.all(handoffs);
  }

  protected handleLegacyEmittedEvent(
    event: SessionManagerEvent,
  ): Promise<void> | void {
    if (event.type === "decryptedMessage") {
      for (const cb of this.internalSubscriptions) {
        cb(event.event, event.sender, event.meta);
      }
      return;
    }

    if (event.type === "subscribe") {
      if (!this.legacyNostrSubscribe) return;
      this.legacyRuntimeSubscriptions.get(event.subid)?.();
      const unsubscribe = this.legacyNostrSubscribe(
        event.filter,
        (received) => {
          this.processReceivedEvent(received);
        },
      );
      this.legacyRuntimeSubscriptions.set(event.subid, unsubscribe);
      return;
    }

    if (event.type === "unsubscribe") {
      this.legacyRuntimeSubscriptions.get(event.subid)?.();
      this.legacyRuntimeSubscriptions.delete(event.subid);
      return;
    }

    if (!this.legacyNostrPublish) return;
    return this.legacyNostrPublish(event.event, event.innerEventId).then(() => {});
  }

  protected emitSubscribe(
    subid: string,
    filter: Parameters<NostrFacade["subscribe"]>[1],
    onEvent?: Parameters<NostrFacade["subscribe"]>[2],
  ): Unsubscribe {
    if (this.legacyNostrSubscribe && onEvent) {
      this.emittedEvents.push({ type: "subscribe", subid, filter });
      this.legacyRuntimeSubscriptions.get(subid)?.();
      const cleanup = this.legacyNostrSubscribe(filter, onEvent);
      this.legacyRuntimeSubscriptions.set(subid, cleanup);
      return () => {
        this.emittedEvents.push({ type: "unsubscribe", subid });
        this.legacyRuntimeSubscriptions.get(subid)?.();
        this.legacyRuntimeSubscriptions.delete(subid);
      };
    }

    void this.emitEvent({ type: "subscribe", subid, filter });
    return () => {
      void this.emitEvent({ type: "unsubscribe", subid });
    };
  }

  protected emitPublish(
    event: Parameters<NostrFacade["publish"]>[0],
    innerEventId?: string,
  ): Promise<void> {
    return this.emitEvent({ type: "publish", event, innerEventId });
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    await this.userRecordStorage.runMigrations().catch(() => {
      // Failed to run migrations
    });

    await this.loadAllUserRecords().catch(() => {
      // Failed to load user records
    });

    await this.expirationSettings.load().catch(() => {
      // Failed to load expiration settings
    });

    // Add our own device to user record to prevent accepting our own invite
    // Use ownerPublicKey so delegates are added to the owner's record
    const ourUserRecord = this.getOrCreateUserRecord(this.ownerPublicKey);
    this.upsertDeviceRecord(ourUserRecord, this.deviceId);

    // Start invite response listener BEFORE setting up users
    // This ensures we're listening when other devices respond to our invites
    this.startInviteResponseListener();

    // Setup sessions with our own devices and resume discovery for all known users
    Array.from(this.userRecords.keys()).forEach((pubkey) =>
      this.setupUser(pubkey),
    );
  }

  /** Start listening for responses addressed to our ephemeral invite key. */
  protected startInviteResponseListener(): void {
    const { publicKey: ephemeralPubkey } = this.inviteKeys.ephemeralKeypair;

    this.ourInviteResponseSubscription = this.emitSubscribe(
      `invite-responses-${ephemeralPubkey}`,
      {
        kinds: [INVITE_RESPONSE_KIND],
        "#p": [ephemeralPubkey],
      },
    );
  }

  protected fetchAppKeys(
    pubkey: string,
    timeoutMs = 2000,
  ): Promise<AppKeys | null> {
    return this.fetchAppKeysSnapshot(pubkey, timeoutMs).then(
      (snapshot) => snapshot?.appKeys ?? null,
    );
  }

  protected fetchAppKeysSnapshot(
    pubkey: string,
    timeoutMs = 2000,
  ): Promise<{ appKeys: AppKeys; createdAt: number } | null> {
    if (!this.legacyNostrSubscribe) {
      return Promise.resolve(null);
    }
    return AppKeys.waitForSnapshot(
      pubkey,
      this.legacyNostrSubscribe,
      timeoutMs,
    );
  }

  protected abstract getOrCreateUserRecord(userPubkey: string): UserRecordActor;

  protected abstract upsertDeviceRecord(
    userRecord: UserRecordActor,
    deviceId: string,
  ): DeviceRecordActor;

  abstract setupUser(userPubkey: string): Promise<void>;

  abstract processReceivedEvent(event: VerifiedEvent): boolean;

  protected abstract loadAllUserRecords(): Promise<unknown>;
}
