import { AppKeys } from "../AppKeys.js";
import { DelegateManager, type DelegatePayload } from "../AppKeysManager.js";
import { Invite } from "../Invite.js";
import { type GroupData } from "../Group.js";
import { shouldRequireRelayRegistrationConfirmation } from "../multiDevice.js";
import {
  SessionManager,
  type AcceptInviteOptions,
  type AcceptInviteResult,
} from "../SessionManager.js";
import { type VerifiedEvent } from "nostr-tools";
import {
  type RuntimeGroupEvent,
  type SendGroupEventOptions,
} from "../RuntimeGroupController.js";
import { NdrRuntimeMessaging } from "./NdrRuntimeMessaging.js";
import type {
  NdrRuntimeState,
  PreparedRegistration,
  PreparedRevocation,
  PrepareRegistrationOptions,
  PrepareRegistrationForIdentityOptions,
  PrepareRevocationOptions,
  PublishPreparedRegistrationResult,
  RegisterCurrentDeviceOptions,
  RegisterDeviceIdentityOptions,
  RevokeDeviceOptions,
} from "../NdrRuntime.js";
import { cloneAppKeys, now } from "./runtimeInternals.js";

export abstract class NdrRuntimeRegistration extends NdrRuntimeMessaging {
  async prepareRegistration(
    options: PrepareRegistrationOptions,
  ): Promise<PreparedRegistration> {
    await this.initManagers();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }

    const baseKeys = await this.resolveBaseAppKeys(
      options.ownerPubkey,
      options.timeoutMs,
    );
    const appKeys = cloneAppKeys(baseKeys);

    const payload = this.buildRegistrationPayload(
      this.delegateManager,
      options,
    );
    appKeys.addDevice({
      identityPubkey: payload.identityPubkey,
      createdAt: now(),
    });
    if (payload.deviceLabel || payload.clientLabel) {
      appKeys.setDeviceLabels(payload.identityPubkey, payload);
    }

