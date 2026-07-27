import { AppKeys } from "../AppKeys.js";
import { Invite } from "../Invite.js";
import { resolveInviteOwnerRouting } from "../multiDevice.js";
import {
  sessionCanReceive,
  sessionCanSend,
  sessionHasActivity,
} from "./sessionSelection.js";
import type { AcceptInviteOptions, AcceptInviteResult } from "./types.js";
import { SessionManagerLifecycle } from "./SessionManagerLifecycle.js";

export abstract class SessionManagerInvites extends SessionManagerLifecycle {
  async acceptInvite(
    invite: Invite,
    options: AcceptInviteOptions = {},
  ): Promise<AcceptInviteResult> {
    await this.init();

    const deviceId = invite.deviceId || invite.inviter;
    if (!deviceId) {
      throw new Error("Invite device id is required");
    }

    if (deviceId === this.deviceId) {
      throw new Error("Cannot accept invite from this device");
    }

    const explicitSameDeviceOwnerHint = options.ownerPublicKey === deviceId;
    const claimedOwnerPublicKey =
      options.ownerPublicKey ||
      invite.ownerPubkey ||
      this.resolveToOwner(deviceId) ||
      deviceId;

    const acceptKey = [
      invite.purpose || "chat",
      claimedOwnerPublicKey,
      deviceId,
      invite.inviterEphemeralPublicKey,
      invite.sharedSecret,
    ].join(":");
    const existingAccept = this.inviteAcceptPromises.get(acceptKey);
    if (existingAccept) {
      return existingAccept;
    }

    const acceptPromise = this.doAcceptInvite(invite, options, {
      deviceId,
      explicitSameDeviceOwnerHint,
      claimedOwnerPublicKey,
    });
    this.inviteAcceptPromises.set(acceptKey, acceptPromise);
    try {
      return await acceptPromise;
    } finally {
      if (this.inviteAcceptPromises.get(acceptKey) === acceptPromise) {
        this.inviteAcceptPromises.delete(acceptKey);
      }
    }
  }

