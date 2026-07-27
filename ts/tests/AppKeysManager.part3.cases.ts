import { describe, it, expect, vi, beforeEach } from "vitest"
import { AppKeysManager, DelegateManager, DelegatePayload } from "../src/AppKeysManager"
import { NostrSubscribe, NostrPublish, APP_KEYS_EVENT_KIND, INVITE_EVENT_KIND } from "../src/types"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { AppKeys, isAppKeysEvent, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT } from "../src/AppKeys"

const mockRevocationCheck = { timeoutMs: 100, retries: 0 } as const

describe("AppKeysManager Integration", () => {
let publishedEvents: any[]

let subscribers: Array<{ filter: any; callback: (event: any) => void }>

let signingKeys: Map<string, Uint8Array>

const matchesFilter = (event: any, filter: any): boolean => {
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false
    if (filter["#d"]) {
      const dTag = event.tags.find((t: string[]) => t[0] === "d")?.[1]
      if (!filter["#d"].includes(dTag)) return false
    }
    if (filter["#l"]) {
      const lTags = event.tags
        .filter((t: string[]) => t[0] === "l")
        .map((t: string[]) => t[1])
      if (!filter["#l"].some((l: string) => lTags.includes(l))) return false
    }
    if (filter["#p"]) {
      const pTags = event.tags
        .filter((t: string[]) => t[0] === "p")
        .map((t: string[]) => t[1])
      if (!filter["#p"].some((p: string) => pTags.includes(p))) return false
    }
    return true
  }

const createNostrSubscribe = (): NostrSubscribe => {
    return vi.fn((filter, onEvent) => {
      const sub = { filter, callback: onEvent }
      subscribers.push(sub)

      for (const event of publishedEvents) {
        if (matchesFilter(event, filter)) {
          setTimeout(() => onEvent(event), 5)
        }
      }

      return () => {
        const index = subscribers.indexOf(sub)
        if (index > -1) subscribers.splice(index, 1)
      }
    }) as unknown as NostrSubscribe
  }

const createNostrPublish = (): NostrPublish => {
    return vi.fn(async (event) => {
      let signedEvent = event
      if (!event.sig && event.pubkey && signingKeys.has(event.pubkey)) {
        const privkey = signingKeys.get(event.pubkey)!
        signedEvent = finalizeEvent(event, privkey)
      }

      publishedEvents.push(signedEvent)

      for (const sub of subscribers) {
        if (matchesFilter(signedEvent, sub.filter)) {
          setTimeout(() => sub.callback(signedEvent), 5)
        }
      }

      return signedEvent
    }) as unknown as NostrPublish
  }

const registerSigningKey = (pubkey: string, privkey: Uint8Array) => {
    signingKeys.set(pubkey, privkey)
  }

beforeEach(() => {
    publishedEvents = []
    subscribers = []
    signingKeys = new Map()
  })


it("AppKeysManager adds delegate, delegate activates via waitForActivation", async () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerPrivateKey)

    registerSigningKey(ownerPublicKey, ownerPrivateKey)

    // 1. Create DelegateManager (device identity)
    const delegateManager = new DelegateManager({
      nostrSubscribe: createNostrSubscribe(),
      nostrPublish: createNostrPublish(),
      storage: new InMemoryStorageAdapter(),
    })

    await delegateManager.init()
    const payload = delegateManager.getRegistrationPayload()

    // Register delegate's signing key
    registerSigningKey(delegateManager.getIdentityPublicKey(), delegateManager.getIdentityKey())

    const activationPromise = delegateManager.waitForActivation(5000)

    // 2. Create AppKeysManager (authority) - only needs nostrPublish
    // The signing is done by the publish implementation that uses signingKeys
    const deviceManagerPublish = createNostrPublish()
    const originalPublish = deviceManagerPublish
    const signedPublish = vi.fn(async (event) => {
      // Add owner's signature if not already signed
      const signedEvent = !event.sig && ownerPrivateKey
        ? finalizeEvent(event, ownerPrivateKey)
        : event
      return originalPublish(signedEvent)
    }) as unknown as NostrPublish

    const deviceManager = new AppKeysManager({
      nostrPublish: signedPublish,
      storage: new InMemoryStorageAdapter(),
      ownerIdentityKey: ownerPrivateKey,
    })

    await deviceManager.init()

    // 3. Add the delegate device (local only) then publish
    deviceManager.addDevice(payload)
    await deviceManager.publish()

    const devices = deviceManager.getOwnDevices()
    expect(devices.length).toBe(1)
    expect(devices[0].identityPubkey).toBe(payload.identityPubkey)

    await new Promise((resolve) => setTimeout(resolve, 50))

    // 4. Delegate should activate
    const activatedOwnerPubkey = await activationPromise

    expect(activatedOwnerPubkey).toBe(ownerPublicKey)
    expect(delegateManager.getOwnerPublicKey()).toBe(ownerPublicKey)
  })

