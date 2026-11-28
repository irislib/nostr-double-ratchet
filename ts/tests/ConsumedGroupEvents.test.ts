import { describe, expect, it } from "vitest";
import { ConsumedGroupEvents } from "../src/group/ConsumedGroupEvents.js";
import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";

describe("bounded consumed group IDs", () => {
  it("retains at most 256 exact IDs; colliding distinct events remain eligible", async () => {
    const storage = new InMemoryStorageAdapter();
    const seen = new ConsumedGroupEvents(storage, "consumed/");
    const old = "a".repeat(64), replacement = "aa" + "b".repeat(62);
    await seen.remember(old);
    expect(await seen.has(old)).toBe(true);
    expect(await seen.has(replacement)).toBe(false);
    await seen.remember(replacement);
    expect(await seen.has(old)).toBe(false);
    expect(await seen.has(replacement)).toBe(true);
    for (let i = 0; i < 512; i++) {
      await seen.remember((i % 256).toString(16).padStart(2, "0") + (i < 256 ? "a" : "b").repeat(62));
    }
    expect(await storage.list("consumed/")).toHaveLength(256);
  });
  it("falls back on IO failures and rejects malformed IDs", async () => {
    class Interrupted extends InMemoryStorageAdapter {
      override async get<T>(): Promise<T | undefined> { throw new Error("unavailable"); }
      override async put<T>(_key: string, _value: T): Promise<void> { throw new Error("unavailable"); }
    }
    const storage = new Interrupted();
    const seen = new ConsumedGroupEvents(storage, "consumed/");
    const id = "a".repeat(64);
    expect(await seen.has(id)).toBe(false);
    await expect(seen.remember(id)).resolves.toBeUndefined();
    await seen.remember("invalid");
    expect(await seen.has("invalid")).toBe(false);
    expect(await storage.list()).toEqual([]);
  });
});
