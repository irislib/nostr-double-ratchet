import { afterEach, describe, expect, it } from "vitest"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Filter,
  type VerifiedEvent,
} from "nostr-tools"
import { AppKeys } from "../src/AppKeys"
import { NdrRuntime } from "../src/NdrRuntime"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"

const runtimes: NdrRuntime[] = []

function createRuntime(
  storage = new InMemoryStorageAdapter(),
  filters: Filter[] = [],
): NdrRuntime {
  const runtime = new NdrRuntime({
    nostrSubscribe: (filter) => {
      filters.push(filter)
      return () => {}
    },
    nostrPublish: async (event) => event as VerifiedEvent,
    storage,
  })
  runtimes.push(runtime)
  return runtime
}

const publicKey = () => getPublicKey(generateSecretKey())

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
})

describe("known AppKeys snapshots", () => {
  it("applies and persists canonical peer snapshots through runtime routing", async () => {
    const storage = new InMemoryStorageAdapter()
    const ownerPubkey = publicKey()
    const peerPubkey = publicKey()
    const firstDevice = publicKey()
    const secondDevice = publicKey()
    const filters: Filter[] = []
    const runtime = createRuntime(storage, filters)
    await runtime.initForOwner(ownerPubkey)

    await expect(runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: new AppKeys([{ identityPubkey: firstDevice, createdAt: 10 }]),
      createdAt: 100,
    })).resolves.toBe("advanced")
    await expect(runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: new AppKeys([{ identityPubkey: secondDevice, createdAt: 20 }]),
      createdAt: 90,
    })).resolves.toBe("stale")
    await expect(runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: new AppKeys([{ identityPubkey: secondDevice, createdAt: 20 }]),
      createdAt: 100,
    })).resolves.toBe("merged_equal_timestamp")

    expect(runtime.getKnownDeviceIdentityPubkeysForOwner(peerPubkey)).toEqual(
      [firstDevice, secondDevice].sort(),
    )
    expect(filters.some((filter) => filter.authors?.includes(peerPubkey))).toBe(true)
    expect(filters.some((filter) => filter.authors?.includes(firstDevice))).toBe(true)
    expect(filters.some((filter) => filter.authors?.includes(secondDevice))).toBe(true)

    await expect(runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: new AppKeys([{ identityPubkey: secondDevice, createdAt: 20 }]),
      createdAt: 110,
    })).resolves.toBe("advanced")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.getKnownAppKeysSnapshots().find(
      (snapshot) => snapshot.ownerPubkey === peerPubkey,
    )).toMatchObject({ createdAt: 110 })
    expect(runtime.getKnownDeviceIdentityPubkeysForOwner(peerPubkey)).toEqual([secondDevice])

    runtime.close()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    const restarted = createRuntime(storage)
    await restarted.initForOwner(ownerPubkey)

    const restored = restarted.getKnownAppKeysSnapshots().find(
      (snapshot) => snapshot.ownerPubkey === peerPubkey,
    )
    expect(restored?.createdAt).toBe(110)
    expect(restored?.appKeys.getAllDevices()).toEqual([
      { identityPubkey: secondDevice, createdAt: 20 },
    ])
  })

  it("routes own snapshots through AppKeysManager without duplicating the owner", async () => {
    const ownerPubkey = publicKey()
    const device = publicKey()
    const runtime = createRuntime()
    await runtime.initForOwner(ownerPubkey)

    await expect(runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey,
      appKeys: new AppKeys([{ identityPubkey: device, createdAt: 10 }]),
      createdAt: 100,
    })).resolves.toBe("advanced")

    expect(runtime.getState()).toMatchObject({
      registeredDevices: [{ identityPubkey: device, createdAt: 10 }],
      lastAppKeysCreatedAt: 100,
    })
    expect(runtime.getKnownDeviceIdentityPubkeysForOwner(ownerPubkey)).toEqual([device])
    expect(runtime.getKnownAppKeysSnapshots().filter(
      (snapshot) => snapshot.ownerPubkey === ownerPubkey,
    )).toHaveLength(1)
  })

  it("preserves newer local labels on surviving own and peer devices", async () => {
    const ownerPubkey = publicKey()
    const peerPubkey = publicKey()
    const ownerDevice = publicKey()
    const peerDevice = publicKey()
    const runtime = createRuntime()
    await runtime.initForOwner(ownerPubkey)

    const ownWithLabels = new AppKeys([{ identityPubkey: ownerDevice, createdAt: 1 }])
    ownWithLabels.setDeviceLabels(ownerDevice, { deviceLabel: "My laptop" }, 50)
    const peerWithLabels = new AppKeys([{ identityPubkey: peerDevice, createdAt: 2 }])
    peerWithLabels.setDeviceLabels(peerDevice, { clientLabel: "Iris mobile" }, 60)

    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey,
      appKeys: ownWithLabels,
      createdAt: 100,
    })
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: peerWithLabels,
      createdAt: 100,
    })
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey,
      appKeys: new AppKeys([{ identityPubkey: ownerDevice, createdAt: 1 }]),
      createdAt: 101,
    })
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: new AppKeys([{ identityPubkey: peerDevice, createdAt: 2 }]),
      createdAt: 101,
    })

    const newerPeerLabels = new AppKeys([
      { identityPubkey: peerDevice, createdAt: 2 },
    ])
    newerPeerLabels.setDeviceLabels(
      peerDevice,
      { clientLabel: "Iris desktop" },
      70,
    )
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: newerPeerLabels,
      createdAt: 102,
    })

    expect(runtime.getAppKeysManager()?.getDeviceLabels(ownerDevice)).toEqual({
      deviceLabel: "My laptop",
      clientLabel: undefined,
      updatedAt: 50,
    })
    expect(runtime.getSessionUserRecords().get(peerPubkey)?.appKeys
      ?.getDeviceLabels(peerDevice)).toEqual({
        deviceLabel: undefined,
        clientLabel: "Iris desktop",
        updatedAt: 70,
      })
    expect(runtime.getKnownAppKeysSnapshots().every(
      (snapshot) => snapshot.appKeys.getAllDeviceLabels().length === 0,
    )).toBe(true)
  })

  it("treats pre-timestamp persisted peer rosters as created at zero", async () => {
    const storage = new InMemoryStorageAdapter()
    const ownerPubkey = publicKey()
    const peerPubkey = publicKey()
    const peerDevice = publicKey()
    await storage.put(`v1/user/${peerPubkey}`, {
      publicKey: peerPubkey,
      devices: [],
      appKeys: new AppKeys([
        { identityPubkey: peerDevice, createdAt: 10 },
      ]).serialize(),
    })

    const runtime = createRuntime(storage)
    await runtime.initForOwner(ownerPubkey)

    const restored = runtime.getKnownAppKeysSnapshots().find(
      (snapshot) => snapshot.ownerPubkey === peerPubkey,
    )
    expect(restored?.createdAt).toBe(0)
    expect(restored?.appKeys.getAllDevices()).toHaveLength(1)
  })

  it("does not recurse when a trusted import subscribes to a synchronous replay", async () => {
    const ownerPubkey = publicKey()
    const peerPrivateKey = generateSecretKey()
    const peerPubkey = getPublicKey(peerPrivateKey)
    const peerDevice = publicKey()
    const replay = finalizeEvent(
      new AppKeys([{ identityPubkey: peerDevice, createdAt: 10 }]).getEvent({
        ownerPrivateKey: peerPrivateKey,
        ownerPubkey: peerPubkey,
        createdAt: 100,
      }),
      peerPrivateKey,
    ) as VerifiedEvent
    const runtime = new NdrRuntime({
      nostrSubscribe: (filter, onEvent) => {
        if (filter.authors?.includes(peerPubkey)) onEvent(replay)
        return () => {}
      },
      nostrPublish: async (event) => event as VerifiedEvent,
    })
    runtimes.push(runtime)
    await runtime.initForOwner(ownerPubkey)

    await expect(runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: peerPubkey,
      appKeys: new AppKeys(),
      createdAt: 90,
    })).resolves.toBe("stale")
    expect(runtime.getKnownAppKeysSnapshots().find(
      (snapshot) => snapshot.ownerPubkey === peerPubkey,
    )?.createdAt).toBe(100)
  })
})
