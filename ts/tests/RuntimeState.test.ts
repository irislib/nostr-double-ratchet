import { describe, expect, it } from "vitest"
import { finalizeEvent, generateSecretKey, type VerifiedEvent } from "nostr-tools"

import {
  OutboundIntentQueue,
  RuntimeState,
  type RuntimeSnapshotV2,
} from "../src/RuntimeState"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import type { Rumor } from "../src/types"

const rumor = (id: string): Rumor => ({
  id,
  pubkey: "a".repeat(64),
  created_at: 1,
  kind: 14,
  tags: [],
  content: id,
})

const signed = (content: string): VerifiedEvent =>
  finalizeEvent(
    { kind: 1060, created_at: 1, tags: [], content },
    generateSecretKey(),
  ) as VerifiedEvent

class FailableStorage extends InMemoryStorageAdapter {
  failNextPut = false

  override async put<T>(key: string, value: T): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error("injected snapshot failure")
    }
    await super.put(key, value)
  }
}

class BlockingPreparedStorage extends InMemoryStorageAdapter {
  captured?: RuntimeSnapshotV2
  private armed = false
  private releasePut!: () => void
  private markEntered!: () => void
  readonly entered = new Promise<void>((resolve) => {
    this.markEntered = resolve
  })
  private readonly released = new Promise<void>((resolve) => {
    this.releasePut = resolve
  })

  arm(): void {
    this.armed = true
  }

  release(): void {
    this.releasePut()
  }

  override async put<T>(key: string, value: T): Promise<void> {
    const snapshot = value as RuntimeSnapshotV2
    if (
      this.armed &&
      key === "v2/runtime-snapshot" &&
      snapshot.outbound.some((entry) => entry.type === "prepared")
    ) {
      this.armed = false
      this.captured = snapshot
      this.markEntered()
      await this.released
    }
    await super.put(key, value)
  }
}

