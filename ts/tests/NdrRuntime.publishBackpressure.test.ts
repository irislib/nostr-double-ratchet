import { expect, it, vi } from "vitest"
import { finalizeEvent, generateSecretKey, getPublicKey, type Filter } from "nostr-tools"
import { NdrRuntime } from "../src/NdrRuntime"
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
    expect(setupSettled).toBe(false)

    if (outcome === "rejects") {
      const error = new Error("relay rejected publish")
      const rejected = expect(setup).rejects.toBe(error)
      const sent = Promise.allSettled([send])
      rejectAcknowledgement(error)
      await Promise.all([rejected, sent])
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

it("awaits publications emitted by synchronous subscription callbacks", async () => {
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
    nostrPublish: async () => {
      publishStarted = true
      await acknowledgement
      return event
    },
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
