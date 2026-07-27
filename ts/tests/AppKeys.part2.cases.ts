import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import {
  AppKeys,
  type AppKeysEventOptions,
  APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
  APP_KEYS_FACT_TYPE,
  buildAppKeysDeviceAuthorizationFilter,
  buildAppKeysFilter,
  resolveAppKeysOwnerForDevice,
  type DeviceEntry,
} from '../src/AppKeys'
import { APP_KEYS_EVENT_KIND } from '../src/types'
import type { NostrSubscribe } from '../src/types'

describe('AppKeys', () => {
/**
   * Create a simple device entry.
   * identityPubkey serves as the device identifier.
   */
  const createTestDevice = (identityPubkey?: string): DeviceEntry => {
    return {
      identityPubkey: identityPubkey || getPublicKey(generateSecretKey()),
      createdAt: Math.floor(Date.now() / 1000),
    }
  }

const getOwnedEvent = (
    list: AppKeys,
    ownerPrivateKey = generateSecretKey(),
    options: Partial<AppKeysEventOptions> = {}
  ) => list.getEvent({
    ownerPrivateKey,
    ownerPubkey: getPublicKey(ownerPrivateKey),
    ...options,
  })


describe('waitFor', () => {
    it('uses author-only backfill filters and validates the AppKeys snapshot type client-side', async () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)
      const device = createTestDevice()
      const list = new AppKeys([device])
      const seenFilters: Record<string, unknown>[] = []
      const unsignedValidEvent = list.getEvent({
        ownerPrivateKey,
        ownerPubkey: ownerPublicKey,
        createdAt: 101,
      })

      const wrongEvent = finalizeEvent(
        {
          ...unsignedValidEvent,
          created_at: 100,
          tags: unsignedValidEvent.tags.map((tag) =>
            tag[0] === 'type' ? ['type', 'not_app_keys'] : tag
          ),
        },
        ownerPrivateKey
      )

      const validEvent = finalizeEvent(unsignedValidEvent, ownerPrivateKey)

      const nostrSubscribe: NostrSubscribe = (filter, onEvent) => {
        seenFilters.push(filter as Record<string, unknown>)
        setTimeout(() => onEvent(wrongEvent), 0)
        setTimeout(() => onEvent(validEvent), 1)
        return () => {}
      }

      const result = await AppKeys.waitFor(ownerPublicKey, nostrSubscribe, 20)

      expect(seenFilters).toEqual([buildAppKeysFilter(ownerPublicKey)])
      expect(result?.getAllDevices()).toEqual([device])
    })

    it('decrypts encrypted device labels while waiting when the owner key is supplied', async () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)
      const device = createTestDevice()
      const list = new AppKeys([device])
      list.setDeviceLabels(device.identityPubkey, {
        deviceLabel: 'Sirius MacBook',
        clientLabel: 'NDR Desktop',
      })
      const event = finalizeEvent(list.getEvent(ownerPrivateKey), ownerPrivateKey)

      const nostrSubscribe: NostrSubscribe = (_filter, onEvent) => {
        setTimeout(() => onEvent(event), 0)
        return () => {}
      }

      const withoutKey = await AppKeys.waitFor(ownerPublicKey, nostrSubscribe, 20)
      expect(withoutKey?.getDeviceLabels(device.identityPubkey)).toBeUndefined()

      const withKey = await AppKeys.waitFor(
        ownerPublicKey,
        nostrSubscribe,
        20,
        ownerPrivateKey
      )
      expect(withKey?.getDeviceLabels(device.identityPubkey)).toEqual({
        deviceLabel: 'Sirius MacBook',
        clientLabel: 'NDR Desktop',
        updatedAt: expect.any(Number),
      })
    })

    it('preserves the larger same-second AppKeys snapshot when events arrive out of order', async () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)
      const firstDevice = createTestDevice()
      const secondDevice = createTestDevice()
      const createdAt = Math.floor(Date.now() / 1000)

      const oldEvent = finalizeEvent(
        new AppKeys([firstDevice]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt,
        }),
        ownerPrivateKey
      )

      const newEvent = finalizeEvent(
        new AppKeys([firstDevice, secondDevice]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt,
        }),
        ownerPrivateKey
      )

      const nostrSubscribe: NostrSubscribe = (_filter, onEvent) => {
        setTimeout(() => onEvent(newEvent), 0)
        setTimeout(() => onEvent(oldEvent), 1)
        return () => {}
      }

      const result = await AppKeys.waitFor(ownerPublicKey, nostrSubscribe, 20)
      const devicePubkeys = result?.getAllDevices().map((device) => device.identityPubkey) ?? []

      expect(devicePubkeys).toContain(firstDevice.identityPubkey)
      expect(devicePubkeys).toContain(secondDevice.identityPubkey)
    })
  })

