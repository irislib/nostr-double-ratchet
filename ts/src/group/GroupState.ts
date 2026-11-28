import { type VerifiedEvent } from "nostr-tools";
import { type GroupData } from "../GroupMeta.js";
import { OneToManyChannel } from "../OneToManyChannel.js";
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "../StorageAdapter.js";
import type { GroupOptions, GroupDecryptedEvent } from "../GroupChannel.js";
import { isHex32 } from "./groupInternals.js";
import type { NostrPublisherOptions } from "../types.js";
import { PendingGroupEvents } from "./PendingGroupEvents.js";
import { ConsumedGroupEvents } from "./ConsumedGroupEvents.js";

export abstract class GroupState {
  public data: GroupData;

  protected readonly ourOwnerPubkey: string;

  protected readonly ourDevicePubkey: string;

  protected memberOwnerPubkeys: string[];

  protected readonly storage: StorageAdapter;

  protected readonly groupDevicePubkeys: GroupOptions["groupDevicePubkeys"];
  protected readonly beforeConsume: GroupOptions["beforeConsume"];
  protected readonly publicationOptions: NostrPublisherOptions;

  protected readonly oneToMany: OneToManyChannel;

  protected readonly storageVersion = "1";

  protected readonly versionPrefix: string;

  protected initialized = false;

  protected senderDeviceToEvent: Map<string, string> = new Map();

  protected senderEventToDevice: Map<string, string> = new Map();

  protected senderDeviceToOwner: Map<string, string> = new Map();

  protected readonly pendingOuter: PendingGroupEvents;
  protected readonly consumedOuter: ConsumedGroupEvents;

  constructor(opts: GroupOptions) {
    this.data = opts.data;
    this.ourOwnerPubkey = opts.ourOwnerPubkey;
    this.ourDevicePubkey = opts.ourDevicePubkey;
    this.memberOwnerPubkeys = [...opts.data.members];
    this.storage = opts.storage || new InMemoryStorageAdapter();
    this.publicationOptions = opts;
    this.groupDevicePubkeys = opts.groupDevicePubkeys;
    this.beforeConsume = opts.beforeConsume;
    this.oneToMany = opts.oneToMany || OneToManyChannel.default();
    // Storage namespace shared with the earlier BroadcastChannel prototype for compatibility.
    this.versionPrefix = `v${this.storageVersion}/broadcast-channel`;
    this.pendingOuter = new PendingGroupEvents(this.storage, `${this.versionPrefix}/group/${this.groupId()}/pending-outer/`);
    this.consumedOuter = new ConsumedGroupEvents(this.storage, `${this.versionPrefix}/group/${this.groupId()}/consumed-outer/`);
  }

  groupId(): string {
    return this.data.id;
  }

  /** Erase optional replay acceleration; ratchet state and history are retained. */
  async clearReplayCache(): Promise<void> { await this.consumedOuter.clear(); }

  setData(data: GroupData): void {
    this.data = data;
    this.memberOwnerPubkeys = [...data.members];
  }

  setMembers(memberOwnerPubkeys: string[]): void {
    this.memberOwnerPubkeys = [...memberOwnerPubkeys];
  }

  async listSenderEventPubkeys(): Promise<string[]> {
    await this.init();
    await this.purgeInactiveSenders();
    if (!this.isMemberOwnerPubkey(this.ourOwnerPubkey)) return [];
    return Array.from(new Set(this.senderDeviceToEvent.values())).filter(key =>
      !this.memberOwnerPubkeys.includes(key) && key !== this.ourDevicePubkey && !this.senderDeviceToEvent.has(key));
  }

  async getSenderEventPubkeyForDevice(
    senderDevicePubkey: string,
  ): Promise<string | undefined> {
    await this.init();
    await this.purgeInactiveSenders();
    return this.senderDeviceToEvent.get(senderDevicePubkey);
  }

  protected async init(): Promise<void> {
    if (this.initialized) return;

    // Load (device -> owner) and (device -> senderEventPubkey) mappings.
    const groupPrefix = `${this.versionPrefix}/group/${this.groupId()}/sender/`;
    const keys = await this.storage.list(groupPrefix);

    for (const key of keys) {
      if (key.endsWith("/sender-event-pubkey")) {
        const senderDevicePubkey = key.slice(groupPrefix.length).split("/")[0];
        const senderEventPubkey = await this.storage.get<string>(key);
        if (
          typeof senderEventPubkey === "string" &&
          isHex32(senderEventPubkey) &&
          isHex32(senderDevicePubkey)
        ) {
          this.setSenderEventMapping(senderDevicePubkey, senderEventPubkey);
        }
      } else if (key.endsWith("/sender-owner-pubkey")) {
        const senderDevicePubkey = key.slice(groupPrefix.length).split("/")[0];
        const owner = await this.storage.get<string>(key);
        if (typeof owner === "string" && isHex32(senderDevicePubkey)) {
          this.senderDeviceToOwner.set(senderDevicePubkey, owner);
        }
      }
    }
    this.initialized = true;
  }

