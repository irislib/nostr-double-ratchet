import { vi } from "vitest"
import { generateSecretKey, getPublicKey, finalizeEvent, UnsignedEvent, VerifiedEvent } from "nostr-tools"
import { AppKeysManager, DelegateManager } from "../../src/AppKeysManager"
import { AppKeys, isAppKeysEvent } from "../../src/AppKeys"
import { InMemoryStorageAdapter, StorageAdapter } from "../../src/StorageAdapter"
import { NostrPublish, NostrSubscribe, Rumor } from "../../src/types"
import { SessionManager } from "../../src/SessionManager"
import { MockRelay } from "./mockRelay"

type DeviceRef = { actor: string; deviceId: string }

type Step =
  | { type: "addDevice"; actor: string; deviceId: string }
  | { type: "addDelegateDevice"; actor: string; deviceId: string; mainDeviceId: string }
  | { type: "send"; from: DeviceRef; to: string; message: string; waitOn?: "all-recipient-devices" | DeviceRef }
  | { type: "expect"; actor: string; deviceId: string; message: string }
  | { type: "expectAll"; actor: string; deviceId: string; messages: string[] }
  | { type: "restart"; actor: string; deviceId: string }
  | { type: "close"; actor: string; deviceId: string }
  | { type: "removeDevice"; actor: string; deviceId: string }

interface ScenarioConfig {
  steps: Step[]
}

interface DeviceState {
  manager: SessionManager
  storage: StorageAdapter
  delegateStorage: StorageAdapter
  delegateIdentityPubkey: string
  receivedMessages: string[]
  messageWaiters: Map<string, Array<() => void>>
  isClosed: boolean
}

interface ActorState {
  secretKey: Uint8Array
  publicKey: string
  appKeysManager: AppKeysManager
  devices: Map<string, DeviceState>
}

