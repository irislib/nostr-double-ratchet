import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateSecretKey,
  getEventHash,
  getPublicKey,
  type VerifiedEvent,
} from "nostr-tools";
import { Group, type GroupData } from "../src/Group.js";
import {
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
} from "../src/GroupMeta.js";
import { OneToManyChannel } from "../src/OneToManyChannel.js";
import { SenderKeyState } from "../src/SenderKey.js";
import {
  buildSenderKeyRepairRequestRumor,
  senderKeyRepairResponseNextRetryAt,
  senderKeyRepairResponseRetryDelaySeconds,
} from "../src/SenderKeyRepair.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";
import { CHAT_MESSAGE_KIND, type Rumor } from "../src/types.js";
import { MockRelay } from "./helpers/mockRelay.js";
import { createRuntime } from "./helpers/runtime.js";

afterEach(() => vi.restoreAllMocks());

function makeEpoch(
  groupId: string,
  aliceDevice: string,
  outerSecret: Uint8Array,
  keyId: number,
  createdAt: number,
) {
  const outerPubkey = getPublicKey(outerSecret);
  const chain = generateSecretKey();
  const state = new SenderKeyState(keyId, chain, 0);
  const rumor: Rumor = {
    kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND,
    pubkey: aliceDevice,
    created_at: createdAt,
    tags: [["l", groupId]],
    id: "",
    content: JSON.stringify({
      groupId,
      keyId,
      chainKey: state.toJSON().chainKey,
      iteration: 0,
      createdAt,
      senderEventPubkey: outerPubkey,
    }),
  };
  rumor.id = getEventHash(rumor);
  return { state, rumor };
}

function encryptGroupMessage(
  groupId: string,
  aliceDevice: string,
  outerSecret: Uint8Array,
  state: SenderKeyState,
  content: string,
): VerifiedEvent {
  const inner: Rumor = {
    kind: CHAT_MESSAGE_KIND,
    pubkey: aliceDevice,
    created_at: 300,
    tags: [["l", groupId]],
    content,
    id: "",
  };
  inner.id = getEventHash(inner);
  return OneToManyChannel.default().encryptToOuterEvent(
    outerSecret,
    state,
    JSON.stringify(inner),
    300,
  );
}

