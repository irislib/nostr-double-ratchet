import {
  IdentityKey,
  NostrSubscribe,
  NostrPublish,
  Rumor,
  CHAT_MESSAGE_KIND,
  CHAT_SETTINGS_KIND,
  RECEIPT_KIND,
  TYPING_KIND,
  ReceiptType,
  ExpirationOptions,
  ChatSettingsPayloadV1,
} from "./types.js";
import { StorageAdapter } from "./StorageAdapter.js";
import { type VerifiedEvent } from "nostr-tools";
import {
  buildRumorEvent,
  ensureMsTag,
  ensureRecipientTag,
} from "./messageBuilders.js";
import {
  applyExpirationPolicy,
  chatSettingsAdoptionForRumor,
  expirationOverrideFromSendOptions,
} from "./session-manager/messagePolicy.js";
import { hydrateUserRecord } from "./session-manager/userRecordHydration.js";
import type {
  DeviceRecord,
  InviteCredentials,
} from "./session-manager/types.js";
import { SessionManagerInvites } from "./session-manager/SessionManagerInvites.js";

export type {
  AcceptInviteOptions,
  AcceptInviteResult,
  DeviceRecord,
  InviteCredentials,
  OnEventCallback,
  OnEventMeta,
  SessionManagerEvent,
  SessionManagerEventsAvailableCallback,
  UserRecord,
} from "./session-manager/types.js";

export type {
  QueuedMessageDiagnostic,
  QueuedMessageStage,
} from "./session-manager/queueDiagnostics.js";

export interface SendMessageOptions extends ExpirationOptions {
  kind?: number;
  tags?: string[][];
  expiration?: ExpirationOptions | null;
}

export class SessionManager extends SessionManagerInvites {
  static createForRuntime(
    ourPublicKey: string,
    identityKey: IdentityKey,
    deviceId: string,
    ownerPublicKey: string,
    inviteKeys: InviteCredentials,
    storage?: StorageAdapter,
  ): SessionManager {
    const noopSubscribe: NostrSubscribe = () => () => {};
    const noopPublish: NostrPublish = async (event) => event as VerifiedEvent;
    const manager = new SessionManager(
      ourPublicKey,
      identityKey,
      deviceId,
      noopSubscribe,
      noopPublish,
      ownerPublicKey,
      inviteKeys,
      storage,
    );
    manager.legacyNostrSubscribe = undefined;
    manager.legacyNostrPublish = undefined;
    return manager;
  }

  async sendEvent(
    recipientIdentityKey: string,
    event: Partial<Rumor>,
  ): Promise<Rumor | undefined> {
    await this.init();

    await Promise.allSettled([
      this.setupUser(recipientIdentityKey),
      this.setupUser(this.ownerPublicKey),
    ]);

    // Queue event for devices that don't have sessions yet
    const completeEvent = event as Rumor;
    const targets = new Set([recipientIdentityKey, this.ownerPublicKey]);
    const queuedDeviceIds = new Set<string>();
    for (const target of targets) {
      const userRecord = this.userRecords.get(target);
      const knownDeviceIds = new Set<string>();

      for (const device of userRecord?.appKeys?.getAllDevices() ?? []) {
        if (device.identityPubkey && device.identityPubkey !== this.deviceId) {
          knownDeviceIds.add(device.identityPubkey);
        }
      }

      for (const deviceId of userRecord?.devices.keys() ?? []) {
        if (deviceId && deviceId !== this.deviceId) {
          knownDeviceIds.add(deviceId);
        }
      }

      if (knownDeviceIds.size > 0) {
        // If we know concrete device ids, queue directly to them so delivery can
        // flush as soon as any invite/session bootstrap completes.
        for (const deviceId of knownDeviceIds) {
          await this.messageQueue.add(deviceId, completeEvent);
          queuedDeviceIds.add(deviceId);
        }
      } else {
        await this.discoveryQueue.add(target, completeEvent);
      }
    }

    const userRecord = this.getOrCreateUserRecord(recipientIdentityKey);
    // Use ownerPublicKey to find sibling devices (important for delegates)
    const ourUserRecord = this.getOrCreateUserRecord(this.ownerPublicKey);

    const recipientDevices = Array.from(userRecord.devices.values());
    const ownDevices = Array.from(ourUserRecord.devices.values());

    // Merge and deduplicate by deviceId, excluding our own sending device
    // This fixes the self-message bug where sending to yourself would duplicate devices
    const deviceMap = new Map<string, DeviceRecord>();
    for (const d of [...recipientDevices, ...ownDevices]) {
      if (d.deviceId !== this.deviceId) {
        // Exclude sender's own device
        deviceMap.set(d.deviceId, d);
      }
    }
    const devices = Array.from(deviceMap.values());

    // Ratchet all sessions synchronously first, then persist state BEFORE network I/O.
    //
    // This is important for apps that "fire and forget" sendEvent() (e.g. UI click handlers):
    // if the page reloads/crashes while publishes are still in-flight, we still want the
    // updated session keys to be on disk so the next incoming message can be decrypted.
    const toPublish: Parameters<NostrPublish>[0][] = [];
    const sentDeviceIds: string[] = [];
    for (const device of devices) {
      // Check if device is still authorized
      const deviceOwner = this.resolveToOwner(device.deviceId);
      if (
        deviceOwner !== device.deviceId &&
        !this.isDeviceAuthorized(deviceOwner, device.deviceId)
      ) {
        continue;
      }

      const verifiedEvent = device.prepareOutboundEvent(completeEvent);
      if (!verifiedEvent) {
        continue;
      }
      toPublish.push(verifiedEvent);
      sentDeviceIds.push(device.deviceId);
    }

    // Persist recipient + owner records before publishing (best-effort).
    await this.storeUserRecord(recipientIdentityKey).catch(() => {});
    if (this.ownerPublicKey !== recipientIdentityKey) {
      await this.storeUserRecord(this.ownerPublicKey).catch(() => {});
    }

    await Promise.allSettled(
      toPublish.map((evt, i) =>
        this.emitPublish(evt, (event as Rumor).id).then(() => {
          const deviceId = sentDeviceIds[i];
          this.messageQueue
            .removeByTargetAndEventId(deviceId, (event as Rumor).id)
            .catch(() => {});
          this.flushMessageQueue(deviceId).catch(() => {});
        }),
      ),
    );

    await Promise.allSettled(
      Array.from(queuedDeviceIds).map((deviceId) =>
        this.flushMessageQueue(deviceId),
      ),
    );

    // Return the event with computed ID (same as library would compute)
    return completeEvent;
  }

