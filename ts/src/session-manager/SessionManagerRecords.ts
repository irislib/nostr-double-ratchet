import { Rumor, Unsubscribe, MESSAGE_EVENT_KIND } from "../types.js";
import { AppKeys } from "../AppKeys.js";
import {
  type AppKeysSnapshotDecision,
  type KnownAppKeysSnapshot,
} from "../multiDevice.js";
import { createSessionFromAccept } from "../inviteUtils.js";
import { type VerifiedEvent } from "nostr-tools";
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
} from "../MessageOrigin.js";
import { DeviceRecordActor } from "./DeviceRecordActor.js";
import { UserRecordActor } from "./UserRecordActor.js";
import type { OnEventCallback, OnEventMeta } from "./types.js";
import { SessionManagerCore } from "./SessionManagerCore.js";
import {
  MAX_PENDING_DIRECT_MESSAGES,
  type PendingInviteResponse,
} from "./managerInternals.js";

export abstract class SessionManagerRecords extends SessionManagerCore {
  protected getOrCreateUserRecord(userPubkey: string): UserRecordActor {
    let rec = this.userRecords.get(userPubkey);
    if (!rec) {
      rec = new UserRecordActor(userPubkey, {
        manager: {
          updateDelegateMapping: (ownerPubkey, appKeys) => {
            this.updateDelegateMapping(ownerPubkey, appKeys);
          },
          removeDelegateMapping: (deviceId) => {
            this.delegateToOwner.delete(deviceId);
          },
          handleDeviceRumor: (ownerPubkey, deviceId, rumor, outerEvent) => {
            this.handleDeviceRumor(ownerPubkey, deviceId, rumor, outerEvent);
          },
          persistUserRecord: (ownerPubkey) => {
            this.storeUserRecord(ownerPubkey).catch(() => {});
            this.notifyMessagePushAuthorsChanged();
          },
        },
        nostr: this.nostrFacade,
        messageQueue: this.messageQueue,
        discoveryQueue: this.discoveryQueue,
        ourDeviceId: this.deviceId,
        ourOwnerPubkey: this.ownerPublicKey,
        identityKey: this.identityKey,
      });
      this.userRecords.set(userPubkey, rec);
    }
    return rec;
  }

  protected handleDeviceRumor(
    ownerPubkey: string,
    deviceId: string,
    event: Rumor,
    outerEvent?: VerifiedEvent,
  ): void {
    const userRecord = this.userRecords.get(ownerPubkey);
    const knownDevice =
      ownerPubkey === deviceId ||
      userRecord?.appKeys
        ?.getAllDevices()
        .some((device) => device.identityPubkey === deviceId) ||
      false;

    if (
      ownerPubkey !== this.ownerPublicKey &&
      (!userRecord?.appKeys || !knownDevice)
    ) {
      this.setupUser(ownerPubkey).catch(() => {});
    }

    this.maybeAutoAdoptChatSettings(event, ownerPubkey);

    const origin = classifyMessageOrigin({
      ourOwnerPubkey: this.ownerPublicKey,
      ourDevicePubkey: this.deviceId,
      senderOwnerPubkey: ownerPubkey,
      senderDevicePubkey: deviceId,
    });

    const meta: OnEventMeta = {
      fromDeviceId: deviceId,
      outerEventId: outerEvent?.id,
      senderOwnerPubkey: ownerPubkey,
      senderDevicePubkey: deviceId,
      origin,
      isSelf: isSelfOrigin(origin),
      isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
    };

    void this.emitEvent({
      type: "decryptedMessage",
      event,
      sender: ownerPubkey,
      senderDevice: deviceId,
      meta,
    });
  }

  protected upsertDeviceRecord(
    userRecord: UserRecordActor,
    deviceId: string,
  ): DeviceRecordActor {
    return userRecord.ensureDevice(deviceId);
  }

  /** Resolve a known delegate device pubkey to its account owner. */
  protected resolveToOwner(pubkey: string): string {
    return this.delegateToOwner.get(pubkey) || pubkey;
  }

