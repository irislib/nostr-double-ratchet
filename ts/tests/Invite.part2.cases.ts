import { describe, it, expect, vi } from 'vitest'
import { Invite } from '../src/Invite'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44 } from 'nostr-tools'
import { getConversationKey } from 'nostr-tools/nip44'
import { INVITE_EVENT_KIND, INVITE_RESPONSE_KIND, MESSAGE_EVENT_KIND } from '../src/types'
import { Session } from '../src/Session'
import { buildTextRumor } from '../src/messageBuilders'
import { serializeSessionState, deserializeSessionState } from '../src/utils'
import { MockRelay } from './helpers/mockRelay'

function sendText(session: Session, text: string) {
  return session.sendEvent(buildTextRumor(text))
}

describe('Invite', () => {



describe('Invite Link URL serialization', () => {
    it('should serialize and deserialize invite link correctly', () => {
      const alicePrivateKey = generateSecretKey()
      const alicePublicKey = getPublicKey(alicePrivateKey)
      const label = 'Test Invite'
      const maxUses = 5

      const invite = Invite.createNew(alicePublicKey, label, maxUses)
      expect(invite.maxUses).toBe(maxUses)
      expect(invite.inviter).toBe(alicePublicKey)
      expect(invite.inviterEphemeralPublicKey).toHaveLength(64)
      expect(invite.sharedSecret).toHaveLength(64)

      const url = invite.getUrl()
      expect(url).toContain('https://chat.iris.to/#')
      const urlData = JSON.parse(decodeURIComponent(new URL(url).hash.slice(1)))
      expect(urlData.inviter).toBe(alicePublicKey)
      expect(urlData.ephemeralKey).toBe(invite.inviterEphemeralPublicKey)
      expect(urlData.sharedSecret).toBe(invite.sharedSecret)

      const parsedInvite = Invite.fromUrl(url)
      expect(parsedInvite.inviter).toBe(alicePublicKey)
      expect(parsedInvite.inviterEphemeralPublicKey).toBe(invite.inviterEphemeralPublicKey)
      expect(parsedInvite.sharedSecret).toBe(invite.sharedSecret)
      expect(parsedInvite.maxUses).toBeUndefined() // maxUses is not included in URL
    })

    it('should include purpose and owner pubkey in invite link when provided', () => {
      const alicePrivateKey = generateSecretKey()
      const alicePublicKey = getPublicKey(alicePrivateKey)
      const ownerPublicKey = getPublicKey(generateSecretKey())

      const invite = Invite.createNew(alicePublicKey, undefined, undefined, {
        purpose: 'link',
        ownerPubkey: ownerPublicKey,
      })

      const url = invite.getUrl()
      const urlData = JSON.parse(decodeURIComponent(new URL(url).hash.slice(1)))

      expect(urlData.purpose).toBe('link')
      expect(urlData.owner).toBe(ownerPublicKey)

      const parsedInvite = Invite.fromUrl(url)
      expect(parsedInvite.purpose).toBe('link')
      expect(parsedInvite.ownerPubkey).toBe(ownerPublicKey)
    })

    it('should parse inviterEphemeralPublicKey from invite URL hash', () => {
      const alicePrivateKey = generateSecretKey()
      const alicePublicKey = getPublicKey(alicePrivateKey)
      const invite = Invite.createNew(alicePublicKey, 'Alias Field Test')

      const payload = {
        inviter: alicePublicKey,
        inviterEphemeralPublicKey: invite.inviterEphemeralPublicKey,
        sharedSecret: invite.sharedSecret,
      }
      const url = `https://chat.iris.to/#${encodeURIComponent(JSON.stringify(payload))}`

      const parsedInvite = Invite.fromUrl(url)
      expect(parsedInvite.inviter).toBe(alicePublicKey)
      expect(parsedInvite.inviterEphemeralPublicKey).toBe(invite.inviterEphemeralPublicKey)
      expect(parsedInvite.sharedSecret).toBe(invite.sharedSecret)
    })

    it('should handle invite link with custom root URL', () => {
      const alicePrivateKey = generateSecretKey()
      const alicePublicKey = getPublicKey(alicePrivateKey)
      const invite = Invite.createNew(alicePublicKey, 'Custom URL Test')

      const customUrl = invite.getUrl('https://custom.example.com')
      expect(customUrl).toContain('https://custom.example.com/#')

      const parsedInvite = Invite.fromUrl(customUrl)
      expect(parsedInvite.inviter).toBe(alicePublicKey)
      expect(parsedInvite.inviterEphemeralPublicKey).toBe(invite.inviterEphemeralPublicKey)
    })

    it('should throw error for invalid URL', () => {
      expect(() => Invite.fromUrl('https://iris.to/')).toThrow('No invite data found in the URL hash')
      expect(() => Invite.fromUrl('https://chat.iris.to/#invalid')).toThrow('Invite data in URL hash is not valid JSON')
      expect(() => Invite.fromUrl('https://chat.iris.to/#{}')).toThrow('Missing required fields')
    })

    it('should allow communication after serializing and deserializing invite for both parties', async () => {
      const alicePrivateKey = generateSecretKey()
      const alicePublicKey = getPublicKey(alicePrivateKey)
      const bobPrivateKey = generateSecretKey()
      const bobPublicKey = getPublicKey(bobPrivateKey)

      const invite = Invite.createNew(alicePublicKey, 'Serialized Test')
      const inviteUrl = invite.getUrl()

      const bobInvite = Invite.fromUrl(inviteUrl)

      let aliceSession: Session | undefined

      const bobOwnerPublicKey = getPublicKey(generateSecretKey())
      const { session: bobSession, event: acceptanceEvent } = await bobInvite.accept(bobPublicKey,
        bobPrivateKey,
        bobOwnerPublicKey
      )

      const aliceSessionPromise = new Promise<Session>((resolve) => {
        invite.listen(
          alicePrivateKey,
          (_filter: any, callback: (event: any) => void) => {
            callback(acceptanceEvent)
            return () => {}
          },
          (session: Session) => {
            aliceSession = session
            resolve(session)
          }
        )
      })

      await aliceSessionPromise
      expect(aliceSession).toBeDefined()

      const bobMessage1 = sendText(bobSession, 'Hello Alice from Bob!')
      const aliceReceived1 = aliceSession!.receiveEvent(bobMessage1.event)
      expect(aliceReceived1?.content).toBe('Hello Alice from Bob!')

      const aliceMessage1 = sendText(aliceSession!, 'Hi Bob from Alice!')
      const bobReceived1 = bobSession.receiveEvent(aliceMessage1.event)
      expect(bobReceived1?.content).toBe('Hi Bob from Alice!')
    })
  })
});
