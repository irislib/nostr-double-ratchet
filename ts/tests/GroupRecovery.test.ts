import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateSecretKey,
  getEventHash,
  getPublicKey,
  type VerifiedEvent,
} from "nostr-tools";
import { Group, GroupManager, type GroupData } from "../src/Group.js";
import {
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
} from "../src/GroupMeta.js";
import { OneToManyChannel } from "../src/OneToManyChannel.js";
import { SenderKeyState } from "../src/SenderKey.js";
import {
  buildSenderKeyRepairRequestRumor,
} from "../src/SenderKeyRepair.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";
import { CHAT_MESSAGE_KIND, type Rumor } from "../src/types.js";
import { MockRelay } from "./helpers/mockRelay.js";
import { createRuntime } from "./helpers/runtime.js";

afterEach(() => vi.restoreAllMocks());

function makeEpoch(
  groupId: string,
  aliceDevice: string,
  outerSecret: Uint8Array,
  keyId: number,
  createdAt: number,
) {
  const outerPubkey = getPublicKey(outerSecret);
  const chain = generateSecretKey();
  const state = new SenderKeyState(keyId, chain, 0);
  const rumor: Rumor = {
    kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND,
    pubkey: aliceDevice,
    created_at: createdAt,
    tags: [["l", groupId]],
    id: "",
    content: JSON.stringify({
      groupId,
      keyId,
      chainKey: state.toJSON().chainKey,
      iteration: 0,
      createdAt,
      senderEventPubkey: outerPubkey,
    }),
  };
  rumor.id = getEventHash(rumor);
  return { state, rumor };
}

function encryptGroupMessage(
  groupId: string,
  aliceDevice: string,
  outerSecret: Uint8Array,
  state: SenderKeyState,
  content: string,
): VerifiedEvent {
  const inner: Rumor = {
    kind: CHAT_MESSAGE_KIND,
    pubkey: aliceDevice,
    created_at: 300,
    tags: [["l", groupId]],
    content,
    id: "",
  };
  inner.id = getEventHash(inner);
  return OneToManyChannel.default().encryptToOuterEvent(
    outerSecret,
    state,
    JSON.stringify(inner),
    300,
  );
}

function receiver(storage = new InMemoryStorageAdapter()) {
  const alice = getPublicKey(generateSecretKey());
  const bob = getPublicKey(generateSecretKey());
  const device = getPublicKey(generateSecretKey());
  const outerSecret = generateSecretKey();
  const data: GroupData = { id: "qualification", name: "Qualification",
    members: [alice, bob], admins: [alice], createdAt: 1, accepted: true };
  const group = new Group({ data, ourOwnerPubkey: bob,
    ourDevicePubkey: getPublicKey(generateSecretKey()), storage });
  const epoch = makeEpoch(data.id, device, outerSecret, 17, 100);
  return { alice, bob, device, outerSecret, data, group, epoch, storage };
}

