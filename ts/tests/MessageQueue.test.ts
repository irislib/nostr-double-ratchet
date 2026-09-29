import { describe, it, expect } from "vitest"
import { MessageQueue } from "../src/MessageQueue"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { Rumor } from "../src/types"

const makeRumor = (id: string, content = "test"): Rumor => ({
  id,
  pubkey: "sender",
  created_at: Math.floor(Date.now() / 1000),
  kind: 14,
  tags: [],
  content,
})

describe("MessageQueue", () => {
  it("reads only the requested device's persisted backlog in a 182-device fanout", async () => {
    class CountingStorage extends InMemoryStorageAdapter {
      reads = 0
      override async get<T = unknown>(key: string): Promise<T | undefined> {
        this.reads += 1
        return super.get<T>(key)
      }
    }
    const storage = new CountingStorage()
    const prefix = "v1/message-queue/"
    const queue = new MessageQueue(storage, prefix)
    const targets = Array.from({ length: 182 }, (_, i) => i.toString(16).padStart(64, "0"))
    for (const target of targets) {
      for (let message = 0; message < 3; message += 1) {
        await queue.add(target, makeRumor(`message-${message}`))
      }
    }

    // Recreate the queue to exercise persistent data rather than an in-memory index.
    const restored = new MessageQueue(storage, prefix)
    for (const target of targets) expect(await restored.getForTarget(target)).toHaveLength(3)
    expect(storage.reads).toBe(182 * 3)
    storage.reads = 0
    await restored.removeForTarget(targets[0])
    expect(storage.reads).toBe(3)
    expect(await restored.getForTarget(targets[0])).toEqual([])
    expect(await restored.getForTarget(targets[1])).toHaveLength(3)
  })

  const createQueue = (prefix = "v1/test-queue/") => {
    const storage = new InMemoryStorageAdapter()
    const queue = new MessageQueue(storage, prefix)
    return { queue, storage }
  }

  describe("add", () => {
    it("should store an entry and return a unique id", async () => {
      const { queue } = createQueue()
      const event = makeRumor("evt1")
      const id = await queue.add("device-a", event)
      expect(id).toBeTruthy()
      expect(typeof id).toBe("string")
    })

    it("should generate deterministic id from event.id + targetKey", async () => {
      const { queue } = createQueue()
      const event = makeRumor("evt1")
      const id1 = await queue.add("device-a", event)
      const id2 = await queue.add("device-a", event)
      expect(id1).toBe(id2)
      expect(id1).toBe("evt1/device-a")
    })

    it("should generate different ids for different events", async () => {
      const { queue } = createQueue()
      const id1 = await queue.add("device-a", makeRumor("evt1"))
      const id2 = await queue.add("device-a", makeRumor("evt2"))
      expect(id1).not.toBe(id2)
    })
  })

  describe("getForTarget", () => {
    it("should return empty array when no entries exist", async () => {
      const { queue } = createQueue()
      const entries = await queue.getForTarget("device-a")
      expect(entries).toEqual([])
    })

    it("should return entries only for the requested target", async () => {
      const { queue } = createQueue()
      await queue.add("device-a", makeRumor("evt1", "for-a"))
      await queue.add("device-b", makeRumor("evt2", "for-b"))
      await queue.add("device-a", makeRumor("evt3", "for-a-2"))

      const entriesA = await queue.getForTarget("device-a")
      expect(entriesA).toHaveLength(2)
      expect(entriesA.map((e) => e.event.content)).toEqual(["for-a", "for-a-2"])

      const entriesB = await queue.getForTarget("device-b")
      expect(entriesB).toHaveLength(1)
      expect(entriesB[0].event.content).toBe("for-b")
    })

    it("should return entries sorted by createdAt", async () => {
      const { queue, storage } = createQueue()

      // Manually insert with controlled timestamps
      await storage.put("v1/test-queue/evt2/device-a", {
        id: "evt2/device-a",
        targetKey: "device-a",
        event: makeRumor("evt2", "second"),
        createdAt: 2000,
      })
      await storage.put("v1/test-queue/evt1/device-a", {
        id: "evt1/device-a",
        targetKey: "device-a",
        event: makeRumor("evt1", "first"),
        createdAt: 1000,
      })

      const entries = await queue.getForTarget("device-a")
      expect(entries).toHaveLength(2)
      expect(entries[0].event.content).toBe("first")
      expect(entries[1].event.content).toBe("second")
    })

    it("should deduplicate entries with the same event id", async () => {
      const { queue } = createQueue()
      const event = makeRumor("same-event-id", "hello")
      await queue.add("device-a", event)
      await queue.add("device-a", event)
      await queue.add("device-a", event)

      const entries = await queue.getForTarget("device-a")
      expect(entries).toHaveLength(1)
      expect(entries[0].event.content).toBe("hello")
    })

    it("should not deduplicate across different targets", async () => {
      const { queue } = createQueue()
      const event = makeRumor("shared-evt", "hello")
      await queue.add("device-a", event)
      await queue.add("device-b", event)

      const a = await queue.getForTarget("device-a")
      const b = await queue.getForTarget("device-b")
      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
    })
  })

  describe("entries", () => {
    it("returns all entries for the queue prefix sorted by creation time", async () => {
      const { queue, storage } = createQueue()

      await storage.put("v1/test-queue/z-late", {
        id: "z-late",
        targetKey: "device-b",
        event: makeRumor("evt2", "second"),
        createdAt: 2000,
      })
      await storage.put("v1/test-queue/evt1/device-a", {
        id: "evt1/device-a",
        targetKey: "device-a",
        event: makeRumor("evt1", "first"),
        createdAt: 1000,
      })

      const entries = await queue.entries()
      expect(entries.map((entry) => entry.targetKey)).toEqual(["device-a", "device-b"])
      expect(entries.map((entry) => entry.event.content)).toEqual(["first", "second"])
    })
  })

  describe("removeForTarget", () => {
    it("should remove all entries for a target", async () => {
      const { queue } = createQueue()
      await queue.add("device-a", makeRumor("evt1"))
      await queue.add("device-a", makeRumor("evt2"))
      await queue.add("device-b", makeRumor("evt3"))

      await queue.removeForTarget("device-a")

      expect(await queue.getForTarget("device-a")).toEqual([])
      expect(await queue.getForTarget("device-b")).toHaveLength(1)
    })

    it("should be a no-op when target has no entries", async () => {
      const { queue } = createQueue()
      await queue.add("device-a", makeRumor("evt1"))
      await queue.removeForTarget("device-nonexistent")
      expect(await queue.getForTarget("device-a")).toHaveLength(1)
    })

    it("should deduplicate at add time — same event+target produces one storage entry", async () => {
      const { queue, storage } = createQueue()
      const event = makeRumor("dup-evt")
      await queue.add("device-a", event)
      await queue.add("device-a", event)

      // Only one storage entry should exist (dedup at add time)
      const keysBefore = await storage.list("v1/test-queue/")
      expect(keysBefore).toHaveLength(1)

      await queue.removeForTarget("device-a")

      const keysAfter = await storage.list("v1/test-queue/")
      expect(keysAfter).toHaveLength(0)
    })
  })

  describe("remove", () => {
    it("should remove a single entry by id", async () => {
      const { queue } = createQueue()
      const id1 = await queue.add("device-a", makeRumor("evt1", "first"))
      await queue.add("device-a", makeRumor("evt2", "second"))

      await queue.remove(id1)

      const entries = await queue.getForTarget("device-a")
      expect(entries).toHaveLength(1)
      expect(entries[0].event.content).toBe("second")
    })

    it("should be a no-op for nonexistent id", async () => {
      const { queue } = createQueue()
      await queue.add("device-a", makeRumor("evt1"))
      await queue.remove("nonexistent-id")
      expect(await queue.getForTarget("device-a")).toHaveLength(1)
    })
  })

  describe("removeByTargetAndEventId", () => {
    it("should remove the entry matching event id + target", async () => {
      const { queue } = createQueue()
      await queue.add("device-a", makeRumor("evt1", "first"))
      await queue.add("device-a", makeRumor("evt2", "second"))

      await queue.removeByTargetAndEventId("device-a", "evt1")

      const entries = await queue.getForTarget("device-a")
      expect(entries).toHaveLength(1)
      expect(entries[0].event.content).toBe("second")
    })

    it("should be a no-op for nonexistent event+target combo", async () => {
      const { queue } = createQueue()
      await queue.add("device-a", makeRumor("evt1"))
      await queue.removeByTargetAndEventId("device-b", "evt1")
      expect(await queue.getForTarget("device-a")).toHaveLength(1)
    })
  })

  describe("prefix isolation", () => {
    it("two queues with different prefixes on same storage should not interfere", async () => {
      const storage = new InMemoryStorageAdapter()
      const queueA = new MessageQueue(storage, "v1/message-queue/")
      const queueB = new MessageQueue(storage, "v1/discovery-queue/")

      await queueA.add("target-1", makeRumor("evt1", "from-A"))
      await queueB.add("target-1", makeRumor("evt2", "from-B"))

      const entriesA = await queueA.getForTarget("target-1")
      const entriesB = await queueB.getForTarget("target-1")

      expect(entriesA).toHaveLength(1)
      expect(entriesA[0].event.content).toBe("from-A")
      expect(entriesB).toHaveLength(1)
      expect(entriesB[0].event.content).toBe("from-B")
    })

    it("removeForTarget on one queue should not affect the other", async () => {
      const storage = new InMemoryStorageAdapter()
      const queueA = new MessageQueue(storage, "v1/message-queue/")
      const queueB = new MessageQueue(storage, "v1/discovery-queue/")

      await queueA.add("target-1", makeRumor("evt1"))
      await queueB.add("target-1", makeRumor("evt2"))

      await queueA.removeForTarget("target-1")

      expect(await queueA.getForTarget("target-1")).toEqual([])
      expect(await queueB.getForTarget("target-1")).toHaveLength(1)
    })
  })
})