describe("RuntimeState", () => {
  it("serializes concurrent intent transitions without losing entries", async () => {
    const state = new RuntimeState(new InMemoryStorageAdapter())
    await state.init()
    const queue = new OutboundIntentQueue(state, "device")

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        queue.add(`device-${index}`, rumor(`event-${index}`))
      )
    )

    expect(await queue.entries()).toHaveLength(20)
  })

  it("atomically replaces an intent with the exact prepared event", async () => {
    const storage = new InMemoryStorageAdapter()
    const state = new RuntimeState(storage)
    await state.init()
    const queue = new OutboundIntentQueue(state, "device")
    const inner = rumor("inner")
    const event = signed("ciphertext")
    const intentId = await queue.add("device", inner)

    await state.commitPreparedTransition(
      () => ({
        result: undefined,
        userRecords: [],
        publishes: [{ event, innerEventId: inner.id, intentId }],
      }),
      () => () => {},
    )

    expect(await queue.entries()).toEqual([])
    expect(state.preparedPublishes()).toEqual([
      expect.objectContaining({ id: event.id, event, innerEventId: inner.id }),
    ])
    const snapshot = await storage.get<RuntimeSnapshotV2>("v2/runtime-snapshot")
    expect(snapshot?.outbound).toEqual(state.preparedPublishes())
  })

  it("keeps the prior state when an atomic replacement fails", async () => {
    const storage = new FailableStorage()
    const state = new RuntimeState(storage)
    await state.init()
    storage.failNextPut = true

    await expect(
      state.addIntent("device", "device", rumor("inner"))
    ).rejects.toThrow("injected snapshot failure")
    expect(state.intents()).toEqual([])
  })

  it("replays a byte-identical prepared event after restart until ack", async () => {
    const storage = new InMemoryStorageAdapter()
    const first = new RuntimeState(storage)
    await first.init()
    const event = signed("exact")
    await first.commitPreparedTransition(
      () => ({
        result: undefined,
        userRecords: [],
        publishes: [{ event, innerEventId: "inner" }],
      }),
      () => () => {},
    )
    await first.publishFailed(event.id, "offline")

    const restarted = new RuntimeState(storage)
    await restarted.init()
    expect(restarted.preparedPublishes()[0]?.event).toEqual(event)
    expect(restarted.preparedPublishes()[0]?.attempts).toBe(1)

    await restarted.acknowledgePublish(event.id)
    const afterAck = new RuntimeState(storage)
    await afterAck.init()
    expect(afterAck.preparedPublishes()).toEqual([])
  })

  it("serializes ratchet mutation before capturing each prepared snapshot", async () => {
    const storage = new BlockingPreparedStorage()
    const state = new RuntimeState(storage)
    await state.init()
    storage.arm()
    let secondMutated = false
    const firstEvent = signed("first")
    const secondEvent = signed("second")

    const first = state.commitPreparedTransition(
      () => ({
        result: undefined,
        userRecords: [{ publicKey: "after-first", devices: [] }],
        publishes: [{ event: firstEvent }],
      }),
      () => () => {},
    )
    await storage.entered
    const second = state.commitPreparedTransition(
      () => {
        secondMutated = true
        return {
          result: undefined,
          userRecords: [{ publicKey: "after-second", devices: [] }],
          publishes: [{ event: secondEvent }],
        }
      },
      () => () => {},
    )

    await Promise.resolve()
    expect(secondMutated).toBe(false)
    expect(storage.captured?.userRecords).toEqual([
      { publicKey: "after-first", devices: [] },
    ])
    expect(storage.captured?.outbound).toEqual([
      expect.objectContaining({ id: firstEvent.id }),
    ])

    storage.release()
    await Promise.all([first, second])
    expect(secondMutated).toBe(true)
    expect(state.preparedPublishes().map(({ id }) => id)).toEqual([
      firstEvent.id,
      secondEvent.id,
    ])
  })

  it("captures rollback state inside the transition queue", async () => {
    const storage = new BlockingPreparedStorage()
    const state = new RuntimeState(storage)
    await state.init()
    storage.arm()
    let ratchet = "initial"

    const first = state.commitPreparedTransition(
      () => {
        ratchet = "after-first"
        return {
          result: undefined,
          userRecords: [],
          publishes: [{ event: signed("first") }],
        }
      },
      () => () => {
        ratchet = "initial"
      },
    )
    await storage.entered

    const second = state.commitPreparedTransition(
      () => {
        ratchet = "after-second"
        throw new Error("injected mutation failure")
      },
      () => {
        const before = ratchet
        return () => {
          ratchet = before
        }
      },
    )

    storage.release()
    await first
    await expect(second).rejects.toThrow("injected mutation failure")
    expect(ratchet).toBe("after-first")
  })

  it("migrates v1 records and both intent queues before deleting legacy keys", async () => {
    const storage = new InMemoryStorageAdapter()
    const user = { publicKey: "owner", devices: [] }
    const deviceIntent = {
      id: "event/device",
      targetKey: "device",
      event: rumor("event"),
      createdAt: 10,
    }
    const ownerIntent = {
      id: "event/owner",
      targetKey: "owner",
      event: rumor("event"),
      createdAt: 9,
    }
    await storage.put("v1/user/owner", user)
    await storage.put("v1/message-queue/event/device", deviceIntent)
    await storage.put("v1/discovery-queue/event/owner", ownerIntent)

    const state = new RuntimeState(storage)
    await state.init()

    expect(state.userRecords()).toEqual([user])
    expect(state.intents().map(({ stage }) => stage).sort()).toEqual([
      "device",
      "discovery",
    ])
    expect(await storage.list("v1/user/")).toEqual([])
    expect(await storage.list("v1/message-queue/")).toEqual([])
    expect(await storage.list("v1/discovery-queue/")).toEqual([])
  })

  it("fails closed on corrupt or future canonical snapshots", async () => {
    for (const snapshot of [
      { version: 3 },
      { version: 2, outbound: null },
      { version: 2, userRecords: [{ publicKey: "owner" }], outbound: [] },
      {
        version: 2,
        userRecords: [],
        outbound: [{ type: "prepared", id: "event", createdAt: 1 }],
      },
    ]) {
      const storage = new InMemoryStorageAdapter()
      await storage.put("v2/runtime-snapshot", snapshot)
      await expect(new RuntimeState(storage).init()).rejects.toThrow(
        "Unsupported or corrupt NDR runtime snapshot"
      )
    }
  })
})
