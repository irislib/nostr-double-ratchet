import { expect, it, vi } from "vitest"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { createNostrPublisher } from "../src/publishing"

const secret = generateSecretKey()
const unsigned = { pubkey: getPublicKey(secret), kind: 1, created_at: 1, content: "hello", tags: [] }
const signed = finalizeEvent({ ...unsigned }, secret)
const never = () => new Promise<never>(() => {})

it("awaits durable handoff before dispatch, but never awaits relay acknowledgement", async () => {
  let persist!: () => void
  const stored = new Promise<void>((resolve) => { persist = resolve })
  const transport = vi.fn(never)
  const enqueue = vi.fn(() => stored)
  const publish = createNostrPublisher(transport, { nostrEnqueue: enqueue })
  let finished = false
  const pending = publish(signed, "inner-id").then((event) => {
    finished = true
    return event
  })
  await vi.waitFor(() => expect(enqueue).toHaveBeenCalledWith(signed, "inner-id"))
  expect(transport).not.toHaveBeenCalled()
  expect(finished).toBe(false)
  persist()
  await expect(pending).resolves.toBe(signed)
  expect(transport).toHaveBeenCalledWith(signed, "inner-id")
})

it("signs unsigned owner events before handing off their exact signed envelope", async () => {
  const sign = vi.fn(async () => signed)
  const enqueue = vi.fn(async () => {})
  const transport = vi.fn(never)
  const publish = createNostrPublisher(transport, { nostrSign: sign, nostrEnqueue: enqueue })
  await expect(publish(unsigned)).resolves.toBe(signed)
  expect(sign).toHaveBeenCalledWith(unsigned)
  expect(enqueue).toHaveBeenCalledWith(signed, undefined)
  expect(transport).toHaveBeenCalledWith(signed, undefined)
})

it("keeps awaiting a legacy unsigned callback that also provides signing", async () => {
  let finishSigning!: (event: typeof signed) => void
  const legacy = vi.fn(() => new Promise<typeof signed>((resolve) => { finishSigning = resolve }))
  const publish = createNostrPublisher(legacy)
  let finished = false
  const result = publish(unsigned).then((event) => { finished = true; return event })
  await Promise.resolve()
  expect(finished).toBe(false)
  finishSigning(signed)
  await expect(result).resolves.toBe(signed)
})

it.each(["synchronous", "asynchronous"])("reports %s transport failure without rejecting local handoff or leaking observer errors", async (mode) => {
  const error = new Error("relay offline")
  const onPublishError = vi.fn(() => { throw new Error("observer failed") })
  const transport = mode === "synchronous"
    ? () => { throw error }
    : async () => { throw error }
  const publish = createNostrPublisher(transport, { onPublishError })
  await expect(publish(signed, "inner-id")).resolves.toBe(signed)
  await vi.waitFor(() => expect(onPublishError).toHaveBeenCalledWith({
    event: signed, innerEventId: "inner-id", error,
  }))
})

it("preserves a failed persistence barrier and never attempts its transport", async () => {
  const error = new Error("disk unavailable")
  const transport = vi.fn(never)
  const onPublishError = vi.fn()
  const publish = createNostrPublisher(transport, {
    nostrEnqueue: async () => { throw error }, onPublishError,
  })
  await expect(publish(signed)).rejects.toBe(error)
  expect(transport).not.toHaveBeenCalled()
  expect(onPublishError).toHaveBeenCalledWith({ event: signed, innerEventId: undefined, error })
})

it("keeps one durable handoff when managers share an already wrapped publisher", async () => {
  const enqueue = vi.fn(async () => {})
  const publish = createNostrPublisher(never, { nostrEnqueue: enqueue })
  await createNostrPublisher(publish)(signed)
  expect(enqueue).toHaveBeenCalledTimes(1)
})
