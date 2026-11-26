import { describe, expect, it } from "vitest";
import type { VerifiedEvent } from "nostr-tools";
import { PendingGroupEvents } from "../src/group/PendingGroupEvents.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";

// Storage-admission tests do not need cryptography; GroupRecovery exercises
// the public API using real signed and encrypted events.
const event = (id: string, content = "ciphertext") => ({ id, content }) as VerifiedEvent;

describe("durable bounded group inbox", () => {
  it("deduplicates concurrent admissions and preserves arrival order across restart", async () => {
    const storage = new InMemoryStorageAdapter();
    const inbox = new PendingGroupEvents(storage, "pending/");
    await Promise.all(Array.from({ length: 129 }, (_, i) =>
      inbox.enqueue("sender", undefined, event(String(i)), 0)));
    await Promise.all(Array.from({ length: 129 }, (_, i) =>
      inbox.enqueue("sender", undefined, event(String(i)), 0)));
    const restored = new PendingGroupEvents(storage, "pending/");
    const entries = await restored.entries("sender", 9);
    expect(entries).toHaveLength(129);
    for (let i = 0; i < entries.length; i++) {
      expect((await restored.get(entries[i]))?.id).toBe(String(i));
    }
    await restored.enqueue("sender", undefined, event("129"), 0);
    expect((await restored.entries("sender", 9)).at(-1)).toBe("pending/sender/*/129");
  });

  it("rejects capacity overflow without evicting accepted events, then admits a retry after draining", async () => {
    const storage = new InMemoryStorageAdapter();
    const inbox = new PendingGroupEvents(storage, "pending/");
    const large = "x".repeat(8 * 1024 * 1024);
    await inbox.enqueue("sender", undefined, event("first", large), 0);
    // A second sender/key bucket shares the group byte budget.
    await expect(inbox.enqueue("other", 2, event("second", large), 0)).rejects.toThrow("storage is full");
    const entries = await inbox.entries("sender", 9);
    expect(entries).toEqual(["pending/sender/*/first"]);
    expect((await inbox.get(entries[0]))?.content).toBe(large);
    expect(await inbox.entries("other", 2)).toEqual([]);
    await inbox.remove(entries[0]);
    await inbox.enqueue("other", 2, event("second", large), 0);
    const restored = new PendingGroupEvents(storage, "pending/");
    await expect(restored.enqueue("sender", undefined, event("third", large), 0)).rejects.toThrow("storage is full");
    await restored.removeSender("other");
    expect(await storage.list("pending/")).toEqual([]);
    await restored.enqueue("sender", undefined, event("third", large), 0);
  });

  it("retries failed enumeration without caching partial accounting", async () => {
    class InterruptedStorage extends InMemoryStorageAdapter {
      fail = false;
      override async list(prefix?: string): Promise<string[]> {
        if (this.fail) { this.fail = false; throw new Error("interrupted list"); }
        return super.list(prefix);
      }
    }
    const storage = new InterruptedStorage();
    let inbox = new PendingGroupEvents(storage, "pending/");
    await inbox.enqueue("sender", undefined, event("0"), 0);
    inbox = new PendingGroupEvents(storage, "pending/");
    storage.fail = true;
    await expect(inbox.enqueue("sender", undefined, event("1"), 0)).rejects.toThrow("interrupted list");
    await inbox.enqueue("sender", undefined, event("1"), 0);
    expect(await inbox.entries("sender", 9)).toEqual(["pending/sender/*/0", "pending/sender/*/1"]);
  });

  it.each([false, true])("reconciles an interrupted admission, committed=%s", async committed => {
    class InterruptedStorage extends InMemoryStorageAdapter {
      fail = true;
      override async put<T>(key: string, value: T): Promise<void> {
        if (!this.fail) return super.put(key, value);
        this.fail = false;
        if (committed) await super.put(key, value);
        throw new Error("interrupted put");
      }
    }
    const storage = new InterruptedStorage();
    const inbox = new PendingGroupEvents(storage, "pending/");
    await expect(inbox.enqueue("sender", undefined, event("0"), 0)).rejects.toThrow("interrupted put");
    await inbox.enqueue("sender", undefined, event("0"), 0);
    await inbox.enqueue("sender", undefined, event("1"), 0);
    expect(await inbox.entries("sender", 9)).toEqual(["pending/sender/*/0", "pending/sender/*/1"]);
  });
});
