// Same signed 129-event rotation/reconnect workload as GroupRecovery.test.ts.
// Measurement only: the original 90-second regression gate is not modified.
import { performance } from "node:perf_hooks";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools";
import { GroupManager } from "../src/Group.js";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../src/GroupMeta.js";
import { OneToManyChannel } from "../src/OneToManyChannel.js";
import { SenderKeyState } from "../src/SenderKey.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";
import { MockRelay } from "../tests/helpers/mockRelay.js";

const started = performance.now();
const cpuStarted = process.cpuUsage();
const owner = getPublicKey(generateSecretKey());
const receiver = getPublicKey(generateSecretKey());
const device = getPublicKey(generateSecretKey());
const outerSecret = generateSecretKey();
const data = { id: "profile", name: "Profile", members: [owner, receiver], admins: [owner], createdAt: 1, accepted: true };
const storage = new InMemoryStorageAdapter();
const counts = { reads: 0, writes: 0, deletes: 0, lists: 0, bytesWritten: 0, blindCalls: 0, blindMs: 0 };
for (const [method, counter] of [["get", "reads"], ["del", "deletes"], ["list", "lists"]] as const) {
  const original = storage[method].bind(storage);
  storage[method] = (...args: any[]) => { counts[counter]++; return (original as any)(...args); };
}
const put = storage.put.bind(storage);
storage.put = async (key, value) => {
  counts.writes++;
  counts.bytesWritten += Buffer.byteLength(key + JSON.stringify(value));
  return put(key, value);
};
const blind = SenderKeyState.prototype.planDecryptBlind;
SenderKeyState.prototype.planDecryptBlind = function (bytes) {
  counts.blindCalls++;
  const start = performance.now();
  try { return blind.call(this, bytes); } finally { counts.blindMs += performance.now() - start; }
};
function epoch(keyId: number, createdAt: number) {
  const state = new SenderKeyState(keyId, generateSecretKey(), 0);
  const rumor = { kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND, pubkey: device, created_at: createdAt,
    tags: [["l", data.id]], id: "", content: JSON.stringify({ groupId: data.id, keyId,
      chainKey: state.toJSON().chainKey, iteration: 0, createdAt, senderEventPubkey: getPublicKey(outerSecret) }) };
  rumor.id = getEventHash(rumor);
  return { state, rumor };
}
const relay = new MockRelay();
const recovered = new Set<string>();
let errors = 0;
const options = { ourOwnerPubkey: receiver, ourDevicePubkey: getPublicKey(generateSecretKey()), storage,
  nostrGroupSubscribe: (filter: any, callback: any) => relay.subscribe(filter, callback).close,
  onDecryptedEvent: (event: any) => { recovered.add(event.outerEventId); }, onError: () => { errors++; } };
let manager = new GroupManager(options);
const phases: any[] = [];
function phase(name: string) { phases.push({ name, elapsedMs: performance.now() - started, recovered: recovered.size, ...counts }); }
try {
  await manager.upsertGroup(data);
  await manager.handleIncomingSessionEvent(epoch(17, 100).rumor, owner, device);
  await new Promise(resolve => setTimeout(resolve, 3800));
  const rotated = epoch(18, 200);
  const outers = Array.from({ length: 129 }, (_, i) => {
    const inner = { kind: 14, pubkey: device, created_at: 300, tags: [["l", data.id]], content: "burst-" + i, id: "" };
    inner.id = getEventHash(inner);
    return OneToManyChannel.default().encryptToOuterEvent(outerSecret, rotated.state, JSON.stringify(inner), 300);
  });
  phase("ready");
  for (const outer of outers) relay.storeAndDeliver(outer);
  await manager.handleIncomingSessionEvent(rotated.rumor, owner, device);
  phase("key-arrived");
  await manager.handleIncomingSessionEvent(rotated.rumor, owner, device);
  phase("identical-distribution");
  manager.destroy();
  manager = new GroupManager(options);
  await manager.upsertGroup(data);
  // Flush the already queued archive replay to measure its CPU, not just the
  // first recovered event; original correctness assertions remain in the test.
  await manager.syncOuterSubscription();
  phase("reconnected");
} finally { manager.destroy(); }
console.log(JSON.stringify({ phases, errors, cpuMicros: process.cpuUsage(cpuStarted), maxRssKiB: process.resourceUsage().maxRSS }));