    return {
      ownerPubkey: options.ownerPubkey,
      appKeys,
      devices: appKeys.getAllDevices(),
      baseDevices: baseKeys.getAllDevices(),
      newDeviceIdentity: payload.identityPubkey,
    };
  }

  async prepareRegistrationForIdentity(
    options: PrepareRegistrationForIdentityOptions,
  ): Promise<PreparedRegistration> {
    await this.initAppKeysManager();

    const baseKeys = await this.resolveBaseAppKeys(
      options.ownerPubkey,
      options.timeoutMs,
    );
    const appKeys = cloneAppKeys(baseKeys);
    appKeys.addDevice({
      identityPubkey: options.identityPubkey,
      createdAt: now(),
    });
    if (options.deviceLabel || options.clientLabel) {
      appKeys.setDeviceLabels(options.identityPubkey, options);
    }

    return {
      ownerPubkey: options.ownerPubkey,
      appKeys,
      devices: appKeys.getAllDevices(),
      baseDevices: baseKeys.getAllDevices(),
      newDeviceIdentity: options.identityPubkey,
    };
  }

  async publishPreparedRegistration(
    prepared: PreparedRegistration,
  ): Promise<PublishPreparedRegistrationResult> {
    await this.initAppKeysManager();
    const relayConfirmationRequired =
      shouldRequireRelayRegistrationConfirmation({
        currentDevicePubkey: this.state.currentDevicePubkey,
        registeredDevices: prepared.baseDevices,
        hasLocalAppKeys: prepared.baseDevices.length > 0,
        appKeysManagerReady: this.state.appKeysManagerReady,
        sessionManagerReady: this.state.sessionManagerReady,
      });
    const publishedEvent = await this.publishAppKeys(
      prepared.appKeys,
      prepared.ownerPubkey,
    );
    await this.appKeysManager?.setAppKeys(prepared.appKeys);
    this.feedSessionManagerEvent(publishedEvent);
    this.syncState({
      registeredDevices: prepared.devices,
      hasLocalAppKeys: prepared.devices.length > 0,
      lastAppKeysCreatedAt: publishedEvent.created_at ?? now(),
    });
    return {
      createdAt: publishedEvent.created_at ?? now(),
      relayConfirmationRequired,
    };
  }

  async prepareRevocation(
    options: PrepareRevocationOptions,
  ): Promise<PreparedRevocation> {
    const baseKeys = await this.resolveBaseAppKeys(
      options.ownerPubkey,
      options.timeoutMs,
    );
    const appKeys = cloneAppKeys(baseKeys);
    appKeys.removeDevice(options.identityPubkey);
    return {
      ownerPubkey: options.ownerPubkey,
      appKeys,
      devices: appKeys.getAllDevices(),
      revokedIdentity: options.identityPubkey,
    };
  }

  async publishPreparedRevocation(
    prepared: PreparedRevocation,
  ): Promise<number> {
    await this.initAppKeysManager();
    const publishedEvent = await this.publishAppKeys(
      prepared.appKeys,
      prepared.ownerPubkey,
    );
    await this.appKeysManager?.setAppKeys(prepared.appKeys);
    this.feedSessionManagerEvent(publishedEvent);
    this.syncState({
      registeredDevices: prepared.devices,
      hasLocalAppKeys: prepared.devices.length > 0,
      lastAppKeysCreatedAt: publishedEvent.created_at ?? now(),
    });
    return publishedEvent.created_at ?? now();
  }

  async registerCurrentDevice(
    options: RegisterCurrentDeviceOptions,
  ): Promise<PublishPreparedRegistrationResult> {
    const prepared = await this.prepareRegistration(options);
    const result = await this.publishPreparedRegistration(prepared);
    if (result.relayConfirmationRequired) {
      await this.waitForDeviceRegistrationOnRelay(
        options.ownerPubkey,
        prepared.newDeviceIdentity,
        options.timeoutMs || this.appKeysFetchTimeoutMs,
      );
      await this.refreshOwnAppKeysFromRelay(
        options.ownerPubkey,
        options.timeoutMs || this.appKeysFastTimeoutMs,
      ).catch(() => {});
    }
    return {
      createdAt: result.createdAt,
      relayConfirmationRequired: result.relayConfirmationRequired,
    };
  }

  async registerDeviceIdentity(
    options: RegisterDeviceIdentityOptions,
  ): Promise<PublishPreparedRegistrationResult> {
    const prepared = await this.prepareRegistrationForIdentity(options);
    const result = await this.publishPreparedRegistration(prepared);
    if (result.relayConfirmationRequired) {
      await this.waitForDeviceRegistrationOnRelay(
        options.ownerPubkey,
        prepared.newDeviceIdentity,
        options.timeoutMs || this.appKeysFetchTimeoutMs,
      );
      await this.refreshOwnAppKeysFromRelay(
        options.ownerPubkey,
        options.timeoutMs || this.appKeysFastTimeoutMs,
      ).catch(() => {});
    }
    return result;
  }

  async revokeDevice(options: RevokeDeviceOptions): Promise<number> {
    const prepared = await this.prepareRevocation(options);
    return this.publishPreparedRevocation(prepared);
  }

  async ensureCurrentDeviceRegistered(
    ownerPubkey: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    await this.initManagers();
    if (this.state.isCurrentDeviceRegistered) {
      return false;
    }

    await this.registerCurrentDevice({
      ownerPubkey,
      timeoutMs,
    });
    return true;
  }

  async republishInvite(): Promise<void> {
    await this.initDelegateManager();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }
    await this.delegateManager.publishInvite();
  }

  async rotateInvite(): Promise<void> {
    await this.initDelegateManager();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }
    await this.delegateManager.rotateInvite();
  }

  async createLinkInvite(ownerPubkey?: string): Promise<Invite> {
    await this.initDelegateManager();
    if (!this.delegateManager) {
      throw new Error("DelegateManager not initialized");
    }
    const baseInvite = this.delegateManager.getInvite();
    if (!baseInvite) {
      throw new Error("DelegateManager invite not initialized");
    }
    const invite = Invite.deserialize(baseInvite.serialize());
    invite.purpose = "link";
    if (ownerPubkey) {
      invite.ownerPubkey = ownerPubkey;
    }
    return invite;
  }

  async acceptInvite(
    invite: Invite,
    options?: AcceptInviteOptions,
  ): Promise<AcceptInviteResult> {
    const ownerPubkey =
      options?.ownerPublicKey ||
      this.state.ownerPubkey ||
      invite.ownerPubkey ||
      invite.inviter;
    return this.withSessionManager(ownerPubkey, (manager) =>
      manager.acceptInvite(invite, options),
    );
  }

  async acceptLinkInvite(
    invite: Invite,
    ownerPubkey: string,
  ): Promise<AcceptInviteResult> {
    return this.acceptInvite(invite, {
      ownerPublicKey: ownerPubkey,
    });
  }

  async upsertGroup(group: GroupData, ownerPubkey?: string): Promise<void> {
    await this.groupController.upsertGroup(group, ownerPubkey);
  }

  async syncGroups(groups: GroupData[], ownerPubkey?: string): Promise<void> {
    await this.groupController.syncGroups(groups, ownerPubkey);
  }

  removeGroup(groupId: string): void {
    this.groupController.removeGroup(groupId);
  }

  async createGroup(
    name: string,
    memberOwnerPubkeys: string[],
    opts: { fanoutMetadata?: boolean; nowMs?: number } = {},
  ) {
    return this.groupController.createGroup(name, memberOwnerPubkeys, opts);
  }

  async sendGroupEvent(
    groupId: string,
    event: RuntimeGroupEvent,
    opts: SendGroupEventOptions = {},
  ) {
    return this.groupController.sendGroupEvent(groupId, event, opts);
  }

  async sendGroupMessage(
    groupId: string,
    message: string,
    opts: SendGroupEventOptions = {},
  ) {
    return this.groupController.sendGroupMessage(groupId, message, opts);
  }

  protected abstract feedSessionManagerEvent(event: VerifiedEvent): boolean;

  protected abstract withSessionManager<T>(
    ownerPubkey: string,
    operation: (manager: SessionManager) => Promise<T>,
  ): Promise<T>;

  protected abstract buildRegistrationPayload(
    delegateManager: DelegateManager,
    options: Pick<PrepareRegistrationOptions, "deviceLabel" | "clientLabel">,
  ): DelegatePayload;

  protected abstract publishAppKeys(
    appKeys: AppKeys,
    ownerPubkey: string,
  ): Promise<VerifiedEvent>;

  protected abstract waitForDeviceRegistrationOnRelay(
    ownerPubkey: string,
    devicePubkey: string,
    timeoutMs: number,
  ): Promise<void>;

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
