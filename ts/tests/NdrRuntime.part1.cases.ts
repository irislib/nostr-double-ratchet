import { describe, expect, it, vi } from "vitest"
import {
  finalizeEvent,
  type Filter,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  type UnsignedEvent,
  type VerifiedEvent,
} from "nostr-tools"
import { AppKeys } from "../src/AppKeys"
import { NdrRuntime } from "../src/NdrRuntime"
import { InMemoryStorageAdapter, type StorageAdapter } from "../src/StorageAdapter"
import {
  CHAT_MESSAGE_KIND,
  INVITE_RESPONSE_KIND,
  type NostrPublish,
  type NostrSubscribe,
  type Rumor,
} from "../src/types"
import { MockRelay } from "./helpers/mockRelay"

const tick = async (ms = 0) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const createSubscribe = (relay: MockRelay): NostrSubscribe => {
  return (filter, onEvent) => relay.subscribe(filter, onEvent).close
}

const createRuntime = (options: {
  relay: MockRelay
  ownerPrivateKey?: Uint8Array
  storage?: StorageAdapter
  appKeysDelayMs?: number
  publishDelayMs?: number
  onPublish?: (
    event: UnsignedEvent | VerifiedEvent,
    innerEventId?: string,
  ) => void
}) => {
  const {
    relay,
    ownerPrivateKey,
    storage,
    appKeysDelayMs = 0,
    publishDelayMs = 0,
    onPublish,
  } = options
  const deliver = (event: VerifiedEvent, delayMs: number) => {
    if (delayMs > 0) {
      setTimeout(() => {
        relay.storeAndDeliver(event)
      }, delayMs)
      return
    }
    relay.storeAndDeliver(event)
  }
  const publish = (async (
    event: UnsignedEvent | VerifiedEvent,
    innerEventId?: string,
  ) => {
    onPublish?.(event, innerEventId)
    if ("sig" in event && event.sig) {
      deliver(event as VerifiedEvent, publishDelayMs)
      return event as VerifiedEvent
    }

    if (!ownerPrivateKey) {
      throw new Error("Cannot sign unsigned event without owner private key")
    }

    const signedEvent = finalizeEvent(event, ownerPrivateKey) as VerifiedEvent
    deliver(signedEvent, Math.max(appKeysDelayMs, publishDelayMs))
    return signedEvent
  }) as NostrPublish

  return new NdrRuntime({
    nostrSubscribe: createSubscribe(relay),
    nostrPublish: publish,
    storage,
    appKeysFastTimeoutMs: 25,
    appKeysFetchTimeoutMs: 50,
  })
}

describe("NdrRuntime", () => {



it("registers a first device without requiring relay confirmation", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const runtime = createRuntime({ relay, ownerPrivateKey })

    await runtime.initForOwner(ownerPubkey)

    const result = await runtime.registerCurrentDevice({ ownerPubkey })

    expect(result.relayConfirmationRequired).toBe(false)
    expect(runtime.getState().ownerPubkey).toBe(ownerPubkey)
    expect(runtime.getState().sessionManagerReady).toBe(true)
    expect(runtime.getState().isCurrentDeviceRegistered).toBe(true)
    expect(runtime.getState().registeredDevices).toHaveLength(1)

    const relaySnapshot = await AppKeys.waitFor(ownerPubkey, createSubscribe(relay), 25)
    expect(relaySnapshot?.getAllDevices()).toHaveLength(1)
    expect(relaySnapshot?.getAllDevices()[0]?.identityPubkey).toBe(
      runtime.getState().currentDevicePubkey
    )
  })

it("waits for relay-visible AppKeys when adding an additional device", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)

    const primaryRuntime = createRuntime({ relay, ownerPrivateKey })
    await primaryRuntime.initForOwner(ownerPubkey)
    await primaryRuntime.registerCurrentDevice({ ownerPubkey })

    const linkedRuntime = createRuntime({
      relay,
      ownerPrivateKey,
      appKeysDelayMs: 50,
    })
    await linkedRuntime.initForOwner(ownerPubkey)

    let resolved = false
    const registrationPromise = linkedRuntime
      .registerCurrentDevice({ ownerPubkey, timeoutMs: 500 })
      .then((result) => {
        resolved = true
        return result
      })

    await tick(20)
    expect(resolved).toBe(false)

    const result = await registrationPromise

    expect(result.relayConfirmationRequired).toBe(true)
    expect(linkedRuntime.getState().isCurrentDeviceRegistered).toBe(true)
    expect(linkedRuntime.getState().registeredDevices).toHaveLength(2)

    const relaySnapshot = await AppKeys.waitFor(ownerPubkey, createSubscribe(relay), 25)
    expect(relaySnapshot?.getAllDevices()).toHaveLength(2)
  })

