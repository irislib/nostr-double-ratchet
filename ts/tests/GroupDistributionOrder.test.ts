import { captureGroupCiphertext } from "./helpers/groupCiphertext.js";
import { expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { Group, type GroupData } from "../src/Group";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../src/GroupMeta";
import { SenderKeyState } from "../src/SenderKey";
import type { Rumor } from "../src/types";

/**
 * Copies of one key distribution are made at different chain positions and can
 * arrive in any order. The first copy to arrive must not decide forever which
 * earlier messages are readable.
 */
it("opens earlier messages when an earlier copy of a key distribution arrives late", async () => {
  const alice = getPublicKey(generateSecretKey());
  const bob = getPublicKey(generateSecretKey());
  const aliceDevice = getPublicKey(generateSecretKey());
  const data: GroupData = {
    id: "distribution-order", name: "Test", members: [alice, bob],
    admins: [alice], createdAt: Date.now(), accepted: true,
  };
  const sender = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: aliceDevice });
  const receiver = new Group({ data, ourOwnerPubkey: bob, ourDevicePubkey: getPublicKey(generateSecretKey()) });
  const sent: Array<{ to: string; rumor: Rumor }> = [];
  const options = {
    sendPairwise: async (to: string, rumor: Rumor) => { sent.push({ to, rumor }); },
    publishOuter: async () => {},
  };

  const first = await captureGroupCiphertext(sender, "sendMessage", "first", options);
  const origin = sent.find((entry) => entry.to === bob && entry.rumor.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND)!.rumor;
  const second = await captureGroupCiphertext(sender, "sendMessage", "second", options);
  const third = await captureGroupCiphertext(sender, "sendMessage", "third", options);

  // The copy this receiver sees first was made two messages later.
  const distribution = JSON.parse(origin.content);
  expect(distribution.iteration).toBe(0);
  const chain = new SenderKeyState(distribution.keyId, hexToBytes(distribution.chainKey), distribution.iteration);
  chain.encryptToBytes("advance");
  chain.encryptToBytes("advance");
  const copy = (changes: object): Rumor => ({ ...origin, content: JSON.stringify({ ...distribution, ...changes }) });
  const later = copy({ chainKey: bytesToHex(chain.chainKeyBytes()), iteration: chain.iterationNumber() });

  const delivered: string[] = [];
  const collect = (events: Array<{ inner: Rumor }> | { inner: Rumor } | null) => {
    for (const event of Array.isArray(events) ? events : events ? [events] : []) delivered.push(event.inner.content);
  };
  collect(await receiver.handleIncomingSessionEvent(later, alice, aliceDevice));
  collect(await receiver.handleOuterEvent(third.outer));
  collect(await receiver.handleOuterEvent(first.outer));
  expect(delivered).toEqual(["third"]);

  // A copy that does not lead to the chain already held changes nothing.
  collect(await receiver.handleIncomingSessionEvent(copy({ chainKey: "09".repeat(32) }), alice, aliceDevice));
  collect(await receiver.handleOuterEvent(first.outer));
  expect(delivered).toEqual(["third"]);

  collect(await receiver.handleIncomingSessionEvent(origin, alice, aliceDevice));
  collect(await receiver.handleOuterEvent(first.outer));
  collect(await receiver.handleOuterEvent(second.outer));
  expect([...delivered].sort()).toEqual(["first", "second", "third"]);

  // Nothing becomes readable twice, also when the early copy is repeated.
  collect(await receiver.handleIncomingSessionEvent(origin, alice, aliceDevice));
  collect(await receiver.handleOuterEvent(first.outer));
  expect([...delivered].sort()).toEqual(["first", "second", "third"]);
  // Each miss searches the whole skip window, which is slow on small CI runners.
}, 30_000);
