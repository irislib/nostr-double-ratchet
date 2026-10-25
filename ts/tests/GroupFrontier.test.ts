import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getEventHash, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { Group, GroupManager, type GroupData } from "../src/Group.js";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../src/GroupMeta.js";
import { OneToManyChannel } from "../src/OneToManyChannel.js";
import { SenderKeyState } from "../src/SenderKey.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";
import { CHAT_MESSAGE_KIND, type Rumor } from "../src/types.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const alice = getPublicKey(generateSecretKey());
  const aliceDevice = getPublicKey(generateSecretKey());
  const bob = getPublicKey(generateSecretKey());
  const bobDevice = getPublicKey(generateSecretKey());
  const outerSecret = generateSecretKey();
  const outerPubkey = getPublicKey(outerSecret);
  const data: GroupData = {
    id: "frontier-group", name: "Test", members: [alice, bob],
    admins: [alice], createdAt: 1, accepted: true,
  };
  const storage = new InMemoryStorageAdapter();
  const receiver = () => new Group({
    data, ourOwnerPubkey: bob, ourDevicePubkey: bobDevice, storage,
  });
  function epoch(keyId: number, createdAt: number) {
    const chain = generateSecretKey();
    const state = new SenderKeyState(keyId, chain, 0);
    const rumor: Rumor = {
      kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND,
      pubkey: aliceDevice, created_at: createdAt,
      tags: [["l", data.id]], id: "",
      content: JSON.stringify({
        groupId: data.id, keyId, chainKey: state.toJSON().chainKey,
        iteration: 0, createdAt, senderEventPubkey: outerPubkey,
      }),
    };
    rumor.id = getEventHash(rumor);
    return { state, rumor };
  }
  function message(state: SenderKeyState, content: string, groupId = data.id) {
    const inner: Rumor = {
      kind: CHAT_MESSAGE_KIND, pubkey: aliceDevice, created_at: 300,
      tags: [["l", groupId]], content, id: "",
    };
    inner.id = getEventHash(inner);
    return OneToManyChannel.default().encryptToOuterEvent(
      outerSecret, state, JSON.stringify(inner), 300,
    );
  }
  const install = (group: Group | GroupManager, rumor: Rumor) =>
    group.handleIncomingSessionEvent(rumor, alice, aliceDevice);
  const snapshot = async () => Object.fromEntries(await Promise.all(
    (await storage.list()).map(async (key) => [key, await storage.get(key)]),
  ));
  return { alice, aliceDevice, bob, bobDevice, data, storage, receiver, epoch, message, install, snapshot };
}

function forbidHistoryScan() {
  return vi.spyOn(SenderKeyState.prototype, "planDecryptBlind").mockImplementation(() => {
    throw new Error("fresh message unexpectedly entered the history scan");
  });
}

