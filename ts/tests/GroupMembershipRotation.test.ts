import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { Group, GroupManager, removeGroupMember, type GroupData } from "../src/Group";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import type { Rumor } from "../src/types";

function fixture() {
  const alice = getPublicKey(generateSecretKey());
  const bob = getPublicKey(generateSecretKey());
  const carol = getPublicKey(generateSecretKey());
  const aliceDevice = getPublicKey(generateSecretKey());
  const storage = new InMemoryStorageAdapter();
  const data: GroupData = {
    id: "membership-rotation", name: "Test", members: [alice, bob, carol],
    admins: [alice], createdAt: Date.now(), accepted: true,
  };
  const sender = (roster = data) => new Group({
    data: roster, ourOwnerPubkey: alice, ourDevicePubkey: aliceDevice, storage,
  });
  const receiver = (owner: string) => new Group({
    data, ourOwnerPubkey: owner, ourDevicePubkey: getPublicKey(generateSecretKey()),
  });
  const sent: Array<{ to: string; rumor: Rumor }> = [];
  const options = {
    sendPairwise: async (to: string, rumor: Rumor) => { sent.push({ to, rumor }); },
    publishOuter: async () => {},
  };
  const install = async (group: Group, owner: string) => {
    const distribution = sent.find((entry) => entry.to === owner);
    expect(distribution).toBeDefined();
    return group.handleIncomingSessionEvent(distribution!.rumor, alice, aliceDevice);
  };
  return { alice, bob, carol, aliceDevice, data, storage, sender, receiver, sent, options, install };
}