  protected groupSenderPrefix(senderDevicePubkey: string): string {
    return `${this.versionPrefix}/group/${this.groupId()}/sender/${senderDevicePubkey}`;
  }

  protected senderEventSecretKeyKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/sender-event-secret-key`;
  }

  protected senderEventPubkeyKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/sender-event-pubkey`;
  }

  protected senderOwnerPubkeyKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/sender-owner-pubkey`;
  }

  protected latestKeyIdKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/latest-key-id`;
  }

  protected senderKeyStateKey(
    senderDevicePubkey: string,
    keyId: number,
  ): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/key/${keyId >>> 0}`;
  }

  /** Earliest chain point a received key was built from; not under `key/`, which lists states. */
  protected senderKeyOriginKey(
    senderDevicePubkey: string,
    keyId: number,
  ): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/key-origin/${keyId >>> 0}`;
  }

  protected senderKeyRepairSnapshotsKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/repair-snapshots`;
  }

  protected setSenderEventMapping(
    senderDevicePubkey: string,
    senderEventPubkey: string,
  ): void {
    const prev = this.senderDeviceToEvent.get(senderDevicePubkey);
    if (prev && prev !== senderEventPubkey) {
      this.senderEventToDevice.delete(prev);
    }
    this.senderDeviceToEvent.set(senderDevicePubkey, senderEventPubkey);
    this.senderEventToDevice.set(senderEventPubkey, senderDevicePubkey);
  }

  protected isMemberOwnerPubkey(ownerPubkey: string): boolean {
    return this.memberOwnerPubkeys.includes(ownerPubkey);
  }

  protected isSenderDeviceActive(senderDevicePubkey: string): boolean {
    if (senderDevicePubkey === this.ourDevicePubkey) {
      return this.isMemberOwnerPubkey(this.ourOwnerPubkey);
    }

    const ownerPubkey = this.senderDeviceToOwner.get(senderDevicePubkey);
    return (
      typeof ownerPubkey === "string" && this.isMemberOwnerPubkey(ownerPubkey)
    );
  }

  protected async removeSenderDeviceState(
    senderDevicePubkey: string,
  ): Promise<void> {
    const senderEventPubkey = this.senderDeviceToEvent.get(senderDevicePubkey);
    if (senderEventPubkey) {
      await this.pendingOuter.removeSender(senderEventPubkey);
      this.senderDeviceToEvent.delete(senderDevicePubkey);
      this.senderEventToDevice.delete(senderEventPubkey);
    } else {
      this.senderDeviceToEvent.delete(senderDevicePubkey);
    }

    for (const [
      mappedSenderEventPubkey,
      mappedSenderDevicePubkey,
    ] of Array.from(this.senderEventToDevice.entries())) {
      if (mappedSenderDevicePubkey !== senderDevicePubkey) {
        continue;
      }

      await this.pendingOuter.removeSender(mappedSenderEventPubkey);
      this.senderEventToDevice.delete(mappedSenderEventPubkey);
    }

    this.senderDeviceToOwner.delete(senderDevicePubkey);

    const senderPrefix = this.groupSenderPrefix(senderDevicePubkey);
    const keys = await this.storage.list(senderPrefix);
    await Promise.allSettled(keys.map((key) => this.storage.del(key)));
  }

  protected async purgeInactiveSenders(): Promise<void> {
    const candidates = new Set<string>([
      ...this.senderDeviceToEvent.keys(),
      ...this.senderDeviceToOwner.keys(),
      ...this.senderEventToDevice.values(),
    ]);

    for (const senderDevicePubkey of candidates) {
      if (!this.isSenderDeviceActive(senderDevicePubkey)) {
        await this.removeSenderDeviceState(senderDevicePubkey);
      }
    }
  }

  protected async queuePending(
    senderEventPubkey: string,
    keyId: number | undefined,
    outer: VerifiedEvent,
  ): Promise<void> {
    const parsed = this.oneToMany.parseOuterEvent(outer);
    await this.pendingOuter.enqueue(senderEventPubkey, keyId, outer, parsed.messageNumber);
  }

  protected async drainPending(
    senderEventPubkey: string,
    keyId: number,
  ): Promise<GroupDecryptedEvent[]> {
    const results: GroupDecryptedEvent[] = [];
    for (const key of await this.pendingOuter.entries(senderEventPubkey, keyId)) {
      const outer = await this.pendingOuter.get(key);
      if (!outer) continue;
      const dec = await this.handleOuterEvent(outer);
      // Retain unresolved ciphertext and interrupted work for a later key/retry.
      if (dec) results.push(dec);
    }
    return results;
  }

  abstract handleOuterEvent(
    outer: VerifiedEvent,
  ): Promise<GroupDecryptedEvent | null>;
}
