import { captureGroupCiphertext } from "./helpers/groupCiphertext.js";
import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";

import { Group, type GroupData } from "../src/Group";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import type { Rumor } from "../src/types";

function makeGroup(groupId: string, members: string[], admins: string[]): GroupData {
  return {
    id: groupId,
    name: "Test",
    members,
    admins,
    createdAt: Date.now(),
    accepted: true,
  };
}

function rumorForRecipient(
  sent: Array<{ to: string; rumor: Rumor }>,
  recipient: string,
): Rumor {
  const match = sent.find((entry) => entry.to === recipient);
  expect(match).toBeDefined();
  return match!.rumor;
}

describe("Group one-to-many (sender keys + OneToManyChannel)", () => {
  it("publishes one outer event and fan-outs one sender-key distribution per member", async () => {
    const groupId = "group-1";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const carolOwnerPk = getPublicKey(generateSecretKey());

    const aliceDevicePk = getPublicKey(generateSecretKey());

    const g = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk, carolOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const sent: Array<{ to: string; rumor: Rumor }> = [];
    const published: unknown[] = [];

    await captureGroupCiphertext(g, "sendMessage", "hello", {
      sendPairwise: async (to, rumor) => {
        sent.push({ to, rumor });
      },
      publishOuter: async (event) => {
        published.push(event);
      },
    });

    // One distribution per member owner, including our own owner for sibling-device sender-copy.
    expect(sent.map((s) => s.to).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk, carolOwnerPk].sort(),
    );
    expect(published).toHaveLength(1);
    const wire = JSON.stringify(published[0]);
    for (const identity of [aliceOwnerPk, bobOwnerPk, carolOwnerPk, aliceDevicePk]) {
      expect(wire).not.toContain(identity);
    }
    expect(wire).not.toContain(groupId);
  });

  it("decrypts a group message even if the outer event arrives before the sender-key distribution", async () => {
    const groupId = "group-2";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());

    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevicePk = getPublicKey(generateSecretKey());

    const alice = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const bob = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const sent: Array<{ to: string; rumor: Rumor }> = [];
    let outer: unknown | null = null;

    await captureGroupCiphertext(alice, "sendMessage", "hello out of order", {
      sendPairwise: async (to, rumor) => {
        sent.push({ to, rumor });
      },
      publishOuter: async (event) => {
        outer = event;
      },
    });

    expect(outer).not.toBeNull();
    expect(sent.map((s) => s.to).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk].sort(),
    );

    // Deliver outer first (missing distribution) -> should queue/pending.
    const early = await bob.handleOuterEvent(outer as any);
    expect(early).toBeNull();

    // Now deliver the distribution via the 1:1 session path.
    const distRumor = rumorForRecipient(sent, bobOwnerPk);
    const rejected = await bob.handleIncomingSessionEvent(distRumor, aliceOwnerPk);
    expect(rejected).toHaveLength(0);
    const after = await bob.handleIncomingSessionEvent(distRumor, aliceOwnerPk, aliceDevicePk);
    expect(after).toHaveLength(1);
    expect(after[0]!.inner.content).toBe("hello out of order");
    expect(after[0]!.senderOwnerPubkey).toBe(aliceOwnerPk);
    expect(after[0]!.senderDevicePubkey).toBe(aliceDevicePk);
  });

  it("supports sender key rotation (new key id) and continues decrypting", async () => {
    const groupId = "group-3";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());

    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevicePk = getPublicKey(generateSecretKey());

    const alice = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const bob = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const sent: Array<{ to: string; rumor: Rumor }> = [];
    const published: unknown[] = [];

    // First message establishes initial key + distribution.
    await captureGroupCiphertext(alice, "sendMessage", "m1", {
      sendPairwise: async (to, rumor) => sent.push({ to, rumor }),
      publishOuter: async (event) => published.push(event),
    });

    // Deliver distribution + outer.
    await bob.handleIncomingSessionEvent(sent.pop()!.rumor, aliceOwnerPk, aliceDevicePk);
    const first = await bob.handleOuterEvent(published.pop() as any);
    expect(first?.inner.content).toBe("m1");
    const firstKeyId = first?.keyId;
    expect(typeof firstKeyId).toBe("number");

    // Rotate + send again.
    sent.length = 0;
    published.length = 0;
    await alice.rotateSenderKey({
      sendPairwise: async (to, rumor) => sent.push({ to, rumor }),
    });
    await captureGroupCiphertext(alice, "sendMessage", "m2", {
      sendPairwise: async (to, rumor) => sent.push({ to, rumor }),
      publishOuter: async (event) => published.push(event),
    });

    // Deliver rotation distribution (there may be one for rotate + one for send; either order ok).
    for (const s of sent) {
      await bob.handleIncomingSessionEvent(s.rumor, aliceOwnerPk, aliceDevicePk);
    }
    const second = await bob.handleOuterEvent(published[0] as any);
    expect(second?.inner.content).toBe("m2");
    expect(second?.keyId).not.toBe(firstKeyId);
  });

  it("multi-device: two devices for the same owner can decrypt after receiving the distribution", async () => {
    const groupId = "group-4";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());

    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevice1Pk = getPublicKey(generateSecretKey());
    const bobDevice2Pk = getPublicKey(generateSecretKey());

    const alice = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const bob1 = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevice1Pk,
      storage: new InMemoryStorageAdapter(),
    });

    const bob2 = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevice2Pk,
      storage: new InMemoryStorageAdapter(),
    });

    const sent: Array<{ to: string; rumor: Rumor }> = [];
    let outer: unknown | null = null;

    await captureGroupCiphertext(alice, "sendMessage", "hello bob devices", {
      sendPairwise: async (to, rumor) => sent.push({ to, rumor }),
      publishOuter: async (event) => {
        outer = event;
      },
    });

    // Deliver outer first to both devices.
    expect(await bob1.handleOuterEvent(outer as any)).toBeNull();
    expect(await bob2.handleOuterEvent(outer as any)).toBeNull();

    // Deliver the same distribution to both devices (simulating SessionManager fanout).
    expect(sent.map((s) => s.to).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk].sort(),
    );
    const distRumor = rumorForRecipient(sent, bobOwnerPk);
    const r1 = await bob1.handleIncomingSessionEvent(distRumor, aliceOwnerPk, aliceDevicePk);
    const r2 = await bob2.handleIncomingSessionEvent(distRumor, aliceOwnerPk, aliceDevicePk);

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]!.inner.content).toBe("hello bob devices");
    expect(r2[0]!.inner.content).toBe("hello bob devices");
  });

  it("rejects impersonation when sender device context mismatches the signed rumor", async () => {
    const groupId = "group-impersonation";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());

    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevicePk = getPublicKey(generateSecretKey());
    const attackerDevicePk = getPublicKey(generateSecretKey());

    const alice = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const bob = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const sent: Array<{ to: string; rumor: Rumor }> = [];
    let outer: unknown | null = null;
    await captureGroupCiphertext(alice, "sendMessage", "impersonation-test", {
      sendPairwise: async (to, rumor) => sent.push({ to, rumor }),
      publishOuter: async (event) => {
        outer = event;
      },
    });

    expect(sent.map((s) => s.to).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk].sort(),
    );
    expect(outer).not.toBeNull();

    // Queue outer first.
    expect(await bob.handleOuterEvent(outer as any)).toBeNull();

    const distRumor = rumorForRecipient(sent, bobOwnerPk);

    // Forged rumor pubkey does not match authenticated sender device context.
    const forgedRumor = { ...distRumor, pubkey: attackerDevicePk } as Rumor;
    const forgedAccepted = await bob.handleIncomingSessionEvent(
      forgedRumor,
      aliceOwnerPk,
      aliceDevicePk
    );
    expect(forgedAccepted).toHaveLength(0);

    // Even with authentic rumor, mismatched sender-device context must be rejected.
    const mismatchedContext = await bob.handleIncomingSessionEvent(
      distRumor,
      aliceOwnerPk,
      attackerDevicePk
    );
    expect(mismatchedContext).toHaveLength(0);

    // Correct sender-device context succeeds.
    const accepted = await bob.handleIncomingSessionEvent(
      distRumor,
      aliceOwnerPk,
      aliceDevicePk
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.inner.content).toBe("impersonation-test");
  });
});
