import { expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { Group, GroupManager, createGroupData } from "../src/Group";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { createNostrPublisher } from "../src/publishing";

const key = () => getPublicKey(generateSecretKey());

it("publishes one signed packet and decrypts it via the anonymous sender subscription", async () => {
  const alice = key(), bob = key(), device = key(), bobDevice = key(), carol = key();
  const data = createGroupData("team", alice, [bob, carol]);
  const sender = new Group({data, ourOwnerPubkey: alice, ourDevicePubkey: device});
  const incoming = vi.fn();
  const subscribe = vi.fn(() => () => {});
  const group = new GroupManager({ourOwnerPubkey: bob, ourDevicePubkey: bobDevice,
    nostrGroupSubscribe: subscribe, storage: new InMemoryStorageAdapter(),
    onDecryptedEvent: incoming, outerBackfillRetryDelaysMs: []});
  try {
    await group.upsertGroup(data);
    const sendPairwise = vi.fn(async (owner, rumor) => {
      if (owner === bob) await group.handleIncomingSessionEvent(rumor, alice, device);
    });
    const relay = vi.fn(async event => event);
    const send = {sendPairwise, publishOuter: createNostrPublisher(relay)};
    await sender.sendMessage("first", send);
    const message = await sender.sendMessage("second", send);
    expect(relay).toHaveBeenCalledTimes(2);
    expect(sendPairwise.mock.calls.filter(([, rumor]) => rumor.kind === 21113)).toHaveLength(0);
    expect(message.outer.tags.map(tag => tag[0])).toEqual(["v", "header"]);
    const subscription = subscribe.mock.calls.at(-1) as unknown as [any, (event: unknown) => void];
    expect(subscription[0].authors).toContain(message.outer.pubkey);
    const wire = JSON.stringify([message.outer, subscription[0]]);
    for (const secret of [alice, bob, carol, device, bobDevice, data.id, "second"]) expect(wire).not.toContain(secret);
    subscription[1](message.outer);
    await vi.waitFor(() => expect(incoming.mock.calls.some(([event]) => event.inner.content === "second")).toBe(true));
  } finally { group.destroy(); }
});

it("rotates after a known device leaves an owner that remains in the group", async () => {
  const alice = key(), bob = key(), aliceDevice = key(), bobDevice = key(), removedDevice = key();
  const data = createGroupData("roster", alice, [bob]);
  let roster = [aliceDevice, bobDevice, removedDevice].sort();
  const storage = new InMemoryStorageAdapter();
  const current = () => new Group({data, ourOwnerPubkey: alice, ourDevicePubkey: aliceDevice,
    storage, groupDevicePubkeys: () => roster});
  const removed = new Group({data, ourOwnerPubkey: bob, ourDevicePubkey: removedDevice});
  const keyIds: number[] = [];
  const publishOuter = vi.fn(async () => {});
  const sendPairwise = async (owner: string, rumor: any) => {
    if (owner !== bob || rumor.kind !== 10446) return;
    keyIds.push(JSON.parse(rumor.content).keyId);
    if (roster.includes(removedDevice)) await removed.handleIncomingSessionEvent(rumor, alice, aliceDevice);
  };
  const original = await current().sendMessage("before removal", {sendPairwise, publishOuter});
  expect((await removed.handleOuterEvent(original.outer))?.inner.content).toBe("before removal");
  await current().sendMessage("steady", {sendPairwise, publishOuter});
  expect(keyIds).toHaveLength(1);
  roster = [aliceDevice,bobDevice].sort();
  const next = await current().sendMessage("after removal", {sendPairwise, publishOuter});
  expect(new Set(keyIds).size).toBe(2);
  expect(await removed.handleOuterEvent(next.outer)).toBeNull();
  expect(publishOuter).toHaveBeenCalledTimes(3);
});

it("settles device discovery during key distribution before publishing data", async () => {
  const alice = key(), bob = key(), device = key(), fresh = key();
  let roster = [device];
  const sender = new Group({data:createGroupData("discovery", alice, [bob]), ourOwnerPubkey:alice,
    ourDevicePubkey:device, groupDevicePubkeys: () => roster});
  const publishOuter = vi.fn(async () => {});
  await sender.sendMessage("same send", {publishOuter, sendPairwise: async () => {roster = [device, fresh].sort();}});
  expect(publishOuter).toHaveBeenCalledTimes(1);
  expect(publishOuter.mock.calls[0]?.[2]).toMatchObject({groupDevicePubkeys: roster});
});
