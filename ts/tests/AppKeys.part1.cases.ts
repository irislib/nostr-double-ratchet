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


describe('constructor and basic properties', () => {
    it('should create an empty AppKeys', () => {
      const list = new AppKeys()

      expect(list.getAllDevices()).toHaveLength(0)
    })

    it('should create AppKeys with initial devices', () => {
      const device = createTestDevice()

      const list = new AppKeys([device])

      expect(list.getAllDevices()).toHaveLength(1)
      expect(list.getAllDevices()[0].identityPubkey).toBe(device.identityPubkey)
    })
  })

describe('device management', () => {
    it('should add a device', () => {
      const list = new AppKeys()
      const device = createTestDevice()

      list.addDevice(device)

      expect(list.getAllDevices()).toHaveLength(1)
      expect(list.getDevice(device.identityPubkey)).toEqual(device)
    })

    it('should add multiple devices', () => {
      const list = new AppKeys()

      const device1 = createTestDevice()
      const device2 = createTestDevice()
      const device3 = createTestDevice()

      list.addDevice(device1)
      list.addDevice(device2)
      list.addDevice(device3)

      expect(list.getAllDevices()).toHaveLength(3)
    })

    it('should not add duplicate device (same identityPubkey)', () => {
      const list = new AppKeys()
      const device = createTestDevice()

      list.addDevice(device)
      list.addDevice(device) // Add same device again

      expect(list.getAllDevices()).toHaveLength(1)
    })

    it('should remove a device', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      expect(list.getAllDevices()).toHaveLength(1)

      list.removeDevice(device.identityPubkey)

      expect(list.getAllDevices()).toHaveLength(0)
      expect(list.getDevice(device.identityPubkey)).toBeUndefined()
    })

    it('should allow re-adding a device after removal', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      list.removeDevice(device.identityPubkey)
      expect(list.getAllDevices()).toHaveLength(0)

      list.addDevice(device) // Re-add should work now

      expect(list.getAllDevices()).toHaveLength(1)
      expect(list.getDevice(device.identityPubkey)).toEqual(device)
    })

    it('should get device by identityPubkey', () => {
      const device1 = createTestDevice()
      const device2 = createTestDevice()
      const list = new AppKeys([device1, device2])

      const found = list.getDevice(device2.identityPubkey)

      expect(found).toEqual(device2)
    })

    it('should return undefined for non-existent device', () => {
      const list = new AppKeys()

      expect(list.getDevice('non-existent-pubkey')).toBeUndefined()
    })
  })

