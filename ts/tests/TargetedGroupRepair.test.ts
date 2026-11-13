import { expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { AppKeys } from "../src/AppKeys.js";
import { Group, createGroupData } from "../src/Group.js";
import { SessionManager } from "../src/SessionManager.js";
import { Session } from "../src/Session.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";
import { buildSenderKeyRepairRequestRumor } from "../src/SenderKeyRepair.js";
import { generateEphemeralKeypair, generateSharedSecret } from "../src/inviteUtils.js";
import type { Rumor } from "../src/types.js";

const key = () => getPublicKey(generateSecretKey());

it("routes a chain repair through the stored writer binding and keeps the fallback audience", async () => {
  const writer = key(), reader = key(), observer = key(), writerDevice = key(), readerDevice = key();
  const data = createGroupData("keys", writer, [reader, observer]);
  const storage = new InMemoryStorageAdapter();
  const makeReader = () => new Group({data, ourOwnerPubkey: reader, ourDevicePubkey: readerDevice, storage});
  const writerGroup = new Group({data, ourOwnerPubkey: writer, ourDevicePubkey: writerDevice});
  const distributions = new Map<string,Rumor>();
  const d = await writerGroup.rotateSenderKey({sendPairwise: async (to,r) => { distributions.set(to,r); }});
  await makeReader().handleIncomingSessionEvent(distributions.get(reader)!, writer, writerDevice);
  const restored = makeReader();
  const request = {groupId:data.id, senderEventPubkey:d.senderEventPubkey!, createdAt:1234};
  const sendPairwise = vi.fn(async (_owner: string, _rumor: Rumor) => {});
  const sendToWriter = vi.fn(async () => true);
  await restored.requestSenderKeyRepair(request,{sendPairwise,sendToWriter});
  expect(sendToWriter).toHaveBeenCalledWith(writer,writerDevice,expect.objectContaining({pubkey:readerDevice}));
  expect(sendPairwise).not.toHaveBeenCalled();
  for (const fallback of [{...request,requiredRevision:4},{...request,senderEventPubkey:key()}]) {
    sendToWriter.mockClear();
    await restored.requestSenderKeyRepair(fallback,{sendPairwise,sendToWriter});
    expect(sendToWriter).not.toHaveBeenCalled();
    expect(sendPairwise.mock.calls.map(call=>call[0]).sort()).toEqual([...data.members].sort());
    sendPairwise.mockClear();
  }
  sendToWriter.mockResolvedValue(false);
  await restored.requestSenderKeyRepair(request,{sendPairwise,sendToWriter});
  expect(sendPairwise).toHaveBeenCalledTimes(data.members.length);
  restored.setData({...data, members:[reader, observer]});
  sendPairwise.mockClear();
  sendToWriter.mockClear();
  await restored.requestSenderKeyRepair(request,{sendPairwise,sendToWriter});
  expect(sendToWriter).not.toHaveBeenCalled();
  expect(sendPairwise.mock.calls.map(call=>call[0]).sort()).toEqual([reader,observer].sort());
});

class RepairSender extends SessionManager {
  async roster(ownerKey: Uint8Array, devices: string[]) {
    const owner = getPublicKey(ownerKey);
    const keys = new AppKeys(devices.map(identityPubkey=>({identityPubkey,createdAt:1234})));
    const proof = finalizeEvent(keys.getEvent(ownerKey), ownerKey);
    const record = this.getOrCreateUserRecord(owner);
    this.updateDelegateMapping(owner,keys);
    record.appKeysEvent = proof;
    record.latestAppKeysCreatedAt = proof.created_at;
    await this.storeUserRecord(owner);
  }
  async install(owner: string, device: string, session: Session) {
    this.getOrCreateUserRecord(owner).ensureDevice(device).installSession(session,false,{persist:false});
    await this.storeUserRecord(owner);
    await this.flushMessageQueue(device);
  }
  queued(device: string) { return this.messageQueue.getForTarget(device); }
}

it("queues only the proven writer, delivers after restart and stops after device revocation", async () => {
  const ownerKey = generateSecretKey(), owner = getPublicKey(ownerKey);
  const readerKey = generateSecretKey(), reader = getPublicKey(readerKey);
  const writer = key(), sibling = key();
  const storage = new InMemoryStorageAdapter();
  const events: VerifiedEvent[] = [];
  const invites = {ephemeralKeypair:generateEphemeralKeypair(),sharedSecret:generateSharedSecret()};
  const open = () => new RepairSender(reader,readerKey,reader,()=>()=>{},async event=>{
    events.push(event as VerifiedEvent); return event as VerifiedEvent;
  },reader,invites,storage);
  let manager = open();
  try {
    await manager.init();
    const rumor = buildSenderKeyRepairRequestRumor({groupId:"g",senderEventPubkey:key(),createdAt:1234},reader);
    expect(await manager.sendGroupRepairToDevice(owner,writer,rumor)).toBe(false);
    await manager.roster(ownerKey,[writer,sibling]);
    expect(await manager.sendGroupRepairToDevice(owner,writer,rumor)).toBe(true);
    expect((await manager.queued(writer)).map(i=>i.event.id)).toEqual([rumor.id]);
    expect(await manager.queued(sibling)).toEqual([]);
    expect(await manager.queued(reader)).toEqual([]);
    manager.close();
    manager = open();
    await manager.init();
    const a = generateSecretKey(), b = generateSecretKey(), shared = generateSharedSecret();
    const receiver = Session.init(getPublicKey(a),b,false,shared);
    await manager.install(owner,writer,Session.init(getPublicKey(b),a,true,shared));
    const plaintexts = events.filter(e=>e.kind===1060).map(e=>receiver.receiveEvent(e)?.id);
    expect(plaintexts).toEqual([rumor.id]);
    expect(await manager.queued(writer)).toEqual([]);
    await manager.roster(ownerKey,[sibling]);
    expect(await manager.sendGroupRepairToDevice(owner,writer,rumor)).toBe(false);
    expect(await manager.queued(writer)).toEqual([]);
    await manager.roster(readerKey,[reader,sibling]);
    expect(await manager.sendGroupRepairToDevice(reader,reader,rumor)).toBe(true);
    expect(await manager.queued(reader)).toEqual([]);
    expect(await manager.sendGroupRepairToDevice(reader,sibling,rumor)).toBe(true);
    expect((await manager.queued(sibling)).map(entry => entry.event.id)).toEqual([rumor.id]);
  } finally { manager.close(); }
});