function waitForMessage(device: DeviceState, message: string, timeoutMs = 10000): Promise<void> {
  // Already received?
  if (device.receivedMessages.includes(message)) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for message "${message}". Received: ${JSON.stringify(device.receivedMessages)}`))
    }, timeoutMs)

    if (!device.messageWaiters.has(message)) {
      device.messageWaiters.set(message, [])
    }
    device.messageWaiters.get(message)!.push(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

export async function runScenario(config: ScenarioConfig): Promise<void> {
  const relay = new MockRelay()
  const actors = new Map<string, ActorState>()

  function getActor(name: string): ActorState {
    const actor = actors.get(name)
    if (!actor) throw new Error(`Actor "${name}" not found`)
    return actor
  }

  function getDevice(actorName: string, deviceId: string): DeviceState {
    const actor = getActor(actorName)
    const device = actor.devices.get(deviceId)
    if (!device) throw new Error(`Device "${deviceId}" not found for actor "${actorName}"`)
    return device
  }

  async function createDevice(
    actorName: string,
    deviceId: string,
    secretKey: Uint8Array,
    appKeysManager: AppKeysManager,
    existingStorage?: StorageAdapter,
    existingDelegateStorage?: StorageAdapter,
  ): Promise<DeviceState> {
    const publicKey = getPublicKey(secretKey)
    const storage = existingStorage || new InMemoryStorageAdapter()

    const nostrSubscribe: NostrSubscribe = (filter, onEvent) => {
      const handle = relay.subscribe(filter, onEvent)
      return handle.close
    }

    const publish = vi.fn<NostrPublish>(async (event: UnsignedEvent) => {
      const signedEvent = finalizeEvent(event, secretKey)
      relay.storeAndDeliver(signedEvent as unknown as VerifiedEvent)
      return signedEvent as unknown as VerifiedEvent
    })

    // Delegate publish signs with delegate key
    const delegateManagerHolder: { manager: DelegateManager | null } = { manager: null }
    const delegatePublish = vi.fn<NostrPublish>(async (event: UnsignedEvent | VerifiedEvent) => {
      if ("sig" in event && event.sig) {
        relay.storeAndDeliver(event as unknown as VerifiedEvent)
        return event as unknown as VerifiedEvent
      }
      const privKey = delegateManagerHolder.manager?.getIdentityKey()
      if (!privKey) throw new Error("No delegate key available")
      const signedEvent = finalizeEvent(event as UnsignedEvent, privKey)
      relay.storeAndDeliver(signedEvent as unknown as VerifiedEvent)
      return signedEvent as unknown as VerifiedEvent
    })

    const delegateStorage = existingDelegateStorage || new InMemoryStorageAdapter()
    const delegateManager = new DelegateManager({
      nostrSubscribe,
      nostrPublish: delegatePublish,
      storage: delegateStorage,
    })
    delegateManagerHolder.manager = delegateManager

    await delegateManager.init()

    // Add device to AppKeysManager and publish
    appKeysManager.addDevice(delegateManager.getRegistrationPayload())
    await appKeysManager.publish()

    // Activate deterministically
    await delegateManager.activate(publicKey)

    // Create SessionManager
    const manager = delegateManager.createSessionManager(storage)

    const deviceState: DeviceState = {
      manager,
      storage,
      delegateStorage,
      delegateIdentityPubkey: delegateManager.getIdentityPublicKey(),
      receivedMessages: [],
      messageWaiters: new Map(),
      isClosed: false,
    }

    // Register onEvent BEFORE init() so events delivered during session
    // restoration (e.g. messages published while device was offline) are captured
    manager.onEvent((event: Rumor) => {
      deviceState.receivedMessages.push(event.content)
      const waiters = deviceState.messageWaiters.get(event.content)
      if (waiters) {
        for (const waiter of waiters) {
          waiter()
        }
        deviceState.messageWaiters.delete(event.content)
      }
    })

    await manager.init()
    await delegateManager.publishInvite()

    return deviceState
  }

  for (const step of config.steps) {
    switch (step.type) {
      case "addDevice": {
        let actor = actors.get(step.actor)
        if (!actor) {
          const secretKey = generateSecretKey()
          const publicKey = getPublicKey(secretKey)
          const appKeysManager = new AppKeysManager({
            nostrPublish: vi.fn<NostrPublish>(async (event: UnsignedEvent) => {
              const signedEvent = finalizeEvent(event, secretKey)
              relay.storeAndDeliver(signedEvent as unknown as VerifiedEvent)
              return signedEvent as unknown as VerifiedEvent
            }),
            storage: new InMemoryStorageAdapter(),
            ownerIdentityKey: secretKey,
          })
          await appKeysManager.init()

          // Check for existing AppKeys on relay
          const existingEvents = relay.getAllEvents()
          for (const event of existingEvents) {
            if (event.pubkey === publicKey && isAppKeysEvent(event)) {
              try {
                const appKeys = AppKeys.fromEvent(event)
                await appKeysManager.setAppKeys(appKeys)
              } catch { /* ignore */ }
            }
          }

          actor = { secretKey, publicKey, appKeysManager, devices: new Map() }
          actors.set(step.actor, actor)
        }

        const device = await createDevice(
          step.actor,
          step.deviceId,
          actor.secretKey,
          actor.appKeysManager,
        )
        actor.devices.set(step.deviceId, device)
        break
      }

      case "addDelegateDevice": {
        const actor = getActor(step.actor)
        const device = await createDevice(
          step.actor,
          step.deviceId,
          actor.secretKey,
          actor.appKeysManager,
        )
        actor.devices.set(step.deviceId, device)
        break
      }

      case "send": {
        const fromDevice = getDevice(step.from.actor, step.from.deviceId)
        const toActor = getActor(step.to)

        await fromDevice.manager.sendMessage(toActor.publicKey, step.message)

        if (step.waitOn === "all-recipient-devices") {
          const promises: Promise<void>[] = []
          for (const [, device] of toActor.devices) {
            if (!device.isClosed) {
              promises.push(waitForMessage(device, step.message))
            }
          }
          await Promise.all(promises)
        } else if (step.waitOn && typeof step.waitOn === "object") {
          const targetDevice = getDevice(step.waitOn.actor, step.waitOn.deviceId)
          await waitForMessage(targetDevice, step.message)
        }
        break
      }

      case "expect": {
        const device = getDevice(step.actor, step.deviceId)
        await waitForMessage(device, step.message)
        break
      }

      case "expectAll": {
        const device = getDevice(step.actor, step.deviceId)
        await Promise.all(step.messages.map((msg) => waitForMessage(device, msg)))
        break
      }

      case "restart": {
        const actor = getActor(step.actor)
        const oldDevice = actor.devices.get(step.deviceId)
        if (oldDevice && !oldDevice.isClosed) {
          oldDevice.manager.close()
          oldDevice.isClosed = true
        }

        // Allow pending async operations (e.g., fetchAppKeys setTimeout)
        // to complete and persist state before creating the new device
        await new Promise((r) => setTimeout(r, 200))

        const device = await createDevice(
          step.actor,
          step.deviceId,
          actor.secretKey,
          actor.appKeysManager,
          oldDevice?.storage,
          oldDevice?.delegateStorage,
        )
        actor.devices.set(step.deviceId, device)
        break
      }

      case "close": {
        const device = getDevice(step.actor, step.deviceId)
        device.manager.close()
        device.isClosed = true
        break
      }

      case "removeDevice": {
        const actor = getActor(step.actor)
        const device = actor.devices.get(step.deviceId)
        if (device) {
          actor.appKeysManager.revokeDevice(device.delegateIdentityPubkey)
          await actor.appKeysManager.publish()
        }
        break
      }
    }
  }
}