  protected async doAcceptInvite(
    invite: Invite,
    options: AcceptInviteOptions,
    resolved: {
      deviceId: string;
      explicitSameDeviceOwnerHint: boolean;
      claimedOwnerPublicKey: string;
    },
  ): Promise<AcceptInviteResult> {
    const { deviceId, explicitSameDeviceOwnerHint, claimedOwnerPublicKey } =
      resolved;

    let ownerPublicKey = claimedOwnerPublicKey;
    let preloadedAppKeys: AppKeys | null = null;
    let shouldApplyPreloadedRoster = false;

    // When an invite claims delegate ownership, verify against AppKeys when available.
    // If claim verification fails for chat invites, fall back to device-identity routing.
    // For owner-side link flow, allow pre-registration acceptance and register via AppKeys afterward.
    if (claimedOwnerPublicKey !== deviceId) {
      const persistedAppKeys =
        this.userRecords.get(claimedOwnerPublicKey)?.appKeys ||
        (await this.fetchAppKeys(claimedOwnerPublicKey, 50).catch(
          () => null,
        )) ||
        undefined;
      if (options.ownerPublicKey && !persistedAppKeys) {
        ownerPublicKey = claimedOwnerPublicKey;
      } else {
        const routing = resolveInviteOwnerRouting({
          devicePubkey: deviceId,
          claimedOwnerPublicKey,
          invitePurpose: invite.purpose,
          currentOwnerPublicKey: this.ownerPublicKey,
          appKeys: persistedAppKeys,
        });
        if (!routing.fellBackToDeviceIdentity && persistedAppKeys) {
          preloadedAppKeys = persistedAppKeys;
          shouldApplyPreloadedRoster = routing.verifiedWithAppKeys;
          this.updateDelegateMapping(claimedOwnerPublicKey, persistedAppKeys);
        }
        ownerPublicKey = routing.ownerPublicKey;
      }
      if (!persistedAppKeys) {
        await this.setupUser(claimedOwnerPublicKey).catch(() => {});
      }
    }

    const userRecord = this.getOrCreateUserRecord(ownerPublicKey);
    if (preloadedAppKeys && ownerPublicKey === claimedOwnerPublicKey) {
      userRecord.setAppKeys(preloadedAppKeys);
    }
    const applyPreloadedRoster = async () => {
      if (
        preloadedAppKeys &&
        shouldApplyPreloadedRoster &&
        ownerPublicKey === claimedOwnerPublicKey
      ) {
        await userRecord.onAppKeys(preloadedAppKeys).catch(() => {});
      }
    };

    const existingRecord = userRecord.devices.get(deviceId);
    const existingSessions = [
      ...(existingRecord?.activeSession ? [existingRecord.activeSession] : []),
      ...(existingRecord?.inactiveSessions ?? []),
    ];
    if (invite.purpose === "link" && existingSessions.length > 0) {
      await applyPreloadedRoster();
      return { ownerPublicKey, deviceId, session: existingSessions[0] };
    }
    const reusableEstablishedSession = existingSessions.find(
      (session) =>
        sessionCanSend(session) &&
        (sessionCanReceive(session) || sessionHasActivity(session)),
    );
    if (reusableEstablishedSession) {
      await applyPreloadedRoster();
      return { ownerPublicKey, deviceId, session: reusableEstablishedSession };
    }

    const hasAnySession = existingSessions.length > 0;
    const hasDormantImportedPlaceholder =
      explicitSameDeviceOwnerHint &&
      invite.purpose !== "link" &&
      hasAnySession &&
      existingSessions.every(
        (session) =>
          !sessionCanSend(session) &&
          !sessionCanReceive(session) &&
          !sessionHasActivity(session),
      );
    if (hasDormantImportedPlaceholder) {
      await applyPreloadedRoster();
      return { ownerPublicKey, deviceId, session: existingSessions[0] };
    }

    const encryptor =
      this.identityKey instanceof Uint8Array
        ? this.identityKey
        : this.identityKey.encrypt;
    const inviteeOwnerClaim =
      invite.purpose === "link"
        ? this.ownerPublicKey
        : await this.resolveInviteeOwnerClaim(ownerPublicKey);
    const { session, event } = await invite.accept(
      this.ourPublicKey,
      encryptor,
      inviteeOwnerClaim,
    );

    const deviceRecord = this.upsertDeviceRecord(userRecord, deviceId);
    this.delegateToOwner.set(deviceId, ownerPublicKey);
    deviceRecord.installSession(session, false, { preferActive: true });
    await this.emitPublish(event);
    await this.sendInviteBootstrap(session, deviceId);
    if (invite.purpose === "link" && ownerPublicKey === this.ownerPublicKey) {
      await this.sendLinkBootstrap(ownerPublicKey, deviceId);
    }
    await this.flushMessageQueue(deviceId).catch(() => {});
    await this.storeUserRecord(ownerPublicKey).catch(() => {});
    await applyPreloadedRoster();

    return { ownerPublicKey, deviceId, session };
  }

  protected async resolveInviteeOwnerClaim(
    recipientOwnerPublicKey: string,
  ): Promise<string | undefined> {
    if (
      recipientOwnerPublicKey === this.ownerPublicKey &&
      this.deviceId !== this.ownerPublicKey &&
      !this.isDeviceAuthorized(this.ownerPublicKey, this.deviceId)
    ) {
      return undefined;
    }

    // Always advertise the local owner claim when we know it. The receiver still
    // treats that claim as untrusted until AppKeys prove that this device belongs
    // to the claimed owner, but omitting the claim entirely makes later
    // verification impossible because the inviter has no owner timeline to watch.
    return this.ownerPublicKey;
  }

  protected abstract storeUserRecord(publicKey: string): Promise<void>;
}