  async sendMessage(
    recipientPublicKey: string,
    content: string,
    options: SendMessageOptions = {},
  ): Promise<Rumor> {
    const { kind = CHAT_MESSAGE_KIND, tags = [] } = options;

    const now = Date.now();
    const builtTags = ensureMsTag(
      ensureRecipientTag(tags, recipientPublicKey),
      now,
    );

    const groupId = builtTags.find((t) => t[0] === "l")?.[1];
    applyExpirationPolicy({
      kind,
      nowSeconds: Math.floor(now / 1000),
      tags: builtTags,
      expirationOverride: expirationOverrideFromSendOptions(options),
      defaultExpiration: this.expirationSettings.default,
      peerExpiration: this.expirationSettings.peer(recipientPublicKey),
      hasPeerExpiration: this.expirationSettings.hasPeer(recipientPublicKey),
      groupExpiration: groupId
        ? this.expirationSettings.group(groupId)
        : undefined,
      hasGroupExpiration: groupId
        ? this.expirationSettings.hasGroup(groupId)
        : false,
    });

    const rumor = buildRumorEvent({
      kind,
      content,
      tags: builtTags,
      pubkey: this.ourPublicKey,
      nowMs: now,
      ensureMsTag: false,
    });

    // Use sendEvent for actual sending (includes queueing).
    // Note: sendEvent is not awaited to maintain backward compatibility.
    this.sendEvent(recipientPublicKey, rumor).catch(() => {});

    return rumor;
  }

  /**
   * Send an encrypted kind-10448 chat-settings event without an expiration tag.
   */
  async sendChatSettings(
    recipientPublicKey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"],
  ): Promise<Rumor> {
    const payload: ChatSettingsPayloadV1 = {
      type: "chat-settings",
      v: 1,
      messageTtlSeconds,
    };
    return this.sendMessage(recipientPublicKey, JSON.stringify(payload), {
      kind: CHAT_SETTINGS_KIND,
      expiration: null,
    });
  }

  /**
   * Update a peer's disappearing-message TTL and notify it with chat settings.
   */
  async setChatSettingsForPeer(
    peerPubkey: string,
    messageTtlSeconds: ChatSettingsPayloadV1["messageTtlSeconds"],
  ): Promise<Rumor> {
    if (messageTtlSeconds === undefined) {
      await this.setExpirationForPeer(peerPubkey, undefined);
    } else if (messageTtlSeconds === null || messageTtlSeconds === 0) {
      await this.setExpirationForPeer(peerPubkey, null);
    } else {
      await this.setExpirationForPeer(peerPubkey, {
        ttlSeconds: messageTtlSeconds,
      });
    }

    return this.sendChatSettings(peerPubkey, messageTtlSeconds);
  }

  async sendReceipt(
    recipientPublicKey: string,
    receiptType: ReceiptType,
    messageIds: string[],
  ): Promise<Rumor | undefined> {
    if (messageIds.length === 0) return;
    return this.sendMessage(recipientPublicKey, receiptType, {
      kind: RECEIPT_KIND,
      tags: messageIds.map((id) => ["e", id]),
    });
  }

  async sendTyping(recipientPublicKey: string): Promise<Rumor> {
    return this.sendMessage(recipientPublicKey, "typing", {
      kind: TYPING_KIND,
    });
  }

  protected maybeAutoAdoptChatSettings(
    event: Rumor,
    fromOwnerPubkey: string,
  ): void {
    if (!this.autoAdoptChatSettings) return;
    const adoption = chatSettingsAdoptionForRumor(
      event,
      fromOwnerPubkey,
      this.ownerPublicKey,
    );
    if (!adoption) return;

    this.setExpirationForPeer(adoption.peerPubkey, adoption.options).catch(
      () => {},
    );
  }

  protected storeUserRecord(publicKey: string) {
    const userRecord = this.userRecords.get(publicKey);
    return this.userRecordStorage.storeUserRecord(publicKey, userRecord);
  }

  protected loadUserRecord(publicKey: string) {
    return this.userRecordStorage
      .loadUserRecord(publicKey)
      .then((data) => {
        if (!data) return;
        hydrateUserRecord({
          data,
          publicKey,
          getOrCreateUserRecord: (ownerPubkey) =>
            this.getOrCreateUserRecord(ownerPubkey),
          rememberDelegate: (deviceId, ownerPubkey) => {
            this.delegateToOwner.set(deviceId, ownerPubkey);
          },
          rememberProcessedInviteResponse: (eventId) => {
            this.processedInviteResponses.add(eventId);
          },
        });
      })
      .catch(() => {
        // Failed to load user record
      });
  }

  protected loadAllUserRecords() {
    return this.userRecordStorage
      .loadAllUserRecordPubkeys()
      .then((publicKeys) =>
        Promise.all(
          publicKeys.map((publicKey) => this.loadUserRecord(publicKey)),
        ),
      );
  }
}