  /** Replace the persisted delegate-to-owner mapping from an AppKeys roster. */
  protected updateDelegateMapping(ownerPubkey: string, appKeys: AppKeys): void {
    const userRecord = this.getOrCreateUserRecord(ownerPubkey);
    const newDeviceIdentities = new Set(
      appKeys
        .getAllDevices()
        .map((d) => d.identityPubkey)
        .filter(Boolean) as string[],
    );

    // Remove stale mappings for devices no longer in AppKeys
    const oldIdentities = (userRecord.appKeys?.getAllDevices() || [])
      .map((d) => d.identityPubkey)
      .filter(Boolean) as string[];
    for (const identity of oldIdentities) {
      if (!newDeviceIdentities.has(identity)) {
        this.delegateToOwner.delete(identity);
        this.messageQueue.removeForTarget(identity).catch(() => {});
      }
    }

    // Store AppKeys in user record (single source of truth)
    userRecord.appKeys = appKeys;

    // Update in-memory mapping for current devices
    for (const identity of newDeviceIdentities) {
      this.delegateToOwner.set(identity, ownerPubkey);
    }

    this.retryPendingInviteResponses(ownerPubkey, appKeys);

    // Persist
    this.storeUserRecord(ownerPubkey).catch(() => {});
  }

  protected queuePendingInviteResponse(response: PendingInviteResponse): void {
    if (this.pendingInviteResponses.has(response.eventId)) {
      return;
    }

    if (this.pendingInviteResponses.size >= 1000) {
      const oldest = this.pendingInviteResponses.keys().next().value;
      if (oldest) {
        this.pendingInviteResponses.delete(oldest);
      }
    }

    this.pendingInviteResponses.set(response.eventId, response);
  }

  protected queuePendingDirectMessage(event: VerifiedEvent): void {
    if (this.pendingDirectMessages.has(event.id)) {
      return;
    }

    if (this.pendingDirectMessages.size >= MAX_PENDING_DIRECT_MESSAGES) {
      const oldest = this.pendingDirectMessages.keys().next().value;
      if (oldest) {
        this.pendingDirectMessages.delete(oldest);
      }
    }

    this.pendingDirectMessages.set(event.id, event);
  }

  protected processDirectMessageEvent(event: VerifiedEvent): boolean {
    for (const userRecord of this.userRecords.values()) {
      for (const device of userRecord.devices.values()) {
        if (device.processReceivedEvent(event)) {
          this.syncLegacyDirectMessageSubscription();
          this.pendingDirectMessages.delete(event.id);
          return true;
        }
      }
    }

    return false;
  }

  protected retryPendingDirectMessages(): void {
    for (const event of Array.from(this.pendingDirectMessages.values())) {
      this.processDirectMessageEvent(event);
    }
  }

  protected installInviteResponseSession(
    response: PendingInviteResponse,
    appKeys?: AppKeys | null,
  ): boolean {
    const isSingleDevice = response.deviceId === response.ownerPublicKey;
    const isAuthorized =
      isSingleDevice ||
      (appKeys
        ?.getAllDevices()
        .some((device) => device.identityPubkey === response.deviceId) ??
        false);

    if (!isAuthorized) {
      return false;
    }

    const userRecord = this.getOrCreateUserRecord(response.ownerPublicKey);
    const deviceRecord = this.upsertDeviceRecord(userRecord, response.deviceId);

    const session = createSessionFromAccept({
      theirPublicKey: response.inviteeSessionPublicKey,
      ourSessionPrivateKey: response.ephemeralPrivateKey,
      sharedSecret: response.sharedSecret,
      isSender: false,
      name: response.eventId,
    });

    deviceRecord.installSession(session, true);
    this.pendingInviteResponses.delete(response.eventId);
    this.processedInviteResponses.add(response.eventId);
    this.storeUserRecord(response.ownerPublicKey).catch(() => {});
    this.notifyMessagePushAuthorsChanged();
    this.retryPendingDirectMessages();
    return true;
  }

  protected retryPendingInviteResponses(
    ownerPubkey: string,
    appKeys?: AppKeys,
  ): void {
    for (const response of this.pendingInviteResponses.values()) {
      if (response.ownerPublicKey !== ownerPubkey) {
        continue;
      }

      this.installInviteResponseSession(response, appKeys);
    }
  }

