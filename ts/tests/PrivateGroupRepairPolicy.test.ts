import { expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Group, createGroupData } from '../src/Group.js'
import { SessionGroupRuntime } from '../src/RuntimeGroupController.js'
import { DurableSessionEvents } from '../src/session-manager/durableSessionEvents.js'
import { buildSenderKeyRepairRequestRumor } from '../src/SenderKeyRepair.js'
import { privateGroupDeliveryRumor } from '../src/PrivateGroupDelivery.js'
import type { Rumor } from '../src/types.js'
import type { StoredDurableSessionEvent } from '../src/session-manager/types.js'

const key = () => getPublicKey(generateSecretKey())

it.each(['member', 'nonmember', 'removed-local'] as const)('rate-bounds missing-key requests and preserves pending rows for %s state', async state => {
  const alice = key(), bob = key(), device = key(), senderDevice = key()
  const data = createGroupData('missing key', alice, [bob])
  const record = { publicKey: alice, pendingDurableEvents: new Map<string, StoredDurableSessionEvent>() }
  const inbox = new DurableSessionEvents(() => [record], async () => {})
  const requests: Array<{ to: string; rumor: Rumor; options: unknown }> = []
  const sessions = { onEvent: () => () => {}, onDurableEvent: inbox.onEvent.bind(inbox),
    notifyDurableSessionEventReadiness: inbox.notifyReady.bind(inbox),
    sendEvent: async (to: string, rumor: Rumor, options: unknown) => { requests.push({ to, rumor, options }) } }
  const runtime = new SessionGroupRuntime({ sessionManager: sessions as never, ourOwnerPubkey: bob,
    ourDevicePubkey: device, nostrSubscribe: () => () => {}, nostrPublish: vi.fn() })
  try {
    await runtime.upsertGroup({ ...data, members: state === 'nonmember' ? [bob] : state === 'removed-local' ? [alice] : data.members })
    const group = new Group({ data, ourOwnerPubkey: alice, ourDevicePubkey: senderDevice })
    const result = await group.sendMessage('missing distribution', { sendPairwise: async () => {}, publishOuter: vi.fn() })
    const event = privateGroupDeliveryRumor(result.outer, data.id, senderDevice, bob)
    inbox.enqueue(record, { id: event.id, event, sender: alice, meta: { senderOwnerPubkey: alice, senderDevicePubkey: senderDevice } })
    await new Promise(resolve => setTimeout(resolve, 40))
    for (let index = 0; index < 5; index++) { inbox.notifyReady(); await new Promise(resolve => setTimeout(resolve, 5)) }
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(record.pendingDurableEvents.size).toBe(1)
    expect(requests).toHaveLength(state === 'member' ? 1 : 0)
    if (requests[0]) {
      expect(requests[0].to).toBe(alice)
      expect(requests[0].rumor.kind).toBe(10447)
      expect(requests[0].options).toEqual({ includeLocalSiblings: false })
    }
  } finally { runtime.close(); inbox.close() }
})

it('rejects nonmember, removed and malformed repair requests without sending keys', async () => {
  const alice = key(), bob = key(), carol = key(), device = key(), peerDevice = key()
  const data = createGroupData('repair authorization', alice, [bob])
  const sent: Rumor[] = []
  const sessions = { onEvent: () => () => {}, onDurableEvent: () => () => {},
    notifyDurableSessionEventReadiness: () => {}, sendEvent: async (_to: string, rumor: Rumor) => { sent.push(rumor) } }
  const runtime = new SessionGroupRuntime({ sessionManager: sessions as never, ourOwnerPubkey: alice,
    ourDevicePubkey: device, nostrSubscribe: () => () => {}, nostrPublish: vi.fn() })
  try {
    await runtime.upsertGroup(data)
    const result = await runtime.sendGroupMessage(data.id, 'eligible only')
    const request = runtime.getGroupManager()!.senderKeyRepairRequestForOuterEvent(data.id, result.outer)!
    const event = buildSenderKeyRepairRequestRumor(request, peerDevice)
    sent.length = 0
    runtime.processSessionEvent(event, carol, { senderOwnerPubkey: carol, senderDevicePubkey: peerDevice } as never)
    runtime.processSessionEvent({ ...event, content: '{}' }, bob, { senderOwnerPubkey: bob, senderDevicePubkey: peerDevice } as never)
    runtime.processSessionEvent(event, bob, { senderOwnerPubkey: bob, senderDevicePubkey: key() } as never)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(sent).toHaveLength(0)
    runtime.processSessionEvent(event, bob, { senderOwnerPubkey: bob, senderDevicePubkey: peerDevice } as never)
    await vi.waitFor(() => expect(sent.filter(rumor => rumor.kind === 10446)).toHaveLength(1), { timeout: 500 })
    await runtime.upsertGroup({ ...data, members: [alice] })
    runtime.processSessionEvent(event, bob, { senderOwnerPubkey: bob, senderDevicePubkey: peerDevice } as never)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(sent.filter(rumor => rumor.kind === 10446)).toHaveLength(1)
  } finally { runtime.close() }
})
