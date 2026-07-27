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
          drainEvents: () => []
          hasPendingEvents: () => boolean
        }
      }).sessionManager = {
        getAllMessagePushAuthorPubkeys: () => authors,
        feedEvent: () => true,
        drainEvents: () => [],
        hasPendingEvents: () => false,
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
});
