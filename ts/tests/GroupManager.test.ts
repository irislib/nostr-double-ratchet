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
  it("createGroup fans out group roster facts by default and returns group data", async () => {
    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const carolOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());

    const manager = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const sent: Array<{ recipient: string; rumor: Rumor }> = [];
    const created = await manager.createGroup(
      "Metadata Group",
      [bobOwnerPk, carolOwnerPk],
      {
        sendPairwise: async (recipient, rumor) => {
          sent.push({ recipient, rumor });
        },
      },
    );

    expect(created.group.name).toBe("Metadata Group");
    expect(created.group.members).toEqual([
      aliceOwnerPk,
      bobOwnerPk,
      carolOwnerPk,
    ]);
    expect(created.fanout.enabled).toBe(true);
    expect(created.fanout.attempted).toBe(3);
    expect(created.fanout.succeeded.sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk, carolOwnerPk].sort(),
    );
    expect(created.fanout.failed).toEqual([]);
    expect(sent).toHaveLength(3);

    for (const entry of sent) {
      expect(entry.rumor.kind).toBe(GROUP_ROSTER_FACT_KIND);
      expect(entry.rumor.pubkey).toBe(aliceOwnerPk);
      expect(entry.rumor.content).toBe("");
      expect(entry.rumor.tags).toContainEqual(["type", GROUP_ROSTER_FACT_TYPE]);
      expect(entry.rumor.tags).toContainEqual(["d", created.group.id]);
      expect(entry.rumor.tags).toContainEqual(["i", created.group.id, "subject"]);
      expect(entry.rumor.tags).toContainEqual(["group_id", created.group.id]);
      expect(entry.rumor.tags).toContainEqual(["revision", "1"]);
      expect(entry.rumor.tags).toContainEqual(["created_by", aliceOwnerPk]);
      expect(entry.rumor.tags).toContainEqual(["name", "Metadata Group"]);
      expect(entry.rumor.tags).toContainEqual(["admin", aliceOwnerPk]);
      expect(
        entry.rumor.tags.some(
          (tag) => tag[0] === "p" && tag[1] === entry.recipient,
        ),
      ).toBe(true);
      expect(
        [aliceOwnerPk, bobOwnerPk, carolOwnerPk].every((member) =>
          entry.rumor.tags.some((tag) => tag[0] === "member" && tag[1] === member),
        ),
      ).toBe(true);
    }
  });

  it("createGroup can disable metadata fanout", async () => {
    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());

    const manager = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const created = await manager.createGroup(
      "Local Draft Group",
      [bobOwnerPk],
      {
        fanoutMetadata: false,
      },
    );

    expect(created.group.name).toBe("Local Draft Group");
    expect(created.fanout.enabled).toBe(false);
    expect(created.fanout.attempted).toBe(0);
    expect(created.fanout.succeeded).toEqual([]);
    expect(created.fanout.failed).toEqual([]);
    expect(created.metadataRumor).toBeUndefined();
  });

  it("createGroup requires sendPairwise when metadata fanout is enabled", async () => {
    const manager = new GroupManager({
      ourOwnerPubkey: getPublicKey(generateSecretKey()),
      ourDevicePubkey: getPublicKey(generateSecretKey()),
      storage: new InMemoryStorageAdapter(),
    });

    await expect(
      manager.createGroup("Needs Fanout Sender", [
        getPublicKey(generateSecretKey()),
      ]),
    ).rejects.toThrow(
      "sendPairwise is required when fanoutMetadata is enabled",
    );
  });

  it("drains queued outer events after sender-key distribution and emits callbacks", async () => {
    const groupId = "group-manager-queue";

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

    const received: string[] = [];
    const filters: Filter[] = [];

    const manager = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
      nostrSubscribe: ((filter, _onEvent) => {
        filters.push(filter);
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

    await alice.sendMessage("hello group", {
      sendPairwise: async (_to, rumor) => {
        distribution = rumor;
      },
      publishOuter: async (event) => {
        outer = event;
      },
    });

    expect(outer).not.toBeNull();
    expect(distribution).not.toBeNull();

    // Outer arrives before the manager has sender mapping.
    const early = await manager.handleOuterEvent(outer!);
    expect(early).toBeNull();
    expect(received).toEqual([]);

    const drained = await manager.handleIncomingSessionEvent(
      distribution!,
      aliceOwnerPk,
      aliceDevicePk,
    );

    expect(drained).toHaveLength(1);
    expect(drained[0]!.inner.content).toBe("hello group");
    expect(received).toEqual(["hello group"]);

    // Manager should now subscribe to this sender-event author for future outers.
    const liveFilter = filters.find((filter) => !("since" in filter));
    expect(liveFilter?.kinds).toEqual([outer!.kind]);
    expect(liveFilter?.authors).toEqual([outer!.pubkey]);
    const backfillFilter = filters.find((filter) => "since" in filter);
    expect(backfillFilter?.authors).toEqual([outer!.pubkey]);
  });

  it("creates an unknown group from pairwise metadata and drains queued distribution state", async () => {
    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevicePk = getPublicKey(generateSecretKey());

    const aliceManager = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    const received: Array<{ kind: number; content: string }> = [];
    const bobManager = new GroupManager({
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: new InMemoryStorageAdapter(),
      onDecryptedEvent: (event) => {
        received.push({
          kind: event.inner.kind,
          content: event.inner.content,
        });
      },
    });

    let metadataRumor: Rumor | null = null;
    const created = await aliceManager.createGroup(
      "Remote Group",
      [bobOwnerPk],
      {
        sendPairwise: async (recipient, rumor) => {
          if (recipient === bobOwnerPk) {
            metadataRumor = rumor;
          }
        },
      },
    );

    let distributionRumor: Rumor | null = null;
    let outer: VerifiedEvent | null = null;
    await aliceManager.sendMessage(created.group.id, "hello from alice", {
      sendPairwise: async (_recipient, rumor) => {
        distributionRumor = rumor;
      },
      publishOuter: async (event) => {
        outer = event;
      },
    });

    expect(metadataRumor?.kind).toBe(GROUP_ROSTER_FACT_KIND);
    expect(distributionRumor?.kind).toBe(GROUP_SENDER_KEY_DISTRIBUTION_KIND);
    expect(outer).not.toBeNull();

    const beforeMetadata = await bobManager.handleIncomingSessionEvent(
      distributionRumor!,
      aliceOwnerPk,
      aliceDevicePk,
    );
    expect(beforeMetadata).toEqual([]);

    const beforeMapping = await bobManager.handleOuterEvent(outer!);
    expect(beforeMapping).toBeNull();

    const drained = await bobManager.handleIncomingSessionEvent(
      metadataRumor!,
      aliceOwnerPk,
      aliceDevicePk,
    );

    expect(bobManager.managedGroupIds()).toEqual([created.group.id]);
    expect(drained.map((event) => event.inner.kind)).toEqual([
      GROUP_ROSTER_FACT_KIND,
      CHAT_MESSAGE_KIND,
    ]);
    expect(drained[0]!.inner.content).toBe(metadataRumor!.content);
    expect(drained[1]!.inner.content).toBe("hello from alice");
    expect(received).toEqual([
      {
        kind: GROUP_ROSTER_FACT_KIND,
        content: metadataRumor!.content,
      },
      {
        kind: CHAT_MESSAGE_KIND,
        content: "hello from alice",
      },
    ]);
  });

  it("sendMessage uses device pubkey for inner rumor and sends distribution once", async () => {
    const groupId = "group-manager-send";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());

    const manager = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    await manager.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    const pairwise: Array<{ recipient: string; rumor: Rumor }> = [];
    const published: VerifiedEvent[] = [];

    const sent = await manager.sendMessage(groupId, "from-device", {
      sendPairwise: async (recipient, rumor) => {
        pairwise.push({ recipient, rumor });
      },
      publishOuter: async (outer) => {
        published.push(outer);
      },
    });

    expect(sent.inner.pubkey).toBe(aliceDevicePk);
    expect(pairwise).toHaveLength(2);
    expect(pairwise.map((entry) => entry.recipient).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk].sort(),
    );
    expect(
      pairwise.every(
        (entry) => entry.rumor.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND,
      ),
    ).toBe(true);
    expect(
      pairwise.every((entry) => entry.rumor.pubkey === aliceDevicePk),
    ).toBe(true);
    expect(published).toHaveLength(1);
  });

  it("sendEvent preserves inner kind and tags for non-message group events", async () => {
    const groupId = "group-manager-send-event";

    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());

    const manager = new GroupManager({
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: new InMemoryStorageAdapter(),
    });

    await manager.upsertGroup(
      makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
    );

    const sent = await manager.sendEvent(
      groupId,
      {
        kind: REACTION_KIND,
        content: "👍",
        tags: [["e", "target-event-id"]],
      },
      {
        sendPairwise: async () => {},
        publishOuter: async () => {},
      },
    );

    expect(sent.inner.kind).toBe(REACTION_KIND);
    expect(sent.inner.pubkey).toBe(aliceDevicePk);
    expect(
      sent.inner.tags.some(
        (tag) => tag[0] === "e" && tag[1] === "target-event-id",
      ),
    ).toBe(true);
    expect(
      sent.inner.tags.some((tag) => tag[0] === "l" && tag[1] === groupId),
    ).toBe(true);
  });

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
