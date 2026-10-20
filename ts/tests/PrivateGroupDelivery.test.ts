import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Group, GroupManager, createGroupData } from '../src/Group.js'
import { InMemoryStorageAdapter } from '../src/StorageAdapter.js'

const key = () => getPublicKey(generateSecretKey())
describe('private group delivery', () => {
  it('hands every group payload to recipient ratchets without a shared relay publication or subscription', async () => {
    const alice = key(), bob = key(), device = key()
    const data = createGroupData('private', alice, [bob])
    const storage = new InMemoryStorageAdapter()
    const group = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: device, storage })
    const publishOuter = vi.fn()
    const deliveries: { recipient: string, rumor: { kind: number, content: string } }[] = []
    const result = await group.sendMessage('private hello', {
      publishOuter,
      sendPairwise: async (recipient, rumor) => { deliveries.push({ recipient, rumor }) },
    })
    expect(publishOuter).not.toHaveBeenCalled()
    const wakes = deliveries.filter(item => item.rumor.kind === 21113)
    expect(wakes.map(item => item.recipient).sort()).toEqual([alice, bob].sort())
    expect(wakes.every(item => JSON.parse(item.rumor.content).event.id === result.outer.id)).toBe(true)
    const subscribe = vi.fn(() => () => {}), fetch = vi.fn(async () => [])
    const manager = new GroupManager({ ourOwnerPubkey: alice, ourDevicePubkey: device, storage, nostrSubscribe: subscribe, nostrFetch: fetch })
    await manager.upsertGroup(data)
    expect(subscribe).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    manager.destroy()
  })
})

describe('private group delivery recovery', () => {
  it('persists all recipients before handoff and resumes only failed recipients after restart', async () => {
    const { PrivateGroupDeliveryOutbox } = await import('../src/PrivateGroupDelivery.js')
    const storage = new InMemoryStorageAdapter(), alice = key(), bob = key(), carol = key(), device = key()
    const data = createGroupData('retry', alice, [bob, carol])
    const sender = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: device, storage })
    const deliveries: string[] = []
    const result = await sender.sendMessage('durable fanout', {
      publishOuter: async () => { throw new Error('Shared publication forbidden') },
      sendPairwise: async (recipient, rumor) => {
        if (rumor.kind !== 21113) return
        const pending = await storage.list(`v1/broadcast-channel/group/${data.id}/private-deliveries/`)
        expect(pending).toHaveLength(1)
        if (recipient === bob) throw new Error('queue unavailable')
        deliveries.push(recipient)
      },
    })
    expect(deliveries.sort()).toEqual([alice, carol].sort())
    const restarted = new PrivateGroupDeliveryOutbox(storage,
      `v1/broadcast-channel/group/${data.id}/private-deliveries/${device}`, data.id, device)
    await restarted.flush(async (recipient, rumor) => {
      expect(JSON.parse(rumor.content).event.id).toBe(result.outer.id)
      deliveries.push(recipient)
    }, data.members)
    expect(deliveries.filter(recipient => recipient === bob)).toHaveLength(1)
    expect(deliveries).toHaveLength(3)
    expect(await storage.list(`v1/broadcast-channel/group/${data.id}/private-deliveries/`)).toEqual([])
  })

  it('cold previews authenticate the wrapped signer without consuming live keys', async () => {
    const { previewPrivateGroupDelivery } = await import('../src/PrivateGroupDelivery.js')
    const alice = key(), bob = key(), carol = key(), device = key(), receiverDevice = key()
    const data = createGroupData('cold', alice, [bob, carol]), storage = new InMemoryStorageAdapter()
    const receiver = new Group({ data, ourOwnerPubkey: bob, ourDevicePubkey: receiverDevice, storage })
    const sender = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: device })
    const result = await sender.sendMessage('cold private preview', {
      publishOuter: async () => { throw new Error('Shared publication forbidden') },
      sendPairwise: async (recipient, rumor) => {
        if (recipient === bob && rumor.kind !== 21113) await receiver.handleIncomingSessionEvent(rumor, alice, device)
      },
    })
    const opts = { storage, ourOwnerPubkey: bob, ourDevicePubkey: receiverDevice, group: data, event: result.outer, senderOwnerPubkey: alice }
    expect((await previewPrivateGroupDelivery(opts))?.inner.id).toBe(result.inner.id)
    expect((await previewPrivateGroupDelivery(opts))?.inner.id).toBe(result.inner.id)
    expect(await previewPrivateGroupDelivery({...opts, senderOwnerPubkey: carol})).toBeNull()
    expect((await receiver.handleOuterEvent(result.outer))?.inner.id).toBe(result.inner.id)
  })

  it('retains a materialized group delivery until an asynchronous app commit succeeds', async () => {
    const { SessionGroupRuntime } = await import('../src/RuntimeGroupController.js')
    const { privateGroupDeliveryRumor } = await import('../src/PrivateGroupDelivery.js')
    const alice = key(), bob = key(), carol = key(), device = key(), receiverDevice = key()
    const data = createGroupData('commit', alice, [bob, carol]), storage = new InMemoryStorageAdapter()
    let deliver: (rumor: any, sender: string) => Promise<void>
    const sessions = { onEvent: () => () => {}, onDurableEvent: (_: number[], callback: typeof deliver) => {
      deliver = callback; return () => {}
    }, flushDurableSessionEvents: async () => {}, sendEvent: async () => {} }
    const runtime = new SessionGroupRuntime({ sessionManager: sessions as never, ourOwnerPubkey: bob,
      ourDevicePubkey: receiverDevice, groupStorage: storage, nostrSubscribe: vi.fn(() => () => {}), nostrPublish: vi.fn() })
    await runtime.upsertGroup(data)
    const sender = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: device })
    const result = await sender.sendMessage('await app persistence', {
      publishOuter: async () => { throw new Error('Shared publication forbidden') },
      sendPairwise: async (recipient, rumor) => {
        if (recipient === bob && rumor.kind !== 21113)
          await runtime.getGroupManager()!.handleIncomingSessionEvent(rumor, alice, device)
      },
    })
    const rumor = privateGroupDeliveryRumor(result.outer, data.id, device)
    await expect(deliver!(rumor, carol)).resolves.toBeUndefined()
    await expect(deliver!(rumor, alice)).rejects.toThrow('application handler')
    const observed: string[] = []
    let callbackCount = 0
    let fail = true
    runtime.onGroupEvent(async event => {
      callbackCount++
      await Promise.resolve()
      if (fail) throw new Error('injected app persistence failure')
      observed.push(event.inner.id)
    })
    runtime.processSessionEvent(rumor, alice, {senderOwnerPubkey: alice, senderDevicePubkey: device} as never)
    await Promise.resolve()
    expect(callbackCount).toBe(0)
    await expect(deliver!(rumor, alice)).rejects.toThrow('app persistence')
    fail = false
    await deliver!(rumor, alice)
    expect(observed).toEqual([result.inner.id])
    runtime.close()
  })
})

