import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../GroupMeta.js";
import { type SenderKeyRepairRequest } from "../SenderKeyRepair.js";
import type {
  SenderKeyDistribution,
  SenderKeyStateSerialized,
} from "../SenderKey.js";
import { SenderKeyState } from "../SenderKey.js";
import { type Rumor } from "../types.js";
import { GroupState } from "./GroupState.js";
import { randomU32, type SenderKeyRepairSnapshot } from "./groupInternals.js";

export abstract class GroupSenderKeys extends GroupState {
  protected async ensureOurSenderEventKeys(): Promise<{
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

  protected async loadSenderKeyState(
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

  protected async loadSenderKeyStates(
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

  protected async saveSenderKeyState(
    senderDevicePubkey: string,
    st: SenderKeyState,
  ): Promise<void> {
    await this.storage.put(
      this.senderKeyStateKey(senderDevicePubkey, st.keyId),
      st.toJSON(),
    );
  }

  protected async loadSenderKeyRepairSnapshots(
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

  protected async saveSenderKeyRepairSnapshots(
    senderDevicePubkey: string,
    snapshots: SenderKeyRepairSnapshot[],
  ): Promise<void> {
    await this.storage.put(
      this.senderKeyRepairSnapshotsKey(senderDevicePubkey),
      snapshots,
    );
  }

  protected async recordSenderKeyRepairSnapshot(
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

  protected async repairDistributionsFor(
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

  protected async ensureOurSenderKeyState(
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

  protected buildDistribution(
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

  protected buildDistributionRumor(
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

  protected buildGroupInnerRumor(
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
}
