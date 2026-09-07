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

import { tick, createSubscribe, createRuntime } from "./helpers/runtime"

describe("NdrRuntime", () => {



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
});
