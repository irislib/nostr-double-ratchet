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
        pendingPublishes: () => []
      }
    }).sessionManager = {
      feedEvent,
      getAllMessagePushAuthorPubkeys: () => [],
      pendingPublishes: () => [],
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
        pendingPublishes: () => []
      }
    }).state.ownerPubkey = ownerPubkey
    ;(runtime as unknown as {
      sessionManager: {
        feedEvent: (event: VerifiedEvent) => boolean
        setupUser: (pubkey: string) => Promise<void>
        getAllMessagePushAuthorPubkeys: () => string[]
        pendingPublishes: () => []
      }
    }).sessionManager = {
      feedEvent,
      setupUser,
      getAllMessagePushAuthorPubkeys: () => [],
      pendingPublishes: () => [],
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

  it("replays the identical prepared event after publish failure and restart", async () => {
    const relay = new MockRelay()
    const aliceKey = generateSecretKey()
    const aliceOwner = getPublicKey(aliceKey)
    const aliceStorage = new InMemoryStorageAdapter()
    let failMessages = false
    const failed: VerifiedEvent[] = []
    const alice = createRuntime({
      relay,
      ownerPrivateKey: aliceKey,
      storage: aliceStorage,
      onPublish: (event, innerEventId) => {
        if (!failMessages || event.kind !== 1060 || !innerEventId) return
        failed.push(event as VerifiedEvent)
        throw new Error("relay offline")
      },
    })
    await alice.initForOwner(aliceOwner)
    await alice.registerCurrentDevice({ ownerPubkey: aliceOwner })
    await alice.republishInvite()

    const bobKey = generateSecretKey()
    const bobOwner = getPublicKey(bobKey)
    const bob = createRuntime({ relay, ownerPrivateKey: bobKey })
    await bob.initForOwner(bobOwner)
    await bob.registerCurrentDevice({ ownerPubkey: bobOwner })
    await bob.republishInvite()

    await alice.sendMessage(bobOwner, "establish")
    await bob.sendMessage(aliceOwner, "answer")
    failMessages = true
    await alice.sendMessage(bobOwner, "survive restart")
    await tick(20)

    expect(failed.length).toBeGreaterThan(0)
    const exactById = new Map(
      failed.map((event) => [event.id, JSON.stringify(event)])
    )
    alice.close()

    const replayed: VerifiedEvent[] = []
    const restarted = createRuntime({
      relay,
      ownerPrivateKey: aliceKey,
      storage: aliceStorage,
      onPublish: (event, innerEventId) => {
        if (event.kind === 1060 && innerEventId) replayed.push(event as VerifiedEvent)
      },
    })
    await restarted.initForOwner(aliceOwner)

    const replayedById = new Map(
      replayed.map((event) => [event.id, JSON.stringify(event)])
    )
    for (const [id, exact] of exactById) {
      expect(replayedById.get(id)).toBe(exact)
    }
  })

  it("routes direct messages through runtime-owned subscriptions", async () => {
    const relay = new MockRelay()

    const aliceOwnerPrivateKey = generateSecretKey()
    const aliceOwnerPubkey = getPublicKey(aliceOwnerPrivateKey)
    const aliceRuntime = createRuntime({
      relay,
      ownerPrivateKey: aliceOwnerPrivateKey,
    })
    await aliceRuntime.initForOwner(aliceOwnerPubkey)
    await aliceRuntime.registerCurrentDevice({ ownerPubkey: aliceOwnerPubkey })
    await aliceRuntime.republishInvite()

    const bobOwnerPrivateKey = generateSecretKey()
    const bobOwnerPubkey = getPublicKey(bobOwnerPrivateKey)
    const bobRuntime = createRuntime({
      relay,
      ownerPrivateKey: bobOwnerPrivateKey,
    })
    await bobRuntime.initForOwner(bobOwnerPubkey)
    await bobRuntime.registerCurrentDevice({ ownerPubkey: bobOwnerPubkey })
    await bobRuntime.republishInvite()

    const bobReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("bob did not receive alice message")), 5_000)
      const unsubscribe = bobRuntime.onSessionEvent((event) => {
        if (event.content !== "hello via runtime") return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await aliceRuntime.sendMessage(bobOwnerPubkey, "hello via runtime")
    await bobReceived

    expect(bobRuntime.getDirectMessageSubscriptionAuthors().length).toBeGreaterThan(0)

    const aliceReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("alice did not receive bob reply")), 5_000)
      const unsubscribe = aliceRuntime.onSessionEvent((event) => {
        if (event.content !== "reply via runtime") return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await bobRuntime.sendMessage(aliceOwnerPubkey, "reply via runtime")
    await aliceReceived
  })

  it("fresh same-nsec runtime sends into an existing peer chat and self-syncs to the old device", async () => {
    const relay = new MockRelay()

    const aliceOwnerPrivateKey = generateSecretKey()
    const aliceOwnerPubkey = getPublicKey(aliceOwnerPrivateKey)
    const aliceRuntime = createRuntime({
      relay,
      ownerPrivateKey: aliceOwnerPrivateKey,
    })
    await aliceRuntime.initForOwner(aliceOwnerPubkey)
    await aliceRuntime.registerCurrentDevice({ ownerPubkey: aliceOwnerPubkey })
    await aliceRuntime.republishInvite()

    const bobOwnerPrivateKey = generateSecretKey()
    const bobOwnerPubkey = getPublicKey(bobOwnerPrivateKey)
    const bobRuntime = createRuntime({
      relay,
      ownerPrivateKey: bobOwnerPrivateKey,
    })
    await bobRuntime.initForOwner(bobOwnerPubkey)
    await bobRuntime.registerCurrentDevice({ ownerPubkey: bobOwnerPubkey })
    await bobRuntime.republishInvite()

    const initialBobReceive = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("bob did not receive initial alice message")),
        5_000,
      )
      const unsubscribe = bobRuntime.onSessionEvent((event, from, meta) => {
        if (event.content !== "initial existing chat message") return
        expect(from).toBe(aliceOwnerPubkey)
        expect(meta?.isSelf).toBe(false)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await aliceRuntime.sendMessage(bobOwnerPubkey, "initial existing chat message")
    await initialBobReceive

    const initialAliceReceive = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("alice did not receive bob's initial reply")),
        5_000,
      )
      const unsubscribe = aliceRuntime.onSessionEvent((event, from, meta) => {
        if (event.content !== "initial bob reply") return
        expect(from).toBe(bobOwnerPubkey)
        expect(meta?.isSelf).toBe(false)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await bobRuntime.sendMessage(aliceOwnerPubkey, "initial bob reply")
    await initialAliceReceive

    const freshAliceRuntime = createRuntime({
      relay,
      ownerPrivateKey: aliceOwnerPrivateKey,
    })
    await freshAliceRuntime.initForOwner(aliceOwnerPubkey)
    await freshAliceRuntime.registerCurrentDevice({
      ownerPubkey: aliceOwnerPubkey,
      timeoutMs: 500,
    })
    await freshAliceRuntime.republishInvite()

    await Promise.all([
      aliceRuntime.setupUser(aliceOwnerPubkey),
      freshAliceRuntime.setupUser(aliceOwnerPubkey),
      freshAliceRuntime.setupUser(bobOwnerPubkey),
      bobRuntime.setupUser(aliceOwnerPubkey),
    ])

    const freshAliceDevicePubkey = freshAliceRuntime.getState().currentDevicePubkey
    if (!freshAliceDevicePubkey) {
      throw new Error("fresh alice device pubkey missing")
    }
    const oldAliceDevicePubkey = aliceRuntime.getState().currentDevicePubkey
    if (!oldAliceDevicePubkey) {
      throw new Error("old alice device pubkey missing")
    }
    const expectedAliceDevices = [
      oldAliceDevicePubkey,
      freshAliceDevicePubkey,
    ].sort()
    expect(
      freshAliceRuntime.getKnownDeviceIdentityPubkeysForOwner(aliceOwnerPubkey),
    ).toEqual(expectedAliceDevices)
    expect(
      bobRuntime.getKnownDeviceIdentityPubkeysForOwner(aliceOwnerPubkey),
    ).toEqual(expectedAliceDevices)

    const message = "fresh same nsec existing chat send"
    const bobReceivedFreshSend = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("bob did not receive fresh same-nsec send")),
        5_000,
      )
      const unsubscribe = bobRuntime.onSessionEvent((event, from, meta) => {
        if (event.content !== message) return
        expect(from).toBe(aliceOwnerPubkey)
        expect(event.pubkey).toBe(freshAliceDevicePubkey)
        expect(meta?.senderOwnerPubkey).toBe(aliceOwnerPubkey)
        expect(meta?.senderDevicePubkey).toBe(freshAliceDevicePubkey)
        expect(meta?.isSelf).toBe(false)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    const oldAliceReceivedSenderCopy = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("old alice device did not receive fresh-device sender copy")),
        5_000,
      )
      const unsubscribe = aliceRuntime.onSessionEvent((event, from, meta) => {
        if (event.content !== message) return
        expect(from).toBe(aliceOwnerPubkey)
        expect(event.pubkey).toBe(freshAliceDevicePubkey)
        expect(meta?.isCrossDeviceSelf).toBe(true)
        expect(
          event.tags.some((tag) => tag[0] === "p" && tag[1] === bobOwnerPubkey),
        ).toBe(true)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await freshAliceRuntime.sendMessage(bobOwnerPubkey, message)
    await Promise.all([bobReceivedFreshSend, oldAliceReceivedSenderCopy])
  })

  it("delivers owner messages to a linked runtime after link invite registration", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)

    const ownerRuntime = createRuntime({ relay, ownerPrivateKey })
    await ownerRuntime.initForOwner(ownerPubkey)
    await ownerRuntime.registerCurrentDevice({ ownerPubkey })
    await ownerRuntime.republishInvite()

    const linkedRuntime = createRuntime({ relay })
    await linkedRuntime.initDelegateManager()
    const linkInvite = await linkedRuntime.createLinkInvite(ownerPubkey)
    await linkedRuntime.republishInvite()

    await ownerRuntime.acceptLinkInvite(linkInvite, ownerPubkey)
    await ownerRuntime.registerDeviceIdentity({
      ownerPubkey,
      identityPubkey: linkInvite.inviter,
    })

    await linkedRuntime.initForOwner(ownerPubkey)

    const linkedReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("linked runtime did not receive owner message")),
        5_000,
      )
      const unsubscribe = linkedRuntime.onSessionEvent((event, from, meta) => {
        if (event.content !== "hello linked runtime") return
        expect(from).toBe(ownerPubkey)
        expect(meta?.isCrossDeviceSelf).toBe(true)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await ownerRuntime.sendMessage(ownerPubkey, "hello linked runtime")
    await linkedReceived
  })

  it("fans out same-owner messages across three registered runtimes", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)

    const firstRuntime = createRuntime({ relay, ownerPrivateKey })
    const secondRuntime = createRuntime({ relay, ownerPrivateKey })
    const thirdRuntime = createRuntime({ relay, ownerPrivateKey })

    await firstRuntime.initForOwner(ownerPubkey)
    await firstRuntime.republishInvite()
    await firstRuntime.registerCurrentDevice({ ownerPubkey })
    await secondRuntime.initForOwner(ownerPubkey)
    await secondRuntime.republishInvite()
    await secondRuntime.registerCurrentDevice({ ownerPubkey, timeoutMs: 500 })
    await thirdRuntime.initForOwner(ownerPubkey)
    await thirdRuntime.republishInvite()
    await thirdRuntime.registerCurrentDevice({ ownerPubkey, timeoutMs: 500 })

    await Promise.all([
      firstRuntime.refreshOwnAppKeysFromRelay(ownerPubkey, 50),
      secondRuntime.refreshOwnAppKeysFromRelay(ownerPubkey, 50),
      thirdRuntime.refreshOwnAppKeysFromRelay(ownerPubkey, 50),
    ])
    await Promise.all([
      firstRuntime.setupUser(ownerPubkey),
      secondRuntime.setupUser(ownerPubkey),
      thirdRuntime.setupUser(ownerPubkey),
    ])
    const receivedBySecond = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("second runtime did not receive owner message")),
        1000,
      )
      const unsubscribe = secondRuntime.onSessionEvent((event) => {
        if (event.content !== "hello three owner runtimes") return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })
    const receivedByThird = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("third runtime did not receive owner message")),
        1000,
      )
      const unsubscribe = thirdRuntime.onSessionEvent((event) => {
        if (event.content !== "hello three owner runtimes") return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await firstRuntime.sendMessage(ownerPubkey, "hello three owner runtimes")
    await Promise.all([receivedBySecond, receivedByThird])
  })

  it("deduplicates concurrent link invite accepts before linked-device fanout", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)

    const ownerRuntime = createRuntime({ relay, ownerPrivateKey })
    await ownerRuntime.initForOwner(ownerPubkey)
    await ownerRuntime.registerCurrentDevice({ ownerPubkey })
    await ownerRuntime.republishInvite()

    const linkedRuntime = createRuntime({ relay })
    await linkedRuntime.initDelegateManager()
    const linkInvite = await linkedRuntime.createLinkInvite(ownerPubkey)
    await linkedRuntime.republishInvite()

    const [firstAccept, secondAccept] = await Promise.all([
      ownerRuntime.acceptLinkInvite(linkInvite, ownerPubkey),
      ownerRuntime.acceptLinkInvite(linkInvite, ownerPubkey),
    ])

    expect(secondAccept.session).toBe(firstAccept.session)
    expect(
      relay.getAllEvents().filter((event) => event.kind === INVITE_RESPONSE_KIND),
    ).toHaveLength(1)

    const ownerDevicePubkey = ownerRuntime.getState().currentDevicePubkey
    if (!ownerDevicePubkey) {
      throw new Error("owner device pubkey missing")
    }
    const staleAppKeys = new AppKeys([
      {
        identityPubkey: ownerDevicePubkey,
        createdAt: Math.floor(Date.now() / 1000),
      },
    ])
    ownerRuntime.feedEvent(
      finalizeEvent(
        {
          ...staleAppKeys.getEvent({
            ownerPrivateKey,
            ownerPubkey: getPublicKey(ownerPrivateKey),
          }),
          created_at: Math.floor(Date.now() / 1000) + 10,
        },
        ownerPrivateKey,
      ) as VerifiedEvent,
    )
    await tick()

    const ownerRecord = ownerRuntime
      .getSessionUserRecords()
      .get(ownerPubkey) as any
    expect(ownerRecord?.devices.get(linkInvite.inviter)?.activeSession).toBeTruthy()

    await ownerRuntime.registerDeviceIdentity({
      ownerPubkey,
      identityPubkey: linkInvite.inviter,
      timeoutMs: 500,
    })

    await linkedRuntime.initForOwner(ownerPubkey)

    const message = "hello after deduped link"
    const linkedReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("linked runtime did not receive deduped-link message")),
        5_000,
      )
      const unsubscribe = linkedRuntime.onSessionEvent((event, from, meta) => {
        if (event.content !== message) return
        expect(from).toBe(ownerPubkey)
        expect(meta?.isCrossDeviceSelf).toBe(true)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await ownerRuntime.sendMessage(ownerPubkey, message)
    await linkedReceived
  })

  it("flushes queued runtime sends after async peer discovery and linked-device fanout", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)

    const ownerRuntime = createRuntime({
      relay,
      ownerPrivateKey,
      publishDelayMs: 10,
    })
    await ownerRuntime.initForOwner(ownerPubkey)
    await ownerRuntime.registerCurrentDevice({ ownerPubkey })
    await ownerRuntime.republishInvite()

    const linkedRuntime = createRuntime({ relay, publishDelayMs: 10 })
    await linkedRuntime.initDelegateManager()
    const linkInvite = await linkedRuntime.createLinkInvite(ownerPubkey)
    await linkedRuntime.republishInvite()

    await ownerRuntime.acceptLinkInvite(linkInvite, ownerPubkey)
    await ownerRuntime.registerDeviceIdentity({
      ownerPubkey,
      identityPubkey: linkInvite.inviter,
      timeoutMs: 500,
    })
    await linkedRuntime.initForOwner(ownerPubkey)

    const peerPrivateKey = generateSecretKey()
    const peerPubkey = getPublicKey(peerPrivateKey)
    const peerRuntime = createRuntime({
      relay,
      ownerPrivateKey: peerPrivateKey,
      publishDelayMs: 10,
    })
    await peerRuntime.initForOwner(peerPubkey)

    const message = "queued async runtime hello"
    const ownerDevicePubkey = ownerRuntime.getState().currentDevicePubkey
    const linkedReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("linked runtime did not receive queued owner send")),
        5_000,
      )
      const unsubscribe = linkedRuntime.onSessionEvent((event, from) => {
        if (event.content !== message) return
        expect([ownerPubkey, peerPubkey]).toContain(from)
        expect(event.pubkey).toBe(ownerDevicePubkey)
        expect(
          event.tags.some((tag) => tag[0] === "p" && tag[1] === peerPubkey),
        ).toBe(true)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    const peerReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("peer runtime did not receive queued owner send")),
        5_000,
      )
      const unsubscribe = peerRuntime.onSessionEvent((event, from) => {
        if (event.content !== message) return
        expect(from).toBe(ownerPubkey)
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    const sendPromise = ownerRuntime.sendMessage(peerPubkey, message)
    await tick(25)
    await peerRuntime.registerCurrentDevice({ ownerPubkey: peerPubkey })
    await peerRuntime.republishInvite()
    await sendPromise

    await Promise.all([linkedReceived, peerReceived])
  })

  it("fans out prebuilt runtime sendEvent rumors to linked devices", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)

    const ownerRuntime = createRuntime({ relay, ownerPrivateKey })
    await ownerRuntime.initForOwner(ownerPubkey)
    await ownerRuntime.registerCurrentDevice({ ownerPubkey })
    await ownerRuntime.republishInvite()

    const linkedRuntime = createRuntime({ relay })
    await linkedRuntime.initDelegateManager()
    const linkInvite = await linkedRuntime.createLinkInvite(ownerPubkey)
    await linkedRuntime.republishInvite()

    await ownerRuntime.acceptLinkInvite(linkInvite, ownerPubkey)
    await ownerRuntime.registerDeviceIdentity({
      ownerPubkey,
      identityPubkey: linkInvite.inviter,
      timeoutMs: 500,
    })
    await linkedRuntime.initForOwner(ownerPubkey)

    const peerPrivateKey = generateSecretKey()
    const peerPubkey = getPublicKey(peerPrivateKey)
    const peerRuntime = createRuntime({ relay, ownerPrivateKey: peerPrivateKey })
    await peerRuntime.initForOwner(peerPubkey)
    await peerRuntime.registerCurrentDevice({ ownerPubkey: peerPubkey })
    await peerRuntime.republishInvite()
    const publishedInnerEventIds: Array<string | undefined> = []
    const originalPublish = (ownerRuntime as unknown as {
      nostrPublish: NostrPublish
    }).nostrPublish
    ;(ownerRuntime as unknown as {
      nostrPublish: NostrPublish
    }).nostrPublish = async (event, innerEventId) => {
      publishedInnerEventIds.push(innerEventId)
      return originalPublish(event, innerEventId)
    }

    const message = "prebuilt runtime hello"
    const ownerDevicePubkey = ownerRuntime.getState().currentDevicePubkey
    if (!ownerDevicePubkey) {
      throw new Error("owner device pubkey missing")
    }
    const now = Date.now()
    const rumor: Rumor = {
      content: message,
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(now / 1000),
      tags: [["p", peerPubkey], ["ms", String(now)]],
      pubkey: ownerDevicePubkey,
      id: "",
    }
    rumor.id = getEventHash(rumor)

    const linkedReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("linked runtime did not receive prebuilt sendEvent")),
        5_000,
      )
      const unsubscribe = linkedRuntime.onSessionEvent((event) => {
        if (event.content !== message) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    const peerReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("peer runtime did not receive prebuilt sendEvent")),
        5_000,
      )
      const unsubscribe = peerRuntime.onSessionEvent((event) => {
        if (event.content !== message) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })

    await ownerRuntime.sendEvent(peerPubkey, rumor)

    await Promise.all([linkedReceived, peerReceived])
    expect(publishedInnerEventIds).toContain(rumor.id)
  })

  it("subscribes newly added direct-message authors without waiting for the throttle", () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    try {
      const firstAuthor = "a".repeat(64)
      const secondAuthor = "b".repeat(64)
      let authors = [firstAuthor]
      const filters: Filter[] = []
      const unsubscribed: Filter[] = []
      const runtime = new NdrRuntime({
        nostrSubscribe: (filter) => {
          filters.push(filter)
          return () => {
            unsubscribed.push(filter)
          }
        },
        nostrPublish: async (event) => event as VerifiedEvent,
      })
      ;(runtime as unknown as {
        sessionManager: {
          getAllMessagePushAuthorPubkeys: () => string[]
          feedEvent: () => boolean
          pendingPublishes: () => []
        }
      }).sessionManager = {
        getAllMessagePushAuthorPubkeys: () => authors,
        feedEvent: () => true,
        pendingPublishes: () => [],
      }
      const event = {
        id: "event",
        pubkey: firstAuthor,
        created_at: 1,
        kind: 1060,
        tags: [],
        content: "",
        sig: "sig",
      } as VerifiedEvent

      runtime.processReceivedEvent(event)
      expect(runtime.getDirectMessageSubscriptionAuthors()).toEqual([firstAuthor])
      expect(filters.at(-1)?.authors).toEqual([firstAuthor])

      authors = [firstAuthor, secondAuthor]
      runtime.processReceivedEvent(event)
      expect(runtime.getDirectMessageSubscriptionAuthors()).toEqual([
        firstAuthor,
        secondAuthor,
      ])
      expect(filters.at(-1)?.authors).toEqual([firstAuthor, secondAuthor])
      expect(unsubscribed).toHaveLength(1)

      authors = [secondAuthor]
      runtime.processReceivedEvent(event)
      expect(runtime.getDirectMessageSubscriptionAuthors()).toEqual([
        firstAuthor,
        secondAuthor,
      ])

      vi.advanceTimersByTime(1500)

      expect(runtime.getDirectMessageSubscriptionAuthors()).toEqual([secondAuthor])
      expect(filters.at(-1)?.authors).toEqual([secondAuthor])
    } finally {
      vi.useRealTimers()
    }
  })

  it("exposes session user records through the runtime boundary", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const runtime = createRuntime({ relay, ownerPrivateKey })

    await runtime.initForOwner(ownerPubkey)
    await runtime.setupUser(ownerPubkey)

    expect(runtime.getSessionUserRecords().has(ownerPubkey)).toBe(true)
  })

  it("owns group transport alongside sessions on the high-level runtime path", async () => {
    const relay = new MockRelay()
    const publishedInnerEventIds: Array<string | undefined> = []

    const aliceOwnerPrivateKey = generateSecretKey()
    const aliceOwnerPubkey = getPublicKey(aliceOwnerPrivateKey)
    const aliceRuntime = createRuntime({
      relay,
      ownerPrivateKey: aliceOwnerPrivateKey,
      onPublish: (_event, innerEventId) => {
        publishedInnerEventIds.push(innerEventId)
      },
    })
    await aliceRuntime.initForOwner(aliceOwnerPubkey)
    await aliceRuntime.registerCurrentDevice({ ownerPubkey: aliceOwnerPubkey })

    const bobOwnerPrivateKey = generateSecretKey()
    const bobOwnerPubkey = getPublicKey(bobOwnerPrivateKey)
    const bobRuntime = createRuntime({
      relay,
      ownerPrivateKey: bobOwnerPrivateKey,
    })
    await bobRuntime.initForOwner(bobOwnerPubkey)
    await bobRuntime.registerCurrentDevice({ ownerPubkey: bobOwnerPubkey })

    await aliceRuntime.waitForSessionManager(aliceOwnerPubkey).then((manager) => {
      return manager.setupUser(bobOwnerPubkey)
    })
    await bobRuntime.waitForSessionManager(bobOwnerPubkey).then((manager) => {
      return manager.setupUser(aliceOwnerPubkey)
    })

    const created = await aliceRuntime.createGroup("Runtime Group", [bobOwnerPubkey], {
      fanoutMetadata: false,
    })
    await bobRuntime.syncGroups([created.group], bobOwnerPubkey)
    const sent = await aliceRuntime.sendGroupMessage(created.group.id, "hello group")
    await tick()

    expect(aliceRuntime.getState().groupManagerReady).toBe(true)
    expect(bobRuntime.getState().groupManagerReady).toBe(true)
    expect(aliceRuntime.getGroupManager()?.managedGroupIds()).toContain(created.group.id)
    expect(bobRuntime.getGroupManager()?.managedGroupIds()).toContain(created.group.id)
    expect(sent.inner.content).toBe("hello group")
    expect(sent.inner.kind).toBe(14)
    expect(sent.inner.tags).toContainEqual(["l", created.group.id])
    expect(publishedInnerEventIds).toContain(sent.inner.id)
    expect(aliceRuntime.getGroupManager()?.knownSenderEventPubkeys().length).toBeGreaterThan(0)

    await bobRuntime.syncGroups([], bobOwnerPubkey)
    expect(bobRuntime.getGroupManager()?.managedGroupIds()).not.toContain(created.group.id)
    expect(relay.getAllEvents().length).toBeGreaterThanOrEqual(2)
  })

  it("exposes direct-message helper wrappers on the runtime surface", async () => {
    const relay = new MockRelay()
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    const runtime = createRuntime({
      relay,
      ownerPrivateKey,
    })
    await runtime.initForOwner(ownerPubkey)

    const manager = await runtime.waitForSessionManager(ownerPubkey)
    const sendEventRumor = {
      id: "reaction-id",
      pubkey: ownerPubkey,
      kind: 7,
      content: "🔥",
      created_at: 1,
      tags: [["e", "message-id"]],
    }
    const sendMessageRumor = {
      id: "message-id",
      pubkey: ownerPubkey,
      kind: 14,
      content: "hello runtime",
      created_at: 1,
      tags: [["p", "peer"]],
    }
    const sendTypingRumor = {
      id: "typing-id",
      pubkey: ownerPubkey,
      kind: 25,
      content: "typing",
      created_at: 1,
      tags: [["p", "peer"]],
    }
    const sendReceiptRumor = {
      id: "receipt-id",
      pubkey: ownerPubkey,
      kind: 15,
      content: "seen",
      created_at: 1,
      tags: [["e", "message-id"]],
    }

    const setupUserSpy = vi.spyOn(manager, "setupUser").mockResolvedValue()
    const sendEventSpy = vi
      .spyOn(manager, "sendEvent")
      .mockResolvedValue(sendEventRumor)
    const sendMessageSpy = vi
      .spyOn(manager, "sendMessage")
      .mockResolvedValue(sendMessageRumor)
    const sendTypingSpy = vi
      .spyOn(manager, "sendTyping")
      .mockResolvedValue(sendTypingRumor)
    const sendReceiptSpy = vi
      .spyOn(manager, "sendReceipt")
      .mockResolvedValue(sendReceiptRumor)

    await runtime.setupUser("peer")
    expect(setupUserSpy).toHaveBeenCalledWith("peer")

    await expect(runtime.sendEvent("peer", sendEventRumor)).resolves.toBe(
      sendEventRumor,
    )
    expect(sendEventSpy).toHaveBeenCalledWith("peer", sendEventRumor)

    await expect(runtime.sendMessage("peer", "hello runtime")).resolves.toBe(
      sendMessageRumor,
    )
    expect(sendMessageSpy).toHaveBeenCalledWith("peer", "hello runtime", {})

    await expect(runtime.sendTyping("peer")).resolves.toBe(sendTypingRumor)
    expect(sendTypingSpy).toHaveBeenCalledWith("peer")

    await expect(
      runtime.sendReceipt("peer", "seen", ["message-id"]),
    ).resolves.toBe(sendReceiptRumor)
    expect(sendReceiptSpy).toHaveBeenCalledWith("peer", "seen", ["message-id"])
  })
})