it("waits for relay-visible AppKeys when registering a linked device identity", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const linkedPrivateKey = generateSecretKey()
    const linkedPubkey = getPublicKey(linkedPrivateKey)

    const primaryRuntime = createRuntime({ relay, ownerPrivateKey })
    await primaryRuntime.initForOwner(ownerPubkey)
    await primaryRuntime.registerCurrentDevice({ ownerPubkey })

    const ownerRuntime = createRuntime({
      relay,
      ownerPrivateKey,
      appKeysDelayMs: 50,
    })
    await ownerRuntime.initForOwner(ownerPubkey)

    let resolved = false
    const registrationPromise = ownerRuntime
      .registerDeviceIdentity({
        ownerPubkey,
        identityPubkey: linkedPubkey,
        timeoutMs: 500,
      })
      .then((result) => {
        resolved = true
        return result
      })

    await tick(20)
    expect(resolved).toBe(false)

    const result = await registrationPromise

    expect(result.relayConfirmationRequired).toBe(true)
    expect(ownerRuntime.getState().registeredDevices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identityPubkey: linkedPubkey }),
      ]),
    )

    const relaySnapshot = await AppKeys.waitFor(ownerPubkey, createSubscribe(relay), 25)
    expect(
      relaySnapshot
        ?.getAllDevices()
        .some((device) => device.identityPubkey === linkedPubkey),
    ).toBe(true)
  })

it("ignores stale AppKeys snapshots on the runtime subscription", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const runtime = createRuntime({ relay, ownerPrivateKey })

    await runtime.initAppKeysManager()
    runtime.startAppKeysSubscription(ownerPubkey)

    const latestAppKeys = new AppKeys([
      { identityPubkey: "device-a", createdAt: 100 },
    ])
    const latestEvent = latestAppKeys.getEvent({
      ownerPrivateKey,
      ownerPubkey,
      createdAt: 200,
    })
    relay.storeAndDeliver(finalizeEvent(latestEvent, ownerPrivateKey) as VerifiedEvent)
    await tick()

    expect(runtime.getState().registeredDevices).toEqual([
      { identityPubkey: "device-a", createdAt: 100 },
    ])
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(200)

    const staleAppKeys = new AppKeys([])
    const staleEvent = staleAppKeys.getEvent({
      ownerPrivateKey,
      ownerPubkey,
      createdAt: 150,
    })
    relay.storeAndDeliver(finalizeEvent(staleEvent, ownerPrivateKey) as VerifiedEvent)
    await tick()

    expect(runtime.getState().registeredDevices).toEqual([
      { identityPubkey: "device-a", createdAt: 100 },
    ])
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(200)
  })

it("feeds runtime AppKeys subscription events into the session core", async () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const appKeysCallbacks: Array<(event: VerifiedEvent) => void> = []
    const feedEvent = vi.fn(() => true)
    const runtime = new NdrRuntime({
      nostrSubscribe: (_filter, onEvent) => {
        appKeysCallbacks.push(onEvent)
        return () => {}
      },
      nostrPublish: async (event) => event as VerifiedEvent,
    })
    ;(runtime as unknown as {
      sessionManager: {
        feedEvent: (event: VerifiedEvent) => boolean
        getAllMessagePushAuthorPubkeys: () => string[]
        drainEvents: () => []
        hasPendingEvents: () => boolean
      }
    }).sessionManager = {
      feedEvent,
      getAllMessagePushAuthorPubkeys: () => [],
      drainEvents: () => [],
      hasPendingEvents: () => false,
    }

    runtime.startAppKeysSubscription(ownerPubkey)
    const event = finalizeEvent(
      {
        ...new AppKeys([{ identityPubkey: "device-a", createdAt: 100 }]).getEvent({
          ownerPrivateKey,
          ownerPubkey,
        }),
        created_at: 200,
      },
      ownerPrivateKey,
    ) as VerifiedEvent

    appKeysCallbacks[0]!(event)
    await tick()

    expect(runtime.getState().registeredDevices).toEqual([
      { identityPubkey: "device-a", createdAt: 100 },
    ])
    expect(feedEvent).toHaveBeenCalledWith(event)
  })

it("decrypts encrypted AppKeys labels from owner-key runtime subscriptions", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const device = { identityPubkey: getPublicKey(generateSecretKey()), createdAt: 100 }
    const runtime = new NdrRuntime({
      nostrSubscribe: createSubscribe(relay),
      nostrPublish: async (event) => event as VerifiedEvent,
      ownerIdentityKey: ownerPrivateKey,
    })

    await runtime.initAppKeysManager()
    runtime.startAppKeysSubscription(ownerPubkey)

    const appKeys = new AppKeys([device])
    appKeys.setDeviceLabels(device.identityPubkey, {
      deviceLabel: "Sirius MacBook",
      clientLabel: "NDR Desktop",
    })
    const event = appKeys.getEvent({
      ownerPrivateKey,
      ownerPubkey,
      createdAt: 200,
    })
    relay.storeAndDeliver(finalizeEvent(event, ownerPrivateKey) as VerifiedEvent)
    await tick()

    expect(
      runtime.getAppKeysManager()?.getDeviceLabels(device.identityPubkey)
    ).toEqual({
      deviceLabel: "Sirius MacBook",
      clientLabel: "NDR Desktop",
      updatedAt: expect.any(Number),
    })
  })

