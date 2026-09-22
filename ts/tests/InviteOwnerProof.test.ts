import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type VerifiedEvent } from 'nostr-tools'
import { AppKeys } from '../src/AppKeys'
import { Invite } from '../src/Invite'
import { SessionManager } from '../src/SessionManager'
import { generateEphemeralKeypair, encryptInviteResponse } from '../src/inviteUtils'
import { buildTextRumor } from '../src/messageBuilders'
import { InMemoryStorageAdapter } from '../src/StorageAdapter'

class Receiver extends SessionManager {
  receiveHandshake(event: VerifiedEvent) { return this.processInviteResponseEvent(event) }
  receiveProof(event: VerifiedEvent) { return this.processAppKeysEvent(event) }
  receiveMessage(event: VerifiedEvent) { return this.processDirectMessageEvent(event) }
  saveOwner(owner: string) { return this.storeUserRecord(owner) }
}

function fixture() {
  const ownerSecret = generateSecretKey()
  const owner = getPublicKey(ownerSecret)
  const deviceSecret = generateSecretKey()
  const device = getPublicKey(deviceSecret)
  const receivingSecret = generateSecretKey()
  const receivingDevice = getPublicKey(receivingSecret)
  const invite = Invite.createNew(receivingDevice)
  const receiver = new Receiver(receivingDevice, receivingSecret, receivingDevice, () => () => {}, async e => e as VerifiedEvent, receivingDevice,
    { ephemeralKeypair: { publicKey: invite.inviterEphemeralPublicKey, privateKey: invite.inviterEphemeralPrivateKey! }, sharedSecret: invite.sharedSecret }, new InMemoryStorageAdapter())
  const proof = finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 10 }]).getEvent({ ownerPubkey: owner, createdAt: 10 }), ownerSecret)
  return { owner, ownerSecret, device, deviceSecret, invite, receiver, proof }
}

describe('encrypted handshake owner proof', () => {
  it.each([true, false])('accepts a proofless handshake with separate registration first=%s', async proofFirst => {
    const { owner, device, deviceSecret, invite, receiver, proof } = fixture()
    await receiver.init()
    try {
      // The original three-argument API produces the original wire format.
      const { event, session } = await invite.accept(device, deviceSecret, owner)
      expect(event.tags.some(tag => tag[0] === 'owner-proof')).toBe(false)
      if (proofFirst) await receiver.receiveProof(proof)
      expect(await receiver.receiveHandshake(event)).toBe(true)
      const received: string[] = []
      receiver.onEvent((rumor, sender) => received.push(`${sender}:${rumor.content}`))
      receiver.feedEvent(session.sendEvent(buildTextRumor('legacy message', { pubkey: owner })).event)
      if (!proofFirst) {
        expect(received).toEqual([])
        receiver.feedEvent(proof)
      }
      await vi.waitFor(() => expect(received).toEqual([`${owner}:legacy message`]))
    } finally { receiver.close() }
  })

  it('authorizes a linked sender without delivering a separate registration', async () => {
    const { owner, device, deviceSecret, invite, receiver, proof } = fixture()
    await receiver.init()
    try {
      const { event, session } = await invite.accept(device, deviceSecret, owner, proof)
      expect(await receiver.receiveHandshake(event)).toBe(true)
      expect(receiver.getUserRecords().get(owner)?.devices.get(device)?.inactiveSessions).toHaveLength(1)
      const wire = JSON.stringify(event)
      expect(wire).not.toContain(owner)
      expect(wire).not.toContain(device)
      expect(wire).not.toContain(proof.sig)
      const received: string[] = []
      receiver.onEvent((rumor, sender) => received.push(`${sender}:${rumor.content}`))
      expect(receiver.receiveMessage(session.sendEvent(buildTextRumor('hello', { pubkey: owner })).event)).toBe(true)
      expect(received).toEqual([`${owner}:hello`])
    } finally { receiver.close() }
  })
})

