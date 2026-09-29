import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../src/GroupMeta";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { type Rumor } from "../src/types";
import { MockRelay } from "./helpers/mockRelay";
import { createRuntime } from "./helpers/runtime";

describe("group pairwise fanout", () => {
  it.each(["current", "legacy"] as const)("retries a failed key handoff after restart from %s snapshots", async (format) => {
    class FailingStorage extends InMemoryStorageAdapter {
      failTarget = "";
      override async put<T = unknown>(key: string, value: T): Promise<void> {
        const entry = value as { targetKey?: string; event?: Rumor };
        if (key.startsWith("v1/message-queue/") && entry.targetKey === this.failTarget &&
            entry.event?.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
          throw new Error("injected queue write failure");
        }
        await super.put(key, value);
      }
    }
    const relay = new MockRelay();
    const aliceKey = generateSecretKey();
    const bobKey = generateSecretKey();
    const aliceOwner = getPublicKey(aliceKey);
    const bobOwner = getPublicKey(bobKey);
    const storage = new FailingStorage();
    let alice = createRuntime({ relay, ownerPrivateKey: aliceKey, storage });
    const bob = createRuntime({ relay, ownerPrivateKey: bobKey });
    const received: string[] = [];
    bob.onGroupEvent(event => { received.push(event.inner.content); });
    try {
      for (const [runtime, owner] of [[alice, aliceOwner], [bob, bobOwner]] as const) {
        await runtime.initForOwner(owner);
        await runtime.registerCurrentDevice({ ownerPubkey: owner });
        await runtime.republishInvite();
      }
      await alice.sendMessage(bobOwner, "warmup");
      await bob.sendMessage(aliceOwner, "ready");
      const created = await alice.createGroup("Retry", [bobOwner], { fanoutMetadata: false });
      await bob.syncGroups([created.group]);
      storage.failTarget = bob.getState().currentDevicePubkey!;
      await alice.sendGroupMessage(created.group.id, "before queue recovered");
      expect(received).not.toContain("before queue recovered");
      alice.close();
      if (format === "legacy") {
        for (const key of await storage.list()) {
          if (!key.endsWith("/repair-snapshots")) continue;
          const snapshots = await storage.get<Array<{ pendingRecipients?: string[] }>>(key);
          for (const snapshot of snapshots ?? []) delete snapshot.pendingRecipients;
          await storage.put(key, snapshots);
        }
      }
      storage.failTarget = "";
      alice = createRuntime({ relay, ownerPrivateKey: aliceKey, storage });
      await alice.initForOwner(aliceOwner);
      await alice.syncGroups([created.group]);
      await alice.sendGroupMessage(created.group.id, "after queue recovered");
      await vi.waitFor(() => {
        expect(received).toContain("before queue recovered");
        expect(received).toContain("after queue recovered");
      });
    } finally {
      alice.close();
      bob.close();
    }
  }, 15_000);

  it("sends one key distribution per device, including the sender's sibling", async () => {
    const relay = new MockRelay();
    const ownerKeys = Array.from({ length: 3 }, () => generateSecretKey());
    const owners = ownerKeys.map(getPublicKey);
    const published: VerifiedEvent[] = [];
    const alice = createRuntime({ relay, ownerPrivateKey: ownerKeys[0], onPublish: (event) => {
      if ("sig" in event) published.push(event as VerifiedEvent);
    } });
    const sibling = createRuntime({ relay, ownerPrivateKey: ownerKeys[0] });
    const bob = createRuntime({ relay, ownerPrivateKey: ownerKeys[1] });
    const carol = createRuntime({ relay, ownerPrivateKey: ownerKeys[2] });
    const clients = [alice, sibling, bob, carol];
    const received = clients.map(() => [] as string[]);
    const keys = clients.map(() => [] as Rumor[]);
    try {
      for (const [index, runtime] of clients.entries()) {
        const owner = owners[Math.max(0, index - 1)];
        await runtime.initForOwner(owner);
        await runtime.registerCurrentDevice({ ownerPubkey: owner });
        await runtime.republishInvite();
        runtime.onSessionEvent((event) => {
          if (event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) keys[index].push(event);
        });
        runtime.onGroupEvent((event) => { received[index].push(event.inner.content); });
      }
      // Establish all sender sessions before measuring the group fanout.
      for (const owner of owners) await alice.sendMessage(owner, "warmup");
      for (const [index, runtime] of clients.entries()) {
        if (index) await runtime.sendMessage(owners[0], "ready");
      }
      const created = await alice.createGroup("Fanout", owners.slice(1), { fanoutMetadata: false });
      for (const runtime of clients.slice(1)) await runtime.syncGroups([created.group]);
      published.length = 0;
      const sent = await alice.sendGroupMessage(created.group.id, "one distribution each");
      await vi.waitFor(() => {
        for (const messages of received.slice(1)) expect(messages).toContain(sent.inner.content);
      });
      // Count encrypted outer envelopes, not deduplicated incoming rumors.
      const distributions = keys.flat();
      const rumorIds = new Set(distributions.map(event => event.id));
      expect(rumorIds.size).toBe(1);
      const keyPublications = published.filter(event => event.id !== sent.outer.id && event.kind === 1060);
      expect(keyPublications).toHaveLength(clients.length - 1);
    } finally {
      for (const runtime of clients) runtime.close();
    }
  }, 15_000);
});
