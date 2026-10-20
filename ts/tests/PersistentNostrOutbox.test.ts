import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, type VerifiedEvent } from "nostr-tools";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { createPersistentNostrOutbox } from "../src/PersistentNostrOutbox";

const event = (content = "encrypted"): VerifiedEvent => finalizeEvent({
  kind: 1060, created_at: 1, content, tags: [["v", "2"], ["p", "ab".repeat(32)], ["header", "encrypted-header"]],
}, generateSecretKey());
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => vi.useRealTimers());

describe("persistent Nostr outbox", () => {
  it("rejects timer delays that would overflow into an immediate retry loop", () => {
    expect(() => createPersistentNostrOutbox({
      storage: new InMemoryStorageAdapter(), publish: async (signed) => signed,
      retryDelayMs: 2_147_483_648,
    })).toThrow("Invalid outbox options");
  });

  it("persists the exact signed envelope before publishing and deduplicates concurrent sends", async () => {
    const storage = new InMemoryStorageAdapter();
    const signed = event();
    const ack = deferred<VerifiedEvent>();
    const published = vi.fn(async () => ack.promise);
    const outbox = createPersistentNostrOutbox({ storage, publish: published });
    const context = { recipientOwnerPubkey: "a".repeat(64), createdAt: 1 };
    const first = outbox.publish(signed, "inner", context);
    const second = outbox.publish(signed, "inner", context);
    await vi.waitFor(() => expect(published).toHaveBeenCalledOnce());
    expect(await storage.get(`v1/runtime-outbox/${signed.id}`)).toEqual(structuredClone({ event: signed, innerEventId: "inner", context }));
    signed.content = "caller mutation";
    const saved = (await storage.get<any>(`v1/runtime-outbox/${signed.id}`)).event;
    expect(saved.content).toBe("encrypted");
    ack.resolve(saved);
    await Promise.all([first, second]);
    expect(await storage.list()).toEqual([]);
    await outbox.close();
  });

  it("rejects failed persistence without publishing or acknowledging local acceptance", async () => {
    class BrokenStorage extends InMemoryStorageAdapter {
      async put(): Promise<void> { throw new Error("disk full"); }
    }
    const publish = vi.fn(async (signed: VerifiedEvent) => signed);
    const outbox = createPersistentNostrOutbox({ storage: new BrokenStorage(), publish });
    await expect(outbox.publish(event())).rejects.toThrow("disk full");
    expect(publish).not.toHaveBeenCalled();
    await outbox.close();
  });

  it("rejects unsigned input and mismatched transport acknowledgements", async () => {
    const storage = new InMemoryStorageAdapter();
    const signed = event();
    const outbox = createPersistentNostrOutbox({ storage, publish: async () => event("unrelated") });
    await expect(outbox.publish({ kind: 14, created_at: 1, pubkey: signed.pubkey, content: "", tags: [] })).rejects.toThrow("unsigned");
    await expect(outbox.publish(signed)).rejects.toThrow("different envelope");
    expect(await storage.list()).toEqual([`v1/runtime-outbox/${signed.id}`]);
    await outbox.close();
  });

  it("waits for already-started persistence on close without publishing its late result", async () => {
    const saved = deferred<void>();
    let writing = false;
    class DelayedStorage extends InMemoryStorageAdapter {
      async put<T>(key: string, value: T): Promise<void> {
        writing = true;
        await saved.promise;
        await super.put(key, value);
      }
    }
    const storage = new DelayedStorage();
    const publish = vi.fn(async (signed: VerifiedEvent) => signed);
    const outbox = createPersistentNostrOutbox({ storage, publish });
    const sending = outbox.publish(event());
    const result = Promise.allSettled([sending]);
    await vi.waitFor(() => expect(writing).toBe(true));
    let complete = false;
    const closing = outbox.close().then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    saved.resolve();
    await closing;
    expect((await result)[0].status).toBe("rejected");
    expect(publish).not.toHaveBeenCalled();
    expect(await storage.list()).toHaveLength(1);
  });

  it("restores pending envelopes after restart and does not let a failed oldest event block newer messages", async () => {
    const storage = new InMemoryStorageAdapter();
    const first = event("first"), second = event("second");
    const before = createPersistentNostrOutbox({ storage, publish: async (signed) => signed });
    await before.enqueue(first);
    await before.enqueue(second, "second-inner");
    await before.close();
    const publish = vi.fn(async (signed: VerifiedEvent) => {
      if (signed.id === first.id) throw new Error("rejected");
      return signed;
    });
    const after = createPersistentNostrOutbox({ storage, publish, concurrency: 1 });
    await after.retry();
    expect(publish.mock.calls.map(([signed]) => signed.id)).toEqual([first.id, second.id]);
    expect(await storage.list()).toEqual([`v1/runtime-outbox/${first.id}`]);
    await after.close();
  });

  it("bounds active publication across ordinary sends and retries", async () => {
    const storage = new InMemoryStorageAdapter();
    const acks = new Map<string, ReturnType<typeof deferred<VerifiedEvent>>>();
    let active = 0, maximum = 0;
    const publish = vi.fn(async (signed: VerifiedEvent) => {
      maximum = Math.max(maximum, ++active);
      const ack = deferred<VerifiedEvent>();
      acks.set(signed.id, ack);
      try { return await ack.promise; } finally { active--; }
    });
    const outbox = createPersistentNostrOutbox({ storage, publish, concurrency: 2 });
    const events = [event("a"), event("b"), event("c")];
    const sends = events.map((signed) => outbox.publish(signed));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    const retry = outbox.retry();
    acks.get(events[0].id)!.resolve(events[0]);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
    acks.get(events[1].id)!.resolve(events[1]);
    acks.get(events[2].id)!.resolve(events[2]);
    await Promise.all([...sends, retry]);
    expect(maximum).toBe(2);
    expect(publish).toHaveBeenCalledTimes(3);
    await outbox.close();
  });

  it("has no idle timer or scan, and clears its retry timer when the outbox drains", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    const list = vi.spyOn(storage, "list");
    const publish = vi.fn(async (signed: VerifiedEvent) => signed);
    const outbox = createPersistentNostrOutbox({ storage, publish, retryDelayMs: 50 });
    expect(vi.getTimerCount()).toBe(0);
    expect(list).not.toHaveBeenCalled();
    await outbox.retry();
    await vi.advanceTimersByTimeAsync(500);
    expect(list).toHaveBeenCalledOnce();
    const signed = event();
    await outbox.enqueue(signed);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(list).toHaveBeenCalledOnce();
    await outbox.close();
  });

  it("close cancels waiting sends and late ACK effects without dropping persisted envelopes", async () => {
    const storage = new InMemoryStorageAdapter();
    const ack = deferred<VerifiedEvent>();
    const publish = vi.fn(async () => ack.promise);
    const onPublished = vi.fn();
    const onError = vi.fn();
    const outbox = createPersistentNostrOutbox({ storage, publish, onPublished, onError, concurrency: 1 });
    const first = event("first"), second = event("second");
    const sends = [outbox.publish(first), outbox.publish(second)];
    const settled = Promise.allSettled(sends);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await outbox.close();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    ack.resolve(first);
    await Promise.resolve();
    expect(await storage.list()).toHaveLength(2);
    expect(onPublished).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    await expect(outbox.enqueue(event())).rejects.toThrow("closed");
  });

  it("isolates account namespaces and retains the row until the durable ACK callback succeeds", async () => {
    const storage = new InMemoryStorageAdapter();
    const signed = event();
    const alice = createPersistentNostrOutbox({ storage, keyPrefix: "alice/", publish: async (signed) => signed });
    await alice.enqueue(signed);
    await alice.close();
    const publish = vi.fn(async (signed: VerifiedEvent) => signed);
    const bob = createPersistentNostrOutbox({ storage, keyPrefix: "bob/", publish });
    await bob.retry();
    expect(publish).not.toHaveBeenCalled();
    await bob.close();
    const onPublished = vi.fn().mockRejectedValueOnce(new Error("UI database failed")).mockResolvedValue(undefined);
    const resumed = createPersistentNostrOutbox({ storage, keyPrefix: "alice/", publish, onPublished });
    await resumed.retry();
    expect(await storage.list()).toEqual([`alice/${signed.id}`]);
    await resumed.retry();
    expect(await storage.list()).toEqual([]);
    expect(onPublished).toHaveBeenCalledTimes(2);
    await resumed.close();
  });
});


