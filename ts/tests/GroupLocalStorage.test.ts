import { afterEach, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, getEventHash } from "nostr-tools";
import { Group } from "../src/Group.js";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../src/GroupMeta.js";
import { OneToManyChannel } from "../src/OneToManyChannel.js";
import { SenderKeyState } from "../src/SenderKey.js";
import { LocalStorageAdapter } from "../src/StorageAdapter.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const values = new Map<string, string>();
  const local = {
    get length() { return values.size; },
    key: (n: number) => [...values.keys()][n] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("localStorage", local);
  const alice = getPublicKey(generateSecretKey()), bob = getPublicKey(generateSecretKey());
  const device = getPublicKey(generateSecretKey()), outerKey = generateSecretKey();
  const state = new SenderKeyState(17, generateSecretKey(), 0);
  const data = { id: "storage", name: "Storage", members: [alice, bob], admins: [alice], createdAt: 1, accepted: true };
  const rumor = { id: "", kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND, pubkey: device, created_at: 100,
    tags: [["l", data.id]], content: JSON.stringify({ groupId: data.id, keyId: 17,
      chainKey: state.toJSON().chainKey, iteration: 0, createdAt: 100, senderEventPubkey: getPublicKey(outerKey) }) };
  rumor.id = getEventHash(rumor);
  const outer = OneToManyChannel.default().encryptToOuterEvent(outerKey, state, "authenticated", 100);
  const delivered: string[] = [];
  const receiverDevice = getPublicKey(generateSecretKey());
  const makeGroup = () => new Group({ data, ourOwnerPubkey: bob, ourDevicePubkey: receiverDevice,
    storage: new LocalStorageAdapter(), beforeConsume: async event => { delivered.push(event.outerEventId); } });
  return { local, values, alice, device, rumor, outer, delivered, makeGroup };
}

it("reclaims real signed ciphertext after LocalStorage removeItem fails and the receiver restarts", async () => {
  const f = fixture();
  let group = f.makeGroup();
  await group.handleOuterEvent(f.outer);
  const remove = f.local.removeItem;
  f.local.removeItem = key => {
    if (key.includes("/pending-outer/")) throw new Error("remove unavailable");
    remove(key);
  };
  await expect(group.handleIncomingSessionEvent(f.rumor, f.alice, f.device)).rejects.toThrow("remove unavailable");
  expect(f.delivered).toEqual([f.outer.id]);
  expect([...f.values.keys()].filter(key => key.includes("/pending-outer/"))).toHaveLength(1);
  f.local.removeItem = remove;
  group = f.makeGroup();
  await group.handleIncomingSessionEvent(f.rumor, f.alice, f.device);
  expect(f.delivered).toEqual([f.outer.id]);
  expect([...f.values.keys()].filter(key => key.includes("/pending-outer/"))).toEqual([]);
});

it("retries an interrupted initial mapping read without caching incomplete initialization", async () => {
  const f = fixture();
  await f.makeGroup().handleIncomingSessionEvent(f.rumor, f.alice, f.device);
  const group = f.makeGroup();
  const get = f.local.getItem;
  f.local.getItem = key => {
    if (key.endsWith("/sender-owner-pubkey")) throw new Error("read unavailable");
    return get(key);
  };
  await expect(group.handleOuterEvent(f.outer)).rejects.toThrow("read unavailable");
  f.local.getItem = get;
  expect((await group.handleOuterEvent(f.outer))?.outerEventId).toBe(f.outer.id);
  expect(f.delivered).toEqual([f.outer.id]);
});

it("documents the callback-to-acknowledgement crash window for idempotent applications", async () => {
  const f = fixture();
  let group = f.makeGroup();
  await group.handleOuterEvent(f.outer);
  const set = f.local.setItem;
  f.local.setItem = (key, value) => {
    if (key.includes("/pending-outer/") && JSON.parse(value).delivered) throw new Error("ack unavailable");
    set(key, value);
  };
  await expect(group.handleIncomingSessionEvent(f.rumor, f.alice, f.device)).rejects.toThrow("ack unavailable");
  expect(f.delivered).toEqual([f.outer.id]);
  f.local.setItem = set;
  group = f.makeGroup();
  await group.handleIncomingSessionEvent(f.rumor, f.alice, f.device);
  expect(f.delivered).toEqual([f.outer.id, f.outer.id]);
  expect([...f.values.keys()].filter(key => key.includes("/pending-outer/"))).toEqual([]);
});
