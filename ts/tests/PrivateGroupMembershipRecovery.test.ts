import { expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import { buildGroupRosterFactEvent, createGroupData } from '../src/Group.js'
import { MockRelay } from './helpers/mockRelay.js'
import { createRuntime } from './helpers/runtime.js'
import { privateGroupDeliveryRumor } from '../src/PrivateGroupDelivery.js'
import type { Rumor } from '../src/types.js'

it('automatically repairs a new member key rejected before the admin membership update arrives', async () => {
  const frames: string[] = [], requests: string[] = [], held: VerifiedEvent[] = []
  let holdRecipient: string | undefined
  class SerializedRelay extends MockRelay {
    override storeAndDeliver(event: VerifiedEvent) {
      const frame = JSON.stringify(['EVENT', event]); frames.push(frame)
      const serialized = JSON.parse(frame)[1] as VerifiedEvent
      if (holdRecipient && serialized.kind === 1060 && serialized.tags.some(tag => tag[0] === 'p' && tag[1] === holdRecipient)) {
        held.push(serialized); return
      }
      super.storeAndDeliver(serialized)
    }
    override subscribe(filter: Parameters<MockRelay['subscribe']>[0], onEvent: Parameters<MockRelay['subscribe']>[1]) {
      const frame = JSON.stringify(['REQ', 'test', filter]); requests.push(frame)
      return super.subscribe(JSON.parse(frame)[2], event => onEvent(structuredClone(event)))
    }
  }
  const relay = new SerializedRelay()
  const secrets = [generateSecretKey(), generateSecretKey(), generateSecretKey()]
  const [alice, bob, carol] = secrets.map(getPublicKey)
  const runtimes = secrets.map(ownerPrivateKey => createRuntime({ relay, ownerPrivateKey }))
  const [admin, receiver, newcomer] = runtimes
  const committed = new Map<string, string>()
  const controls: number[] = []
  const repairs: Rumor[] = []
  let commits = 0
  newcomer!.onSessionEvent(event => { if (event.kind === 10447) repairs.push(event) })
  receiver!.onSessionEvent(event => { controls.push(event.kind) })
  receiver!.onGroupEvent(async event => {
    if (event.inner.kind === 37368) return
    commits++
    committed.set(event.inner.id, event.inner.content)
  })
  try {
    for (const [index, runtime] of runtimes.entries()) {
      await runtime.initForOwner(secrets.map(getPublicKey)[index]!)
      await runtime.registerCurrentDevice({ ownerPubkey: secrets.map(getPublicKey)[index]! })
      await runtime.republishInvite()
    }
    for (const [left, right] of [[0, 1], [0, 2], [2, 1]]) {
      await runtimes[left!]!.sendMessage(secrets.map(getPublicKey)[right!]!, 'warmup')
      await runtimes[right!]!.sendMessage(secrets.map(getPublicKey)[left!]!, 'ready')
    }
    const original = createGroupData('member ordering', alice!, [bob!])
    const updated = { ...original, members: [...original.members, carol!] }
    await receiver!.upsertGroup(original)
    await admin!.upsertGroup(updated)
    await newcomer!.upsertGroup(updated)
    const membership = finalizeEvent(buildGroupRosterFactEvent(updated,
      { signerPubkey: alice!, revision: 2 }), secrets[0]!)
    holdRecipient = receiver!.getState().currentDevicePubkey!
    await admin!.sendEvent(bob!, { kind: membership.kind, content: membership.content,
      tags: membership.tags, pubkey: membership.pubkey, created_at: membership.created_at, id: membership.id })
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 500 })
    holdRecipient = undefined
    const message = await newcomer!.sendGroupMessage(updated.id, 'sent before the membership arrives')
    const inbox = () => [...receiver!.getSessionUserRecords().values()].flatMap(record => [...record.pendingDurableEvents.values()])
    await vi.waitFor(() => expect(controls).toContain(10446), { timeout: 500 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(1), { timeout: 500 })
    expect(receiver!.getGroupManager()!.groupForSenderEvent(message.outer.pubkey)).toBeUndefined()
    expect(committed.size).toBe(0)
    expect(repairs).toHaveLength(0)
    for (const event of held) relay.storeAndDeliver(event)
    await vi.waitFor(() => expect(receiver!.getGroupManager()!.getGroup(updated.id)?.members).toContain(carol), { timeout: 500 })
    // Recovery must be driven by normal authenticated controls, not a test resend/flush.
    await vi.waitFor(() => expect(committed.get(message.inner.id)).toBe(message.inner.content), { timeout: 500 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(0), { timeout: 500 })
    expect(repairs).toHaveLength(1)
    expect(controls.filter(kind => kind === 10446)).toHaveLength(2)
    // Retries preserve canonical message identity and do not cause key-response loops.
    await newcomer!.sendEvent(bob!, privateGroupDeliveryRumor(message.outer, updated.id,
      newcomer!.getState().currentDevicePubkey!, bob!))
    await receiver!.sendEvent(carol!, repairs[0]!)
    await vi.waitFor(() => expect(commits).toBe(2), { timeout: 500 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(0), { timeout: 500 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(committed.size).toBe(1)
    expect(controls.filter(kind => kind === 10446)).toHaveLength(2)
    const identities = [...secrets.map(getPublicKey), ...runtimes.map(runtime => runtime.getState().currentDevicePubkey!)]
    for (const frame of frames) {
      const event = JSON.parse(frame)[1]
      expect([10445, 10446, 10447, 21113]).not.toContain(event.kind)
      expect(event.kind === 37368 && event.tags.some((tag: string[]) => tag[0] === 'type' && tag[1] === 'group_roster')).toBe(false)
      if ([1059, 1060].includes(event.kind)) {
        expect(identities).not.toContain(event.pubkey)
        expect(event.tags.filter((tag: string[]) => tag[0] === 'p')).toHaveLength(1)
      }
    }
    for (const request of requests) expect(JSON.parse(request)[2].authors ?? []).not.toContain(message.outer.pubkey)
  } finally { for (const runtime of runtimes) runtime.close() }
})
