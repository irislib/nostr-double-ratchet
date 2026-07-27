import { describe, it, expect, vi, beforeEach } from "vitest"
import { AppKeysManager, DelegateManager, DelegatePayload } from "../src/AppKeysManager"
import { NostrSubscribe, NostrPublish, APP_KEYS_EVENT_KIND, INVITE_EVENT_KIND } from "../src/types"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { AppKeys, isAppKeysEvent, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT } from "../src/AppKeys"

const mockRevocationCheck = { timeoutMs: 100, retries: 0 } as const

describe("AppKeysManager - Authority", () => {
let nostrPublish: NostrPublish

let publishedEvents: any[]

let ownerPubkey: string

beforeEach(() => {
    publishedEvents = []
    ownerPubkey = getPublicKey(generateSecretKey())

    nostrPublish = vi.fn(async (event) => {
      publishedEvents.push(event)
      return event
    }) as unknown as NostrPublish
  })


describe("constructor", () => {
    it("should create a AppKeysManager", () => {
      const manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })

      expect(manager).toBeInstanceOf(AppKeysManager)
    })
  })

describe("init()", () => {
    it("should not auto-publish AppKeys on init", async () => {
      const manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })

      await manager.init()

      // Init does NOT auto-publish - client must call publish() explicitly
      expect(publishedEvents.length).toBe(0)

      // Calling publish() will publish
      await manager.publish()
      const appKeysEvents = publishedEvents.filter(
        (e) => isAppKeysEvent(e)
      )
      expect(appKeysEvents.length).toBe(1)
    })

    it("should start with empty device list", async () => {
      const manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })

      await manager.init()

      const appKeys = manager.getAppKeys()
      expect(appKeys).not.toBeNull()

      // AppKeysManager no longer auto-adds a device (client must add via DelegateManager flow)
      const devices = manager.getOwnDevices()
      expect(devices.length).toBe(0)
    })
  })

describe("addDevice()", () => {
    it("should add device to AppKeys (local only - publish separately)", async () => {
      const manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })
      await manager.init()

      // Simplified payload format - only identityPubkey
      const payload: DelegatePayload = {
        identityPubkey: getPublicKey(generateSecretKey()),
      }

      manager.addDevice(payload) // Synchronous - local only

      const devices = manager.getOwnDevices()
      expect(devices.length).toBe(1)
      const device = devices[0]
      expect(device.identityPubkey).toBe(payload.identityPubkey)

      // Not published yet
      expect(publishedEvents.length).toBe(0)

      // Must call publish() to send to relay
      await manager.publish()
      expect(publishedEvents.length).toBe(1)
    })

    it("should use identityPubkey as device identifier", async () => {
      const manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })
      await manager.init()

      const delegateIdentityPubkey = getPublicKey(generateSecretKey())
      const payload: DelegatePayload = {
        identityPubkey: delegateIdentityPubkey,
      }

      manager.addDevice(payload)

      const devices = manager.getOwnDevices()
      expect(devices.length).toBe(1)
      expect(devices[0].identityPubkey).toBe(delegateIdentityPubkey)

      // Can retrieve by identityPubkey
      const device = manager.getAppKeys()?.getDevice(delegateIdentityPubkey)
      expect(device).toBeDefined()
      expect(device?.identityPubkey).toBe(delegateIdentityPubkey)
    })

    it("publishes encrypted device labels instead of plaintext when ownerIdentityKey is available", async () => {
      const ownerIdentityKey = generateSecretKey()
      const manager = new AppKeysManager({
        nostrPublish,
        ownerIdentityKey,
      })
      await manager.init()

      const payload: DelegatePayload = {
        identityPubkey: getPublicKey(generateSecretKey()),
        deviceLabel: "Sirius MacBook",
        clientLabel: "NDR Desktop",
      }

      manager.addDevice(payload)
      await manager.publish()

      expect(publishedEvents).toHaveLength(1)
      expect(publishedEvents[0].content).toBe("")
      expect(
        publishedEvents[0].tags.some(
          (tag: string[]) => tag[0] === APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT && !!tag[1]
        )
      ).toBe(true)
      expect(publishedEvents[0].content).not.toContain("Sirius MacBook")
      expect(publishedEvents[0].content).not.toContain("NDR Desktop")
    })
  })

describe("revokeDevice()", () => {
    it("should remove device from AppKeys by identityPubkey", async () => {
      const manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })
      await manager.init()

      const identityPubkey = getPublicKey(generateSecretKey())
      const payload: DelegatePayload = {
        identityPubkey,
      }
      manager.addDevice(payload)

      expect(manager.getOwnDevices().length).toBe(1)

      manager.revokeDevice(identityPubkey)

      expect(manager.getOwnDevices().length).toBe(0)
    })
  })

describe("getters", () => {
    let manager: AppKeysManager

    beforeEach(async () => {
      manager = new AppKeysManager({
        nostrPublish,
        ownerPubkey,
      })
      await manager.init()
    })

    it("getAppKeys() should return AppKeys", () => {
      const list = manager.getAppKeys()
      expect(list).not.toBeNull()
    })
  })
});