describe("later ratchet exact-source qualification", () => {
  it.each([128, 129])("recovers all %i authenticated queued messages when the key arrives", async count => {
    const f = receiver();
    const ids = [];
    for (let i = 0; i < count; i++) {
      const outer = encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "message-" + i);
      ids.push(outer.id);
      expect(await f.group.handleOuterEvent(outer)).toBeNull();
    }
    const recovered = await f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
    expect(recovered.map(e => e.outerEventId)).toEqual(ids);
  });

  it("delivers every queued message once when the caller also replays ciphertext", async () => {
    const f = receiver();
    const outers = Array.from({ length: 129 }, (_, i) =>
      encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "message-" + i));
    for (const outer of outers) await f.group.handleOuterEvent(outer);
    const recovered = await f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
    const replayed = await f.group.handleOuterEvent(outers[0]);
    expect(new Set([...recovered.map(e => e.outerEventId), ...(replayed ? [replayed.outerEventId] : [])]).size).toBe(129);
  });

  it("retries pending delivery after an interrupted origin save and identical distribution retry", async () => {
    class InterruptedOriginStorage extends InMemoryStorageAdapter {
      failOnce = true;
      override async put<T>(key: string, value: T): Promise<void> {
        if (this.failOnce && key.includes("/key-origin/")) {
          this.failOnce = false;
          throw new Error("injected origin write interruption");
        }
        await super.put(key, value);
      }
    }
    const f = receiver(new InterruptedOriginStorage());
    const outer = encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "pending");
    expect(await f.group.handleOuterEvent(outer)).toBeNull();
    await expect(f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device))
      .rejects.toThrow("injected origin write interruption");
    const recovered = await f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
    expect(recovered.map(e => e.outerEventId)).toEqual([outer.id]);
  });

  it.each(["/sender-event-pubkey", "/key/", "/key-origin/"])(
    "resumes identical distribution after restart and interrupted %s write", async failureKey => {
      class InterruptedStorage extends InMemoryStorageAdapter {
        fail = true;
        override async put<T>(key: string, value: T): Promise<void> {
          if (this.fail && key.includes(failureKey)) {
            this.fail = false;
            throw new Error("interrupted distribution");
          }
          await super.put(key, value);
        }
      }
      const f = receiver(new InterruptedStorage());
      const outer = encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "restart");
      await f.group.handleOuterEvent(outer);
      await expect(f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device))
        .rejects.toThrow("interrupted distribution");
      const restarted = new Group({ data: f.data, ourOwnerPubkey: f.bob,
        ourDevicePubkey: getPublicKey(generateSecretKey()), storage: f.storage });
      expect((await restarted.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device))
        .map(event => event.outerEventId)).toEqual([outer.id]);
      expect(await f.storage.list(`v1/broadcast-channel/group/${f.data.id}/pending-outer/`)).toEqual([]);
    });

  it("resumes an interrupted application drain after restart without losing remaining ciphertexts", async () => {
    const f = receiver();
    const accepted: string[] = [];
    const options = { data: f.data, ourOwnerPubkey: f.bob, ourDevicePubkey: getPublicKey(generateSecretKey()),
      storage: f.storage, beforeConsume: async (event: { outerEventId: string }) => {
        if (accepted.length === 1 && fail) { fail = false; throw new Error("application unavailable"); }
        accepted.push(event.outerEventId);
      } };
    let fail = true;
    let group = new Group(options);
    const outers = Array.from({ length: 3 }, (_, i) =>
      encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "queued-" + i));
    for (const outer of outers) await group.handleOuterEvent(outer);
    await expect(group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device))
      .rejects.toThrow("application unavailable");
    group = new Group(options);
    await group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
    expect(accepted).toEqual(outers.map(event => event.id));
  });

  it("still recovers older ciphertext when an earlier distribution extends a known chain", async () => {
    const f = receiver();
    const outer = encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "older");
    const late = structuredClone(f.epoch.rumor);
    const dist = JSON.parse(late.content);
    dist.iteration = f.epoch.state.iteration;
    dist.chainKey = f.epoch.state.toJSON().chainKey;
    late.content = JSON.stringify(dist);
    late.id = getEventHash(late);
    await f.group.handleIncomingSessionEvent(late, f.alice, f.device);
    expect(await f.group.handleOuterEvent(outer)).toBeNull();
    const recovered = await f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
    expect(recovered.map(e => e.outerEventId)).toEqual([outer.id]);
  });
});

describe("real pairwise repair progression", () => {
  it.each([false, true])("recovers older history on a later request with responder restart=%s", async restart => {
    const relay = new MockRelay();
    const aliceKey = generateSecretKey();
    const bobKey = generateSecretKey();
    const aliceOwner = getPublicKey(aliceKey);
    const bobOwner = getPublicKey(bobKey);
    const aliceStore = new InMemoryStorageAdapter();
    let alice = createRuntime({ relay, ownerPrivateKey: aliceKey, storage: aliceStore });
    const bob = createRuntime({ relay, ownerPrivateKey: bobKey });
    const received: string[] = [];
    const distributions: number[] = [];
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      for (const [runtime, owner] of [[alice, aliceOwner], [bob, bobOwner]] as const) {
        await runtime.initForOwner(owner);
        await runtime.registerCurrentDevice({ ownerPubkey: owner });
        await runtime.republishInvite();
      }
      await alice.sendMessage(bobOwner, "warmup");
      await bob.sendMessage(aliceOwner, "warmup reply");
      bob.onGroupEvent(event => { received.push(event.outerEventId); });
      bob.onSessionEvent(event => {
        if (event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND)
          distributions.push(JSON.parse(event.content).keyId);
      });
      const created = await alice.createGroup("history repair", [bobOwner], { fanoutMetadata: false });
      await bob.syncGroups([created.group]);
      const sender = alice.getGroupManager()!;
      const noDelivery = { sendPairwise: async () => {}, publishOuter: async () => {} };
      const old = await sender.sendMessage(created.group.id, "old history", noDelivery);
      const oldKey = await sender.getLatestSenderKeyId(created.group.id);
      await sender.rotateSenderKey(created.group.id, { sendPairwise: async () => {} });
      const latestKey = await sender.getLatestSenderKeyId(created.group.id);
      expect(latestKey).not.toBe(oldKey);
      expect(await bob.getGroupManager()!.handleOuterEvent(old.outer)).toBeNull();
      const request = async (expectedCount: number) => {
        const rumor = buildSenderKeyRepairRequestRumor({
          groupId: created.group.id, senderEventPubkey: old.outer.pubkey,
          createdAt: Math.floor(clock / 1000),
        }, bob.getState().currentDevicePubkey!);
        await bob.sendEvent(aliceOwner, rumor, undefined, { includeLocalSiblings: false });
        await vi.waitFor(() => expect(distributions.length).toBeGreaterThanOrEqual(expectedCount), { timeout: 3000 });
      };
      // Simulate losing the first older-epoch response. The next request must
      // recover it even when every responder lifetime begins with a cold cache.
      const sessions = alice.getSessionManager()!;
      const sendDistribution = sessions.sendGroupDistributionToDevice.bind(sessions);
      const dropOlder = vi.spyOn(sessions, "sendGroupDistributionToDevice").mockImplementation(
        async (owner, device, rumor) => JSON.parse(rumor.content).keyId === oldKey
          ? true : sendDistribution(owner, device, rumor));
      await request(1);
      dropOlder.mockRestore();
      expect(distributions).toEqual([latestKey]);
      expect(received).not.toContain(old.outer.id);
      for (let attempt = 0; attempt < (restart ? 3 : 1); attempt++) {
        if (restart) {
          alice.close();
          alice = createRuntime({ relay, ownerPrivateKey: aliceKey, storage: aliceStore });
          await alice.initForOwner(aliceOwner);
          await alice.syncGroups([created.group]);
        }
        clock += 31_000;
        await request(restart ? 1 + (attempt + 1) * 2 : 3);
      }
      // Flush receiver operations after the asynchronous distribution handler.
      await bob.getGroupManager()!.syncOuterSubscription();
      await new Promise(resolve => setTimeout(resolve, 350));
      console.log("repair result", JSON.stringify({ restart, replyCount: distributions.length,
        latestReplies: distributions.filter(id => id === latestKey).length,
        oldReplies: distributions.filter(id => id === oldKey).length,
        recovered: received.includes(old.outer.id) }));
      expect(received).toContain(old.outer.id);
      expect(distributions).toContain(oldKey);
    } finally {
      alice.close();
      bob.close();
    }
  }, 15000);
});

