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



it("serializes concurrent same-group sends so typing does not race the first message", async () => {
    const groupId = "group-manager-concurrent-send";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevicePk = getPublicKey(generateSecretKey());

    const sender = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });
    const receiver = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    await sender.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );
    await receiver.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    const pairwise: Array<{ recipient: string; rumor: Rumor }> = [];
    const published: VerifiedEvent[] = [];

    await Promise.all([
      sender.sendEvent(
        groupId,
        {
          kind: TYPING_KIND,
          content: "typing",
          tags: [],
        },
        {
          sendPairwise: async (recipient, rumor) => {
            pairwise.push({ recipient, rumor });
          },
          publishOuter: async (outer) => {
            published.push(outer);
          },
        },
      ),
      sender.sendEvent(
        groupId,
        {
          kind: CHAT_MESSAGE_KIND,
          content: "hello after typing",
          tags: [],
        },
        {
          sendPairwise: async (recipient, rumor) => {
            pairwise.push({ recipient, rumor });
          },
          publishOuter: async (outer) => {
            published.push(outer);
          },
        },
      ),
    ]);

    expect(pairwise).toHaveLength(2);
    expect(pairwise.map((entry) => entry.recipient).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk].sort(),
    );
    expect(published).toHaveLength(2);

    expect(
      published.every((event) =>
        event.tags.some((tag) => tag[0] === "header" && tag[1]),
      ),
    ).toBe(true);

    const received: Array<{ kind: number; content: string }> = [];
    await receiver.handleIncomingSessionEvent(
      pairwise[0]!.rumor,
      aliceOwnerPk,
      aliceDevicePk,
    );
    for (const outer of published) {
      const decrypted = await receiver.handleOuterEvent(outer);
      if (decrypted) {
        received.push({
          kind: decrypted.inner.kind,
          content: decrypted.inner.content,
        });
      }
    }

    expect(received).toEqual([
      { kind: TYPING_KIND, content: "typing" },
      { kind: CHAT_MESSAGE_KIND, content: "hello after typing" },
    ]);
  });

