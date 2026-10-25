import { expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { Group, type GroupData } from "../src/Group";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import type { Rumor } from "../src/types";

it("ignores the current device's relay echoes before cryptographic decryption, including after restart", async () => {
  const owner = getPublicKey(generateSecretKey());
  const device = getPublicKey(generateSecretKey());
  const siblingDevice = getPublicKey(generateSecretKey());
  const storage = new InMemoryStorageAdapter();
  const data: GroupData = { id: "self-echo", name: "Test", members: [owner], admins: [owner], createdAt: Date.now() };
  const sender = new Group({ data, ourOwnerPubkey: owner, ourDevicePubkey: device, storage });
  const sibling = new Group({ data, ourOwnerPubkey: owner, ourDevicePubkey: siblingDevice });
  const distributions: Rumor[] = [];
  const sent = await sender.sendMessage("for my other device", {
    sendPairwise: async (_to, rumor) => { distributions.push(rumor); }, publishOuter: async () => {},
  });
  const restored = new Group({ data, ourOwnerPubkey: owner, ourDevicePubkey: device, storage });
  const decrypt = vi.spyOn(nip44.v2, "decrypt");
  try {
    expect(await restored.handleOuterEvent(sent.outer)).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    await sibling.handleIncomingSessionEvent(distributions[0], owner, device);
    expect((await sibling.handleOuterEvent(sent.outer))?.inner.content).toBe(sent.inner.content);
    expect(decrypt).toHaveBeenCalledOnce();
  } finally {
    decrypt.mockRestore();
  }
});