describe('event serialization', () => {
    it('should create a valid unsigned event', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      const event = getOwnedEvent(list)

      expect(event.kind).toBe(APP_KEYS_EVENT_KIND)
      expect(event.pubkey).toBe('') // Signer will set this
      expect(event.tags.some((tag) => tag[0] === 'd' && tag[1])).toBe(true)
      expect(event.tags.some((tag) => tag[0] === 'i' && tag[2] === 'subject')).toBe(true)
      expect(event.tags).toContainEqual(['type', APP_KEYS_FACT_TYPE])
      expect(event.tags).toContainEqual(['schema', '1'])

      // Simplified tag format: ["device", identityPubkey, createdAt]
      const deviceTag = event.tags.find(t => t[0] === 'device' && t[1] === device.identityPubkey)
      expect(deviceTag).toBeDefined()
      expect(deviceTag!.length).toBe(3)
      expect(deviceTag![1]).toBe(device.identityPubkey)
      expect(deviceTag![2]).toBe(String(device.createdAt))
    })

    it('should not include removed tags in event (devices are simply deleted)', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      list.removeDevice(device.identityPubkey)
      const event = getOwnedEvent(list)

      // No "removed" tags - device is simply not in the list
      const removedTag = event.tags.find(t => t[0] === 'removed')
      expect(removedTag).toBeUndefined()
      expect(event.tags.filter(t => t[0] === 'device')).toHaveLength(0)
    })

    it('should parse AppKeys from event', () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)
      const device = createTestDevice()
      const list = new AppKeys([device])

      const event = list.getEvent({
        ownerPrivateKey,
        ownerPubkey: ownerPublicKey,
      })
      const signedEvent = finalizeEvent(event, ownerPrivateKey)

      const parsed = AppKeys.fromEvent(signedEvent)

      expect(parsed.getAllDevices()).toHaveLength(1)
      expect(parsed.getAllDevices()[0].identityPubkey).toBe(device.identityPubkey)
      // ownerPublicKey comes from the signed event
      expect(signedEvent.pubkey).toBe(ownerPublicKey)
    })

    it('should parse event after device removal (device is simply gone)', () => {
      const ownerPrivateKey = generateSecretKey()
      const device = createTestDevice()
      const list = new AppKeys([device])
      list.removeDevice(device.identityPubkey)

      const event = list.getEvent({
        ownerPrivateKey,
        ownerPubkey: getPublicKey(ownerPrivateKey),
      })
      const signedEvent = finalizeEvent(event, ownerPrivateKey)

      const parsed = AppKeys.fromEvent(signedEvent)

      expect(parsed.getAllDevices()).toHaveLength(0)
    })

    it('should throw on unsigned event', () => {
      const list = new AppKeys()

      const event = getOwnedEvent(list)
      // Event without signature
      const unsignedEvent = { ...event, id: 'fake-id', sig: '' } as any

      expect(() => AppKeys.fromEvent(unsignedEvent)).toThrow('Event is not signed')
    })

    it('encrypts device labels into event content instead of plaintext', () => {
      const ownerPrivateKey = generateSecretKey()
      const device = createTestDevice()
      const list = new AppKeys([device])

      list.setDeviceLabels(device.identityPubkey, {
        deviceLabel: 'Sirius MacBook',
        clientLabel: 'NDR Desktop',
      })

      const event = list.getEvent(ownerPrivateKey)

      expect(event.content).toBe('')
      expect(
        event.tags.some(
          (tag) => tag[0] === APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT && !!tag[1]
        )
      ).toBe(true)
      expect(event.content).not.toContain('Sirius MacBook')
      expect(event.content).not.toContain('NDR Desktop')
    })

    it('omits encrypted label content when owner private key is unavailable', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      list.setDeviceLabels(device.identityPubkey, {
        deviceLabel: 'Sirius MacBook',
        clientLabel: 'NDR Desktop',
      })

      const ownerPrivateKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerPrivateKey)
      expect(() => list.getEvent({ ownerPubkey })).not.toThrow()
      expect(list.getEvent({ ownerPubkey }).content).toBe('')
    })

    it('roundtrips encrypted device labels for owner-key devices only', () => {
      const ownerPrivateKey = generateSecretKey()
      const device = createTestDevice()
      const list = new AppKeys([device])

      list.setDeviceLabels(device.identityPubkey, {
        deviceLabel: 'Sirius MacBook',
        clientLabel: 'NDR Desktop',
      })

      const signedEvent = finalizeEvent(list.getEvent(ownerPrivateKey), ownerPrivateKey)

      const parsedWithoutKey = AppKeys.fromEvent(signedEvent)
      expect(parsedWithoutKey.getDeviceLabels(device.identityPubkey)).toBeUndefined()

      const parsedWithKey = AppKeys.fromEvent(signedEvent, ownerPrivateKey)
      expect(parsedWithKey.getDeviceLabels(device.identityPubkey)).toEqual({
        deviceLabel: 'Sirius MacBook',
        clientLabel: 'NDR Desktop',
        updatedAt: expect.any(Number),
      })
    })

    it('requires owner_pubkey on signed snapshots', () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPubkey = getPublicKey(ownerPrivateKey)
      const list = new AppKeys([createTestDevice()])
      const event = getOwnedEvent(list, ownerPrivateKey)

      expect(event.tags).toContainEqual(['owner_pubkey', ownerPubkey])
      const signedEvent = finalizeEvent(event, ownerPrivateKey)
      expect(AppKeys.fromEvent(signedEvent).getAllDevices()).toEqual(list.getAllDevices())

      const ownerless = finalizeEvent(
        {
          ...event,
          tags: event.tags.filter((tag) => tag[0] !== 'owner_pubkey'),
        },
        ownerPrivateKey
      )
      expect(() => AppKeys.fromEvent(ownerless)).toThrow('AppKeys roster missing owner_pubkey')
    })
  })

describe('serialization for persistence', () => {
    it('should serialize and deserialize', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      const json = list.serialize()
      const restored = AppKeys.deserialize(json)

      expect(restored.getAllDevices()).toHaveLength(1)
      expect(restored.getAllDevices()[0].identityPubkey).toBe(device.identityPubkey)
    })

    it('should serialize empty list after device removal', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])
      list.removeDevice(device.identityPubkey)

      const json = list.serialize()
      const restored = AppKeys.deserialize(json)

      expect(restored.getAllDevices()).toHaveLength(0)
    })

    it('should serialize and deserialize device labels for local persistence', () => {
      const device = createTestDevice()
      const list = new AppKeys([device])

      list.setDeviceLabels(device.identityPubkey, {
        deviceLabel: 'Office Laptop',
        clientLabel: 'NDR Web',
      })

      const restored = AppKeys.deserialize(list.serialize())

      expect(restored.getDeviceLabels(device.identityPubkey)).toEqual({
        deviceLabel: 'Office Laptop',
        clientLabel: 'NDR Web',
        updatedAt: expect.any(Number),
      })
    })
  })