  /** Check whether the owner's current AppKeys roster authorizes a device. */
  protected isDeviceAuthorized(ownerPubkey: string, deviceId: string): boolean {
    const appKeys = this.userRecords.get(ownerPubkey)?.appKeys;
    if (!appKeys) return false;
    return appKeys.getAllDevices().some((d) => d.identityPubkey === deviceId);
  }

  async setupUser(userPubkey: string): Promise<void> {
    const existing = this.userSetupPromises.get(userPubkey);
    if (existing) {
      return existing;
    }

    const setupPromise = this.doSetupUser(userPubkey).finally(() => {
      if (this.userSetupPromises.get(userPubkey) === setupPromise) {
        this.userSetupPromises.delete(userPubkey);
      }
    });
    this.userSetupPromises.set(userPubkey, setupPromise);
    return setupPromise;
  }

  protected async doSetupUser(userPubkey: string): Promise<void> {
    const userRecord = this.getOrCreateUserRecord(userPubkey);
    await userRecord.ensureSetup().catch(() => {});

    const latestAppKeys = await this.fetchAppKeysSnapshot(userPubkey, 50).catch(
      () => null,
    );
    if (latestAppKeys) {
      await this.applyTrustedAppKeysSnapshot({
        ownerPubkey: userPubkey,
        ...latestAppKeys,
      }).catch(() => {});
      return;
    }

    const shouldTrySingleDeviceInviteFallback =
      userPubkey !== this.ownerPublicKey ||
      this.deviceId === this.ownerPublicKey;

    if (
      shouldTrySingleDeviceInviteFallback &&
      !userRecord.appKeys &&
      !userRecord.devices.has(userPubkey)
    ) {
      const directDevice = this.upsertDeviceRecord(userRecord, userPubkey);
      await directDevice.ensureSetup().catch(() => {});
      await this.storeUserRecord(userPubkey).catch(() => {});
    }
  }

  onEvent(callback: OnEventCallback) {
    this.internalSubscriptions.add(callback);

    return () => {
      this.internalSubscriptions.delete(callback);
    };
  }

  onMessagePushAuthorsChanged(callback: () => void): Unsubscribe {
    this.messagePushAuthorCallbacks.add(callback);
    callback();
    return () => {
      this.messagePushAuthorCallbacks.delete(callback);
    };
  }

  protected notifyMessagePushAuthorsChanged(): void {
    for (const callback of this.messagePushAuthorCallbacks) {
      callback();
    }
    this.syncLegacyDirectMessageSubscription();
  }

  protected syncLegacyDirectMessageSubscription(): void {
    if (!this.legacyNostrSubscribe) return;
    const nextAuthors = this.getAllMessagePushAuthorPubkeys();
    if (
      nextAuthors.length === this.legacyDirectMessageAuthors.length &&
      nextAuthors.every(
        (author, index) => author === this.legacyDirectMessageAuthors[index],
      )
    ) {
      return;
    }

    this.legacyDirectMessageSubscription?.();
    this.legacyDirectMessageSubscription = null;
    this.legacyDirectMessageAuthors = nextAuthors;
    if (nextAuthors.length === 0) {
      return;
    }

    this.legacyDirectMessageSubscription = this.legacyNostrSubscribe(
      {
        kinds: [MESSAGE_EVENT_KIND],
        authors: nextAuthors,
      },
      (event) => {
        this.processReceivedEvent(event);
      },
    );
  }

  abstract applyTrustedAppKeysSnapshot(
    snapshot: KnownAppKeysSnapshot,
  ): Promise<AppKeysSnapshotDecision>;

  abstract getAllMessagePushAuthorPubkeys(): string[];

  abstract processReceivedEvent(event: VerifiedEvent): boolean;

  protected abstract maybeAutoAdoptChatSettings(
    event: Rumor,
    fromOwnerPubkey: string,
  ): void;

  protected abstract storeUserRecord(publicKey: string): Promise<void>;
}
