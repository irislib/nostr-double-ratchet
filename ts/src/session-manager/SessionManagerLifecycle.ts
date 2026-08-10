import {
  ExpirationOptions,
  MESSAGE_EVENT_KIND,
  INVITE_EVENT_KIND,
  INVITE_RESPONSE_KIND,
} from "../types.js";
import {
  AppKeys,
  applyAppKeysSnapshotPreservingLabels,
  isAppKeysEvent,
} from "../AppKeys.js";
import { Invite } from "../Invite.js";
import { Session } from "../Session.js";
import {
  type AppKeysSnapshotDecision,
  type KnownAppKeysSnapshot,
} from "../multiDevice.js";
import { decryptInviteResponse } from "../inviteUtils.js";
import { type VerifiedEvent } from "nostr-tools";
import {
  planInviteBootstrapEvents,
  scheduleInviteBootstrapRetryEvents,
} from "./inviteBootstrap.js";
import {
  collectAllMessagePushAuthorPubkeys,
  collectMessagePushAuthorPubkeys,
} from "./messageAuthors.js";
import {
  queuedMessageDiagnostics,
  type QueuedMessageDiagnostic,
} from "./queueDiagnostics.js";
import { UserRecordActor } from "./UserRecordActor.js";
import type { UserRecord } from "./types.js";
import { SessionManagerRecords } from "./SessionManagerRecords.js";
import type { PendingInviteResponse } from "./managerInternals.js";

