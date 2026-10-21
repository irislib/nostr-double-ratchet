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
  it('rejects known-group nonmember keys instead of retaining them for a future metadata revision', async () => {
    const alice = key(), bob = key(), device = key(), receiverDevice = key();
    const data = createGroupData('membership', alice, [bob]);
    const sender = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: device });
    const receiver = new GroupManager({ ourOwnerPubkey: bob, ourDevicePubkey: receiverDevice });
    const keys: import('../src/types.js').Rumor[] = [];
    try {
      await receiver.upsertGroup({ ...data, members: [bob], admins: [bob] });
      const result = await sender.sendMessage('membership-gated', {
        publishOuter: async () => { throw new Error('Shared publication forbidden') },
        sendPairwise: async (recipient, rumor) => { if (recipient === bob && rumor.kind === 10446) keys.push(rumor) },
      });
      expect(keys.length).toBeGreaterThan(0);
      for (const rumor of keys) await receiver.handleIncomingSessionEvent(rumor, alice, device);
      expect(receiver.groupForSenderEvent(result.outer.pubkey)).toBeUndefined();
      await receiver.upsertGroup(data);
      // A later local membership update cannot authenticate a previously rejected key.
      expect(receiver.groupForSenderEvent(result.outer.pubkey)).toBeUndefined();
      for (const rumor of keys) await receiver.handleIncomingSessionEvent(rumor, alice, device);
      expect(receiver.groupForSenderEvent(result.outer.pubkey)?.id).toBe(data.id);
      expect((await receiver.handleOuterEvent(result.outer))?.inner.id).toBe(result.inner.id);
    } finally { receiver.destroy(); }
  });

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
    }, flushDurableSessionEvents: async () => {}, notifyDurableSessionEventReadiness: () => {}, sendEvent: async () => {} }
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


