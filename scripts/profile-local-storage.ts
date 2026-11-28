// Actual supported adapter over Node's file-backed Web Storage (SQLite), not a browser claim.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools";
import { GroupManager } from "../src/Group.js";
import { OneToManyChannel } from "../src/OneToManyChannel.js";
import { SenderKeyState } from "../src/SenderKey.js";
import { LocalStorageAdapter } from "../src/StorageAdapter.js";

const storage = new LocalStorageAdapter("disk-profile/");
const counts = { puts: 0, serializedBytes: 0, cachePuts: 0, cacheSerializedBytes: 0 };
const put = storage.put.bind(storage);
storage.put = async (key, value) => {
  const bytes = Buffer.byteLength("disk-profile/" + key + JSON.stringify(value));
  counts.puts++; counts.serializedBytes += bytes;
  if (key.includes("/consumed-outer/")) { counts.cachePuts++; counts.cacheSerializedBytes += bytes; }
  return put(key, value);
};
const owner = getPublicKey(generateSecretKey()), receiver = getPublicKey(generateSecretKey());
const device = getPublicKey(generateSecretKey()), outerSecret = generateSecretKey();
const data = { id: "disk-profile", name: "Profile", members: [owner, receiver], admins: [owner], createdAt: 1, accepted: true };
const state = new SenderKeyState(17, generateSecretKey(), 0);
const distribution = { kind: 10446, pubkey: device, created_at: 100,
  tags: [["l", data.id]], id: "", content: JSON.stringify({ groupId: data.id, keyId: 17,
    chainKey: state.toJSON().chainKey, iteration: 0, createdAt: 100, senderEventPubkey: getPublicKey(outerSecret) }) };
distribution.id = getEventHash(distribution);
const accepted: string[] = [];
const manager = new GroupManager({ ourOwnerPubkey: receiver,
  ourDevicePubkey: getPublicKey(generateSecretKey()), storage,
  onDecryptedEvent: event => { accepted.push(event.outerEventId); } });
await manager.upsertGroup(data);
await manager.handleIncomingSessionEvent(distribution, owner, device);
const events = Array.from({ length: 128 }, (_, i) => {
  const inner = { kind: 14, pubkey: device, created_at: 300, tags: [["l", data.id]], content: "known-key-" + i, id: "" };
  inner.id = getEventHash(inner);
  return OneToManyChannel.default().encryptToOuterEvent(outerSecret, state, JSON.stringify(inner), 300);
});
function diskBytes() {
  return Number(readFileSync("/proc/self/io", "utf8").match(/^write_bytes: (\d+)/m)![1]);
}
function fileBytes() { return statSync(process.env.STORAGE_FILE!).size; }
const before = { ...counts, diskBytes: diskBytes(), fileBytes: fileBytes() };
const started = performance.now();
for (const event of events) assert.equal((await manager.handleOuterEvent(event))?.outerEventId, event.id);
assert.deepEqual(accepted, events.map(event => event.id));
const receiveWallMs = performance.now() - started;
const after = { ...counts, diskBytes: diskBytes(), fileBytes: fileBytes() };
const prefix = `v1/broadcast-channel/group/${data.id}/`;
const cacheKeys = await storage.list(prefix + "consumed-outer/");
const retainedCacheBytes = (await Promise.all(cacheKeys.map(async key =>
  Buffer.byteLength("disk-profile/" + key + JSON.stringify(await storage.get(key)))))).reduce((a, b) => a + b, 0);
await manager.removeGroup(data.id);
manager.destroy();
assert.deepEqual(await storage.list(prefix + "consumed-outer/"), []);
// Application-owned namespace erase, preserving an unrelated account fixture.
await storage.put("unrelated", "preserve");
for (const key of await storage.list(prefix)) await storage.del(key);
assert.deepEqual(await storage.list(prefix), []);
assert.equal(await storage.get("unrelated"), "preserve");
console.log(JSON.stringify({ source: process.env.CANDIDATE_SHA, before, after,
  receiveWallMs, retainedCacheEntries: cacheKeys.length,
  retainedCacheBytes, publicRemovalErasesReplay: true, explicitNamespaceEraseVerified: true }));
