import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { Group, GroupManager, type GroupData } from "../src/Group";
import type { Rumor } from "../src/types";

describe("GroupManager outer event authentication", () => {
  it.each([false, true])(
    "forged wrappers cannot suppress valid delivery (keys already known: %s)",
    async (keysKnown) => {
      const aliceOwner = getPublicKey(generateSecretKey());
      const aliceDevice = getPublicKey(generateSecretKey());
      const bobOwner = getPublicKey(generateSecretKey());
      const data: GroupData = {
        id: "outer-authentication",
        name: "Test",
        members: [aliceOwner, bobOwner],
        admins: [aliceOwner],
        createdAt: Date.now(),
        accepted: true,
      };
      const alice = new Group({
        data, ourOwnerPubkey: aliceOwner, ourDevicePubkey: aliceDevice,
      });
      const received: string[] = [];
      const bob = new GroupManager({
        ourOwnerPubkey: bobOwner,
        ourDevicePubkey: getPublicKey(generateSecretKey()),
        onDecryptedEvent: (event) => received.push(event.inner.content),
      });
      await bob.upsertGroup(data);
      let distribution: Rumor | undefined;
      const { outer } = await alice.sendMessage("authentic message", {
        sendPairwise: async (_recipient, rumor) => { distribution = rumor; },
        publishOuter: async () => {},
      });
      const installKeys = () => bob.handleIncomingSessionEvent(
        distribution!, aliceOwner, aliceDevice,
      );
      if (keysKnown) await installKeys();

      // JSON transport removes nostr-tools' cached verification symbol.
      const forged = JSON.parse(JSON.stringify(outer)) as VerifiedEvent;
      forged.sig = "00".repeat(64);
      await expect(bob.handleOuterEvent(forged)).resolves.toBeNull();
      await bob.handleOuterEvent(JSON.parse(JSON.stringify(outer)) as VerifiedEvent);
      if (!keysKnown) await installKeys();

      expect(received).toEqual(["authentic message"]);
      await bob.handleOuterEvent(outer);
      expect(received).toEqual(["authentic message"]);
      bob.destroy();
    },
  );
});