it('replays a real ratchet group inbox after restart when the app commit previously failed', async () => {
  const { MockRelay } = await import('./helpers/mockRelay.js')
  const { createRuntime } = await import('./helpers/runtime.js')
  const relay = new MockRelay(), aliceSecret = generateSecretKey(), bobSecret = generateSecretKey()
  const alice = getPublicKey(aliceSecret), bob = getPublicKey(bobSecret), storage = new InMemoryStorageAdapter()
  const sender = createRuntime({relay, ownerPrivateKey: aliceSecret})
  let receiver = createRuntime({relay, ownerPrivateKey: bobSecret, storage})
  let failedCalls = 0
  receiver.onGroupEvent(async () => { failedCalls++; throw new Error('app database unavailable') })
  try {
    for (const [runtime, owner] of [[sender, alice], [receiver, bob]] as const) {
      await runtime.initForOwner(owner)
      await runtime.registerCurrentDevice({ownerPubkey: owner})
      await runtime.republishInvite()
    }
    await sender.sendMessage(bob, 'warmup')
    await receiver.sendMessage(alice, 'ready')
    const created = await sender.createGroup('restart', [bob], {fanoutMetadata: false})
    await receiver.syncGroups([created.group])
    const result = await sender.sendGroupMessage(created.group.id, 'survive receiver restart')
    await vi.waitFor(() => expect(failedCalls).toBeGreaterThan(0))
    receiver.close()
    receiver = createRuntime({relay, ownerPrivateKey: bobSecret, storage})
    const committed: string[] = []
    receiver.onGroupEvent(async event => { committed.push(event.inner.id) })
    await receiver.initForOwner(bob)
    await receiver.syncGroups([created.group])
    await (await receiver.waitForSessionManager(bob)).flushDurableSessionEvents()
    await vi.waitFor(() => expect(committed).toContain(result.inner.id))
  } finally { sender.close(); receiver.close() }
})


it('rejects an oversized group delivery before acknowledging an undeliverable fanout', async () => {
  const alice = key(), bob = key(), device = key(), deliveries: number[] = []
  const sender = new Group({data: createGroupData('size', alice, [bob]), ourOwnerPubkey: alice, ourDevicePubkey: device})
  await expect(sender.sendMessage('x'.repeat(262144), {
    publishOuter: async () => { throw new Error('Shared publication forbidden') },
    sendPairwise: async (_recipient, rumor) => { deliveries.push(rumor.kind) },
  })).rejects.toThrow('oversized')
  expect(deliveries).not.toContain(21113)
})
