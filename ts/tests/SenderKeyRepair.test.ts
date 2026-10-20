import { captureGroupCiphertext } from "./helpers/groupCiphertext.js";
import { describe, expect, it } from "vitest";
import {
  generateSecretKey,
  getEventHash,
  getPublicKey,
  type VerifiedEvent,
} from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";

import { Group, type GroupData } from "../src/Group";
import { OneToManyChannel } from "../src/OneToManyChannel";
import type { SenderKeyDistribution } from "../src/SenderKey";
import { SenderKeyState } from "../src/SenderKey";
import {
  buildSenderKeyRepairRequestRumor,
  parseSenderKeyRepairRequestRumor,
  senderKeyRepairDefaultNextRetryAt,
  senderKeyRepairDefaultRetryDelaySeconds,
  senderKeyRepairRequestFromPendingSenderKeyMessage,
  type SenderKeyRepairRequest,
} from "../src/SenderKeyRepair";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { CHAT_MESSAGE_KIND, type Rumor } from "../src/types";
import {
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
} from "../src/GroupMeta";

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

function rumorForRecipient(
  sent: Array<{ to: string; rumor: Rumor }>,
  recipient: string,
): Rumor {
  const match = sent.find((entry) => entry.to === recipient);
  expect(match).toBeDefined();
  return match!.rumor;
}

