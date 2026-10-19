import { afterEach, describe, expect, it, vi } from "vitest"
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools"
import { AppKeys } from "../src/AppKeys"
import { NdrRuntime } from "../src/NdrRuntime"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { MockRelay } from "./helpers/mockRelay"
import { createRuntime, tick } from "./helpers/runtime"

const runtimes: NdrRuntime[] = []
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close() })
const device = () => ({ identityPubkey: getPublicKey(generateSecretKey()), createdAt: 1 })
const latest = (relay: MockRelay) => relay.getAllEvents().filter(e => e.kind === 37368)
  .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]!

function participant(relay: MockRelay, secret: Uint8Array, delay = 0) {
  const runtime = createRuntime({ relay, ownerPrivateKey: secret, appKeysDelayMs: delay })
  runtimes.push(runtime)
  return runtime
}

describe("registration snapshot safety", () => {
  it("rebases only the requested addition, preserving newer additions and removals", async () => {
    const relay = new MockRelay(), secret = generateSecretKey(), owner = getPublicKey(secret)
    const removed = device(), retained = device(), added = device()
    const publish = (devices: ReturnType<typeof device>[], createdAt: number) => {
      const event = finalizeEvent(new AppKeys(devices).getEvent({ ownerPubkey: owner, createdAt }), secret)
      relay.storeAndDeliver(event)
      return event
    }
    publish([removed, retained], 100)
    const runtime = participant(relay, secret)
    await runtime.initForOwner(owner)
    const prepared = await runtime.prepareRegistration({ ownerPubkey: owner })
    const newer = publish([retained, added], 101)
    // Make the conflicting inclusion win the NIP-01 ID tie: even that branch
    // must not silently restore a device excluded by another signed head.
    let conflicting: VerifiedEvent
    do { conflicting = finalizeEvent(new AppKeys([removed, retained, added]).getEvent({ownerPubkey: owner, createdAt: 101}), secret) } while (conflicting.id > newer.id)
    relay.storeAndDeliver(conflicting)
    await runtime.applyVerifiedAppKeysEvent(newer)
    await runtime.applyVerifiedAppKeysEvent(conflicting)
    await runtime.publishPreparedRegistration(prepared)
    const devices = AppKeys.fromEvent(latest(relay)).getAllDevices().map(d => d.identityPubkey)
    expect(devices).toEqual(expect.arrayContaining([retained.identityPubkey, added.identityPubkey, prepared.newDeviceIdentity]))
    expect(devices).not.toContain(removed.identityPubkey)
  })

  it("does not overwrite a newer roster received while publishing", async () => {
    const relay = new MockRelay(), secret = generateSecretKey(), owner = getPublicKey(secret)
    const sibling = device()
    let injected: VerifiedEvent | undefined
    const runtime = new NdrRuntime({
      nostrSubscribe: (filter, onEvent) => relay.subscribe(filter, onEvent).close,
      nostrPublish: async event => {
        const signed = 'sig' in event ? event as VerifiedEvent : finalizeEvent(event, secret)
        if (signed.kind === 37368) {
          relay.storeAndDeliver(signed)
          injected = finalizeEvent(new AppKeys([sibling]).getEvent({ ownerPubkey: owner, createdAt: signed.created_at + 1 }), secret)
          relay.storeAndDeliver(injected)
          await tick(10)
        }
        return signed
      },
      appKeysFastTimeoutMs: 10, appKeysFetchTimeoutMs: 30,
    })
    runtimes.push(runtime)
    await runtime.initForOwner(owner)
    const prepared = await runtime.prepareRegistration({ownerPubkey: owner})
    await runtime.publishPreparedRegistration(prepared)
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(injected!.created_at)
    expect(runtime.getState().registeredDevices).toEqual([sibling])
  })

  it("does not re-add a prepared target revoked before publication", async () => {
    const relay = new MockRelay(), secret = generateSecretKey(), owner = getPublicKey(secret)
    const target = device(), sibling = device()
    relay.storeAndDeliver(finalizeEvent(new AppKeys([target, sibling]).getEvent({ ownerPubkey: owner, createdAt: 100 }), secret))
    const runtime = participant(relay, secret)
    await runtime.initForOwner(owner)
    const prepared = await runtime.prepareRegistrationForIdentity({ownerPubkey: owner, identityPubkey: target.identityPubkey})
    const revoked = finalizeEvent(new AppKeys([sibling]).getEvent({ownerPubkey: owner, createdAt: 101}), secret)
    relay.storeAndDeliver(revoked)
    await runtime.applyVerifiedAppKeysEvent(revoked)
    const count = relay.getAllEvents().length
    await expect(runtime.publishPreparedRegistration(prepared)).rejects.toThrow('Please try again')
    expect(relay.getAllEvents()).toHaveLength(count)
    expect(runtime.getState().registeredDevices).toEqual([sibling])
  })

  it("detects a newer unmodified-client roster and preserves its keys on an explicit retry", async () => {
    const relay = new MockRelay(), secret = generateSecretKey(), owner = getPublicKey(secret)
    const other = device()
    let first = true
    const runtime = new NdrRuntime({
      nostrSubscribe: (filter, onEvent) => relay.subscribe(filter, onEvent).close,
      nostrPublish: async event => {
        const signed = finalizeEvent(event, secret)
        relay.storeAndDeliver(signed)
        if (first && signed.kind === 37368) {
          first = false
          // An older client can publish a valid roster without conflict checks.
          relay.storeAndDeliver(finalizeEvent(new AppKeys([other]).getEvent({ownerPubkey: owner, createdAt: signed.created_at + 1}), secret))
          await tick()
        }
        return signed
      },
      appKeysFastTimeoutMs: 10, appKeysFetchTimeoutMs: 30,
    })
    runtimes.push(runtime)
    await runtime.initForOwner(owner)
    await expect(runtime.ensureCurrentDeviceRegistered(owner, 30)).rejects.toThrow('Please try again')
    expect(runtime.getState().isCurrentDeviceRegistered).toBe(false)
    const newerExclusion = finalizeEvent(new AppKeys([other]).getEvent({ownerPubkey: owner, createdAt: latest(relay).created_at + 1}), secret)
    relay.storeAndDeliver(newerExclusion)
    await runtime.applyVerifiedAppKeysEvent(newerExclusion)
    await expect(runtime.sendMessage(getPublicKey(generateSecretKey()), 'blocked')).rejects.toThrow('Please try again')
    await runtime.ensureCurrentDeviceRegistered(owner, 30)
    expect(AppKeys.fromEvent(latest(relay)).getAllDevices().map(d => d.identityPubkey)).toEqual(expect.arrayContaining([
      other.identityPubkey, runtime.getState().currentDevicePubkey!,
    ]))
  })

  it("keeps interrupted local enrollment unconfirmed after restart", async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret), storage = new InMemoryStorageAdapter()
    const options = {
      storage,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, secret),
      appKeysFastTimeoutMs: 10, appKeysFetchTimeoutMs: 20,
    }
    const runtime = new NdrRuntime(options)
    runtimes.push(runtime)
    await runtime.initForOwner(owner)
    const registration = runtime.ensureCurrentDeviceRegistered(owner, 100)
    void registration.catch(() => {})
    await vi.waitFor(() => expect(runtime.getState().registeredDevices).toHaveLength(1))
    runtime.close()
    const restarted = new NdrRuntime(options)
    runtimes.push(restarted)
    await restarted.initForOwner(owner)
    expect(restarted.getState().registeredDevices).toHaveLength(1)
    expect(restarted.getState().isCurrentDeviceRegistered).toBe(false)
    await expect(restarted.sendMessage(getPublicKey(generateSecretKey()), 'blocked')).rejects.toThrow('Please try again')
    await expect(registration).rejects.toThrow('Please try again')
  })

  it("does not accept stale relay confirmation after observing a newer revocation", async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret), sibling = device()
    let published: VerifiedEvent | undefined
    const runtime = new NdrRuntime({
      nostrSubscribe: (_filter, onEvent) => {
        if (published) onEvent(published)
        return () => {}
      },
      nostrPublish: async event => {
        const signed = finalizeEvent(event, secret)
        if (signed.kind === 37368) {
          published = signed
          await runtime.applyVerifiedAppKeysEvent(finalizeEvent(new AppKeys([sibling]).getEvent({ownerPubkey: owner, createdAt: signed.created_at + 1}), secret))
        }
        return signed
      },
      appKeysFastTimeoutMs: 10, appKeysFetchTimeoutMs: 30,
    })
    runtimes.push(runtime)
    await runtime.initForOwner(owner)
    await expect(runtime.ensureCurrentDeviceRegistered(owner, 30)).rejects.toThrow('Please try again')
    expect(runtime.getState().isCurrentDeviceRegistered).toBe(false)
    expect(runtime.getState().registeredDevices).toEqual([sibling])
  })

  it("serializes roster persistence so a delayed save cannot roll back a newer roster", async () => {
    const relay = new MockRelay(), secret = generateSecretKey(), owner = getPublicKey(secret)
    const runtime = participant(relay, secret)
    await runtime.initForOwner(owner)
    const older = device(), newer = device()
    const manager = runtime.getAppKeysManager()!
    const save = manager.setAppKeys.bind(manager)
    let release!: () => void, started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const saving = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(manager, 'setAppKeys').mockImplementation(async keys => {
      if (keys.getAllDevices().some(d => d.identityPubkey === older.identityPubkey)) {
        started(); await pending
      }
      await save(keys)
    })
    const apply = (runtime as unknown as {applyIncomingAppKeys: (keys: AppKeys, timestamp: number) => Promise<unknown>}).applyIncomingAppKeys.bind(runtime)
    const first = apply(new AppKeys([older]), 100)
    await saving
    const second = apply(new AppKeys([newer]), 101)
    await tick()
    release()
    await Promise.all([first, second])
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(101)
    expect(manager.getOwnDevices()).toEqual([newer])
    expect(runtime.getState().registeredDevices).toEqual([newer])
  })

  it.each([0, 1])("detects competing registration with %i second timestamp separation, then retries on the settled roster", async separation => {
    const relay = new MockRelay(), secret = generateSecretKey(), owner = getPublicKey(secret)
    const held: VerifiedEvent[] = []
    const stores = [new InMemoryStorageAdapter(), new InMemoryStorageAdapter()]
    const timestamp = Math.floor(Date.now() / 1000)
    const make = (index: number) => {
      let first = true
      const runtime = new NdrRuntime({
        storage: stores[index],
        nostrSubscribe: (filter, onEvent) => relay.subscribe(filter, onEvent).close,
        nostrPublish: async event => {
          const signed = finalizeEvent({ ...event, ...(first && event.kind === 37368 ? { created_at: timestamp + index * separation } : {}) }, secret)
          if (first && signed.kind === 37368) {
            first = false
            held.push(signed)
            if (held.length === 2) for (const candidate of held) relay.storeAndDeliver(candidate)
          } else relay.storeAndDeliver(signed)
          return signed
        },
        appKeysFastTimeoutMs: 10, appKeysFetchTimeoutMs: 30,
      })
      runtimes.push(runtime)
      return runtime
    }
    const a = make(0), b = make(1)
    await Promise.all([a.initForOwner(owner), b.initForOwner(owner)])
    // Hold both signed snapshots until both publishers have read the same base.
    const outcomes = await Promise.allSettled([
      a.registerCurrentDevice({ownerPubkey: owner, timeoutMs: 80}),
      b.registerCurrentDevice({ownerPubkey: owner, timeoutMs: 80}),
    ])
    await tick(30)
    const canonical = AppKeys.fromEvent(latest(relay)).getAllDevices().map(d => d.identityPubkey)
    for (const [index, result] of outcomes.entries()) {
      const runtime = [a,b][index]!
      if (!canonical.includes(runtime.getState().currentDevicePubkey!)) {
        expect(result.status).toBe('rejected')
        expect(runtime.getState().isCurrentDeviceRegistered).toBe(false)
      }
    }
    expect(outcomes.some(result => result.status === 'rejected')).toBe(true)
    for (const candidate of held) relay.storeAndDeliver(candidate)
    await tick()
    for (const [index, result] of outcomes.entries()) if (result.status === 'rejected') {
      expect([a,b][index]!.getState().isCurrentDeviceRegistered).toBe(false)
    }
    const retrying = [a,b]
    for (const [index, result] of outcomes.entries()) if (result.status === 'rejected') {
      retrying[index]!.close()
      const restarted = createRuntime({relay, ownerPrivateKey: secret, storage: stores[index]})
      runtimes.push(restarted)
      retrying[index] = restarted
      await restarted.initForOwner(owner)
      await tick()
      expect(restarted.getState().isCurrentDeviceRegistered).toBe(false)
      await expect(restarted.sendMessage(getPublicKey(generateSecretKey()), 'blocked')).rejects.toThrow('Please try again')
    }
    for (const [index, result] of outcomes.entries()) if (result.status === 'rejected') {
      await retrying[index]!.ensureCurrentDeviceRegistered(owner, 80)
    }
    expect(AppKeys.fromEvent(latest(relay)).getAllDevices().map(d => d.identityPubkey)).toEqual(expect.arrayContaining([
      retrying[0]!.getState().currentDevicePubkey!, retrying[1]!.getState().currentDevicePubkey!,
    ]))
  })
})