describe('createDeviceEntry helper', () => {
    it('should create a device entry with identity info', () => {
      const identityPubkey = getPublicKey(generateSecretKey())
      const list = new AppKeys()

      const now = Math.floor(Date.now() / 1000)
      const device = list.createDeviceEntry(identityPubkey)

      expect(device.identityPubkey).toBe(identityPubkey)
      // Allow 1 second tolerance for rounding
      expect(device.createdAt).toBeGreaterThanOrEqual(now - 1)
      expect(device.createdAt).toBeLessThanOrEqual(now + 1)
    })
  })

describe('DeviceEntry with identityPubkey', () => {
    it('should add device with identityPubkey', () => {
      const list = new AppKeys()

      const delegatePrivateKey = generateSecretKey()
      const delegatePublicKey = getPublicKey(delegatePrivateKey)
      const device = createTestDevice(delegatePublicKey)

      list.addDevice(device)

      const retrieved = list.getDevice(device.identityPubkey)
      expect(retrieved).toBeDefined()
      expect(retrieved!.identityPubkey).toBe(delegatePublicKey)
    })

    it('should include identityPubkey in event tags', () => {
      const list = new AppKeys()

      const delegatePrivateKey = generateSecretKey()
      const delegatePublicKey = getPublicKey(delegatePrivateKey)
      const device = createTestDevice(delegatePublicKey)

      list.addDevice(device)
      const event = getOwnedEvent(list)

      // Simplified format: ["device", identityPubkey, createdAt]
      const deviceTag = event.tags.find(t => t[0] === 'device' && t[1] === device.identityPubkey)
      expect(deviceTag).toBeDefined()
      expect(deviceTag![1]).toBe(delegatePublicKey)
    })

    it('should parse identityPubkey from event', () => {
      const ownerPrivateKey = generateSecretKey()
      const list = new AppKeys()

      const delegatePrivateKey = generateSecretKey()
      const delegatePublicKey = getPublicKey(delegatePrivateKey)
      const device = createTestDevice(delegatePublicKey)

      list.addDevice(device)
      const event = list.getEvent({
        ownerPrivateKey,
        ownerPubkey: getPublicKey(ownerPrivateKey),
      })
      const signedEvent = finalizeEvent(event, ownerPrivateKey)

      const parsed = AppKeys.fromEvent(signedEvent)
      const parsedDevice = parsed.getDevice(device.identityPubkey)

      expect(parsedDevice).toBeDefined()
      expect(parsedDevice!.identityPubkey).toBe(delegatePublicKey)
    })

    it('should preserve identityPubkey in serialization', () => {
      const list = new AppKeys()

      const delegatePrivateKey = generateSecretKey()
      const delegatePublicKey = getPublicKey(delegatePrivateKey)
      const device = createTestDevice(delegatePublicKey)

      list.addDevice(device)
      const json = list.serialize()
      const restored = AppKeys.deserialize(json)

      const restoredDevice = restored.getDevice(device.identityPubkey)
      expect(restoredDevice).toBeDefined()
      expect(restoredDevice!.identityPubkey).toBe(delegatePublicKey)
    })

    it('should preserve identityPubkey in merge', () => {
      const delegatePrivateKey = generateSecretKey()
      const delegatePublicKey = getPublicKey(delegatePrivateKey)
      const device = createTestDevice(delegatePublicKey)

      const list1 = new AppKeys([device])
      const list2 = new AppKeys()

      const merged = list1.merge(list2)

      const mergedDevice = merged.getDevice(device.identityPubkey)
      expect(mergedDevice).toBeDefined()
      expect(mergedDevice!.identityPubkey).toBe(delegatePublicKey)
    })

    it('should handle mixed devices (with different identityPubkeys)', () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)
      const list = new AppKeys()

      const delegatePrivateKey = generateSecretKey()
      const delegatePublicKey = getPublicKey(delegatePrivateKey)

      const mainDevice = createTestDevice(ownerPublicKey)
      const delegateDevice = createTestDevice(delegatePublicKey)

      list.addDevice(mainDevice)
      list.addDevice(delegateDevice)

      const event = list.getEvent({
        ownerPrivateKey,
        ownerPubkey: ownerPublicKey,
      })
      const signedEvent = finalizeEvent(event, ownerPrivateKey)
      const parsed = AppKeys.fromEvent(signedEvent)

      // Both devices should have identityPubkey set correctly
      expect(parsed.getDevice(mainDevice.identityPubkey)?.identityPubkey).toBe(ownerPublicKey)
      expect(parsed.getDevice(delegateDevice.identityPubkey)?.identityPubkey).toBe(delegatePublicKey)
    })
  })
});
