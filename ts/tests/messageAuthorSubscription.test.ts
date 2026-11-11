import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, generateSecretKey, getPublicKey, type Filter, type VerifiedEvent } from "nostr-tools";
import {
  buildMessageAuthorSubscriptionFilters,
  MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
  MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
} from "../src/directMessageSubscriptions";
import { prioritizedSessionMessageAuthorPubkeys } from "../src/session-manager/messageAuthors";
import { NdrRuntime } from "../src/NdrRuntime";
import type { Session } from "../src/Session";
import { MockRelay } from "./helpers/mockRelay";

const author = (index: number) => bytesToHex(sha256(new TextEncoder().encode(`author-${index}`)));
const authors = (count: number, from = 0) => Array.from({ length: count }, (_, index) => author(from + index));
const authorsOf = (filters: Filter[]) => filters.flatMap((filter) => filter.authors ?? []);

describe("message author subscription filters", () => {
  it("keeps a small author set in the single filter clients have always sent", () => {
    const plan = buildMessageAuthorSubscriptionFilters(authors(5));
    expect(plan.filters).toEqual([{ kinds: [1060], authors: authors(5).sort() }]);
    expect(plan.dropped).toEqual([]);
  });

  it("splits a large set into filters no relay refuses, without losing an author", () => {
    const all = authors(2_500);
    const plan = buildMessageAuthorSubscriptionFilters(all);
    expect(plan.filters.length).toBeGreaterThan(2);
    for (const filter of plan.filters) {
      expect(filter.kinds).toEqual([1060]);
      expect(filter.authors!.length).toBeLessThanOrEqual(MESSAGE_AUTHOR_FILTER_CHUNK_SIZE);
      expect(filter.authors).toEqual([...filter.authors!].sort());
    }
    expect(authorsOf(plan.filters).sort()).toEqual([...all].sort());
    expect(plan.dropped).toEqual([]);
  });

  it("leaves most filters untouched when one author is added", () => {
    const before = buildMessageAuthorSubscriptionFilters(authors(2_500)).filters.map((filter) => filter.authors!.join());
    const after = buildMessageAuthorSubscriptionFilters(authors(2_501)).filters.map((filter) => filter.authors!.join());
    expect(after).toHaveLength(before.length);
    expect(after.filter((key) => !before.includes(key))).toHaveLength(1);
  });

  it("drops the least important authors first once the limit is reached", () => {
    const all = authors(13);
    const plan = buildMessageAuthorSubscriptionFilters(all, { chunkSize: 4, maxAuthors: 10 });
    expect(plan.dropped).toEqual(all.slice(10));
    expect(authorsOf(plan.filters).sort()).toEqual(all.slice(0, 10).sort());
    for (const filter of plan.filters) expect(filter.authors!.length).toBeLessThanOrEqual(4);
    expect(buildMessageAuthorSubscriptionFilters(authors(MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT + 7)).dropped).toHaveLength(7);
    // The same layout as the Rust implementation, for hosts that share relays.
    expect(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(plan.filters.map((filter) => filter.authors))))))
      .toBe("790c1c4646399fbc11069a6e30c318509935f0a06af4796acf07af94703b8e21");
  });

  it("ranks live ratchet keys of every session above keys that only have missed messages", () => {
    const session = (current: string, next: string, skipped: string[]) => ({ state: {
      metadataPrivacyVersion: 2, theirCurrentNostrPublicKey: current, theirNextNostrPublicKey: next,
      skippedKeys: Object.fromEntries(skipped.map((key) => [key, {}])),
    } }) as unknown as Session;
    const ranked = prioritizedSessionMessageAuthorPubkeys([
      session(author(1), author(2), [author(7), author(1)]),
      session(author(3), author(4), [author(8)]),
    ]);
    expect(ranked).toEqual([author(1), author(2), author(3), author(4), author(7), author(8)]);
  });
});

class ObservableRuntime extends NdrRuntime {
  refreshSubscriptions(): void { this.syncDirectMessageSubscription(); }
}

it("runtime subscribes to message authors in chunks and only replaces the chunk that changed", async () => {
  const relay = new MockRelay();
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
  const open = () => subscriptions.filter(({ filter, closes }) => filter.kinds?.includes(1060) && filter.authors && !closes);
  const ranked = vi.spyOn(runtime.getSessionManager()!, "getPrioritizedMessageAuthorPubkeys");
  try {
    ranked.mockReturnValue(authors(2_500));
    runtime.refreshSubscriptions();
    const first = open();
    expect(first.length).toBeGreaterThan(2);
    expect(authorsOf(first.map(({ filter }) => filter)).sort()).toEqual(authors(2_500).sort());
    expect(runtime.getDirectMessageSubscriptionAuthors()).toEqual(authors(2_500).sort());

    ranked.mockReturnValue(authors(2_501));
    runtime.refreshSubscriptions();
    expect(first.filter(({ closes }) => closes)).toHaveLength(1);
    expect(open().filter((subscription) => !first.includes(subscription))).toHaveLength(1);
    expect(authorsOf(open().map(({ filter }) => filter)).sort()).toEqual(authors(2_501).sort());
  } finally {
    ranked.mockRestore();
    runtime.close();
  }
  expect(subscriptions.filter(({ filter }) => filter.authors && filter.kinds?.includes(1060)).every(({ closes }) => closes === 1)).toBe(true);
});
