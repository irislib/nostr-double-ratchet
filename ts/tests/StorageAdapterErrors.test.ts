import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStorageAdapter } from "../src/StorageAdapter.js";

afterEach(() => vi.unstubAllGlobals());

function backingStore() {
  const values = new Map<string, string>();
  const local = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("localStorage", local);
  return { local, values, adapter: new LocalStorageAdapter("test_") };
}

describe("LocalStorage operational error boundary", () => {
  it("propagates getItem failure instead of reporting missing data", async () => {
    const { local, adapter } = backingStore();
    local.getItem = () => { throw new Error("storage unavailable"); };
    await expect(adapter.get("key")).rejects.toThrow("storage unavailable");
  });
  it("propagates failed removal without acknowledging deletion", async () => {
    const { local, adapter, values } = backingStore();
    await adapter.put("key", "retained");
    local.removeItem = () => { throw new Error("storage unavailable"); };
    await expect(adapter.del("key")).rejects.toThrow("storage unavailable");
    expect(values.get("test_key")).toBe(JSON.stringify("retained"));
  });
  it("rejects an interrupted enumeration instead of returning a partial list", async () => {
    const { local, adapter } = backingStore();
    await adapter.put("one", 1);
    await adapter.put("two", 2);
    const key = local.key;
    local.key = index => { if (index === 1) throw new Error("enumeration interrupted"); return key(index); };
    await expect(adapter.list()).rejects.toThrow("enumeration interrupted");
    local.key = key;
    expect(await adapter.list()).toEqual(["one", "two"]);
  });
  it("keeps the existing corrupt-JSON compatibility separate from operational errors", async () => {
    const { adapter, values } = backingStore();
    values.set("test_corrupt", "{");
    expect(await adapter.get("corrupt")).toBeUndefined();
    expect(await adapter.get("absent")).toBeUndefined();
    await adapter.put("valid", { value: 1 });
    expect(await adapter.get("valid")).toEqual({ value: 1 });
  });
});

it("does not admit more pending data using a corrupt row as free space", async () => {
  const { values, adapter } = backingStore();
  const { PendingGroupEvents } = await import("../src/group/PendingGroupEvents.js");
  values.set("test_pending/sender/*/0", "{");
  const inbox = new PendingGroupEvents(adapter, "pending/");
  await expect(inbox.enqueue("sender", undefined, { id: "1" } as any, 0))
    .rejects.toThrow("Unreadable pending group ciphertext record");
  expect(values.size).toBe(1);
});
