import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
  type VerifiedEvent,
} from "nostr-tools";

import {
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
  type GroupData,
} from "./GroupMeta.js";
import {
  classifyMessageOrigin,
  isCrossDeviceSelfOrigin,
  isSelfOrigin,
  type MessageOrigin,
} from "./MessageOrigin.js";
import { OneToManyChannel } from "./OneToManyChannel.js";
import {
  buildSenderKeyRepairRequestRumor,
  parseSenderKeyRepairRequestRumor,
  type SenderKeyRepairRequest,
} from "./SenderKeyRepair.js";
import type {
  SenderKeyDistribution,
  SenderKeyStateSerialized,
} from "./SenderKey.js";
import { SenderKeyState } from "./SenderKey.js";
import { InMemoryStorageAdapter, type StorageAdapter } from "./StorageAdapter.js";
import { CHAT_MESSAGE_KIND, MESSAGE_EVENT_KIND, type Rumor } from "./types.js";

export type PairwiseSend = (
  recipientOwnerPubkey: string,
  rumor: Rumor,
) => Promise<void>;
export type PublishOuter = (
  outer: VerifiedEvent,
  innerEventId?: string,
) => Promise<unknown>;

export interface GroupOptions {
  data: GroupData;
  /** Owner pubkey for *this* device (group membership is expressed in owner pubkeys). */
  ourOwnerPubkey: string;
  /** Device identity pubkey for *this* device (used inside encrypted payloads). */
  ourDevicePubkey: string;
  storage?: StorageAdapter;
  oneToMany?: OneToManyChannel;
}

export interface GroupDecryptedEvent {
  groupId: string;
  senderEventPubkey: string;
  senderDevicePubkey: string;
  senderOwnerPubkey?: string;
  origin: MessageOrigin;
  isSelf: boolean;
  isCrossDeviceSelf: boolean;
  outerEventId: string;
  outerCreatedAt: number;
  keyId: number;
  messageNumber: number;
  inner: Rumor;
}

interface SenderKeyRepairSnapshot {
  keyId: number;
  distribution: SenderKeyDistribution;
  recipients: string[];
}

function getFirstTagValue(
  tags: string[][] | undefined,
  key: string,
): string | undefined {
  const t = tags?.find((tag) => tag[0] === key);
  return t?.[1];
}

function randomU32(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] >>> 0;
}

function isHex32(s: string): boolean {
  return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);
}

function parseSenderKeyDistribution(
  content: string,
): SenderKeyDistribution | null {
  try {
    const d = JSON.parse(content) as Partial<SenderKeyDistribution>;
    if (!d || typeof d !== "object") return null;
    if (typeof d.groupId !== "string") return null;
    if (
      typeof d.keyId !== "number" ||
      !Number.isInteger(d.keyId) ||
      d.keyId < 0
    )
      return null;
    if (typeof d.chainKey !== "string" || !/^[0-9a-f]{64}$/i.test(d.chainKey))
      return null;
    if (
      typeof d.iteration !== "number" ||
      !Number.isInteger(d.iteration) ||
      d.iteration < 0
    )
      return null;
    if (
      typeof d.createdAt !== "number" ||
      !Number.isInteger(d.createdAt) ||
      d.createdAt < 0
    )
      return null;
    if (
      d.senderEventPubkey !== undefined &&
      typeof d.senderEventPubkey !== "string"
    )
      return null;
    return d as SenderKeyDistribution;
  } catch {
    return null;
  }
}

/**
 * Signal-style efficient group messaging:
 *
 * - Each *device* has a per-group "sender event" pubkey (outer Nostr author).
 * - Each device uses a symmetric SenderKeyState chain for forward secrecy within that sender.
 * - Sender keys are distributed pairwise over 1:1 Double Ratchet sessions (forward secure).
 * - Group messages are published once using OneToManyChannel.
 *
 * This class is transport-agnostic:
 * - You provide `sendPairwise` for distributing keys over 1:1 sessions.
 * - You provide `publishOuter` for publishing the one-to-many outer events.
 * - You feed it incoming session rumors + outer events via the `handle…` methods.
 */