describe("Group preferred received epoch frontier", () => {
  it("uses an authenticated newer lower key ID before older higher IDs, including after restart", async () => {
    const f = fixture();
    const old = f.epoch(9_000, 100);
    const current = f.epoch(7, 200);
    const group = f.receiver();
    await f.install(group, old.rumor);
    await f.install(group, current.rumor);
    const history = forbidHistoryScan();

    expect((await group.handleOuterEvent(f.message(current.state, "fresh")))?.inner.content).toBe("fresh");
    expect((await f.receiver().handleOuterEvent(f.message(current.state, "restored")))?.inner.content).toBe("restored");
    expect(history).not.toHaveBeenCalled();
  });

  it.each([100, 200])("does not replace a trustworthy hint with a delayed epoch at time %s", async (timestamp) => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const delayed = f.epoch(9_000, timestamp);
    const group = f.receiver();
    await f.install(group, current.rumor);
    await f.install(group, delayed.rumor);
    const history = forbidHistoryScan();
    expect((await group.handleOuterEvent(f.message(current.state, "still fresh")))?.inner.content).toBe("still fresh");
    expect(history).not.toHaveBeenCalled();
  });

  it("learns an undated performance hint after valid fallback for an older store", async () => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const group = f.receiver();
    await f.install(group, current.rumor);
    for (const key of await f.storage.list()) {
      if (key.endsWith("/preferred-received-key")) await f.storage.del(key);
    }
    expect((await group.handleOuterEvent(f.message(current.state, "fallback")))?.inner.content).toBe("fallback");
    const history = forbidHistoryScan();
    expect((await group.handleOuterEvent(f.message(current.state, "next")))?.inner.content).toBe("next");
    expect(history).not.toHaveBeenCalled();
  });

  it("retains out-of-order and skipped-key fallback", async () => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const group = f.receiver();
    await f.install(group, current.rumor);
    const old = f.message(current.state, "old");
    const ahead = f.message(current.state, "ahead");
    expect((await group.handleOuterEvent(ahead))?.inner.content).toBe("ahead");
    expect((await group.handleOuterEvent(old))?.inner.content).toBe("old");
    const history = forbidHistoryScan();
    expect((await group.handleOuterEvent(f.message(current.state, "fresh")))?.inner.content).toBe("fresh");
    expect(history).not.toHaveBeenCalled();
  });

  it.each(["present", "absent"])("does not commit state after authenticated wrong-group plaintext with a %s hint", async (hint) => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const group = f.receiver();
    await f.install(group, current.rumor);
    if (hint === "absent") {
      for (const key of await f.storage.list()) {
        if (key.endsWith("/preferred-received-key")) await f.storage.del(key);
      }
    }
    const before = await f.snapshot();
    const frontier = vi.spyOn(SenderKeyState.prototype, "planDecryptFrontier");
    const history = vi.spyOn(SenderKeyState.prototype, "planDecryptBlind");
    expect(await group.handleOuterEvent(f.message(current.state, "wrong", "another-group"))).toBeNull();
    expect(await f.snapshot()).toEqual(before);
    expect(frontier).toHaveBeenCalledTimes(hint === "present" ? 1 : 0);
    expect(history).toHaveBeenCalledTimes(hint === "absent" ? 1 : 0);
  });

  it("authenticates the outer signature and active membership before a frontier probe", async () => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const group = f.receiver();
    await f.install(group, current.rumor);
    const outer = f.message(current.state, "fresh");
    const forged = JSON.parse(JSON.stringify(outer)) as VerifiedEvent;
    forged.sig = "00".repeat(64);
    const frontier = vi.spyOn(SenderKeyState.prototype, "planDecryptFrontier");
    expect(await group.handleOuterEvent(forged)).toBeNull();
    expect(frontier).not.toHaveBeenCalled();
    group.setMembers([f.bob]);
    expect(await group.handleOuterEvent(outer)).toBeNull();
    expect(frontier).not.toHaveBeenCalled();
  });

  it("does not overwrite the local sending epoch with received preference metadata", async () => {
    const f = fixture();
    const group = f.receiver();
    const ownPrefix = `v1/broadcast-channel/group/${f.data.id}/sender/${f.bobDevice}`;
    await f.storage.put(`${ownPrefix}/latest-key-id`, 777);
    const incoming = f.epoch(7, 200).rumor;
    incoming.pubkey = f.bobDevice;
    incoming.id = getEventHash(incoming);
    await group.handleIncomingSessionEvent(incoming, f.bob, f.bobDevice);
    expect(await f.storage.get(`${ownPrefix}/latest-key-id`)).toBe(777);
    expect(await f.storage.get(`${ownPrefix}/preferred-received-key`)).toBeUndefined();
  });

  it.each(["read", "write"])("keeps valid delivery when optional preference %s fails", async (failure) => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const group = f.receiver();
    const read = f.storage.get.bind(f.storage);
    const write = f.storage.put.bind(f.storage);
    let failures = 0;
    if (failure === "read") {
      vi.spyOn(f.storage, "get").mockImplementation(async (key) => {
        if (key.endsWith("/preferred-received-key")) {
          failures += 1;
          throw new Error("preference read unavailable");
        }
        return read(key);
      });
    } else {
      vi.spyOn(f.storage, "put").mockImplementation(async (key, value) => {
        if (key.endsWith("/preferred-received-key")) {
          failures += 1;
          throw new Error("preference write unavailable");
        }
        await write(key, value);
      });
    }

    await expect(f.install(group, current.rumor)).resolves.toEqual([]);
    expect((await group.handleOuterEvent(f.message(current.state, "first")))?.inner.content).toBe("first");
    expect((await group.handleOuterEvent(f.message(current.state, "second")))?.inner.content).toBe("second");
    expect(failures).toBeGreaterThan(0);
    const stateKey = (await f.storage.list()).find((key) => key.endsWith("/key/7"));
    expect(await read(stateKey!)).toMatchObject({ keyId: 7, iteration: 2 });
  });

  it("records the remaining shared-queue limitation without running an expensive history scan", async () => {
    const f = fixture();
    const current = f.epoch(7, 200);
    const unavailableHistory = f.epoch(9_000, 100);
    const manager = new GroupManager({ ourOwnerPubkey: f.bob, ourDevicePubkey: f.bobDevice, storage: f.storage });
    await manager.upsertGroup(f.data);
    await f.install(manager, current.rumor);
    const history = f.message(unavailableHistory.state, "unresolved history");
    const fresh = f.message(current.state, "fresh");
    let entered!: () => void;
    let release!: () => void;
    const historyEntered = new Promise<void>((resolve) => { entered = resolve; });
    const historyGate = new Promise<void>((resolve) => { release = resolve; });
    const original = Group.prototype.handleOuterEvent;
    const visited: string[] = [];
    vi.spyOn(Group.prototype, "handleOuterEvent").mockImplementation(async function (outer) {
      visited.push(outer.id);
      if (outer.id === history.id) {
        entered();
        await historyGate;
        return null;
      }
      return original.call(this, outer);
    });
    try {
      const first = manager.handleOuterEvent(history);
      await historyEntered;
      const second = manager.handleOuterEvent(fresh);
      await Promise.resolve();
      await Promise.resolve();
      // This documents serialization, not a timing benchmark or scheduler fix.
      expect(visited).toEqual([history.id]);
      release();
      expect(await first).toBeNull();
      expect((await second)?.inner.content).toBe("fresh");
    } finally {
      release();
      manager.destroy();
    }
  });
});