it("feeds local owner AppKeys into the session core before owner setup", async () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const feedEvent = vi.fn(() => true)
    const setupUser = vi.fn().mockResolvedValue(undefined)
    const runtime = new NdrRuntime({
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as VerifiedEvent,
      ownerIdentityKey: ownerPrivateKey,
    })
    await runtime.initAppKeysManager()
    await runtime.initDelegateManager()
    ;(runtime as unknown as {
      state: { ownerPubkey: string }
      sessionManager: {
        feedEvent: (event: VerifiedEvent) => boolean
        setupUser: (pubkey: string) => Promise<void>
        getAllMessagePushAuthorPubkeys: () => string[]
        drainEvents: () => []
        hasPendingEvents: () => boolean
      }
    }).state.ownerPubkey = ownerPubkey
    ;(runtime as unknown as {
      sessionManager: {
        feedEvent: (event: VerifiedEvent) => boolean
        setupUser: (pubkey: string) => Promise<void>
        getAllMessagePushAuthorPubkeys: () => string[]
        drainEvents: () => []
        hasPendingEvents: () => boolean
      }
    }).sessionManager = {
      feedEvent,
      setupUser,
      getAllMessagePushAuthorPubkeys: () => [],
      drainEvents: () => [],
      hasPendingEvents: () => false,
    }
    await runtime.publishPreparedRegistration({
      appKeys: new AppKeys([
        { identityPubkey: "device-a", createdAt: 100 },
        { identityPubkey: "device-b", createdAt: 101 },
      ]),
      devices: [
        { identityPubkey: "device-a", createdAt: 100 },
        { identityPubkey: "device-b", createdAt: 101 },
      ],
      baseDevices: [],
      newDeviceIdentity: "device-b",
    })
    feedEvent.mockClear()

    await runtime.setupUser(ownerPubkey)

    expect(setupUser).toHaveBeenCalledWith(ownerPubkey)
    const fedEvent = feedEvent.mock.calls[0]?.[0]
    expect(fedEvent?.pubkey).toBe(ownerPubkey)
    expect(AppKeys.fromEvent(fedEvent as VerifiedEvent).getAllDevices()).toHaveLength(2)
  })

it("preserves relay AppKeys timestamps when refreshing from relay", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const runtime = createRuntime({ relay, ownerPrivateKey })

    await runtime.initAppKeysManager()

    const oldAppKeys = new AppKeys([
      { identityPubkey: "device-a", createdAt: 100 },
    ])
    const oldEvent = oldAppKeys.getEvent({
      ownerPrivateKey,
      ownerPubkey,
      createdAt: 100,
    })
    relay.storeAndDeliver(finalizeEvent(oldEvent, ownerPrivateKey) as VerifiedEvent)

    await runtime.refreshOwnAppKeysFromRelay(ownerPubkey, 10)

    expect(runtime.getState().registeredDevices).toEqual([
      { identityPubkey: "device-a", createdAt: 100 },
    ])
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(100)

    runtime.startAppKeysSubscription(ownerPubkey)

    const newAppKeys = new AppKeys([
      { identityPubkey: "device-a", createdAt: 100 },
      { identityPubkey: "device-b", createdAt: 101 },
    ])
    const newEvent = newAppKeys.getEvent({
      ownerPrivateKey,
      ownerPubkey,
      createdAt: 101,
    })
    relay.storeAndDeliver(finalizeEvent(newEvent, ownerPrivateKey) as VerifiedEvent)
    await tick()

    expect(runtime.getState().registeredDevices).toEqual([
      { identityPubkey: "device-a", createdAt: 100 },
      { identityPubkey: "device-b", createdAt: 101 },
    ])
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(101)
  })

it("restores the same delegate identity and local AppKeys state after restart", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const storage = new InMemoryStorageAdapter()

    const firstRuntime = createRuntime({
      relay,
      ownerPrivateKey,
      storage,
    })
    await firstRuntime.initForOwner(ownerPubkey)
    await firstRuntime.registerCurrentDevice({ ownerPubkey })

    const firstDevicePubkey = firstRuntime.getState().currentDevicePubkey
    firstRuntime.close()

    const restartedRuntime = createRuntime({
      relay,
      ownerPrivateKey,
      storage,
    })
    await restartedRuntime.initForOwner(ownerPubkey)

    expect(restartedRuntime.getState().currentDevicePubkey).toBe(firstDevicePubkey)
    expect(restartedRuntime.getState().registeredDevices).toHaveLength(1)
    expect(restartedRuntime.getState().hasLocalAppKeys).toBe(true)
  })
});
