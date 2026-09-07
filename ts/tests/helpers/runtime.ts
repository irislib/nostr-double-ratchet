import { finalizeEvent, type UnsignedEvent, type VerifiedEvent } from "nostr-tools"
import { NdrRuntime } from "../../src/NdrRuntime"
import { type StorageAdapter } from "../../src/StorageAdapter"
import { type NostrPublish, type NostrSubscribe } from "../../src/types"
import { MockRelay } from "./mockRelay"

export const tick = async (ms = 0) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const createSubscribe = (relay: MockRelay): NostrSubscribe => {
  return (filter, onEvent) => relay.subscribe(filter, onEvent).close
}

export const createRuntime = (options: {
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
