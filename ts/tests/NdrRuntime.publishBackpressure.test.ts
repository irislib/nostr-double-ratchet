import { expect, it, vi } from "vitest"
import { finalizeEvent, generateSecretKey, getPublicKey, type Filter } from "nostr-tools"
import { NdrRuntime } from "../src/NdrRuntime"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { MessageQueue } from "../src/MessageQueue"
import { type SessionManagerEvent } from "../src/SessionManager"
import { APP_KEYS_EVENT_KIND } from "../src/types"
import { MockRelay } from "./helpers/mockRelay"

it.each(["resolves", "rejects"])("keeps receiving and discovering peers before a publish acknowledgement %s", async (outcome) => {
  const relay = new MockRelay()
  let acknowledge!: () => void
  let rejectAcknowledgement!: (error: Error) => void
  const acknowledgement = new Promise<void>((resolve, reject) => {
    acknowledge = resolve
    rejectAcknowledgement = reject
  })
  let holdAcknowledgement = false
  let awaitingAcknowledgement = false
  const failures = vi.fn()
  const subscriptions: Filter[] = []
  const createParticipant = () => {
    const privateKey = generateSecretKey()
    const owner = getPublicKey(privateKey)
    const runtime = new NdrRuntime({
      nostrSubscribe: (filter, onEvent) => {
        subscriptions.push(filter)
        return relay.subscribe(filter, onEvent).close
      },
      nostrPublish: async (event, innerEventId) => {
        const signed = "sig" in event ? event : finalizeEvent(event, privateKey)
        relay.storeAndDeliver(signed)
        if (runtime === alice.runtime && holdAcknowledgement && innerEventId) {
          awaitingAcknowledgement = true
          await acknowledgement
        }
        return signed
      },
      appKeysFastTimeoutMs: 1,
      appKeysFetchTimeoutMs: 1,
      onPublishError: failures,
    })
    const received: string[] = []
    runtime.onSessionEvent((event) => { received.push(event.content) })
    return { owner, runtime, received }
  }
  const alice = createParticipant()
  const bob = createParticipant()
  let send: Promise<unknown> | undefined
  let setup: Promise<unknown> | undefined
  try {
    for (const participant of [alice, bob]) {
      await participant.runtime.initForOwner(participant.owner)
      await participant.runtime.registerCurrentDevice({ ownerPubkey: participant.owner })
      await participant.runtime.republishInvite()
    }
    await alice.runtime.sendMessage(bob.owner, "warmup")
    await bob.runtime.sendMessage(alice.owner, "ready")
    await vi.waitFor(() => expect(alice.received).toContain("ready"))

    holdAcknowledgement = true
    send = alice.runtime.sendMessage(bob.owner, "pending acknowledgement")
    await vi.waitFor(() => expect(bob.received).toContain("pending acknowledgement"))
    await vi.waitFor(() => expect(awaitingAcknowledgement).toBe(true))

    const peer = getPublicKey(generateSecretKey())
    let setupSettled = false
    setup = alice.runtime.setupUser(peer).finally(() => { setupSettled = true })
    await bob.runtime.sendMessage(alice.owner, "reply before acknowledgement")
    await vi.waitFor(() => {
      expect(alice.received).toContain("reply before acknowledgement")
      expect(subscriptions.some((filter) =>
        filter.kinds?.includes(APP_KEYS_EVENT_KIND) && filter.authors?.includes(peer),
      )).toBe(true)
    }, { timeout: 250, interval: 5 })
    expect(setupSettled).toBe(true)
    await Promise.all([send, setup])

    if (outcome === "rejects") {
      const error = new Error("relay rejected publish")
      rejectAcknowledgement(error)
      await vi.waitFor(() => expect(failures).toHaveBeenCalledWith(
        expect.objectContaining({ error }),
      ))
    } else {
      acknowledge()
      await Promise.all([send, setup])
    }
    expect(setupSettled).toBe(true)
  } finally {
    acknowledge()
    await Promise.allSettled([send, setup])
    alice.runtime.close()
    bob.runtime.close()
  }
})

it("awaits durable handoffs emitted by synchronous subscription callbacks", async () => {
  class Runtime extends NdrRuntime {
    flush() { return this.flushSessionManagerEvents() }
  }
  const secret = generateSecretKey()
  const owner = getPublicKey(secret)
  const event = finalizeEvent({ kind: 1, pubkey: owner, created_at: 1, content: "test", tags: [] }, secret)
  let acknowledge!: () => void
  const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve })
  let publishStarted = false
  let emitter!: { emitEvent(event: SessionManagerEvent): Promise<void> }
  const runtime = new Runtime({
    nostrSubscribe: (filter) => {
      if (filter.kinds?.includes(123)) {
        void emitter.emitEvent({ type: "publish", event })
      }
      return () => {}
    },
    nostrEnqueue: async (published) => {
      if (published.id !== event.id) return
      publishStarted = true
      await acknowledgement
    },
    nostrPublish: async () => event,
    appKeysFastTimeoutMs: 1,
    appKeysFetchTimeoutMs: 1,
  })
  let flushed: Promise<void> | undefined
  try {
    await runtime.initForOwner(owner)
    emitter = runtime.getSessionManager() as unknown as typeof emitter
    void emitter.emitEvent({ type: "subscribe", subid: "cached-replay", filter: { kinds: [123] } })
    let finished = false
    flushed = runtime.flush().then(() => { finished = true })
    await vi.waitFor(() => expect(publishStarted).toBe(true))
    expect(finished).toBe(false)
    acknowledge()
    await flushed
    expect(finished).toBe(true)
  } finally {
    acknowledge()
    await flushed
    runtime.close()
  }
})

