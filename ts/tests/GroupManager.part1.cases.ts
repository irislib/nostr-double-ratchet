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
});