describe("group membership sender-key rotation", () => {
  it.each(["setData", "setMembers", "restart"] as const)(
    "excludes a removed member's existing keys after %s",
    async (update) => {
      const f = fixture();
      let alice = f.sender();
      const bob = f.receiver(f.bob);
      const carol = f.receiver(f.carol);
      const first = await alice.sendMessage("before removal", f.options);
      await f.install(bob, f.bob);
      await f.install(carol, f.carol);
      expect((await bob.handleOuterEvent(first.outer))?.inner.content).toBe("before removal");

      const next = removeGroupMember(f.data, f.bob, f.alice);
      expect(next).not.toBeNull();
      if (update === "setData") alice.setData(next!);
      else if (update === "setMembers") alice.setMembers(next!.members);
      else alice = f.sender(next!);
      f.sent.length = 0;

      const second = await alice.sendMessage("after removal", f.options);
      // Bob deliberately retains his old roster and keys, like an uncooperative ex-member.
      expect(await bob.handleOuterEvent(second.outer)).toBeNull();
      expect(f.sent.map((entry) => entry.to).sort()).toEqual([f.alice, f.carol].sort());
      await f.install(carol, f.carol);
      expect((await carol.handleOuterEvent(second.outer))?.inner.content).toBe("after removal");
    },
  );

  it("rotates through GroupManager and still repairs an eligible member's older messages", async () => {
    const f = fixture();
    const alice = new GroupManager({
      ourOwnerPubkey: f.alice, ourDevicePubkey: f.aliceDevice, storage: f.storage,
    });
    await alice.upsertGroup(f.data);
    const bob = f.receiver(f.bob);
    const carol = f.receiver(f.carol);
    const first = await alice.sendMessage(f.data.id, "missed original key", f.options);
    await f.install(bob, f.bob);
    // Carol receives the ciphertext but misses the original key distribution.
    expect(await carol.handleOuterEvent(first.outer)).toBeNull();
    const request = carol.senderKeyRepairRequestForOuterEvent(first.outer)!;
    await alice.upsertGroup(removeGroupMember(f.data, f.bob, f.alice)!);
    f.sent.length = 0;
    const second = await alice.sendMessage(f.data.id, "new membership", f.options);
    expect(await bob.handleOuterEvent(second.outer)).toBeNull();
    await f.install(carol, f.carol);
    expect((await carol.handleOuterEvent(second.outer))?.inner.content).toBe("new membership");

    const repaired: Rumor[] = [];
    await alice.respondToSenderKeyRepairRequest(f.data.id, f.carol, request, {
      sendPairwise: async (_to, rumor) => { repaired.push(rumor); },
    });
    const recovered: string[] = [];
    for (const rumor of repaired) {
      const events = await carol.handleIncomingSessionEvent(rumor, f.alice, f.aliceDevice);
      recovered.push(...events.map((event) => event.inner.content));
    }
    expect(recovered).toContain("missed original key");
    const denied: Rumor[] = [];
    await alice.respondToSenderKeyRepairRequest(f.data.id, f.bob, request, {
      sendPairwise: async (_to, rumor) => { denied.push(rumor); },
    });
    expect(denied).toEqual([]);
    alice.destroy();
  });

  it("keeps the current key for a renamed or reordered unchanged membership", async () => {
    const f = fixture();
    const alice = f.sender();
    const bob = f.receiver(f.bob);
    const first = await alice.sendMessage("first", f.options);
    await f.install(bob, f.bob);
    await bob.handleOuterEvent(first.outer);
    f.sent.length = 0;
    alice.setData({ ...f.data, name: "Renamed", members: [...f.data.members].reverse() });
    const second = await alice.sendMessage("same members", f.options);
    expect(f.sent).toEqual([]);
    expect((await bob.handleOuterEvent(second.outer))?.inner.content).toBe("same members");
  });

  it("does not send or distribute keys after the local owner is removed", async () => {
    const f = fixture();
    const alice = f.sender();
    await alice.sendMessage("first", f.options);
    alice.setMembers([f.bob, f.carol]);
    f.sent.length = 0;
    let published = false;
    await expect(alice.sendMessage("not a member", {
      ...f.options, publishOuter: async () => { published = true; },
    })).rejects.toThrow(/member/i);
    expect(f.sent).toEqual([]);
    expect(published).toBe(false);
    await expect(alice.rotateSenderKey(f.options)).rejects.toThrow(/member/i);
    expect(f.sent).toEqual([]);
  });

  it.each(["missing snapshots", "failed snapshot write"] as const)(
    "rotates safely after %s and a restart",
    async (failure) => {
      const f = fixture();
      let alice = f.sender();
      const bob = f.receiver(f.bob);
      const carol = f.receiver(f.carol);
      await alice.sendMessage("first", f.options);
      await f.install(bob, f.bob);
      const next = removeGroupMember(f.data, f.bob, f.alice)!;
      alice.setData(next);
      f.sent.length = 0;
      let published = false;
      if (failure === "missing snapshots") {
        for (const key of await f.storage.list()) {
          if (key.endsWith("/repair-snapshots")) await f.storage.del(key);
        }
      } else {
        const put = f.storage.put.bind(f.storage);
        f.storage.put = async (key, value) => {
          if (key.endsWith("/repair-snapshots")) throw new Error("storage unavailable");
          await put(key, value);
        };
        await expect(alice.sendMessage("interrupted", {
          ...f.options, publishOuter: async () => { published = true; },
        })).rejects.toThrow("storage unavailable");
        expect(f.sent).toEqual([]);
        expect(published).toBe(false);
        f.storage.put = put;
      }
      alice = f.sender(next);
      const message = await alice.sendMessage("safe retry", f.options);
      expect(await bob.handleOuterEvent(message.outer)).toBeNull();
      await f.install(carol, f.carol);
      expect((await carol.handleOuterEvent(message.outer))?.inner.content).toBe("safe retry");
    },
  );

  it("gives an added member a fresh key without exposing pre-join messages", async () => {
    const f = fixture();
    const alice = f.sender();
    const first = await alice.sendMessage("before joining", f.options);
    const daveOwner = getPublicKey(generateSecretKey());
    const next = { ...f.data, members: [...f.data.members, daveOwner] };
    const dave = new Group({
      data: next, ourOwnerPubkey: daveOwner, ourDevicePubkey: getPublicKey(generateSecretKey()),
    });
    alice.setData(next);
    f.sent.length = 0;
    const second = await alice.sendMessage("welcome", f.options);
    await f.install(dave, daveOwner);
    expect((await dave.handleOuterEvent(second.outer))?.inner.content).toBe("welcome");
    expect(await dave.handleOuterEvent(first.outer)).toBeNull();
  });

  it("aborts if membership changes during key distribution and rekeys on retry", async () => {
    const f = fixture();
    const alice = f.sender();
    const bob = f.receiver(f.bob);
    await alice.sendMessage("first", f.options);
    await f.install(bob, f.bob);
    const dave = getPublicKey(generateSecretKey());
    alice.setMembers([...f.data.members, dave]);
    let published = false;
    await expect(alice.sendMessage("interrupted", {
      sendPairwise: async (_to, rumor) => {
        // Bob receives this newly issued key before his removal is observed.
        await bob.handleIncomingSessionEvent(rumor, f.alice, f.aliceDevice);
        alice.setMembers([f.alice, f.carol, dave]);
      },
      publishOuter: async () => { published = true; },
    })).rejects.toThrow(/membership changed/i);
    expect(published).toBe(false);
    f.sent.length = 0;
    const message = await alice.sendMessage("retry after removal", f.options);
    expect(await bob.handleOuterEvent(message.outer)).toBeNull();
    expect(f.sent.map((entry) => entry.to)).not.toContain(f.bob);
  });
});
