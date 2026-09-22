import { getPublicKey, nip44, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import { AppKeys } from './AppKeys.js'
import { INVITE_RESPONSE_KIND } from './types.js'

export const INVITE_OWNER_PROOF_TAG = 'owner-proof'
const MAX_PROOF_BYTES = 32 * 1024
const MAX_DEVICES = 64

export function validInviteOwnerProof(event: VerifiedEvent, owner?: string, device?: string): boolean {
  try {
    if (new TextEncoder().encode(JSON.stringify(event)).length > MAX_PROOF_BYTES ||
        !verifyEvent(event) || event.created_at > Math.floor(Date.now() / 1000) + 300 ||
        (owner && event.pubkey !== owner)) return false
    const keys = AppKeys.fromEvent(event)
    return keys.getAllDevices().length <= MAX_DEVICES && (!device || !!keys.getDevice(device))
  } catch { return false }
}

// Only the existing random envelope secret is needed. The signed authorization
// is public data that a linked device receives from its approving device.
export function encryptInviteOwnerProof(proof: VerifiedEvent, senderSecret: Uint8Array, recipientEphemeral: string): string {
  if (!validInviteOwnerProof(proof)) throw new Error('Invalid invite owner proof')
  return nip44.encrypt(JSON.stringify(proof), nip44.getConversationKey(senderSecret, recipientEphemeral))
}

export function decryptInviteOwnerProof(event: VerifiedEvent, recipientSecret: Uint8Array): VerifiedEvent | undefined {
  try {
    if (!verifyEvent(event) || event.kind !== INVITE_RESPONSE_KIND ||
        event.tags.find(t => t[0] === 'p')?.[1] !== getPublicKey(recipientSecret)) return undefined
    const tags = event.tags.filter(t => t[0] === INVITE_OWNER_PROOF_TAG)
    if (tags.length !== 1 || tags[0].length !== 2 || tags[0][1].length > MAX_PROOF_BYTES * 2) return undefined
    const json = nip44.decrypt(tags[0][1], nip44.getConversationKey(recipientSecret, event.pubkey))
    if (new TextEncoder().encode(json).length > MAX_PROOF_BYTES) return undefined
    const proof = JSON.parse(json) as VerifiedEvent
    return validInviteOwnerProof(proof) ? proof : undefined
  } catch { return undefined }
}