it("re-subscribes outer authors when new sender-event pubkeys are learned", async () => {
    const groupAId = "group-a";
    const groupBId = "group-b";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());

    const senderForGroupA = new Group({
      data: makeGroup(groupAId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const senderForGroupB = new Group({
      data: makeGroup(groupBId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const filters: Filter[] = [];
    let unsubscribeCalls = 0;

    const manager = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: getPublicKey(generateSecretKey()),
      storage: new InMemoryStorageAdapter(),
      nostrSubscribe: ((filter, _onEvent) => {
        filters.push(filter);
        return () => {
          unsubscribeCalls += 1;
        };
      }) as NostrSubscribe,
    });

    await manager.upsertGroup(
      makeGroup(groupAId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );
    await manager.upsertGroup(
      makeGroup(groupBId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    let distA: Rumor | null = null;
    let outerA: VerifiedEvent | null = null;
    await senderForGroupA.sendMessage("a1", {
      sendPairwise: async (_to, rumor) => {
        distA = rumor;
      },
      publishOuter: async (outer) => {
        outerA = outer;
      },
    });

    let distB: Rumor | null = null;
    let outerB: VerifiedEvent | null = null;
    await senderForGroupB.sendMessage("b1", {
      sendPairwise: async (_to, rumor) => {
        distB = rumor;
      },
      publishOuter: async (outer) => {
        outerB = outer;
      },
    });

    await manager.handleIncomingSessionEvent(
      distA!,
      aliceOwnerPk,
      aliceDevicePk,
    );
    const liveFiltersAfterA = filters.filter((filter) => !("since" in filter));
    expect(liveFiltersAfterA).toHaveLength(1);
    expect(liveFiltersAfterA[0]!.authors).toEqual([outerA!.pubkey]);
    expect(unsubscribeCalls).toBe(0);

    await manager.handleIncomingSessionEvent(
      distB!,
      aliceOwnerPk,
      aliceDevicePk,
    );
    const liveFiltersAfterB = filters.filter((filter) => !("since" in filter));
    expect(liveFiltersAfterB).toHaveLength(2);
    expect(liveFiltersAfterB[1]!.authors).toEqual(
      [outerA!.pubkey, outerB!.pubkey].sort(),
    );
    expect(unsubscribeCalls).toBe(1);
  });

it("backfills recent outer events when a sender-event pubkey is learned after publish", async () => {
    const groupId = "group-manager-backfill";

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

    const subscriptions: Array<{
      filter: Filter;
      onEvent: (event: VerifiedEvent) => void;
    }> = [];
    const received: string[] = [];

    const manager = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
      nostrSubscribe: ((filter, onEvent) => {
        subscriptions.push({ filter, onEvent });
        return () => {};
      }) as NostrSubscribe,
      onDecryptedEvent: (event) => {
        received.push(event.inner.content);
      },
    });

    await manager.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    let distribution: Rumor | null = null;
    let outer: VerifiedEvent | null = null;
    await alice.sendMessage("late group reply", {
      sendPairwise: async (_to, rumor) => {
        distribution = rumor;
      },
      publishOuter: async (event) => {
        outer = event;
      },
    });

    await manager.handleIncomingSessionEvent(
      distribution!,
      aliceOwnerPk,
      aliceDevicePk,
    );

    const backfillSubscription = subscriptions.find(
      (entry) => "since" in entry.filter,
    );
    expect(backfillSubscription).toBeDefined();

    backfillSubscription!.onEvent(outer!);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual(["late group reply"]);
  });

it("retries outer backfill after learning a sender-event pubkey", async () => {
    vi.useFakeTimers();
    try {
      const groupId = "group-manager-backfill-retry";

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

      let distribution: Rumor | null = null;
      let outer: VerifiedEvent | null = null;
      await alice.sendMessage("retried group reply", {
        sendPairwise: async (_to, rumor) => {
          distribution = rumor;
        },
        publishOuter: async (event) => {
          outer = event;
        },
      });

      let backfillCalls = 0;
      const received: string[] = [];
      const manager = new GroupManager({
        ourOwnerPubkey: bobOwnerPk,
        ourDevicePubkey: bobDevicePk,
        storage: new InMemoryStorageAdapter(),
        outerBackfillDurationMs: 10,
        outerBackfillRetryDelaysMs: [0, 25],
        nostrSubscribe: ((filter, onEvent) => {
          if ("since" in filter) {
            backfillCalls += 1;
            if (backfillCalls === 2) {
              onEvent(outer!);
            }
          }
          return () => {};
        }) as NostrSubscribe,
        onDecryptedEvent: (event) => {
          received.push(event.inner.content);
        },
      });

      await manager.upsertGroup(
        makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      );
      await manager.handleIncomingSessionEvent(
        distribution!,
        aliceOwnerPk,
        aliceDevicePk,
      );

      expect(received).toEqual([]);
      await vi.advanceTimersByTimeAsync(30);

      expect(backfillCalls).toBe(2);
      expect(received).toEqual(["retried group reply"]);
    } finally {
      vi.useRealTimers();
    }
  });

it("fetches and orders recent outer events for newly learned sender-event pubkeys", async () => {
    const groupId = "group-manager-fetch-backfill";

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

    let distribution: Rumor | null = null;
    const published: VerifiedEvent[] = [];
    await alice.sendMessage("fetch backfill #1", {
      sendPairwise: async (_to, rumor) => {
        distribution = rumor;
      },
      publishOuter: async (outer) => {
        published.push(outer);
      },
      nowMs: 1_000,
    });
    await alice.sendMessage("fetch backfill #2", {
      sendPairwise: async () => {},
      publishOuter: async (outer) => {
        published.push(outer);
      },
      nowMs: 2_000,
    });
    for (let index = 3; index <= 5; index += 1) {
      await alice.sendMessage(`fetch backfill #${index}`, {
        sendPairwise: async () => {},
        publishOuter: async (outer) => {
          published.push(outer);
        },
        nowMs: index * 1_000,
      });
    }

    const received: string[] = [];
    const fetchCalls: Array<{ authors?: string[]; since?: number }> = [];
    const oneToMany = OneToManyChannel.default();
    const parseSpy = vi.spyOn(oneToMany, "parseOuterEvent");

    const manager = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
      oneToMany,
      outerBackfillRetryDelaysMs: [0],
      nostrFetch: (async (filter) => {
        fetchCalls.push({
          authors: Array.isArray(filter.authors)
            ? [...filter.authors]
            : undefined,
          since: typeof filter.since === "number" ? filter.since : undefined,
        });
        return [...published].reverse();
      }) as NostrFetch,
      onDecryptedEvent: (event) => {
        received.push(event.inner.content);
      },
    });

    await manager.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );
    await manager.handleIncomingSessionEvent(
      distribution!,
      aliceOwnerPk,
      aliceDevicePk,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls.every((call) => call.authors?.length === 1)).toBe(true);
    expect(received).toEqual(
      Array.from({ length: 5 }, (_, index) => `fetch backfill #${index + 1}`),
    );
    expect(parseSpy).toHaveBeenCalledTimes(published.length * 2);
  });
});