it("initializes, registers, sends direct and group messages while every relay ACK remains pending", async () => {
  const relay = new MockRelay()
  const createParticipant = () => {
    const secret = generateSecretKey()
    const owner = getPublicKey(secret)
    const enqueued: string[] = []
    const runtime = new NdrRuntime({
      nostrSubscribe: (filter, onEvent) => relay.subscribe(filter, onEvent).close,
      nostrSign: async (event) => finalizeEvent(event, secret),
      nostrEnqueue: async (event) => { enqueued.push(event.id) },
      nostrPublish: async (event) => {
        expect(enqueued).toContain((event as { id: string }).id)
        relay.storeAndDeliver(event as ReturnType<typeof finalizeEvent>)
        return new Promise<never>(() => {})
      },
      appKeysFastTimeoutMs: 1,
      appKeysFetchTimeoutMs: 1,
    })
    const received: string[] = []
    runtime.onSessionEvent((event) => { received.push(event.content) })
    return { runtime, owner, received }
  }
  const alice = createParticipant()
  const bob = createParticipant()
  try {
    for (const participant of [alice, bob]) {
      await participant.runtime.initForOwner(participant.owner)
      const registration = await participant.runtime.registerCurrentDevice({ ownerPubkey: participant.owner })
      expect(registration.relayConfirmationRequired).toBe(false)
      await participant.runtime.republishInvite()
    }
    const sent = await alice.runtime.sendMessage(bob.owner, "without ACK")
    await vi.waitFor(() => expect(bob.received).toContain("without ACK"))
    await bob.runtime.sendMessage(alice.owner, "reply without ACK")
    await vi.waitFor(() => expect(alice.received).toContain("reply without ACK"))
    await alice.runtime.sendTyping(bob.owner)
    await alice.runtime.sendReceipt(bob.owner, "seen", [sent.id])
    await alice.runtime.setupUser(getPublicKey(generateSecretKey()))
    const created = await alice.runtime.createGroup("No ACK group", [bob.owner], { fanoutMetadata: false })
    await bob.runtime.syncGroups([created.group], bob.owner)
    const groups: string[] = []
    bob.runtime.onGroupEvent((event) => { groups.push(event.inner.content) })
    const groupMessage = await alice.runtime.sendGroupMessage(created.group.id, "group without ACK")
    expect(groupMessage.inner.content).toBe("group without ACK")
    await vi.waitFor(() => expect(groups).toContain("group without ACK"))
    await alice.runtime.rotateInvite()
  } finally {
    alice.runtime.close()
    bob.runtime.close()
  }
})

it("retains queued messages when durable handoff fails and retries after storage recovers", async () => {
  const relay = new MockRelay()
  const storage = new InMemoryStorageAdapter()
  const queue = new MessageQueue(storage, "v1/message-queue/")
  const error = new Error("local storage unavailable")
  const failures = vi.fn()
  let failHandoff = false
  const aliceSecret = generateSecretKey()
  const bobSecret = generateSecretKey()
  const aliceOwner = getPublicKey(aliceSecret)
  const bobOwner = getPublicKey(bobSecret)
  const createRuntime = (secret: Uint8Array, isAlice: boolean) => new NdrRuntime({
    storage: isAlice ? storage : undefined,
    nostrSubscribe: (filter, onEvent) => relay.subscribe(filter, onEvent).close,
    nostrSign: async (event) => finalizeEvent(event, secret),
    nostrEnqueue: async () => { if (isAlice && failHandoff) throw error },
    nostrPublish: async (event) => {
      relay.storeAndDeliver(event as ReturnType<typeof finalizeEvent>)
      return event as ReturnType<typeof finalizeEvent>
    },
    onPublishError: failures,
    appKeysFastTimeoutMs: 1,
    appKeysFetchTimeoutMs: 1,
  })
  const alice = createRuntime(aliceSecret, true)
  const bob = createRuntime(bobSecret, false)
  const received: string[] = []
  bob.onSessionEvent((event) => { received.push(event.content) })
  try {
    for (const [runtime, owner] of [[alice, aliceOwner], [bob, bobOwner]] as const) {
      await runtime.initForOwner(owner)
      await runtime.registerCurrentDevice({ ownerPubkey: owner })
      await runtime.republishInvite()
    }
    await alice.sendMessage(bobOwner, "warmup")
    await bob.sendMessage(aliceOwner, "ready")
    await vi.waitFor(() => expect(received).toContain("warmup"))
    failHandoff = true
    const message = await alice.sendMessage(bobOwner, "retry after disk recovers")
    expect(received).not.toContain(message.content)
    expect((await queue.entries()).some((entry) => entry.event.id === message.id)).toBe(true)
    expect(failures).toHaveBeenCalledWith(expect.objectContaining({ error }))
    failHandoff = false
    await alice.setupUser(bobOwner)
    await vi.waitFor(() => expect(received).toContain(message.content))
    await vi.waitFor(async () => expect((await queue.entries()).some((entry) => entry.event.id === message.id)).toBe(false))
  } finally {
    alice.close()
    bob.close()
  }
})