it("quarantines restored unversioned publications without deleting them or retrying them", async () => {
  const storage = new InMemoryStorageAdapter();
  const legacy = finalizeEvent({ kind: 1060, created_at: 1, content: "legacy", tags: [] }, generateSecretKey());
  const key = `v1/runtime-outbox/${legacy.id}`;
  await storage.put(key, { event: legacy });
  const publish = vi.fn(async (signed: VerifiedEvent) => signed);
  const onError = vi.fn();
  const outbox = createPersistentNostrOutbox({ storage, publish, onError });
  await outbox.retry();
  await outbox.retry();
  expect(publish).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledOnce();
  expect(await storage.get(key)).toEqual({ event: legacy });
  await expect(outbox.publish(legacy)).rejects.toThrow("new private handshake");
  await outbox.close();
});

it('quarantines saved group roster facts and shared ciphertext without deleting history', async () => {
  const storage = new InMemoryStorageAdapter(), publish = vi.fn(async (event: VerifiedEvent) => event)
  const legacy = [
    finalizeEvent({kind: 37368, created_at: 1, content: '', tags: [['type', 'group_roster']]}, generateSecretKey()),
    finalizeEvent({kind: 1060, created_at: 1, content: 'encrypted', tags: [['v', '2'], ['header', 'encrypted-header']]}, generateSecretKey()),
  ]
  for (const event of legacy) await storage.put(`v1/runtime-outbox/${event.id}`, {event})
  const outbox = createPersistentNostrOutbox({storage, publish})
  await outbox.retry()
  expect(publish).not.toHaveBeenCalled()
  for (const event of legacy) expect(await storage.get(`v1/runtime-outbox/${event.id}`)).toEqual({event})
  await outbox.close()
})
