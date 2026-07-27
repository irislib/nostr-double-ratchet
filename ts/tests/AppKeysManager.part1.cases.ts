import { describe, it, expect, vi, beforeEach } from "vitest"
import { AppKeysManager, DelegateManager, DelegatePayload } from "../src/AppKeysManager"
import { NostrSubscribe, NostrPublish, APP_KEYS_EVENT_KIND, INVITE_EVENT_KIND } from "../src/types"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { AppKeys, isAppKeysEvent, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT } from "../src/AppKeys"

const mockRevocationCheck = { timeoutMs: 100, retries: 0 } as const

describe("DelegateManager", () => {
let nostrSubscribe: NostrSubscribe

let nostrPublish: NostrPublish

let publishedEvents: any[]

let subscriptions: Map<string, { filter: any; callback: (event: any) => void }>

beforeEach(() => {
    publishedEvents = []
    subscriptions = new Map()

    nostrSubscribe = vi.fn((filter, onEvent) => {
      const key = JSON.stringify(filter)
      subscriptions.set(key, { filter, callback: onEvent })
      return () => {
        subscriptions.delete(key)
      }
    }) as unknown as NostrSubscribe

    nostrPublish = vi.fn(async (event) => {
      publishedEvents.push(event)
      return event
    }) as unknown as NostrPublish
  })


describe("constructor and init()", () => {
    it("should create a DelegateManager", async () => {
      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      expect(manager).toBeInstanceOf(DelegateManager)
    })

    it("should generate identity keypair on init", async () => {
      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()
      const payload = manager.getRegistrationPayload()

      expect(payload.identityPubkey).toBeDefined()
      expect(payload.identityPubkey).toHaveLength(64)
      expect(manager.getIdentityPublicKey()).toBe(payload.identityPubkey)

      const privkey = manager.getIdentityKey()
      expect(privkey).toBeInstanceOf(Uint8Array)
      expect((privkey as Uint8Array).length).toBe(32)
    })

    it("should return simplified payload with only identityPubkey", async () => {
      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()
      const payload = manager.getRegistrationPayload()

      // Simplified payload only contains identityPubkey
      expect(payload.identityPubkey).toBeDefined()
      // No deviceId, deviceLabel, ephemeralPubkey, or sharedSecret
      expect((payload as any).deviceId).toBeUndefined()
      expect((payload as any).deviceLabel).toBeUndefined()
      expect((payload as any).ephemeralPubkey).toBeUndefined()
      expect((payload as any).sharedSecret).toBeUndefined()
    })
  })

describe("init()", () => {
    it("should not auto-publish Invite event on init", async () => {
      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()

      // Should NOT publish AppKeys (only AppKeysManager does that)
      const appKeysEvents = publishedEvents.filter(
        (e) => isAppKeysEvent(e)
      )
      expect(appKeysEvents.length).toBe(0)

      // Invite publication is explicit; init alone must not publish anything.
      const inviteEvents = publishedEvents.filter(
        (e) => e.kind === INVITE_EVENT_KIND && e.tags?.some((t: string[]) => t[0] === "d" && t[1]?.startsWith("double-ratchet/invites/"))
      )
      expect(inviteEvents.length).toBe(0)
    })

    it("should publish Invite event explicitly", async () => {
      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()
      await manager.publishInvite()

      const inviteEvents = publishedEvents.filter(
        (e) => e.kind === INVITE_EVENT_KIND && e.tags?.some((t: string[]) => t[0] === "d" && t[1]?.startsWith("double-ratchet/invites/"))
      )
      expect(inviteEvents.length).toBe(1)
    })

    it("should create and store Invite on init", async () => {
      const storage = new InMemoryStorageAdapter()

      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
        storage,
      })

      await manager.init()

      const invite = manager.getInvite()
      expect(invite).not.toBeNull()
      expect(invite?.inviterEphemeralPublicKey).toHaveLength(64)
      expect(invite?.inviterEphemeralPrivateKey).toBeInstanceOf(Uint8Array)
      expect(invite?.sharedSecret).toHaveLength(64)
    })

    it("should load stored owner pubkey if exists", async () => {
      const storage = new InMemoryStorageAdapter()
      const ownerPubkey = getPublicKey(generateSecretKey())

      // DelegateManager uses v1 for storage version
      await storage.put("v1/device-manager/owner-pubkey", ownerPubkey)

      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
        storage,
      })

      await manager.init()

      expect(manager.getOwnerPublicKey()).toBe(ownerPubkey)
    })

    it("should restore identity keys from storage on restart", async () => {
      const storage = new InMemoryStorageAdapter()

      // First instance - generates keys
      const manager1 = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
        storage,
      })
      await manager1.init()
      const originalPubkey = manager1.getIdentityPublicKey()
      const originalPrivkey = manager1.getIdentityKey()

      // Second instance with same storage - should restore keys
      const manager2 = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
        storage,
      })
      await manager2.init()

      expect(manager2.getIdentityPublicKey()).toBe(originalPubkey)
      expect(Array.from(manager2.getIdentityKey())).toEqual(Array.from(originalPrivkey))
    })
  })