describe("rotated sender burst on a live group subscription", () => {
  it("recovers all retained relay history after the missing key arrives", async () => {
    const f = receiver();
    const relay = new MockRelay();
    const recovered = new Set<string>();
    const errors: unknown[] = [];
    const options = {
      ourOwnerPubkey: f.bob, ourDevicePubkey: getPublicKey(generateSecretKey()),
      storage: f.storage,
      nostrGroupSubscribe: (filter: any, callback: (event: VerifiedEvent) => void) =>
        relay.subscribe(filter, callback).close,
      onDecryptedEvent: (event: any) => { recovered.add(event.outerEventId); },
      onError: (error: unknown) => errors.push(error),
    };
    let manager = new GroupManager(options);
    try {
      await manager.upsertGroup(f.data);
      await manager.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
      // Complete the existing 0/500/1500 ms backfill windows before the rotation.
      await new Promise(resolve => setTimeout(resolve, 3800));
      const rotated = makeEpoch(f.data.id, f.device, f.outerSecret, 18, 200);
      const outers = Array.from({ length: 129 }, (_, i) =>
        encryptGroupMessage(f.data.id, f.device, f.outerSecret, rotated.state, "burst-" + i));
      for (const outer of outers) relay.storeAndDeliver(outer);
      // Key processing is serialized after the live subscription has queued the burst.
      await manager.handleIncomingSessionEvent(rotated.rumor, f.alice, f.device);
      const beforeReconnect = recovered.size;
      await manager.handleIncomingSessionEvent(rotated.rumor, f.alice, f.device);
      const afterDuplicate = recovered.size;
      manager.destroy();
      manager = new GroupManager(options);
      await manager.upsertGroup(f.data);
      await vi.waitFor(() => expect(recovered.size).toBe(129), { timeout: 4000 });
      console.log("live burst", JSON.stringify({ beforeReconnect, afterDuplicate,
        afterReconnect: recovered.size, errors: errors.length }));
      expect(errors).toEqual([]);
      expect(beforeReconnect).toBe(129);
    } finally { manager.destroy(); }
  }, 90000);
});

describe("burst exceeding the retained skipped-key window", () => {
  it("recovers all 2129 pre-key ciphertexts before advancing beyond skipped-key retention", async () => {
    const f = receiver();
    let oldest!: VerifiedEvent;
    for (let i = 0; i < 2129; i++) {
      const outer = encryptGroupMessage(f.data.id, f.device, f.outerSecret, f.epoch.state, "large-burst-" + i);
      if (i === 0) oldest = outer;
      await f.group.handleOuterEvent(outer);
    }
    const drained = await f.group.handleIncomingSessionEvent(f.epoch.rumor, f.alice, f.device);
    expect(drained).toHaveLength(2129);
    expect(drained[0].outerEventId).toBe(oldest.id);
    expect(new Set(drained.map(event => event.outerEventId)).size).toBe(2129);

  }, 30000);
});