export class Group {
  public data: GroupData;

  private readonly ourOwnerPubkey: string;
  private readonly ourDevicePubkey: string;
  private memberOwnerPubkeys: string[];
  private readonly storage: StorageAdapter;
  private readonly oneToMany: OneToManyChannel;

  private readonly storageVersion = "1";
  private readonly versionPrefix: string;

  private initialized = false;

  // In-memory maps (rebuilt from storage on init, then updated live)
  private senderDeviceToEvent: Map<string, string> = new Map();
  private senderEventToDevice: Map<string, string> = new Map();
  private senderDeviceToOwner: Map<string, string> = new Map();

  // Outer events we couldn't decrypt yet (waiting for mapping/state).
  private pendingOuter: Map<string, VerifiedEvent[]> = new Map(); // key: `${senderEventPubkey}:${keyId|*}`

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

  private async init(): Promise<void> {
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

  private groupSenderPrefix(senderDevicePubkey: string): string {
    return `${this.versionPrefix}/group/${this.groupId()}/sender/${senderDevicePubkey}`;
  }

  private senderEventSecretKeyKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/sender-event-secret-key`;
  }

  private senderEventPubkeyKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/sender-event-pubkey`;
  }

  private senderOwnerPubkeyKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/sender-owner-pubkey`;
  }

  private latestKeyIdKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/latest-key-id`;
  }

  private senderKeyStateKey(senderDevicePubkey: string, keyId: number): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/key/${keyId >>> 0}`;
  }

  private senderKeyRepairSnapshotsKey(senderDevicePubkey: string): string {
    return `${this.groupSenderPrefix(senderDevicePubkey)}/repair-snapshots`;
  }

  private setSenderEventMapping(
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

  private isMemberOwnerPubkey(ownerPubkey: string): boolean {
    return this.memberOwnerPubkeys.includes(ownerPubkey);
  }

  private isSenderDeviceActive(senderDevicePubkey: string): boolean {
    if (senderDevicePubkey === this.ourDevicePubkey) {
      return this.isMemberOwnerPubkey(this.ourOwnerPubkey);
    }

    const ownerPubkey = this.senderDeviceToOwner.get(senderDevicePubkey);
    return (
      typeof ownerPubkey === "string" && this.isMemberOwnerPubkey(ownerPubkey)
    );
  }

  private async removeSenderDeviceState(
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

  private async purgeInactiveSenders(): Promise<void> {
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

  private pendingKey(senderEventPubkey: string, keyId?: number | null): string {
    return `${senderEventPubkey}:${keyId === undefined || keyId === null ? "*" : keyId >>> 0}`;
  }

  private queuePending(
    senderEventPubkey: string,
    keyId: number | undefined,
    outer: VerifiedEvent,
  ): void {
    const k = this.pendingKey(senderEventPubkey, keyId);
    const existing = this.pendingOuter.get(k) || [];
    existing.push(outer);
    this.pendingOuter.set(k, existing);
  }

  private async drainPending(
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

  private async ensureOurSenderEventKeys(): Promise<{
    senderEventSecretKey: Uint8Array;
    senderEventPubkey: string;
    changed: boolean;
  }> {
    await this.init();

    const stored = await this.storage.get<string>(
      this.senderEventSecretKeyKey(this.ourDevicePubkey),
    );
    if (typeof stored === "string" && /^[0-9a-f]{64}$/i.test(stored)) {
      const bytes = hexToBytes(stored);
      if (bytes.length === 32) {
        const senderEventPubkey = getPublicKey(bytes);

        // Keep a cached mapping so we can subscribe/decrypt our own outer events if needed.
        this.setSenderEventMapping(this.ourDevicePubkey, senderEventPubkey);
        await this.storage.put(
          this.senderEventPubkeyKey(this.ourDevicePubkey),
          senderEventPubkey,
        );

        return {
          senderEventSecretKey: bytes,
          senderEventPubkey,
          changed: false,
        };
      }
    }

    // Missing/invalid: rotate to a fresh sender-event keypair for this group/device.
    const senderEventSecretKey = generateSecretKey();
    const senderEventPubkey = getPublicKey(senderEventSecretKey);
    await this.storage.put(
      this.senderEventSecretKeyKey(this.ourDevicePubkey),
      bytesToHex(senderEventSecretKey),
    );
    await this.storage.put(
      this.senderEventPubkeyKey(this.ourDevicePubkey),
      senderEventPubkey,
    );
    this.setSenderEventMapping(this.ourDevicePubkey, senderEventPubkey);
    return { senderEventSecretKey, senderEventPubkey, changed: true };
  }

  private async loadSenderKeyState(
    senderDevicePubkey: string,
    keyId: number,
  ): Promise<SenderKeyState | null> {
    const data = await this.storage.get<SenderKeyStateSerialized>(
      this.senderKeyStateKey(senderDevicePubkey, keyId),
    );
    if (!data) return null;
    try {
      return SenderKeyState.fromJSON(data);
    } catch {
      return null;
    }
  }

  private async loadSenderKeyStates(
    senderDevicePubkey: string,
  ): Promise<SenderKeyState[]> {
    const prefix = `${this.groupSenderPrefix(senderDevicePubkey)}/key/`;
    const keys = await this.storage.list(prefix);
    const states: SenderKeyState[] = [];
    for (const key of keys) {
      const data = await this.storage.get<SenderKeyStateSerialized>(key);
      if (!data) continue;
      try {
        states.push(SenderKeyState.fromJSON(data));
      } catch {
        // Ignore corrupt sender-key state entries.
      }
    }
    return states.sort((a, b) => b.keyId - a.keyId);
  }

  private async saveSenderKeyState(
    senderDevicePubkey: string,
    st: SenderKeyState,
  ): Promise<void> {
    await this.storage.put(
      this.senderKeyStateKey(senderDevicePubkey, st.keyId),
      st.toJSON(),
    );
  }

  private async loadSenderKeyRepairSnapshots(
    senderDevicePubkey: string,
  ): Promise<SenderKeyRepairSnapshot[]> {
    const snapshots = await this.storage.get<SenderKeyRepairSnapshot[]>(
      this.senderKeyRepairSnapshotsKey(senderDevicePubkey),
    );
    if (!Array.isArray(snapshots)) return [];
    return snapshots.filter((snapshot) => {
      const dist = snapshot?.distribution;
      return (
        typeof snapshot?.keyId === "number" &&
        Array.isArray(snapshot?.recipients) &&
        dist &&
        typeof dist.groupId === "string" &&
        typeof dist.keyId === "number" &&
        typeof dist.chainKey === "string" &&
        typeof dist.iteration === "number" &&
        typeof dist.createdAt === "number"
      );
    });
  }

  private async saveSenderKeyRepairSnapshots(
    senderDevicePubkey: string,
    snapshots: SenderKeyRepairSnapshot[],
  ): Promise<void> {
    await this.storage.put(
      this.senderKeyRepairSnapshotsKey(senderDevicePubkey),
      snapshots,
    );
  }

  private async recordSenderKeyRepairSnapshot(
    dist: SenderKeyDistribution,
    recipients: string[],
  ): Promise<void> {
    const uniqueRecipients = Array.from(new Set(recipients));
    const snapshots = await this.loadSenderKeyRepairSnapshots(
      this.ourDevicePubkey,
    );
    const duplicate = snapshots.some(
      (snapshot) =>
        snapshot.keyId === dist.keyId &&
        snapshot.distribution.iteration === dist.iteration &&
        snapshot.distribution.senderEventPubkey === dist.senderEventPubkey,
    );
    if (duplicate) return;

    snapshots.push({
      keyId: dist.keyId >>> 0,
      distribution: { ...dist },
      recipients: uniqueRecipients,
    });
    await this.saveSenderKeyRepairSnapshots(this.ourDevicePubkey, snapshots);
  }

  private async repairDistributionsFor(
    requesterOwnerPubkey: string,
    request: SenderKeyRepairRequest,
  ): Promise<SenderKeyDistribution[]> {
    if (request.groupId !== this.groupId()) return [];
    if (!this.isMemberOwnerPubkey(this.ourOwnerPubkey)) return [];
    if (!this.isMemberOwnerPubkey(requesterOwnerPubkey)) return [];

    const localSenderEventPubkey =
      this.senderDeviceToEvent.get(this.ourDevicePubkey) ||
      (await this.storage.get<string>(
        this.senderEventPubkeyKey(this.ourDevicePubkey),
      ));
    if (localSenderEventPubkey !== request.senderEventPubkey) return [];

    const snapshots = await this.loadSenderKeyRepairSnapshots(
      this.ourDevicePubkey,
    );
    const candidates = snapshots.filter((snapshot) => {
      if (snapshot.distribution.groupId !== request.groupId) return false;
      if (snapshot.distribution.senderEventPubkey !== request.senderEventPubkey)
        return false;
      if (!snapshot.recipients.includes(requesterOwnerPubkey)) return false;

      if (
        request.keyId !== undefined &&
        snapshot.keyId !== request.keyId >>> 0
      ) {
        return false;
      }
      if (
        request.messageNumber !== undefined &&
        snapshot.distribution.iteration > request.messageNumber >>> 0
      ) {
        return false;
      }
      return true;
    });

    if (request.keyId !== undefined && request.messageNumber !== undefined) {
      const newest = candidates.sort(
        (a, b) => b.distribution.iteration - a.distribution.iteration,
      )[0];
      return newest ? [newest.distribution] : [];
    }

    const unique = new Map<string, SenderKeyDistribution>();
    for (const snapshot of candidates.sort(
      (a, b) =>
        b.distribution.createdAt - a.distribution.createdAt ||
        b.distribution.iteration - a.distribution.iteration,
    )) {
      const key = `${snapshot.distribution.keyId}:${snapshot.distribution.iteration}`;
      if (!unique.has(key)) {
        unique.set(key, snapshot.distribution);
      }
    }
    return Array.from(unique.values());
  }

  private async ensureOurSenderKeyState(
    forceRotate: boolean,
  ): Promise<{ state: SenderKeyState; created: boolean }> {
    await this.init();

    if (forceRotate) {
      const keyId = randomU32();
      const chainKey = generateSecretKey();
      const state = new SenderKeyState(keyId, chainKey, 0);
      await this.saveSenderKeyState(this.ourDevicePubkey, state);
      await this.storage.put(this.latestKeyIdKey(this.ourDevicePubkey), keyId);
      return { state, created: true };
    }

    const latestKeyId = await this.storage.get<number>(
      this.latestKeyIdKey(this.ourDevicePubkey),
    );
    if (
      typeof latestKeyId === "number" &&
      Number.isInteger(latestKeyId) &&
      latestKeyId >= 0
    ) {
      const existing = await this.loadSenderKeyState(
        this.ourDevicePubkey,
        latestKeyId >>> 0,
      );
      if (existing) {
        return { state: existing, created: false };
      }
    }

    // Missing/invalid: create a fresh sender key state.
    const keyId = randomU32();
    const chainKey = generateSecretKey();
    const state = new SenderKeyState(keyId, chainKey, 0);
    await this.saveSenderKeyState(this.ourDevicePubkey, state);
    await this.storage.put(this.latestKeyIdKey(this.ourDevicePubkey), keyId);
    return { state, created: true };
  }

  private buildDistribution(
    nowSeconds: number,
    senderEventPubkey: string,
    senderKey: SenderKeyState,
  ): SenderKeyDistribution {
    return {
      groupId: this.groupId(),
      keyId: senderKey.keyId,
      chainKey: bytesToHex(senderKey.chainKeyBytes()),
      iteration: senderKey.iterationNumber(),
      createdAt: nowSeconds,
      senderEventPubkey,
    };
  }

  private buildDistributionRumor(
    nowSeconds: number,
    nowMs: number,
    dist: SenderKeyDistribution,
  ): Rumor {
    const rumor: Rumor = {
      kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND,
      content: JSON.stringify(dist),
      created_at: nowSeconds,
      tags: [
        ["l", this.groupId()],
        ["key", String(dist.keyId >>> 0)],
        ["ms", String(nowMs)],
      ],
      pubkey: this.ourDevicePubkey,
      id: "",
    };
    rumor.id = getEventHash(rumor);
    return rumor;
  }

  private buildGroupInnerRumor(
    nowSeconds: number,
    nowMs: number,
    event: { kind: number; content: string; tags?: string[][] },
  ): Rumor {
    const tags = [...(event.tags || [])];
    if (!tags.some((tag) => tag[0] === "l")) {
      tags.unshift(["l", this.groupId()]);
    }
    if (!tags.some((tag) => tag[0] === "ms")) {
      tags.push(["ms", String(nowMs)]);
    }

    const rumor: Rumor = {
      kind: event.kind,
      content: event.content,
      created_at: nowSeconds,
      tags,
      pubkey: this.ourDevicePubkey,
      id: "",
    };
    rumor.id = getEventHash(rumor);
    return rumor;
  }

  private senderKeyRecipientOwnerPubkeys(): string[] {
    return Array.from(
      new Set(
        this.memberOwnerPubkeys.filter(
          (pubkey) => typeof pubkey === "string" && pubkey.length > 0,
        ),
      ),
    );
  }

  /**
   * Rotate our sender key (new keyId + chain key) and distribute it to group members.
   */
  async rotateSenderKey(opts: {
    sendPairwise: PairwiseSend;
    nowMs?: number;
  }): Promise<SenderKeyDistribution> {
    await this.init();

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const { senderEventPubkey } = await this.ensureOurSenderEventKeys();
    const { state } = await this.ensureOurSenderKeyState(true);

    const dist = this.buildDistribution(nowSeconds, senderEventPubkey, state);
    const rumor = this.buildDistributionRumor(nowSeconds, nowMs, dist);

    // Include our owner so sibling devices on the same account can decrypt
    // subsequent outer messages in self-only and multi-device group chats.
    const recipients = this.senderKeyRecipientOwnerPubkeys();
    await this.recordSenderKeyRepairSnapshot(dist, recipients);
    await Promise.allSettled(
      recipients.map((pk) => opts.sendPairwise(pk, rumor)),
    );

    return dist;
  }

  /**
   * Send an inner group event over one-to-many transport.
   * - Ensures we have sender-event keys and a sender key state.
   * - Distributes sender key to group members if needed.
   * - Publishes exactly one outer event via OneToManyChannel.
   */
  async sendEvent(
    event: { kind: number; content: string; tags?: string[][] },
    opts: {
      sendPairwise: PairwiseSend;
      publishOuter: PublishOuter;
      nowMs?: number;
    },
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    await this.init();

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const {
      senderEventSecretKey,
      senderEventPubkey,
      changed: senderEventKeysChanged,
    } = await this.ensureOurSenderEventKeys();
    const { state: senderKey, created: senderKeyCreated } =
      await this.ensureOurSenderKeyState(false);

    // Distribute if we just created the sender key, or if our sender-event pubkey changed.
    if (senderKeyCreated || senderEventKeysChanged) {
      const dist = this.buildDistribution(
        nowSeconds,
        senderEventPubkey,
        senderKey,
      );
      const rumor = this.buildDistributionRumor(nowSeconds, nowMs, dist);
      const recipients = this.senderKeyRecipientOwnerPubkeys();
      await this.recordSenderKeyRepairSnapshot(dist, recipients);
      await Promise.allSettled(
        recipients.map((pk) => opts.sendPairwise(pk, rumor)),
      );
    }

    const inner = this.buildGroupInnerRumor(nowSeconds, nowMs, event);
    const innerJson = JSON.stringify(inner);
    const outer = this.oneToMany.encryptToOuterEvent(
      senderEventSecretKey,
      senderKey,
      innerJson,
      nowSeconds,
    );

    await this.saveSenderKeyState(this.ourDevicePubkey, senderKey);
    await opts.publishOuter(outer, inner.id);

    return { outer, inner };
  }

  /**
   * Send a regular group chat message (kind 14).
   */
  async sendMessage(
    message: string,
    opts: {
      sendPairwise: PairwiseSend;
      publishOuter: PublishOuter;
      nowMs?: number;
    },
  ): Promise<{ outer: VerifiedEvent; inner: Rumor }> {
    return this.sendEvent(
      {
        kind: CHAT_MESSAGE_KIND,
        content: message,
      },
      opts,
    );
  }

  senderKeyRepairRequestForOuterEvent(
    outer: VerifiedEvent,
    createdAtSeconds: number = Math.floor(Date.now() / 1000),
    requiredRevision?: number,
  ): SenderKeyRepairRequest | null {
    if (outer.kind !== MESSAGE_EVENT_KIND) return null;
    if (!verifyEvent(outer)) return null;

    try {
      const parsed = this.oneToMany.parseOuterEvent(outer);
      return {
        groupId: this.groupId(),
        senderEventPubkey: outer.pubkey,
        ...(parsed.isHiddenCounterMessage()
          ? {}
          : {
              keyId: parsed.keyId,
              messageNumber: parsed.messageNumber,
            }),
        ...(requiredRevision !== undefined
          ? { requiredRevision: Math.max(0, Math.floor(requiredRevision)) }
          : {}),
        createdAt: Math.max(0, Math.floor(createdAtSeconds)),
      };
    } catch {
      return null;
    }
  }

  async requestSenderKeyRepair(
    request: SenderKeyRepairRequest,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<Rumor | null> {
    await this.init();

    if (request.groupId !== this.groupId()) return null;
    if (!this.isMemberOwnerPubkey(this.ourOwnerPubkey)) return null;

    const rumor = buildSenderKeyRepairRequestRumor(
      request,
      this.ourDevicePubkey,
      opts.nowMs,
    );
    const recipients = this.senderKeyRecipientOwnerPubkeys();
    await Promise.allSettled(
      recipients.map((pk) => opts.sendPairwise(pk, rumor)),
    );
    return rumor;
  }

  async respondToSenderKeyRepairRequest(
    requesterOwnerPubkey: string,
    request: SenderKeyRepairRequest,
    opts: { sendPairwise: PairwiseSend; nowMs?: number },
  ): Promise<SenderKeyDistribution | null> {
    await this.init();

    const distributions = await this.repairDistributionsFor(
      requesterOwnerPubkey,
      request,
    );
    if (distributions.length === 0) return null;

    const nowMs = opts.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    for (const dist of distributions) {
      const rumor = this.buildDistributionRumor(nowSeconds, nowMs, dist);
      await opts.sendPairwise(requesterOwnerPubkey, rumor);
    }
    return distributions[0]!;
  }

  /**
   * Handle an incoming 1:1 session rumor (decrypted Double Ratchet event).
   *
   * This consumes sender-key distribution rumors and repair requests for this group.
   * It may return decrypted outer group events that were pending until the distribution arrived.
   *
   * `fromSenderDevicePubkey` must come from authenticated session context (not `event.pubkey`).
   */
  async handleIncomingSessionEvent(
    event: Rumor,
    fromOwnerPubkey: string,
    fromSenderDevicePubkey?: string,
  ): Promise<GroupDecryptedEvent[]> {
    await this.init();

    if (!this.memberOwnerPubkeys.includes(fromOwnerPubkey)) {
      return [];
    }

    const gid = getFirstTagValue(event.tags, "l");
    if (gid !== this.groupId()) return [];

    if (event.kind === GROUP_SENDER_KEY_REPAIR_REQUEST_KIND) {
      const request = parseSenderKeyRepairRequestRumor(event);
      if (!request || request.groupId !== this.groupId()) return [];

      const senderDevicePubkey = fromSenderDevicePubkey;
      if (!senderDevicePubkey || !isHex32(senderDevicePubkey)) return [];
      if (isHex32(event.pubkey) && event.pubkey !== senderDevicePubkey)
        return [];

      const origin = classifyMessageOrigin({
        ourOwnerPubkey: this.ourOwnerPubkey,
        ourDevicePubkey: this.ourDevicePubkey,
        senderOwnerPubkey: fromOwnerPubkey,
        senderDevicePubkey,
      });

      return [
        {
          groupId: this.groupId(),
          senderEventPubkey: senderDevicePubkey,
          senderDevicePubkey,
          senderOwnerPubkey: fromOwnerPubkey,
          origin,
          isSelf: isSelfOrigin(origin),
          isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
          outerEventId: event.id,
          outerCreatedAt: event.created_at,
          keyId: request.keyId ?? 0,
          messageNumber: request.messageNumber ?? 0,
          inner: event,
        },
      ];
    }

    if (event.kind !== GROUP_SENDER_KEY_DISTRIBUTION_KIND) return [];

    const dist = parseSenderKeyDistribution(event.content);
    if (!dist) return [];
    if (dist.groupId !== this.groupId()) return [];

    const senderDevicePubkey = fromSenderDevicePubkey;
    if (!senderDevicePubkey || !isHex32(senderDevicePubkey)) return [];
    if (isHex32(event.pubkey) && event.pubkey !== senderDevicePubkey) return [];

    // Persist sender->owner mapping (for UI attribution).
    this.senderDeviceToOwner.set(senderDevicePubkey, fromOwnerPubkey);
    await this.storage.put(
      this.senderOwnerPubkeyKey(senderDevicePubkey),
      fromOwnerPubkey,
    );

    // Learn/update sender-event pubkey mapping (used to route outer messages).
    if (dist.senderEventPubkey && isHex32(dist.senderEventPubkey)) {
      this.setSenderEventMapping(senderDevicePubkey, dist.senderEventPubkey);
      await this.storage.put(
        this.senderEventPubkeyKey(senderDevicePubkey),
        dist.senderEventPubkey,
      );
    }

    // Store sender key state for this key id if we don't already have one.
    const existing = await this.storage.get<SenderKeyStateSerialized>(
      this.senderKeyStateKey(senderDevicePubkey, dist.keyId),
    );
    if (!existing) {
      const st = SenderKeyState.fromDistribution(dist);
      await this.saveSenderKeyState(senderDevicePubkey, st);
    }

    // If we have a sender-event pubkey, retry pending outer events for (senderEventPubkey,keyId).
    if (dist.senderEventPubkey && isHex32(dist.senderEventPubkey)) {
      return await this.drainPending(dist.senderEventPubkey, dist.keyId);
    }

    return [];
  }

  /**
   * Handle an incoming one-to-many outer event (authored by a per-sender sender-event pubkey).
   *
   * Returns a decrypted inner rumor if possible, or null if we're missing mapping/state and queued it.
   */
  async handleOuterEvent(
    outer: VerifiedEvent,
  ): Promise<GroupDecryptedEvent | null> {
    await this.init();
    await this.purgeInactiveSenders();

    if (outer.kind !== MESSAGE_EVENT_KIND) return null;
    if (!verifyEvent(outer)) return null;

    let parsed: ReturnType<OneToManyChannel["parseOuterEvent"]>;
    try {
      parsed = this.oneToMany.parseOuterEvent(outer);
    } catch {
      return null;
    }

    const senderEventPubkey = outer.pubkey;
    const senderDevicePubkey = this.senderEventToDevice.get(senderEventPubkey);
    if (!senderDevicePubkey) {
      this.queuePending(
        senderEventPubkey,
        parsed.isHiddenCounterMessage() ? undefined : parsed.keyId,
        outer,
      );
      return null;
    }
    if (!this.isSenderDeviceActive(senderDevicePubkey)) {
      await this.removeSenderDeviceState(senderDevicePubkey);
      return null;
    }

    let plaintext = "";
    let keyId = parsed.keyId;
    let messageNumber = parsed.messageNumber;
    let nextState: SenderKeyState | null = null;

    if (parsed.isHiddenCounterMessage()) {
      const states = await this.loadSenderKeyStates(senderDevicePubkey);
      for (const state of states) {
        const candidate = SenderKeyState.fromJSON(state.toJSON());
        try {
          const decrypted = candidate.decryptBlindFromBytes(parsed.ciphertext);
          plaintext = decrypted.plaintext;
          keyId = decrypted.keyId;
          messageNumber = decrypted.messageNumber;
          nextState = candidate;
          break;
        } catch {
          // Try the next known sender key.
        }
      }
      if (!nextState) {
        this.queuePending(senderEventPubkey, undefined, outer);
        return null;
      }
    } else {
      const st = await this.loadSenderKeyState(
        senderDevicePubkey,
        parsed.keyId,
      );
      if (!st) {
        this.queuePending(senderEventPubkey, parsed.keyId, outer);
        return null;
      }

      nextState = SenderKeyState.fromJSON(st.toJSON());
      try {
        plaintext = nextState.decryptFromBytes(
          parsed.messageNumber,
          parsed.ciphertext,
        );
      } catch {
        return null;
      }
    }

    let inner: Rumor;
    try {
      inner = JSON.parse(plaintext) as Rumor;
    } catch {
      // Not a Nostr JSON event; wrap as a message-shaped rumor.
      inner = {
        kind: CHAT_MESSAGE_KIND,
        content: plaintext,
        created_at: outer.created_at,
        tags: [["l", this.groupId()]],
        pubkey: senderDevicePubkey,
        id: "",
      };
      inner.id = getEventHash(inner);
    }

    // Best-effort sanity: ensure this is the right group (encrypted, so shouldn't leak).
    const innerGid = getFirstTagValue(inner.tags, "l");
    if (innerGid && innerGid !== this.groupId()) {
      return null;
    }

    await this.saveSenderKeyState(senderDevicePubkey, nextState);

    const senderOwnerPubkey =
      this.senderDeviceToOwner.get(senderDevicePubkey) ||
      (await this.storage.get<string>(
        this.senderOwnerPubkeyKey(senderDevicePubkey),
      )) ||
      undefined;

    const origin = classifyMessageOrigin({
      ourOwnerPubkey: this.ourOwnerPubkey,
      ourDevicePubkey: this.ourDevicePubkey,
      senderOwnerPubkey,
      senderDevicePubkey,
    });

    return {
      groupId: this.groupId(),
      senderEventPubkey,
      senderDevicePubkey,
      senderOwnerPubkey,
      origin,
      isSelf: isSelfOrigin(origin),
      isCrossDeviceSelf: isCrossDeviceSelfOrigin(origin),
      outerEventId: outer.id,
      outerCreatedAt: outer.created_at,
      keyId,
      messageNumber,
      inner,
    };
  }
}