describe("waitForActivation()", () => {
    it("should subscribe to AppKeys events", async () => {
      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()

      const activationPromise = manager.waitForActivation(100)

      expect(nostrSubscribe).toHaveBeenCalled()
      const calls = (nostrSubscribe as any).mock.calls
      const appKeysCall = calls.find(
        (call: any) => call[0].kinds?.includes(APP_KEYS_EVENT_KIND)
      )
      expect(appKeysCall).toBeDefined()

      await expect(activationPromise).rejects.toThrow("Activation timeout")
    })

    it("should resolve when own identityPubkey appears in an AppKeys", async () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)

      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()
      const payload = manager.getRegistrationPayload()

      const activationPromise = manager.waitForActivation(5000)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const createdAt = Math.floor(Date.now() / 1000)
      const appKeysEvent = finalizeEvent(
        new AppKeys([{ identityPubkey: payload.identityPubkey, createdAt }]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt,
        }),
        ownerPrivateKey
      )

      const subscriptionKey = Array.from(subscriptions.keys()).find((key) =>
        key.includes(String(APP_KEYS_EVENT_KIND))
      )
      if (subscriptionKey) {
        const sub = subscriptions.get(subscriptionKey)
        sub?.callback(appKeysEvent)
      }

      const result = await activationPromise
      expect(result).toBe(ownerPublicKey)
    })

    it("should resolve immediately if already activated", async () => {
      const storage = new InMemoryStorageAdapter()
      const ownerPubkey = getPublicKey(generateSecretKey())

      // DelegateManager uses v1 for storage version
      await storage.put("v1/device-manager/owner-pubkey", ownerPubkey)

      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
        storage,
      })

      await manager.init()

      const result = await manager.waitForActivation(100)
      expect(result).toBe(ownerPubkey)
    })
  })

describe("isRevoked()", () => {
    it("should return false when device is in AppKeys", async () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)

      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()
      const payload = manager.getRegistrationPayload()

      const activationPromise = manager.waitForActivation(5000)
      await new Promise((resolve) => setTimeout(resolve, 50))

      const createdAt = Math.floor(Date.now() / 1000)
      const appKeysEvent = finalizeEvent(
        new AppKeys([{ identityPubkey: payload.identityPubkey, createdAt }]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt,
        }),
        ownerPrivateKey
      )

      let subscriptionKey = Array.from(subscriptions.keys()).find((key) =>
        key.includes(String(APP_KEYS_EVENT_KIND))
      )
      if (subscriptionKey) {
        subscriptions.get(subscriptionKey)?.callback(appKeysEvent)
      }

      await activationPromise

      const isRevokedSubscribe = vi.fn((filter, onEvent) => {
        if (
          filter.kinds?.includes(APP_KEYS_EVENT_KIND) &&
          filter.authors?.includes(ownerPublicKey)
        ) {
          setTimeout(() => onEvent(appKeysEvent), 10)
        }
        return () => {}
      }) as unknown as NostrSubscribe

      ;(manager as any).nostrSubscribe = isRevokedSubscribe

      const revoked = await manager.isRevoked(mockRevocationCheck)
      expect(revoked).toBe(false)
    })

    it("should return true when device is removed from AppKeys", async () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)

      const manager = new DelegateManager({
        nostrSubscribe,
        nostrPublish,
      })

      await manager.init()
      const payload = manager.getRegistrationPayload()

      const activationPromise = manager.waitForActivation(5000)
      await new Promise((resolve) => setTimeout(resolve, 50))

      const createdAt = Math.floor(Date.now() / 1000)
      const appKeysEvent = finalizeEvent(
        new AppKeys([{ identityPubkey: payload.identityPubkey, createdAt }]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt,
        }),
        ownerPrivateKey
      )

      let subscriptionKey = Array.from(subscriptions.keys()).find((key) =>
        key.includes(String(APP_KEYS_EVENT_KIND))
      )
      if (subscriptionKey) {
        subscriptions.get(subscriptionKey)?.callback(appKeysEvent)
      }

      await activationPromise

      // Device is revoked by simply not being in the list anymore
      const revokedAppKeysEvent = finalizeEvent(
        new AppKeys([]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt: createdAt + 1,
        }),
        ownerPrivateKey
      )

      const isRevokedSubscribe = vi.fn((filter, onEvent) => {
        if (
          filter.kinds?.includes(APP_KEYS_EVENT_KIND) &&
          filter.authors?.includes(ownerPublicKey)
        ) {
          setTimeout(() => onEvent(revokedAppKeysEvent), 10)
        }
        return () => {}
      }) as unknown as NostrSubscribe

      ;(manager as any).nostrSubscribe = isRevokedSubscribe

      const revoked = await manager.isRevoked(mockRevocationCheck)
      expect(revoked).toBe(true)
    })
  })
});
