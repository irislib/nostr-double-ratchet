import { getEventHash, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import { Group, type GroupDecryptedEvent, type PairwiseSend } from './GroupChannel.js'
import type { GroupData } from './GroupMeta.js'
import { InMemoryStorageAdapter, type StorageAdapter } from './StorageAdapter.js'
import { hasMetadataPrivacyVersion } from './metadataPrivacy.js'
import type { Rumor } from './types.js'

export const PAIRWISE_GROUP_DELIVERY_VERSION = 1
export const PRIVATE_GROUP_DELIVERY_KIND = 21113

export function parsePrivateGroupDelivery(rumor: Pick<Rumor, 'kind' | 'content'>): VerifiedEvent | undefined {
  if (rumor.kind !== PRIVATE_GROUP_DELIVERY_KIND || rumor.content.length > 262144) return
  try {
    const value = JSON.parse(rumor.content)
    const event = value?.event
    if (value?.v !== 1 || value.type !== 'group-wake' || !event || event.kind !== 1060 ||
        !hasMetadataPrivacyVersion(event) || event.tags.some((tag: string[]) => tag[0] === 'p') || !verifyEvent(event)) return
    return event
  } catch { return }
}

export function privateGroupDeliveryRumor(event: VerifiedEvent, groupId: string, device: string, recipient?: string, innerEventId?: string): Rumor {
  const rumor: Rumor = { id: '', pubkey: device, kind: PRIVATE_GROUP_DELIVERY_KIND,
    content: JSON.stringify({ v: 1, type: 'group-wake', event }), created_at: event.created_at,
    tags: [['l', groupId], ...(recipient ? [['p', recipient]] : []), ...(innerEventId ? [['e', innerEventId, '', 'group-message']] : [])] }
  rumor.id = getEventHash(rumor)
  return rumor
}

export interface PrivateGroupPreviewOptions {
  storage: StorageAdapter
  ourOwnerPubkey: string
  ourDevicePubkey: string
  group: GroupData
  event: VerifiedEvent
  senderOwnerPubkey: string
}

export async function privateGroupDeliverySenderStatus(opts: PrivateGroupPreviewOptions): Promise<'unknown' | 'rejected' | 'authorized'> {
  if (!opts.group.members.includes(opts.ourOwnerPubkey) || !opts.group.members.includes(opts.senderOwnerPubkey)) return 'rejected'
  const prefix = `v1/broadcast-channel/group/${opts.group.id}/sender/`
  for (const key of await opts.storage.list(prefix)) {
    if (!key.endsWith('/sender-event-pubkey') || await opts.storage.get(key) !== opts.event.pubkey) continue
    const owner = await opts.storage.get(key.replace(/sender-event-pubkey$/, 'sender-owner-pubkey'))
    return owner === opts.senderOwnerPubkey ? 'authorized' : 'rejected'
  }
  return 'unknown'
}

/** Cold preview never advances the live sender chain or consumes an unacknowledged delivery. */
export async function previewPrivateGroupDelivery(opts: PrivateGroupPreviewOptions): Promise<GroupDecryptedEvent | null> {
  if (!parsePrivateGroupDelivery({kind: PRIVATE_GROUP_DELIVERY_KIND, content: JSON.stringify({v: 1, type: 'group-wake', event: opts.event})}) ||
      await privateGroupDeliverySenderStatus(opts) !== 'authorized') return null
  const copy = new InMemoryStorageAdapter()
  for (const key of await opts.storage.list(`v1/broadcast-channel/group/${opts.group.id}/`))
    await copy.put(key, structuredClone(await opts.storage.get(key)))
  const group = new Group({ data: opts.group, ourOwnerPubkey: opts.ourOwnerPubkey,
    ourDevicePubkey: opts.ourDevicePubkey, storage: copy })
  return group.handleOuterEvent(opts.event)
}

interface PendingPrivateGroupDelivery { event: VerifiedEvent; recipients: string[]; innerEventId?: string }
/** Persist the complete fanout before handing any copy to a recipient's durable ratchet queue. */
export class PrivateGroupDeliveryOutbox {
  constructor(private readonly storage: StorageAdapter, private readonly prefix: string,
    private readonly groupId: string, private readonly device: string) {}
  async enqueue(event: VerifiedEvent, recipients: string[], innerEventId?: string): Promise<void> {
    if (!parsePrivateGroupDelivery({kind: PRIVATE_GROUP_DELIVERY_KIND, content: JSON.stringify({v: 1, type: 'group-wake', event})}))
      throw new Error('Invalid or oversized private group delivery');
    await this.storage.put(`${this.prefix}/${event.id}`, { event, recipients: [...recipients], innerEventId })
  }
  async flush(send: PairwiseSend, members: string[]): Promise<boolean> {
    for (const key of await this.storage.list(`${this.prefix}/`)) {
      const stored = await this.storage.get<PendingPrivateGroupDelivery>(key)
      if (!stored) continue
      const job = structuredClone(stored)
      job.recipients = job.recipients.filter(member => members.includes(member))
      for (const recipient of [...job.recipients]) {
        try { await send(recipient, privateGroupDeliveryRumor(job.event, this.groupId, this.device, recipient, job.innerEventId)) }
        catch { continue }
        job.recipients = job.recipients.filter(member => member !== recipient)
        await this.storage.put(key, structuredClone(job))
      }
      if (!job.recipients.length) await this.storage.del(key)
    }
    return (await this.storage.list(`${this.prefix}/`)).length > 0
  }
}
