import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Filter, type VerifiedEvent } from "nostr-tools";
import { NdrRuntime } from "../src/NdrRuntime";
import { MockRelay } from "./helpers/mockRelay";

class ObservableRuntime extends NdrRuntime {
  refreshSubscriptions(): void { this.syncDirectMessageSubscription(); }
}

async function runtimeOn(relay: MockRelay) {
  const key = generateSecretKey();
  const owner = getPublicKey(key);
  const subscriptions: Array<{ filter: Filter; closes: number }> = [];
  const runtime = new ObservableRuntime({
    nostrSubscribe: (filter, onEvent) => {
      const record = { filter, closes: 0 };
      subscriptions.push(record);
      const subscription = relay.subscribe(filter, onEvent);
      return () => { record.closes++; subscription.close(); };
    },
    nostrPublish: async (event) => {
      const signed = "sig" in event ? event as VerifiedEvent : finalizeEvent(event, key);
      relay.storeAndDeliver(signed);
      return signed;
    },
    appKeysFastTimeoutMs: 25,
    appKeysFetchTimeoutMs: 50,
  });
  await runtime.initForOwner(owner);
  await runtime.registerCurrentDevice({ ownerPubkey: owner });
  await runtime.republishInvite();
  const recipientSubscriptions = () => subscriptions.filter(({ filter }) =>
    filter.kinds?.includes(1060) && filter["#p"]?.length === 1 && !filter.authors);
  return { runtime, owner, subscriptions, recipientSubscriptions };
}

describe("runtime recipient subscriptions", () => {
  it("keeps the local recipient subscription open across peer setup, ratchets, and removal", async () => {
    const relay = new MockRelay();
    const alice = await runtimeOn(relay);
    const bob = await runtimeOn(relay);
    const carol = await runtimeOn(relay);
    const received: string[] = [];
    alice.runtime.onSessionEvent((event) => received.push(event.content));
    try {
      for (const [index, peer] of [bob, carol].entries()) {
        await peer.runtime.sendMessage(alice.owner, `hello ${index}`);
        await vi.waitFor(() => expect(received).toContain(`hello ${index}`));
        const replies: string[] = [];
        peer.runtime.onSessionEvent((event) => replies.push(event.content));
        await alice.runtime.sendMessage(peer.owner, `reply ${index}`);
        await vi.waitFor(() => expect(replies).toContain(`reply ${index}`));
      }
      expect(alice.recipientSubscriptions()).toHaveLength(1);
      expect(alice.recipientSubscriptions()[0]!.closes).toBe(0);
      const removedAuthors = alice.runtime.getSessionManager()!.getMessagePushAuthorPubkeys(bob.owner);
      await alice.runtime.deleteChat(bob.owner);
      await vi.waitFor(() => expect(alice.runtime.getSessionUserRecords().has(bob.owner)).toBe(false));
      alice.runtime.refreshSubscriptions();
      await vi.waitFor(() => expect(alice.runtime.getDirectMessageSubscriptionAuthors()
        .some((author) => removedAuthors.includes(author))).toBe(false), { timeout: 2000 });
      expect(alice.recipientSubscriptions()).toHaveLength(1);
      expect(alice.recipientSubscriptions()[0]!.closes).toBe(0);
    } finally {
      alice.runtime.close(); bob.runtime.close(); carol.runtime.close();
    }
    expect(alice.recipientSubscriptions()[0]!.closes).toBe(1);
    expect(alice.subscriptions.every(({ closes }) => closes === 1)).toBe(true);
  });

  it("switches recipient immediately without restarting unchanged authors and cleans up on close", async () => {
    const relay = new MockRelay();
    const peer = await runtimeOn(relay);
    const sender = await runtimeOn(relay);
    const received: string[] = [];
    peer.runtime.onSessionEvent((event) => received.push(event.content));
    await sender.runtime.sendMessage(peer.owner, "establish authors");
    await vi.waitFor(() => expect(received).toContain("establish authors"));
    const authorSubscriptions = peer.subscriptions.filter(({ filter }) => filter.kinds?.includes(1060) && filter.authors);
    expect(authorSubscriptions.length).toBeGreaterThan(0);
    const replacement = getPublicKey(generateSecretKey());
    const delegate = peer.runtime.getDelegateManager()!;
    const identity = vi.spyOn(delegate, "getIdentityPublicKey").mockReturnValue(replacement);
    try {
      peer.runtime.refreshSubscriptions();
      const subscriptions = peer.recipientSubscriptions();
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0]!.closes).toBe(1);
      expect(subscriptions[1]!.filter["#p"]).toEqual([replacement]);
      expect(subscriptions[1]!.closes).toBe(0);
      expect(peer.subscriptions.filter(({ filter }) => filter.kinds?.includes(1060) && filter.authors))
        .toEqual(authorSubscriptions);
    } finally {
      identity.mockRestore();
      peer.runtime.close();
      sender.runtime.close();
    }
    expect(peer.recipientSubscriptions().every(({ closes }) => closes === 1)).toBe(true);
  });

  it("resubscribes the same device after closing and reinitializing the runtime", async () => {
    const peer = await runtimeOn(new MockRelay());
    const recipient = peer.runtime.getState().currentDevicePubkey;
    peer.runtime.close();
    await peer.runtime.initForOwner(peer.owner);
    try {
      expect(peer.runtime.getState().currentDevicePubkey).toBe(recipient);
      expect(peer.recipientSubscriptions()).toHaveLength(2);
      expect(peer.recipientSubscriptions().map(({ closes }) => closes)).toEqual([1, 0]);
    } finally {
      peer.runtime.close();
    }
    expect(peer.recipientSubscriptions().map(({ closes }) => closes)).toEqual([1, 1]);
  });
});