export abstract class SessionManagerLifecycle extends SessionManagerRecords {
  /** Enable or disable adoption of incoming kind-10448 chat settings. */
  setAutoAdoptChatSettings(enabled: boolean) {
    this.autoAdoptChatSettings = enabled;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getUserRecords(): Map<string, UserRecord> {
    return this.userRecords as unknown as Map<string, UserRecord>;
  }

  getKnownAppKeysSnapshots(): KnownAppKeysSnapshot[] {
    return Array.from(this.userRecords.values())
      .filter(
        (record): record is UserRecordActor & { appKeys: AppKeys } =>
          record.appKeys !== undefined,
      )
      .map((record) => ({
        ownerPubkey: record.publicKey,
        appKeys: new AppKeys(
          record.appKeys.getAllDevices().map((device) => ({ ...device })),
        ),
        createdAt: record.appKeysCreatedAt,
      }))
      .sort((left, right) => left.ownerPubkey.localeCompare(right.ownerPubkey));
  }

  async applyTrustedAppKeysSnapshot(
    snapshot: KnownAppKeysSnapshot,
  ): Promise<AppKeysSnapshotDecision> {
    const record = this.getOrCreateUserRecord(snapshot.ownerPubkey);
    await record.ensureSetup().catch(() => {});
    const incoming = new AppKeys(
      snapshot.appKeys.getAllDevices().map((device) => ({ ...device })),
      snapshot.appKeys.getAllDeviceLabels().map((labels) => ({ ...labels })),
    );
    const update = applyAppKeysSnapshotPreservingLabels({
      currentAppKeys: record.appKeys,
      currentCreatedAt: record.appKeysCreatedAt,
      incomingAppKeys: incoming,
      incomingCreatedAt: snapshot.createdAt,
    });
    if (update.decision !== "stale") {
      await record.onAppKeys(update.appKeys, update.createdAt);
      this.syncLegacyDirectMessageSubscription();
    }
    return update.decision;
  }

  getMessagePushAuthorPubkeys(peerPubkey: string): string[] {
    const ownerPubkey = this.resolveToOwner(peerPubkey);
    const userRecord = this.userRecords.get(ownerPubkey);
    return collectMessagePushAuthorPubkeys(userRecord);
  }

  getKnownDeviceIdentityPubkeysForOwner(ownerPubkey: string): string[] {
    const owner = this.resolveToOwner(ownerPubkey);
    const userRecord = this.userRecords.get(owner);
    if (!userRecord) {
      return [];
    }

    const devices = new Set<string>();
    for (const device of userRecord.appKeys?.getAllDevices() ?? []) {
      if (device.identityPubkey) {
        devices.add(device.identityPubkey);
      }
    }
    for (const deviceId of userRecord.devices.keys()) {
      devices.add(deviceId);
    }
    return [...devices].sort();
  }

  getAllMessagePushAuthorPubkeys(): string[] {
    return collectAllMessagePushAuthorPubkeys(this.userRecords.values());
  }

  feedEvent(event: VerifiedEvent): boolean {
    return this.processReceivedEvent(event);
  }

  processReceivedEvent(event: VerifiedEvent): boolean {
    if (isAppKeysEvent(event)) {
      void this.processAppKeysEvent(event).then(() => {
        this.retryPendingDirectMessages();
      });
      return true;
    }

    if (event.kind === INVITE_RESPONSE_KIND) {
      void this.processInviteResponseEvent(event).then(() => {
        this.retryPendingDirectMessages();
      });
      return true;
    }

    if (event.kind === INVITE_EVENT_KIND) {
      void this.processInviteEvent(event);
      return true;
    }

    if (event.kind !== MESSAGE_EVENT_KIND) {
      return false;
    }

    if (this.processDirectMessageEvent(event)) {
      return true;
    }

    this.queuePendingDirectMessage(event);
    return false;
  }

  protected async processAppKeysEvent(event: VerifiedEvent): Promise<boolean> {
    const userRecord = this.getOrCreateUserRecord(event.pubkey);
    return userRecord.processAppKeysEvent(event);
  }

  protected async processInviteResponseEvent(
    event: VerifiedEvent,
  ): Promise<boolean> {
    if (
      this.processedInviteResponses.has(event.id) ||
      this.pendingInviteResponses.has(event.id)
    ) {
      return false;
    }

    try {
      const { privateKey: ephemeralPrivkey } = this.inviteKeys.ephemeralKeypair;
      const decrypted = await decryptInviteResponse({
        envelopeContent: event.content,
        envelopeSenderPubkey: event.pubkey,
        inviterEphemeralPrivateKey: ephemeralPrivkey,
        inviterPrivateKey:
          this.identityKey instanceof Uint8Array ? this.identityKey : undefined,
        inviterPublicKey: this.ourPublicKey,
        sharedSecret: this.inviteKeys.sharedSecret,
        decrypt:
          this.identityKey instanceof Uint8Array
            ? undefined
            : this.identityKey.decrypt,
      });

      if (decrypted.inviteeIdentity === this.deviceId) {
        return false;
      }

      const claimedOwner =
        decrypted.ownerPublicKey ||
        this.resolveToOwner(decrypted.inviteeIdentity);
      const pendingResponse: PendingInviteResponse = {
        eventId: event.id,
        ownerPublicKey: claimedOwner,
        deviceId: decrypted.inviteeIdentity,
        inviteeSessionPublicKey: decrypted.inviteeSessionPublicKey,
        ephemeralPrivateKey: ephemeralPrivkey,
        sharedSecret: this.inviteKeys.sharedSecret,
      };

      const persistedAppKeys = this.userRecords.get(claimedOwner)?.appKeys;
      if (
        this.installInviteResponseSession(pendingResponse, persistedAppKeys)
      ) {
        return true;
      }

      this.queuePendingInviteResponse(pendingResponse);
      await this.setupUser(claimedOwner).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  protected async processInviteEvent(event: VerifiedEvent): Promise<boolean> {
    let invite: Invite;
    try {
      invite = Invite.fromEvent(event);
    } catch {
      return false;
    }

    const deviceId = invite.deviceId || invite.inviter;
    if (!deviceId) {
      return false;
    }
    if (deviceId === this.deviceId) {
      return false;
    }

    let handled = false;
    for (const userRecord of this.userRecords.values()) {
      const device = userRecord.devices.get(deviceId);
      if (!device) continue;
      handled = true;
      await device.acceptInvite(invite).catch(() => {});
    }
    return handled;
  }

  /** Set or clear the default expiration applied to outgoing rumors. */
  async setDefaultExpiration(
    options: ExpirationOptions | undefined,
  ): Promise<void> {
    await this.expirationSettings.setDefault(options);
  }

  /** Set, disable, or clear the expiration override for one peer. */
  async setExpirationForPeer(
    peerPubkey: string,
    options: ExpirationOptions | null | undefined,
  ): Promise<void> {
    await this.expirationSettings.setPeer(peerPubkey, options);
  }

  /** Set, disable, or clear the expiration override for one group. */
  async setExpirationForGroup(
    groupId: string,
    options: ExpirationOptions | null | undefined,
  ): Promise<void> {
    await this.expirationSettings.setGroup(groupId, options);
  }

  close() {
    for (const timeout of this.bootstrapRetryTimeouts) {
      clearTimeout(timeout);
    }
    this.bootstrapRetryTimeouts.clear();

    for (const userRecord of this.userRecords.values()) {
      userRecord.close();
    }

    this.ourInviteResponseSubscription?.();
    this.ourInviteResponseSubscription = null;
    this.legacyDirectMessageSubscription?.();
    this.legacyDirectMessageSubscription = null;
    this.legacyDirectMessageAuthors = [];
    this.pendingDirectMessages.clear();
    for (const unsubscribe of this.legacyRuntimeSubscriptions.values()) {
      unsubscribe();
    }
    this.legacyRuntimeSubscriptions.clear();
  }

  deactivateCurrentSessions(publicKey: string) {
    const userRecord = this.userRecords.get(publicKey);
    if (!userRecord) return;
    userRecord.deactivateCurrentSessions();
    this.storeUserRecord(publicKey).catch(() => {});
  }

  async deleteChat(userPubkey: string): Promise<void> {
    return this.deleteUser(this.resolveToOwner(userPubkey));
  }

  async deleteUser(userPubkey: string): Promise<void> {
    await this.init();

    const ownerPubkey = this.resolveToOwner(userPubkey);
    if (ownerPubkey === this.ownerPublicKey) return;

    const userRecord = this.userRecords.get(ownerPubkey);

    if (userRecord) {
      userRecord.close();
      for (const device of userRecord.devices.values()) {
        await device.revoke();
      }
      this.userRecords.delete(ownerPubkey);
    }

    // Remove discovery queue entries for this owner
    await this.discoveryQueue.removeForTarget(ownerPubkey);
    // Remove message queue entries for all known devices
    if (userRecord) {
      for (const [deviceId] of userRecord.devices) {
        await this.messageQueue.removeForTarget(deviceId);
      }
    }

    await this.userRecordStorage.deleteUserData(ownerPubkey);
  }

  async queuedMessageDiagnostics(
    innerEventId?: string,
  ): Promise<QueuedMessageDiagnostic[]> {
    await this.init();
    return queuedMessageDiagnostics({
      userRecords: this.userRecords,
      discoveryQueue: this.discoveryQueue,
      messageQueue: this.messageQueue,
      innerEventId,
    });
  }

  protected async flushMessageQueue(deviceIdentity: string): Promise<void> {
    const ownerPubkey = this.resolveToOwner(deviceIdentity);
    const userRecord = this.userRecords.get(ownerPubkey);
    const device = userRecord?.devices.get(deviceIdentity);
    if (!device) {
      return;
    }

    await device.flushMessageQueue();
    await this.storeUserRecord(ownerPubkey).catch(() => {});
  }

  protected async sendLinkBootstrap(
    ownerPublicKey: string,
    deviceId: string,
  ): Promise<void> {
    const userRecord = this.userRecords.get(ownerPublicKey);
    const session = userRecord?.devices.get(deviceId)?.activeSession;
    if (!session) {
      return;
    }

    try {
      const bootstrapEvents = planInviteBootstrapEvents(session, deviceId);
      const [initialBootstrap] = bootstrapEvents;
      if (!initialBootstrap) {
        return;
      }
      await this.emitPublish(initialBootstrap);
      scheduleInviteBootstrapRetryEvents(
        bootstrapEvents,
        (event) => this.emitPublish(event),
        this.bootstrapRetryTimeouts,
      );
      await this.storeUserRecord(ownerPublicKey).catch(() => {});
    } catch {
      // Ignore bootstrap send failures; the next valid inbound event will retry queue flush.
    }
  }

  protected async sendInviteBootstrap(
    session: Session,
    recipientDevicePubkey: string,
  ): Promise<void> {
    try {
      const bootstrapEvents = planInviteBootstrapEvents(
        session,
        recipientDevicePubkey,
      );
      const [initialBootstrap] = bootstrapEvents;
      if (!initialBootstrap) {
        return;
      }
      await this.emitPublish(initialBootstrap);
      scheduleInviteBootstrapRetryEvents(
        bootstrapEvents,
        (event) => this.emitPublish(event),
        this.bootstrapRetryTimeouts,
      );
    } catch {
      // The session is still established even if the bootstrap publish fails.
    }
  }

  protected abstract storeUserRecord(publicKey: string): Promise<void>;
}