describe("group sender-key repair and decrypt efficiency", () => {
  it("uses capped responder retry delays without altering requester default delays", () => {
    expect(senderKeyRepairResponseRetryDelaySeconds(0)).toBe(10);
    expect(senderKeyRepairResponseRetryDelaySeconds(1)).toBe(10);
    expect(senderKeyRepairResponseRetryDelaySeconds(2)).toBe(30);
    expect(senderKeyRepairResponseRetryDelaySeconds(3)).toBe(60);
    expect(senderKeyRepairResponseRetryDelaySeconds(4)).toBe(120);
    expect(senderKeyRepairResponseRetryDelaySeconds(5)).toBe(300);
    expect(senderKeyRepairResponseRetryDelaySeconds(99)).toBe(300);
    expect(senderKeyRepairResponseNextRetryAt(100, 2)).toBe(130);
  });

  it("deduplicates snapshots per keyId oldest-first and supports progressive latest-only replay", async () => {
    const alice = getPublicKey(generateSecretKey());
    const bob = getPublicKey(generateSecretKey());
    const aliceDevice = getPublicKey(generateSecretKey());
    const outerPubkey = getPublicKey(generateSecretKey());
    const storage = new InMemoryStorageAdapter();
    const data: GroupData = {
      id: "dedup-group",
      name: "Dedup",
      members: [alice, bob],
      admins: [alice],
      createdAt: 1,
      accepted: true,
    };
    const group = new Group({
      data,
      ourOwnerPubkey: alice,
      ourDevicePubkey: aliceDevice,
      storage,
    });
    const prefix = `v1/broadcast-channel/group/${data.id}/sender/${aliceDevice}`;
    await storage.put(`${prefix}/sender-event-pubkey`, outerPubkey);
    await storage.put(`${prefix}/latest-key-id`, 20);
    const chain = "11".repeat(32);
    await storage.put(`${prefix}/repair-snapshots`, [
      {
        keyId: 10,
        recipients: [alice, bob],
        distribution: {
          groupId: data.id,
          keyId: 10,
          chainKey: chain,
          iteration: 5,
          createdAt: 100,
          senderEventPubkey: outerPubkey,
        },
      },
      {
        keyId: 10,
        recipients: [alice, bob],
        distribution: {
          groupId: data.id,
          keyId: 10,
          chainKey: chain,
          iteration: 0,
          createdAt: 100,
          senderEventPubkey: outerPubkey,
        },
      },
      {
        keyId: 20,
        recipients: [alice, bob],
        distribution: {
          groupId: data.id,
          keyId: 20,
          chainKey: chain,
          iteration: 0,
          createdAt: 200,
          senderEventPubkey: outerPubkey,
        },
      },
      {
        keyId: 30,
        recipients: [alice],
        distribution: {
          groupId: data.id,
          keyId: 30,
          chainKey: chain,
          iteration: 0,
          createdAt: 300,
          senderEventPubkey: outerPubkey,
        },
      },
    ]);

    const request = {
      groupId: data.id,
      senderEventPubkey: outerPubkey,
      createdAt: 250,
    };

    const firstPass: Array<{ keyId: number; iteration: number }> = [];
    await group.respondToSenderKeyRepairRequest(bob, request, {
      latestOnly: true,
      sendPairwise: async (_to, rumor) => {
        const dist = JSON.parse(rumor.content);
        firstPass.push({ keyId: dist.keyId, iteration: dist.iteration });
      },
    });
    expect(firstPass).toEqual([{ keyId: 20, iteration: 0 }]);

    const fullPass: Array<{ keyId: number; iteration: number }> = [];
    await group.respondToSenderKeyRepairRequest(bob, request, {
      latestOnly: false,
      sendPairwise: async (_to, rumor) => {
        const dist = JSON.parse(rumor.content);
        fullPass.push({ keyId: dist.keyId, iteration: dist.iteration });
      },
    });
    // Lowest iteration per eligible keyId, ordered oldest-first, excluding ineligible key 30.
    expect(fullPass).toEqual([
      { keyId: 10, iteration: 0 },
      { keyId: 20, iteration: 0 },
    ]);
  });

  it("targets complete repair history to the requesting device, resets on rotation, and preserves wire privacy", async () => {
    const frames: string[] = [];
    class RecordingRelay extends MockRelay {
      override storeAndDeliver(event: VerifiedEvent) {
        frames.push(JSON.stringify(["EVENT", event]));
        super.storeAndDeliver(event);
      }
    }
    const relay = new RecordingRelay();
    const aliceKey = generateSecretKey();
    const bobKey = generateSecretKey();
    const aliceOwner = getPublicKey(aliceKey);
    const bobOwner = getPublicKey(bobKey);
    const alice = createRuntime({ relay, ownerPrivateKey: aliceKey });
    const bobPhone = createRuntime({ relay, ownerPrivateKey: bobKey });
    const bobLaptop = createRuntime({ relay, ownerPrivateKey: bobKey });
    const runtimes = [alice, bobPhone, bobLaptop];
    const phoneDists: Array<{ keyId: number; iteration: number }> = [];
    const laptopDists: Array<{ keyId: number; iteration: number }> = [];

    try {
      for (const [runtime, owner] of [
        [alice, aliceOwner],
        [bobPhone, bobOwner],
        [bobLaptop, bobOwner],
      ] as const) {
        await runtime.initForOwner(owner);
        await runtime.registerCurrentDevice({ ownerPubkey: owner });
        await runtime.republishInvite();
      }
      await alice.sendMessage(bobOwner, "warmup");
      await bobPhone.sendMessage(aliceOwner, "phone ready");
      await bobLaptop.sendMessage(aliceOwner, "laptop ready");

      bobPhone.onSessionEvent((event) => {
        if (event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
          const dist = JSON.parse(event.content);
          phoneDists.push({ keyId: dist.keyId, iteration: dist.iteration });
        }
      });
      bobLaptop.onSessionEvent((event) => {
        if (event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
          const dist = JSON.parse(event.content);
          laptopDists.push({ keyId: dist.keyId, iteration: dist.iteration });
        }
      });

      const created = await alice.createGroup("Targeted Reply", [bobOwner], {
        fanoutMetadata: false,
      });
      await bobPhone.syncGroups([created.group]);
      await bobLaptop.syncGroups([created.group]);

      const firstMsg = await alice.sendGroupMessage(created.group.id, "epoch 1");
      await vi.waitFor(() => {
        expect(phoneDists).toHaveLength(1);
        expect(laptopDists).toHaveLength(1);
      });
      const firstKeyId = phoneDists[0]!.keyId;

      // Rotate to epoch 2 so Alice holds two eligible epochs for Bob.
      await alice.getGroupManager()!.rotateSenderKey(created.group.id, {
        sendPairwise: async (recipient, rumor) => {
          await alice.sendEvent(recipient, rumor, undefined, {
            includeLocalSiblings: false,
          });
        },
      });
      await vi.waitFor(() => {
        expect(phoneDists).toHaveLength(2);
        expect(laptopDists).toHaveLength(2);
      });
      const secondKeyId = phoneDists[1]!.keyId;
      expect(secondKeyId).not.toBe(firstKeyId);

      phoneDists.length = 0;
      laptopDists.length = 0;
      const sendToDeviceSpy = vi.spyOn(
        alice.getSessionManager()!,
        "sendGroupDistributionToDevice",
      );

      // Round 0: bobPhone requests blind repair; all eligible epochs go to that device.
      const phoneDevice = bobPhone.getState().currentDevicePubkey!;
      const repairRumor = buildSenderKeyRepairRequestRumor(
        {
          groupId: created.group.id,
          senderEventPubkey: firstMsg.outer.pubkey,
          createdAt: Math.floor(Date.now() / 1000),
        },
        phoneDevice,
      );
      await bobPhone.sendEvent(aliceOwner, repairRumor, undefined, {
        includeLocalSiblings: false,
      });

      await vi.waitFor(() => expect(phoneDists).toHaveLength(2), {
        timeout: 2_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(new Set(phoneDists.map((d) => d.keyId))).toEqual(new Set([firstKeyId, secondKeyId]));
      expect(laptopDists).toEqual([]);
      expect(sendToDeviceSpy).toHaveBeenCalledTimes(2);
      expect(sendToDeviceSpy).toHaveBeenCalledWith(
        bobOwner,
        phoneDevice,
        expect.objectContaining({ kind: GROUP_SENDER_KEY_DISTRIBUTION_KIND }),
      );

      // Immediate retry within 10s throttle window is suppressed.
      await bobPhone.sendEvent(aliceOwner, repairRumor, undefined, {
        includeLocalSiblings: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(phoneDists).toHaveLength(2);
      expect(laptopDists).toEqual([]);

      // Rotation resets the throttle, retaining complete eligible history.
      await alice.getGroupManager()!.rotateSenderKey(created.group.id, {
        sendPairwise: async (recipient, rumor) => {
          await alice.sendEvent(recipient, rumor, undefined, {
            includeLocalSiblings: false,
          });
        },
      });
      await vi.waitFor(() => expect(phoneDists).toHaveLength(3), {
        timeout: 2_000,
      });
      const thirdKeyId = phoneDists[2]!.keyId;
      phoneDists.length = 0;
      laptopDists.length = 0;

      const retryAfterRotate = buildSenderKeyRepairRequestRumor(
        {
          groupId: created.group.id,
          senderEventPubkey: firstMsg.outer.pubkey,
          createdAt: Math.floor(Date.now() / 1000) + 1,
        },
        phoneDevice,
      );
      await bobPhone.sendEvent(aliceOwner, retryAfterRotate, undefined, {
        includeLocalSiblings: false,
      });
      await vi.waitFor(() => expect(phoneDists).toHaveLength(3), {
        timeout: 2_000,
      });
      expect(new Set(phoneDists.map((d) => d.keyId))).toEqual(new Set([firstKeyId, secondKeyId, thirdKeyId]));
      expect(laptopDists).toEqual([]);

      // Wire-level metadata privacy check across every recorded relay frame.
      const identities = [
        aliceOwner,
        bobOwner,
        ...runtimes.map((r) => r.getState().currentDevicePubkey!),
      ];
      for (const frame of frames) {
        const event = JSON.parse(frame)[1] as VerifiedEvent;
        expect([
          GROUP_SENDER_KEY_DISTRIBUTION_KIND,
          GROUP_SENDER_KEY_REPAIR_REQUEST_KIND,
          21113,
        ]).not.toContain(event.kind);
        if (event.kind === 1060) {
          expect(identities).not.toContain(event.pubkey);
          expect(event.tags.filter((tag) => tag[0] === "p")).toHaveLength(0);
          expect(frame).not.toContain(created.group.id);
        }
      }
    } finally {
      for (const runtime of runtimes) runtime.close();
    }
  }, 15_000);

  it("probes all key frontiers before blind scan, prefers active key on out-of-order decrypt, and skips drainPending on unchanged replays", async () => {
    const alice = getPublicKey(generateSecretKey());
    const bob = getPublicKey(generateSecretKey());
    const aliceDevice = getPublicKey(generateSecretKey());
    const bobDevice = getPublicKey(generateSecretKey());
    const outerSecret = generateSecretKey();
    const data: GroupData = {
      id: "multi-key-frontier",
      name: "Frontier",
      members: [alice, bob],
      admins: [alice],
      createdAt: 1,
      accepted: true,
    };
    const storage = new InMemoryStorageAdapter();
    const bobGroup = new Group({
      data,
      ourOwnerPubkey: bob,
      ourDevicePubkey: bobDevice,
      storage,
    });

    const oldEpoch = makeEpoch(data.id, aliceDevice, outerSecret, 9_000, 100);
    const currentEpoch = makeEpoch(data.id, aliceDevice, outerSecret, 7, 200);
    await bobGroup.handleIncomingSessionEvent(oldEpoch.rumor, alice, aliceDevice);
    await bobGroup.handleIncomingSessionEvent(currentEpoch.rumor, alice, aliceDevice);

    // 1. Non-preferred key frontier hit avoids any blind scan.
    const blindSpy = vi.spyOn(SenderKeyState.prototype, "planDecryptBlind");
    const oldFrontierMsg = encryptGroupMessage(
      data.id,
      aliceDevice,
      outerSecret,
      oldEpoch.state,
      "old epoch frontier",
    );
    expect((await bobGroup.handleOuterEvent(oldFrontierMsg))?.inner.content).toBe(
      "old epoch frontier",
    );
    expect(blindSpy).not.toHaveBeenCalled();

    // 2. Out-of-order message on current preferred key (keyId 7) tries preferred key BEFORE old keyId 9000.
    const skippedCurrent = encryptGroupMessage(
      data.id,
      aliceDevice,
      outerSecret,
      currentEpoch.state,
      "current skipped",
    );
    const aheadCurrent = encryptGroupMessage(
      data.id,
      aliceDevice,
      outerSecret,
      currentEpoch.state,
      "current ahead",
    );
    const scannedKeyIds: number[] = [];
    const origBlind = SenderKeyState.prototype.planDecryptBlind;
    vi.spyOn(SenderKeyState.prototype, "planDecryptBlind").mockImplementation(
      function (this: SenderKeyState, bytes: Uint8Array) {
        scannedKeyIds.push(this.keyId);
        return origBlind.call(this, bytes);
      },
    );
    expect((await bobGroup.handleOuterEvent(aheadCurrent))?.inner.content).toBe(
      "current ahead",
    );
    expect(scannedKeyIds).toEqual([7]);
    expect((await bobGroup.handleOuterEvent(skippedCurrent))?.inner.content).toBe(
      "current skipped",
    );

    // 3. Replaying an already-known unchanged distribution does not re-scan stuck pending ciphertexts.
    const unknownEpoch = makeEpoch(data.id, aliceDevice, outerSecret, 42, 300);
    const stuckMsg = encryptGroupMessage(
      data.id,
      aliceDevice,
      outerSecret,
      unknownEpoch.state,
      "unknown epoch",
    );
    expect(await bobGroup.handleOuterEvent(stuckMsg)).toBeNull();
    scannedKeyIds.length = 0;

    expect(
      await bobGroup.handleIncomingSessionEvent(currentEpoch.rumor, alice, aliceDevice),
    ).toEqual([]);
    expect(scannedKeyIds).toEqual([]);

    // Delivering the genuinely new epoch unlocks the pending ciphertext cleanly.
    const drained = await bobGroup.handleIncomingSessionEvent(
      unknownEpoch.rumor,
      alice,
      aliceDevice,
    );
    expect(drained.map((e) => e.inner.content)).toEqual(["unknown epoch"]);
  });
});