it.each(['known', 'upsert', 'sync'] as const)('automatically commits queued ratchet group deliveries after %s readiness', async bootstrap => {
  const { MockRelay } = await import('./helpers/mockRelay.js')
  const { createRuntime } = await import('./helpers/runtime.js')
  const { PRIVATE_GROUP_DELIVERY_KIND } = await import('../src/PrivateGroupDelivery.js')
  const frames: string[] = [], requests: string[] = []
  class SerializedRelay extends MockRelay {
    override storeAndDeliver(event: Parameters<MockRelay['storeAndDeliver']>[0]) {
      const frame = JSON.stringify(['EVENT', event]); frames.push(frame)
      super.storeAndDeliver(JSON.parse(frame)[1])
    }
    override subscribe(filter: Parameters<MockRelay['subscribe']>[0], onEvent: Parameters<MockRelay['subscribe']>[1]) {
      const frame = JSON.stringify(['REQ', 'test', filter]); requests.push(frame)
      return super.subscribe(JSON.parse(frame)[2], event => onEvent(JSON.parse(JSON.stringify(event))))
    }
  }
  const relay = new SerializedRelay(), aliceSecret = generateSecretKey(), bobSecret = generateSecretKey()
  const alice = getPublicKey(aliceSecret), bob = getPublicKey(bobSecret)
  const sender = createRuntime({ relay, ownerPrivateKey: aliceSecret })
  const receiver = createRuntime({ relay, ownerPrivateKey: bobSecret })
  const committed = new Map<string, string>()
  let callbackCount = 0, keysReceived = 0
  receiver.onSessionEvent(event => { if (event.kind === 10446) keysReceived++ })
  let releaseCommit!: () => void
  const commitAllowed = new Promise<void>(resolve => { releaseCommit = resolve })
  receiver.onGroupEvent(async event => {
    callbackCount++
    await commitAllowed
    committed.set(event.inner.id, event.inner.content)
  })
  try {
    for (const [runtime, owner] of [[sender, alice], [receiver, bob]] as const) {
      await runtime.initForOwner(owner)
      await runtime.registerCurrentDevice({ ownerPubkey: owner })
      await runtime.republishInvite()
    }
    await sender.sendMessage(bob, 'warmup')
    await receiver.sendMessage(alice, 'ready')
    const data = createGroupData('delayed keys', alice, [bob])
    if (bootstrap === 'known') await receiver.upsertGroup(data)
    const group = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: sender.getState().currentDevicePubkey! })
    const held: import('../src/types.js').Rumor[] = []
    const expected: Array<{ id: string; content: string }> = []
    let groupAuthor = ''
    for (let index = 0; index < 4; index++) {
      const result = await group.sendMessage(`delayed ${index}`, {
        publishOuter: async () => { throw new Error('Shared publication forbidden') },
        sendPairwise: async (recipient, rumor) => { if (recipient === bob) held.push(structuredClone(rumor)) },
      })
      groupAuthor = result.outer.pubkey
      expected.push({ id: result.inner.id, content: result.inner.content })
    }
    const deliveries = held.filter(rumor => rumor.kind === PRIVATE_GROUP_DELIVERY_KIND)
    const keys = held.filter(rumor => rumor.kind !== PRIVATE_GROUP_DELIVERY_KIND)
    expect(deliveries).toHaveLength(4)
    expect(keys.length).toBeGreaterThan(0)
    for (const rumor of deliveries) await sender.sendEvent(bob, rumor)
    const sessions = await receiver.waitForSessionManager(bob)
    const pending = () => [...sessions.getUserRecords().values()].flatMap(record => [...record.pendingDurableEvents.values()])
    await vi.waitFor(() => expect(pending()).toHaveLength(4))
    expect(committed.size).toBe(0)
    // Let the ordinary failed drain establish backoff before supplying keys.
    await new Promise(resolve => setTimeout(resolve, 30))
    for (const rumor of keys) await sender.sendEvent(bob, rumor)
    await vi.waitFor(() => expect(keysReceived).toBeGreaterThan(0), { timeout: 500 })
    if (bootstrap === 'upsert') await receiver.upsertGroup(data)
    if (bootstrap === 'sync') await receiver.syncGroups([data])
    await vi.waitFor(() => expect(receiver.getGroupManager()!.knownSenderEventPubkeys()).toContain(groupAuthor), { timeout: 500 })
    await vi.waitFor(() => expect(callbackCount).toBeGreaterThan(0), { timeout: 500 })
    expect(pending()).toHaveLength(4)
    releaseCommit()
    await vi.waitFor(() => expect([...committed].sort()).toEqual(expected.map(event => [event.id, event.content]).sort()), { timeout: 500 })
    await vi.waitFor(() => expect(pending()).toHaveLength(0), { timeout: 500 })
    // Replayed controls cannot create another application message or strand an ACK.
    for (const rumor of [...keys, deliveries[0]!]) await sender.sendEvent(bob, rumor)
    await vi.waitFor(() => expect(callbackCount).toBe(5), { timeout: 500 })
    await vi.waitFor(() => expect(pending()).toHaveLength(0), { timeout: 500 })
    expect(committed.size).toBe(4)
    const identities = [alice, bob, sender.getState().currentDevicePubkey!, receiver.getState().currentDevicePubkey!]
    for (const frame of frames) {
      const event = JSON.parse(frame)[1]
      expect(event.kind === 37368 && event.tags.some((tag: string[]) => tag[0] === 'type' && tag[1] === 'group_roster')).toBe(false)
      expect([10445, 10446, 10447, 21113]).not.toContain(event.kind)
      if ([1059, 1060].includes(event.kind)) {
        expect(identities).not.toContain(event.pubkey)
        expect(event.tags.filter((tag: string[]) => tag[0] === 'p')).toHaveLength(1)
      }
    }
    for (const request of requests) expect(JSON.parse(request)[2].authors ?? []).not.toContain(groupAuthor)
  } finally { releaseCommit(); sender.close(); receiver.close() }
})