it('automatically carries persisted approval on a linked device without an account secret', async () => {
  const { owner, device, deviceSecret, invite, receiver, proof } = fixture()
  const localInvite = Invite.createNew(device)
  const storage = new InMemoryStorageAdapter()
  const createSender = () => new Receiver(device, deviceSecret, device, () => () => {}, async e => e as VerifiedEvent, owner,
    { ephemeralKeypair: { publicKey: localInvite.inviterEphemeralPublicKey, privateKey: localInvite.inviterEphemeralPrivateKey! }, sharedSecret: localInvite.sharedSecret }, storage)
  let sender = createSender()
  await sender.init()
  await sender.receiveProof(proof)
  await sender.saveOwner(owner)
  sender.close()
  sender = createSender()
  await sender.init()
  await receiver.init()
  try {
    await sender.acceptInvite(invite)
    const response = sender.drainEvents().find(e => e.type === 'publish' && e.event.kind === 1059)
    expect(response?.type).toBe('publish')
    if (response?.type !== 'publish') throw new Error('Missing response')
    await receiver.receiveHandshake(response.event as VerifiedEvent)
    expect(receiver.getUserRecords().get(owner)?.devices.get(device)?.inactiveSessions).toHaveLength(1)
  } finally { sender.close(); receiver.close() }
})

it.each(['forged', 'wrong-owner', 'wrong-device', 'future', 'revoked', 'conflicting', 'duplicate'])(
  'does not authorize a sender using a %s proof', async failure => {
    const { owner, ownerSecret, device, deviceSecret, invite, receiver, proof } = fixture()
    await receiver.init()
    try {
      const sessionKeys = generateEphemeralKeypair()
      const encrypted = await encryptInviteResponse({ inviteeSessionPublicKey: sessionKeys.publicKey,
        inviteeSessionPrivateKey: sessionKeys.privateKey, inviteePublicKey: device, inviteePrivateKey: deviceSecret,
        inviterPublicKey: invite.inviter, inviterEphemeralPublicKey: invite.inviterEphemeralPublicKey,
        sharedSecret: invite.sharedSecret, ownerPublicKey: owner })
      let candidate: VerifiedEvent = JSON.parse(JSON.stringify(proof))
      if (failure === 'forged') candidate.content = 'forged'
      if (failure === 'wrong-owner') {
        const stranger = generateSecretKey()
        candidate = finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 10 }]).getEvent({ ownerPubkey: getPublicKey(stranger), createdAt: 10 }), stranger)
      }
      if (failure === 'wrong-device') candidate = finalizeEvent(new AppKeys([{ identityPubkey: getPublicKey(generateSecretKey()), createdAt: 10 }]).getEvent({ ownerPubkey: owner, createdAt: 10 }), ownerSecret)
      if (failure === 'future') candidate = finalizeEvent({ ...proof, created_at: Math.floor(Date.now()/1000)+3600 }, ownerSecret)
      if (failure === 'revoked' || failure === 'conflicting') {
        const revocation = finalizeEvent(new AppKeys([]).getEvent({ ownerPubkey: owner, createdAt: failure === 'revoked' ? 20 : 10 }), ownerSecret)
        await receiver.receiveProof(revocation)
      }
      const tag = ['owner-proof', nip44.encrypt(JSON.stringify(candidate), nip44.getConversationKey(encrypted.randomSenderPrivateKey, invite.inviterEphemeralPublicKey))]
      encrypted.envelope.tags.push(tag)
      if (failure === 'duplicate') encrypted.envelope.tags.push(tag)
      const response = finalizeEvent(encrypted.envelope, encrypted.randomSenderPrivateKey)
      await receiver.receiveHandshake(response)
      const record = receiver.getUserRecords().get(owner)?.devices.get(device)
      expect(record?.activeSession).toBeUndefined()
      expect(record?.inactiveSessions ?? []).toHaveLength(0)
    } finally { receiver.close() }
  }
)
