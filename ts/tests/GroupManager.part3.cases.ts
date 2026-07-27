import { describe, expect, it, vi } from "vitest";
import type { Filter, VerifiedEvent } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools";

import {
  Group,
  GroupManager,
  GROUP_ROSTER_FACT_KIND,
  GROUP_ROSTER_FACT_TYPE,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  type GroupData,
} from "../src/Group";
import { OneToManyChannel } from "../src/OneToManyChannel";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { CHAT_MESSAGE_KIND, REACTION_KIND, TYPING_KIND } from "../src/types";
import type { NostrFetch, NostrSubscribe, Rumor } from "../src/types";

function makeGroup(
  groupId: string,
  members: string[],
  admins: string[],
): GroupData {
  return {
    id: groupId,
    name: "Test",
    members,
    admins,
    createdAt: Date.now(),
    accepted: true,
  };
}

describe("GroupManager", () => {



it("suppresses local-device one-to-many outer echoes by default", async () => {
    const groupId = "group-local-echo";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());

    const received: string[] = [];
    const manager = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
      onDecryptedEvent: (event) => {
        received.push(event.inner.content);
      },
    });

    await manager.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    let outer: VerifiedEvent | null = null;
    await manager.sendMessage(groupId, "local-device-message", {
      sendPairwise: async () => {},
      publishOuter: async (event) => {
        outer = event;
      },
    });

    expect(outer).not.toBeNull();

    const decrypted = await manager.handleOuterEvent(outer!);
    expect(decrypted).toBeNull();
    expect(received).toEqual([]);
  });

it("purges removed-member sender mappings and blocks future outer delivery", async () => {
    const groupId = "group-manager-revocation";

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

    const filters: Filter[] = [];
    let unsubscribeCalls = 0;

    const manager = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
      nostrSubscribe: ((filter, _onEvent) => {
        filters.push(filter);
        return () => {
          unsubscribeCalls += 1;
        };
      }) as NostrSubscribe,
    });

    await manager.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    let firstDistribution: Rumor | null = null;
    let firstOuter: VerifiedEvent | null = null;
    await alice.sendMessage("before-revocation", {
      sendPairwise: async (_to, rumor) => {
        firstDistribution = rumor;
      },
      publishOuter: async (outer) => {
        firstOuter = outer;
      },
    });

    const drained = await manager.handleIncomingSessionEvent(
      firstDistribution!,
      aliceOwnerPk,
      aliceDevicePk,
    );
    expect(drained).toEqual([]);
    const liveFilters = filters.filter((filter) => !("since" in filter));
    expect(liveFilters).toHaveLength(1);
    expect(liveFilters[0]!.authors).toEqual([firstOuter!.pubkey]);

    const before = await manager.handleOuterEvent(firstOuter!);
    expect(before?.inner.content).toBe("before-revocation");

    await manager.upsertGroup(makeGroup(groupId, [bobOwnerPk], [bobOwnerPk]));
    expect(unsubscribeCalls).toBe(1);
    expect(filters.filter((filter) => !("since" in filter))).toHaveLength(1);

    let secondOuter: VerifiedEvent | null = null;
    await alice.sendMessage("after-revocation", {
      sendPairwise: async () => {},
      publishOuter: async (outer) => {
        secondOuter = outer;
      },
    });

    const after = await manager.handleOuterEvent(secondOuter!);
    expect(after).toBeNull();

    let rotateDistribution: Rumor | null = null;
    await alice.rotateSenderKey({
      sendPairwise: async (_to, rumor) => {
        rotateDistribution = rumor;
      },
    });

    const drainedAfterRemoval = await manager.handleIncomingSessionEvent(
      rotateDistribution!,
      aliceOwnerPk,
      aliceDevicePk,
    );
    expect(drainedAfterRemoval).toEqual([]);
    expect(filters.filter((filter) => !("since" in filter))).toHaveLength(1);
  });
});
