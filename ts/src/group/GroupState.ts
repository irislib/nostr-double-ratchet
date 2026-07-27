import { type VerifiedEvent } from "nostr-tools";
import { type GroupData } from "../GroupMeta.js";
import { OneToManyChannel } from "../OneToManyChannel.js";
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "../StorageAdapter.js";
import type { GroupOptions, GroupDecryptedEvent } from "../GroupChannel.js";
import { isHex32 } from "./groupInternals.js";

export abstract class GroupState {
  public data: GroupData;

  protected readonly ourOwnerPubkey: string;

  protected readonly ourDevicePubkey: string;

  protected memberOwnerPubkeys: string[];

  protected readonly storage: StorageAdapter;

  protected readonly oneToMany: OneToManyChannel;

  protected readonly storageVersion = "1";

  protected readonly versionPrefix: string;

  protected initialized = false;

  protected senderDeviceToEvent: Map<string, string> = new Map();

  protected senderEventToDevice: Map<string, string> = new Map();

  protected senderDeviceToOwner: Map<string, string> = new Map();

  protected pendingOuter: Map<string, VerifiedEvent[]> = new Map();

  constructor(opts: GroupOptions) {
    this.data = opts.data;
    this.ourOwnerPubkey = opts.ourOwnerPubkey;
    this.ourDevicePubkey = opts.ourDevicePubkey;
    this.memberOwnerPubkeys = [...opts.data.members];
    this.storage = opts.storage || new InMemoryStorageAdapter();
    this.oneToMany = opts.oneToMany || OneToManyChannel.default();
    // Storage namespace shared with the earlier BroadcastChannel prototype for compatibility.
    this.versionPrefix = `v${this.storageVersion}/broadcast-channel`;
  }

  groupId(): string {
    return this.data.id;
  }

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
    return Array.from(new Set(this.senderDeviceToEvent.values()));
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
    this.initialized = true;

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
      this.senderDeviceToEvent.delete(senderDevicePubkey);
      this.senderEventToDevice.delete(senderEventPubkey);
      for (const pendingKey of Array.from(this.pendingOuter.keys())) {
        if (pendingKey.startsWith(`${senderEventPubkey}:`)) {
          this.pendingOuter.delete(pendingKey);
        }
      }
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

      this.senderEventToDevice.delete(mappedSenderEventPubkey);
      for (const pendingKey of Array.from(this.pendingOuter.keys())) {
        if (pendingKey.startsWith(`${mappedSenderEventPubkey}:`)) {
          this.pendingOuter.delete(pendingKey);
        }
      }
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

  protected pendingKey(
    senderEventPubkey: string,
    keyId?: number | null,
  ): string {
    return `${senderEventPubkey}:${keyId === undefined || keyId === null ? "*" : keyId >>> 0}`;
  }

  protected queuePending(
    senderEventPubkey: string,
    keyId: number | undefined,
    outer: VerifiedEvent,
  ): void {
    const k = this.pendingKey(senderEventPubkey, keyId);
    const existing = this.pendingOuter.get(k) || [];
    existing.push(outer);
    this.pendingOuter.set(k, existing);
  }

  protected async drainPending(
    senderEventPubkey: string,
    keyId: number,
  ): Promise<GroupDecryptedEvent[]> {
    const keys = [
      this.pendingKey(senderEventPubkey, keyId),
      this.pendingKey(senderEventPubkey),
    ];
    const pending = keys.flatMap((key) => this.pendingOuter.get(key) || []);
    if (!pending || pending.length === 0) return [];
    for (const key of keys) {
      this.pendingOuter.delete(key);
    }

    // Best-effort: decrypt in message-number order to reduce skipped-key cache pressure.
    const withN = pending
      .map((outer) => {
        try {
          const parsed = this.oneToMany.parseOuterEvent(outer);
          return { outer, n: parsed.messageNumber };
        } catch {
          return { outer, n: 0 };
        }
      })
      .sort((a, b) => a.n - b.n);

    const results: GroupDecryptedEvent[] = [];
    for (const { outer } of withN) {
      const dec = await this.handleOuterEvent(outer);
      if (dec) results.push(dec);
    }
    return results;
  }

  abstract handleOuterEvent(
    outer: VerifiedEvent,
  ): Promise<GroupDecryptedEvent | null>;
}
