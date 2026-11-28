import { afterEach, expect, it, vi } from "vitest";
import { GroupManager } from "../src/Group.js";
import { LocalStorageAdapter } from "../src/StorageAdapter.js";
import { ConsumedGroupEvents } from "../src/group/ConsumedGroupEvents.js";

afterEach(() => vi.unstubAllGlobals());

it("public group removal erases replay slots, propagates failed deletion and can retry after removal", async () => {
  const values = new Map<string, string>();
  let fail = false;
  vi.stubGlobal("localStorage", {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { if (fail) throw new Error("erase unavailable"); values.delete(key); },
  });
  const storage = new LocalStorageAdapter("account/");
  const prefix = "v1/broadcast-channel/group/g/consumed-outer/";
  const cache = new ConsumedGroupEvents(storage, prefix);
  await cache.remember("ab".repeat(32));
  await storage.put("unrelated", "preserve");
  const errors: unknown[] = [];
  const manager = new GroupManager({ ourOwnerPubkey: "aa".repeat(32),
    ourDevicePubkey: "bb".repeat(32), storage, onError: error => { errors.push(error); } });
  await manager.upsertGroup({ id: "g", name: "G", members: ["aa".repeat(32)],
    admins: ["aa".repeat(32)], createdAt: 1, accepted: true });
  fail = true;
  await expect(manager.removeGroup("g")).rejects.toThrow("erase unavailable");
  expect(await storage.list(prefix)).toHaveLength(1);
  fail = false;
  await manager.removeGroup("g");
  expect(await storage.list(prefix)).toEqual([]);
  expect(await storage.get("unrelated")).toBe("preserve");
  expect(errors).toHaveLength(1);
  manager.destroy();
});