describe('merge (conflict resolution)', () => {
    it('should merge two lists with different devices', () => {
      const device1 = createTestDevice()
      const device2 = createTestDevice()

      const list1 = new AppKeys([device1])
      const list2 = new AppKeys([device2])

      const merged = list1.merge(list2)

      expect(merged.getAllDevices()).toHaveLength(2)
      expect(merged.getDevice(device1.identityPubkey)).toBeDefined()
      expect(merged.getDevice(device2.identityPubkey)).toBeDefined()
    })

    it('should merge two empty lists after removals', () => {
      const device1 = createTestDevice()
      const device2 = createTestDevice()

      const list1 = new AppKeys([device1])
      list1.removeDevice(device1.identityPubkey)

      const list2 = new AppKeys([device2])
      list2.removeDevice(device2.identityPubkey)

      const merged = list1.merge(list2)

      // Both lists are empty after removal, merged is also empty
      expect(merged.getAllDevices()).toHaveLength(0)
    })

    it('should include device from one list when other list has removed it', () => {
      const device = createTestDevice()

      // List1 has the device
      const list1 = new AppKeys([device])

      // List2 has removed the device (so it's empty)
      const list2 = new AppKeys([device])
      list2.removeDevice(device.identityPubkey)

      const merged = list1.merge(list2)

      // Device is in list1, so it appears in merged (no explicit revocation tracking)
      expect(merged.getAllDevices()).toHaveLength(1)
      expect(merged.getDevice(device.identityPubkey)).toBeDefined()
    })

    it('should prefer earlier createdAt during merge for same identityPubkey', () => {
      const identityPubkey = getPublicKey(generateSecretKey())
      const earlierDevice: DeviceEntry = {
        identityPubkey,
        createdAt: 1000,
      }
      const laterDevice: DeviceEntry = {
        identityPubkey,
        createdAt: 2000,
      }

      const list1 = new AppKeys([laterDevice])
      const list2 = new AppKeys([earlierDevice])

      const merged = list1.merge(list2)

      expect(merged.getDevice(identityPubkey)?.createdAt).toBe(1000)
    })

    it('should prefer newer device labels during merge for same identityPubkey', () => {
      const identityPubkey = getPublicKey(generateSecretKey())
      const device: DeviceEntry = {
        identityPubkey,
        createdAt: 1000,
      }

      const older = new AppKeys([device])
      older.setDeviceLabels(identityPubkey, {
        deviceLabel: 'Old Name',
        clientLabel: 'Old Client',
      }, 100)

      const newer = new AppKeys([device])
      newer.setDeviceLabels(identityPubkey, {
        deviceLabel: 'New Name',
        clientLabel: 'New Client',
      }, 200)

      const merged = older.merge(newer)

      expect(merged.getDeviceLabels(identityPubkey)).toEqual({
        deviceLabel: 'New Name',
        clientLabel: 'New Client',
        updatedAt: 200,
      })
    })
  })

describe('device authorization discovery', () => {
    it('builds a 37368 device-authorization filter and resolves the owner signer', () => {
      const ownerPrivateKey = generateSecretKey()
      const ownerPublicKey = getPublicKey(ownerPrivateKey)
      const device = createTestDevice()
      const otherDevice = createTestDevice()
      const event = finalizeEvent(
        new AppKeys([device]).getEvent({
          ownerPrivateKey,
          ownerPubkey: ownerPublicKey,
          createdAt: 1700000300,
        }),
        ownerPrivateKey
      )

      expect(buildAppKeysDeviceAuthorizationFilter(device.identityPubkey)).toEqual({
        kinds: [APP_KEYS_EVENT_KIND],
        '#p': [device.identityPubkey],
      })
      expect(resolveAppKeysOwnerForDevice(event, device.identityPubkey)).toBe(ownerPublicKey)
      expect(resolveAppKeysOwnerForDevice(event, otherDevice.identityPubkey)).toBeNull()
    })
  })
});