it("main device follows same pairing flow as delegate device", async () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerPrivateKey)

    registerSigningKey(ownerPublicKey, ownerPrivateKey)

    // 1. Create AppKeysManager (authority) with signed publish
    const deviceManagerPublish = createNostrPublish()
    const originalPublish = deviceManagerPublish
    const signedPublish = vi.fn(async (event) => {
      const signedEvent = !event.sig && ownerPrivateKey
        ? finalizeEvent(event, ownerPrivateKey)
        : event
      return originalPublish(signedEvent)
    }) as unknown as NostrPublish

    const deviceManager = new AppKeysManager({
      nostrPublish: signedPublish,
      storage: new InMemoryStorageAdapter(),
      ownerIdentityKey: ownerPrivateKey,
    })
    await deviceManager.init()

    // 2. Create DelegateManager for main device identity (same flow as delegate!)
    const mainDelegateManager = new DelegateManager({
      nostrSubscribe: createNostrSubscribe(),
      nostrPublish: createNostrPublish(),
      storage: new InMemoryStorageAdapter(),
    })

    await mainDelegateManager.init()
    const mainPayload = mainDelegateManager.getRegistrationPayload()

    registerSigningKey(mainDelegateManager.getIdentityPublicKey(), mainDelegateManager.getIdentityKey())

    // 3. Add main device to AppKeys (same as adding any device) then publish
    deviceManager.addDevice(mainPayload)
    await deviceManager.publish()

    const devices = deviceManager.getOwnDevices()
    expect(devices.length).toBe(1)
    expect(devices[0].identityPubkey).toBe(mainPayload.identityPubkey)

    // 4. Wait for activation (same as any device!)
    const ownerPubkey = await mainDelegateManager.waitForActivation(5000)
    expect(ownerPubkey).toBe(ownerPublicKey)

    // Main device now has separate identity key (not main key!)
    expect(mainDelegateManager.getIdentityPublicKey()).not.toBe(ownerPublicKey)
  })

it("AppKeysManager revokes delegate, delegate detects revocation", async () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerPrivateKey)

    registerSigningKey(ownerPublicKey, ownerPrivateKey)

    const delegateManager = new DelegateManager({
      nostrSubscribe: createNostrSubscribe(),
      nostrPublish: createNostrPublish(),
      storage: new InMemoryStorageAdapter(),
    })

    await delegateManager.init()
    const payload = delegateManager.getRegistrationPayload()

    registerSigningKey(delegateManager.getIdentityPublicKey(), delegateManager.getIdentityKey())

    const activationPromise = delegateManager.waitForActivation(5000)

    // Create AppKeysManager with signed publish
    const deviceManagerPublish = createNostrPublish()
    const originalPublish = deviceManagerPublish
    const signedPublish = vi.fn(async (event) => {
      const signedEvent = !event.sig && ownerPrivateKey
        ? finalizeEvent(event, ownerPrivateKey)
        : event
      return originalPublish(signedEvent)
    }) as unknown as NostrPublish

    const deviceManager = new AppKeysManager({
      nostrPublish: signedPublish,
      storage: new InMemoryStorageAdapter(),
      ownerIdentityKey: ownerPrivateKey,
    })

    await deviceManager.init()
    deviceManager.addDevice(payload)
    await deviceManager.publish()

    await new Promise((resolve) => setTimeout(resolve, 50))
    await activationPromise

    const initialRevoked = await delegateManager.isRevoked(mockRevocationCheck)
    expect(initialRevoked).toBe(false)

    // Revoke by identityPubkey and publish
    deviceManager.revokeDevice(payload.identityPubkey)
    await deviceManager.publish()

    await new Promise((resolve) => setTimeout(resolve, 50))

    const revoked = await delegateManager.isRevoked(mockRevocationCheck)
    expect(revoked).toBe(true)
  })

it("delegate cannot activate if not added to AppKeys", async () => {
    const delegateManager = new DelegateManager({
      nostrSubscribe: createNostrSubscribe(),
      nostrPublish: createNostrPublish(),
      storage: new InMemoryStorageAdapter(),
    })

    await delegateManager.init()

    registerSigningKey(delegateManager.getIdentityPublicKey(), delegateManager.getIdentityKey())

    await expect(delegateManager.waitForActivation(200)).rejects.toThrow(
      "Activation timeout"
    )
  })

it("external user can discover delegate via owner's AppKeys", async () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPublicKey = getPublicKey(ownerPrivateKey)

    registerSigningKey(ownerPublicKey, ownerPrivateKey)

    const delegateManager = new DelegateManager({
      nostrSubscribe: createNostrSubscribe(),
      nostrPublish: createNostrPublish(),
    })
    await delegateManager.init()
    const payload = delegateManager.getRegistrationPayload()

    // Create AppKeysManager with signed publish
    const deviceManagerPublish = createNostrPublish()
    const originalPublish = deviceManagerPublish
    const signedPublish = vi.fn(async (event) => {
      const signedEvent = !event.sig && ownerPrivateKey
        ? finalizeEvent(event, ownerPrivateKey)
        : event
      return originalPublish(signedEvent)
    }) as unknown as NostrPublish

    const deviceManager = new AppKeysManager({
      nostrPublish: signedPublish,
      ownerIdentityKey: ownerPrivateKey,
    })

    await deviceManager.init()
    deviceManager.addDevice(payload)
    await deviceManager.publish()

    await new Promise((resolve) => setTimeout(resolve, 50))

    const externalSubscribe = createNostrSubscribe()

    const fetchedList = await new Promise<AppKeys | null>((resolve) => {
      let latestEvent: any = null
      const unsub = externalSubscribe(
        {
          kinds: [APP_KEYS_EVENT_KIND],
          authors: [ownerPublicKey],
        },
        (event) => {
          try {
            if (!latestEvent || event.created_at >= latestEvent.created_at) {
              latestEvent = event
            }
          } catch {
            // ignore
          }
        }
      )

      setTimeout(() => {
        unsub()
        if (latestEvent) {
          try {
            resolve(AppKeys.fromEvent(latestEvent))
          } catch {
            resolve(null)
          }
        } else {
          resolve(null)
        }
      }, 100)
    })

    expect(fetchedList).not.toBeNull()

    const devices = fetchedList!.getAllDevices()
    expect(devices.length).toBe(1)
    expect(devices[0].identityPubkey).toBe(payload.identityPubkey)
  })
});