describe("sender-key repair requests", () => {
  it("uses the Rust-compatible retry schedule", () => {
    expect(senderKeyRepairDefaultRetryDelaySeconds(0)).toBe(30);
    expect(senderKeyRepairDefaultRetryDelaySeconds(1)).toBe(30);
    expect(senderKeyRepairDefaultRetryDelaySeconds(2)).toBe(120);
    expect(senderKeyRepairDefaultRetryDelaySeconds(3)).toBe(600);
    expect(senderKeyRepairDefaultRetryDelaySeconds(4)).toBe(3_600);
    expect(senderKeyRepairDefaultRetryDelaySeconds(5)).toBe(21_600);
    expect(
      senderKeyRepairDefaultRetryDelaySeconds(Number.MAX_SAFE_INTEGER),
    ).toBe(21_600);
    expect(senderKeyRepairDefaultNextRetryAt(100, 2)).toBe(220);
  });

  it("builds repair requests from pending sender-key outcomes", () => {
    const senderEventPubkey = getPublicKey(generateSecretKey());
    const message = {
      senderEventPubkey,
      keyId: 7,
      messageNumber: 42,
    };

    expect(
      senderKeyRepairRequestFromPendingSenderKeyMessage(
        message,
        {
          type: "pending_distribution",
          groupId: "group-1",
          senderEventPubkey,
          keyId: 7,
        },
        13,
      ),
    ).toEqual({
      groupId: "group-1",
      senderEventPubkey,
      keyId: 7,
      messageNumber: 42,
      createdAt: 13,
    });

    expect(
      senderKeyRepairRequestFromPendingSenderKeyMessage(
        message,
        {
          type: "pending_revision",
          groupId: "group-1",
          currentRevision: 3,
          requiredRevision: 9,
        },
        13,
      ),
    ).toEqual({
      groupId: "group-1",
      senderEventPubkey,
      keyId: 7,
      messageNumber: 42,
      requiredRevision: 9,
      createdAt: 13,
    });

    expect(
      senderKeyRepairRequestFromPendingSenderKeyMessage(
        message,
        { type: "event" },
        13,
      ),
    ).toBeNull();
  });

  it("encodes and validates 10447 repair request rumors", () => {
    const requesterDevicePubkey = getPublicKey(generateSecretKey());
    const senderEventPubkey = getPublicKey(generateSecretKey());
    const request: SenderKeyRepairRequest = {
      groupId: "group-1",
      senderEventPubkey,
      keyId: 7,
      messageNumber: 42,
      requiredRevision: 9,
      createdAt: 13,
    };

    const rumor = buildSenderKeyRepairRequestRumor(
      request,
      requesterDevicePubkey,
      12_000,
    );
    expect(rumor.kind).toBe(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND);
    expect(rumor.pubkey).toBe(requesterDevicePubkey);
    expect(rumor.created_at).toBe(12);
    expect(rumor.tags).toEqual([
      ["l", "group-1"],
      ["sender", senderEventPubkey],
      ["ms", "12000"],
      ["key", "7"],
      ["message", "42"],
      ["revision", "9"],
    ]);
    expect(JSON.parse(rumor.content)).toEqual({
      groupId: "group-1",
      senderEventPubkey,
      keyId: 7,
      messageNumber: 42,
      requiredRevision: 9,
      createdAt: 13,
    });
    expect(parseSenderKeyRepairRequestRumor(rumor)).toEqual(request);

    const mismatchedTag = {
      ...rumor,
      tags: rumor.tags.map((tag) => (tag[0] === "l" ? ["l", "group-2"] : tag)),
    };
    expect(parseSenderKeyRepairRequestRumor(mismatchedTag)).toBeNull();

    const oldEnvelope = {
      ...rumor,
      content: JSON.stringify({
        kind: "sender_key_repair_request",
        request: {
          group_id: "group-1",
          sender_event_pubkey: senderEventPubkey,
          key_id: 7,
          message_number: 42,
          required_revision: 9,
          created_at: 13,
        },
      }),
    };
    expect(parseSenderKeyRepairRequestRumor(oldEnvelope)).toBeNull();
  });

  it("omits sender-key counters from broad repair requests", () => {
    const requesterDevicePubkey = getPublicKey(generateSecretKey());
    const senderEventPubkey = getPublicKey(generateSecretKey());
    const request: SenderKeyRepairRequest = {
      groupId: "group-1",
      senderEventPubkey,
      createdAt: 13,
    };

    const rumor = buildSenderKeyRepairRequestRumor(
      request,
      requesterDevicePubkey,
      12_000,
    );
    expect(rumor.tags).toEqual([
      ["l", "group-1"],
      ["sender", senderEventPubkey],
      ["ms", "12000"],
    ]);
    expect(JSON.parse(rumor.content)).toEqual({
      groupId: "group-1",
      senderEventPubkey,
      createdAt: 13,
    });
    expect(parseSenderKeyRepairRequestRumor(rumor)).toEqual(request);
  });

  it("repairs a missed sender-key distribution after the sender chain advances", async () => {
    const groupId = "group-repair-flow";
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

    const distributions: Array<{ to: string; rumor: Rumor }> = [];
    const published: VerifiedEvent[] = [];
    await captureGroupCiphertext(alice, "sendMessage", "repair me", {
      nowMs: 1_700_000_000_000,
      sendPairwise: async (to, rumor) => distributions.push({ to, rumor }),
      publishOuter: async (event) => {
        published.push(event);
      },
    });

    expect(await bob.handleOuterEvent(published[0]!)).toBeNull();
    const request = bob.senderKeyRepairRequestForOuterEvent(
      published[0]!,
      1_700_000_001,
    );
    expect(request).toMatchObject({
      groupId,
      senderEventPubkey: published[0]!.pubkey,
      createdAt: 1_700_000_001,
    });
    expect(request!.keyId).toBeUndefined();
    expect(request!.messageNumber).toBeUndefined();

    const repairRequests: Array<{ to: string; rumor: Rumor }> = [];
    const repairRumor = await bob.requestSenderKeyRepair(request!, {
      nowMs: 1_700_000_001_000,
      sendPairwise: async (to, rumor) => repairRequests.push({ to, rumor }),
    });
    expect(repairRumor).not.toBeNull();
    expect(repairRequests.map((entry) => entry.to).sort()).toEqual(
      [aliceOwnerPk, bobOwnerPk].sort(),
    );

    const aliceRepairEvents = await alice.handleIncomingSessionEvent(
      rumorForRecipient(repairRequests, aliceOwnerPk),
      bobOwnerPk,
      bobDevicePk,
    );
    expect(aliceRepairEvents).toHaveLength(1);
    expect(aliceRepairEvents[0]!.inner.kind).toBe(
      GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
    );
    expect(
      parseSenderKeyRepairRequestRumor(aliceRepairEvents[0]!.inner),
    ).toEqual(request);

    await captureGroupCiphertext(alice, "sendMessage", "sender chain moved on", {
      nowMs: 1_700_000_002_000,
      sendPairwise: async () => {},
      publishOuter: async () => {},
    });

    const repairResponses: Array<{ to: string; rumor: Rumor }> = [];
    const response = await alice.respondToSenderKeyRepairRequest(
      bobOwnerPk,
      request!,
      {
        nowMs: 1_700_000_003_000,
        sendPairwise: async (to, rumor) => repairResponses.push({ to, rumor }),
      },
    );

    expect(response).not.toBeNull();
    expect(response!.iteration).toBe(0);
    expect(repairResponses).toHaveLength(1);
    expect(repairResponses[0]!.to).toBe(bobOwnerPk);
    expect(repairResponses[0]!.rumor.kind).toBe(
      GROUP_SENDER_KEY_DISTRIBUTION_KIND,
    );

    const drained = await bob.handleIncomingSessionEvent(
      repairResponses[0]!.rumor,
      aliceOwnerPk,
      aliceDevicePk,
    );
    expect(drained).toHaveLength(1);
    expect(drained[0]!.inner.content).toBe("repair me");
  });

  it("does not leak repair distributions to removed members", async () => {
    const groupId = "group-repair-removed";
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

    const published: VerifiedEvent[] = [];
    await captureGroupCiphertext(alice, "sendMessage", "before removal", {
      sendPairwise: async () => {},
      publishOuter: async (event) => {
        published.push(event);
      },
    });

    const request = bob.senderKeyRepairRequestForOuterEvent(
      published[0]!,
      1_700_000_010,
    );
    expect(request).not.toBeNull();

    alice.setData(makeGroup(groupId, [aliceOwnerPk], [aliceOwnerPk]));
    const repairResponses: Array<{ to: string; rumor: Rumor }> = [];
    const response = await alice.respondToSenderKeyRepairRequest(
      bobOwnerPk,
      request!,
      {
        sendPairwise: async (to, rumor) => repairResponses.push({ to, rumor }),
      },
    );

    expect(response).toBeNull();
    expect(repairResponses).toEqual([]);
  });

  it("does not consume a receiver sender-key state for valid ciphertext from the wrong group", async () => {
    const groupId = "group-repair-no-burn";
    const aliceOwnerPk = getPublicKey(generateSecretKey());
    const bobOwnerPk = getPublicKey(generateSecretKey());
    const aliceDevicePk = getPublicKey(generateSecretKey());
    const bobDevicePk = getPublicKey(generateSecretKey());
    const aliceStorage = new InMemoryStorageAdapter();
    const bobStorage = new InMemoryStorageAdapter();

    const alice = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: aliceOwnerPk,
      ourDevicePubkey: aliceDevicePk,
      storage: aliceStorage,
    });
    const bob = new Group({
      data: makeGroup(groupId, [aliceOwnerPk, bobOwnerPk], [aliceOwnerPk]),
      ourOwnerPubkey: bobOwnerPk,
      ourDevicePubkey: bobDevicePk,
      storage: bobStorage,
    });

    const distributions: Array<{ to: string; rumor: Rumor }> = [];
    const published: VerifiedEvent[] = [];
    await captureGroupCiphertext(alice, "sendMessage", "real message", {
      nowMs: 1_700_000_020_000,
      sendPairwise: async (to, rumor) => distributions.push({ to, rumor }),
      publishOuter: async (event) => {
        published.push(event);
      },
    });

    const distRumor = rumorForRecipient(distributions, bobOwnerPk);
    await bob.handleIncomingSessionEvent(
      distRumor,
      aliceOwnerPk,
      aliceDevicePk,
    );

    const dist = JSON.parse(distRumor.content) as SenderKeyDistribution;
    const senderSecretHex = await aliceStorage.get<string>(
      `v1/broadcast-channel/group/${groupId}/sender/${aliceDevicePk}/sender-event-secret-key`,
    );
    expect(senderSecretHex).toMatch(/^[0-9a-f]{64}$/);

    const wrongInner: Rumor = {
      kind: CHAT_MESSAGE_KIND,
      content: "wrong group",
      created_at: published[0]!.created_at,
      tags: [["l", "some-other-group"]],
      pubkey: aliceDevicePk,
      id: "",
    };
    wrongInner.id = getEventHash(wrongInner);

    const badOuter = OneToManyChannel.default().encryptToOuterEvent(
      hexToBytes(senderSecretHex!),
      SenderKeyState.fromDistribution(dist),
      JSON.stringify(wrongInner),
      published[0]!.created_at,
    );

    expect(await bob.handleOuterEvent(badOuter)).toBeNull();
    const decrypted = await bob.handleOuterEvent(published[0]!);
    expect(decrypted?.inner.content).toBe("real message");
  });
});
