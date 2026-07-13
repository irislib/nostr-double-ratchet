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
  it('should create a new invite link', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey, 'Test Device', 5)
    expect(invite.inviterEphemeralPublicKey).toHaveLength(64)
    expect(invite.sharedSecret).toHaveLength(64)
    expect(invite.inviter).toBe(alicePublicKey)
    expect(invite.deviceId).toBe('Test Device')
    expect(invite.maxUses).toBe(5)
  })

  it('should generate and parse URL correctly', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const url = invite.getUrl()
    const parsedInvite = Invite.fromUrl(url)
    expect(parsedInvite.inviter).toBe(invite.inviter)
    expect(parsedInvite.inviterEphemeralPublicKey).toBe(invite.inviterEphemeralPublicKey)
    expect(parsedInvite.sharedSecret).toBe(invite.sharedSecret)
  })

  it('should accept invite and create session', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { session, event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    expect(session).toBeDefined()
    expect(event).toBeDefined()
    expect(event.pubkey).not.toBe(bobPublicKey)
    expect(event.kind).toBe(INVITE_RESPONSE_KIND)
    expect(event.tags).toEqual([['p', invite.inviterEphemeralPublicKey]])
  })

  it('encodes invite response inner payload as an unsigned kind 1060 rumor', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)
    const innerJson = nip44.decrypt(
      event.content,
      getConversationKey(invite.inviterEphemeralPrivateKey!, event.pubkey)
    )
    const inner = JSON.parse(innerJson)

    expect(inner.pubkey).toBe(bobPublicKey)
    expect(inner.kind).toBe(MESSAGE_EVENT_KIND)
    expect(inner.tags).toEqual([])
    expect(typeof inner.content).toBe('string')
    expect(inner.content.length).toBeGreaterThan(0)
    expect(inner.id).toBe(getEventHash(inner))
  })

  it('should listen for invite acceptances', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    const onSession = vi.fn()

    const mockSubscribe = (filter: any, callback: (event: any) => void) => {
      expect(filter.kinds).toEqual([INVITE_RESPONSE_KIND])
      expect(filter['#p']).toEqual([invite.inviterEphemeralPublicKey])
      callback(event)
      return () => {}
    }

    invite.listen(
      alicePrivateKey,
      mockSubscribe, 
      onSession
    )

    // Wait for any asynchronous operations to complete
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(onSession).toHaveBeenCalledTimes(1)
    const [session, identity] = onSession.mock.calls[0]
    expect(session).toBeDefined()
    expect(identity).toBe(bobPublicKey)
  })

  it('should allow invitee and inviter to exchange messages', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)

    let aliceSession: Session | undefined

    const bobOwnerPublicKey = getPublicKey(generateSecretKey())
    const { session: bobSession, event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    invite.listen(
      alicePrivateKey,
      (_filter: any, callback: (event: any) => void) => {
        callback(event)
        return () => {}
      },
      (session: Session) => {
        aliceSession = session
      }
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(aliceSession).toBeDefined()

    const sendAndExpect = (sender: Session, receiver: Session, message: string) => {
      const receivedMessage = receiver.receiveEvent(sendText(sender, message).event)
      expect(receivedMessage?.content).toBe(message)
    }

    sendAndExpect(bobSession, aliceSession!, 'Hello Alice!')
    sendAndExpect(aliceSession!, bobSession, 'Hi Bob!')
    sendAndExpect(bobSession, aliceSession!, 'How are you?')
    sendAndExpect(aliceSession!, bobSession, "I'm doing great, thanks!")
  })

  it('should require device ID for getEvent', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    
    expect(() => invite.getEvent()).toThrow('Device ID is required')
  })

  it('should convert between event and Invite correctly', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey, 'test-device')
    
    const event = invite.getEvent()
    expect(event.kind).toBe(INVITE_EVENT_KIND)
    expect(event.pubkey).toBe(alicePublicKey)
    expect(event.tags).toContainEqual(['ephemeralKey', invite.inviterEphemeralPublicKey])
    expect(event.tags).toContainEqual(['sharedSecret', invite.sharedSecret])
    expect(event.tags).toContainEqual(['d', 'double-ratchet/invites/test-device'])
    expect(event.tags).toContainEqual(['l', 'double-ratchet/invites'])

    const finalizedEvent = finalizeEvent(event, alicePrivateKey)
    const parsedInvite = Invite.fromEvent(finalizedEvent)
    
    expect(parsedInvite.inviterEphemeralPublicKey).toBe(invite.inviterEphemeralPublicKey)
    expect(parsedInvite.sharedSecret).toBe(invite.sharedSecret)
    expect(parsedInvite.inviter).toBe(alicePublicKey)
  })

  it('treats public-addressed invite events as belonging to the inviter device', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey, 'public')

    const event = invite.getEvent()
    expect(event.tags).toContainEqual(['d', 'double-ratchet/invites/public'])

    const finalizedEvent = finalizeEvent(event, alicePrivateKey)
    const parsedInvite = Invite.fromEvent(finalizedEvent)

    expect(parsedInvite.deviceId).toBeUndefined()
    expect(parsedInvite.inviter).toBe(alicePublicKey)
  })

  it('waitFor prefers the canonical public invite over device-scoped invites', async () => {
    const relay = new MockRelay()
    const subscribe = (filter: any, onEvent: (event: any) => void) => relay.subscribe(filter, onEvent).close
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)

    const deviceInvite = Invite.createNew(alicePublicKey, alicePublicKey, 1)
    deviceInvite.createdAt = 10
    relay.storeAndDeliver(finalizeEvent(deviceInvite.getEvent(), alicePrivateKey))

    const publicInvite = Invite.createNew(alicePublicKey, 'public')
    publicInvite.createdAt = 11
    relay.storeAndDeliver(finalizeEvent(publicInvite.getEvent(), alicePrivateKey))

    const preferred = await Invite.waitFor(alicePublicKey, subscribe, 50)

    expect(preferred).not.toBeNull()
    expect(preferred?.deviceId).toBeUndefined()
    expect(preferred?.inviter).toBe(alicePublicKey)
  })

  it('fromUser emits the preferred public invite once both invite types are visible', async () => {
    const relay = new MockRelay()
    const subscribe = (filter: any, onEvent: (event: any) => void) => relay.subscribe(filter, onEvent).close
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const onInvite = vi.fn()

    const unsubscribe = Invite.fromUser(alicePublicKey, subscribe, onInvite)

    const deviceInvite = Invite.createNew(alicePublicKey, alicePublicKey, 1)
    deviceInvite.createdAt = 10
    relay.storeAndDeliver(finalizeEvent(deviceInvite.getEvent(), alicePrivateKey))

    const publicInvite = Invite.createNew(alicePublicKey, 'public')
    publicInvite.createdAt = 11
    relay.storeAndDeliver(finalizeEvent(publicInvite.getEvent(), alicePrivateKey))

    await new Promise((resolve) => setTimeout(resolve, 150))
    unsubscribe()

    expect(onInvite).toHaveBeenCalledTimes(1)
    expect(onInvite.mock.calls[0][0]?.deviceId).toBeUndefined()
    expect(onInvite.mock.calls[0][0]?.inviter).toBe(alicePublicKey)
  })

  it('should handle session reinitialization with serialization after invite acceptance', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)

    let aliceSession: Session | undefined

    const bobOwnerPublicKey = getPublicKey(generateSecretKey())
    const { session: bobSession, event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    invite.listen(
      alicePrivateKey,
      (_filter: any, callback: (event: any) => void) => {
        callback(event)
        return () => {}
      },
      (session: Session) => {
        aliceSession = session
      }
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(aliceSession).toBeDefined()

    const firstMessage = aliceSession!.receiveEvent(sendText(bobSession, 'Hello Alice!').event)
    expect(firstMessage?.content).toBe('Hello Alice!')

    // Alice closes her session and reinitializes with serialized state
    const serializedAliceState = serializeSessionState(aliceSession!.state)
    aliceSession!.close()
    aliceSession = new Session(deserializeSessionState(serializedAliceState))

    const secondMessage = aliceSession.receiveEvent(sendText(bobSession, 'Can you still hear me?').event)
    expect(secondMessage?.content).toBe('Can you still hear me?')
  })

  it('should accept invite with ownerPublicKey parameter', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { session, event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    expect(session).toBeDefined()
    expect(event).toBeDefined()
    expect(event.pubkey).not.toBe(bobPublicKey)
    expect(event.kind).toBe(INVITE_RESPONSE_KIND)
    expect(event.tags).toEqual([['p', invite.inviterEphemeralPublicKey]])
  })

  it('should pass identity to onSession callback', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    const onSession = vi.fn()

    const mockSubscribe = (filter: any, callback: (event: any) => void) => {
      expect(filter.kinds).toEqual([INVITE_RESPONSE_KIND])
      expect(filter['#p']).toEqual([invite.inviterEphemeralPublicKey])
      callback(event)
      return () => {}
    }

    invite.listen(
      alicePrivateKey,
      mockSubscribe,
      onSession
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(onSession).toHaveBeenCalledTimes(1)
    const [session, identity] = onSession.mock.calls[0]
    expect(session).toBeDefined()
    expect(identity).toBe(bobPublicKey)
  })

  it('should use event.id as session name', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    const onSession = vi.fn()

    const mockSubscribe = (filter: any, callback: (event: any) => void) => {
      callback(event)
      return () => {}
    }

    invite.listen(
      alicePrivateKey,
      mockSubscribe,
      onSession
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(onSession).toHaveBeenCalledTimes(1)
    const [session] = onSession.mock.calls[0]
    expect(session.name).toBe(event.id)
  })

  it('should use inviteePublicKey as device identity', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())

    const { event } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)

    const onSession = vi.fn()

    const mockSubscribe = (filter: any, callback: (event: any) => void) => {
      callback(event)
      return () => {}
    }

    invite.listen(
      alicePrivateKey,
      mockSubscribe,
      onSession
    )

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(onSession).toHaveBeenCalledTimes(1)
    const [session, identity] = onSession.mock.calls[0]
    expect(session).toBeDefined()
    // inviteePublicKey serves as both identity and device ID
    expect(identity).toBe(bobPublicKey)
    expect(session.name).toBe(event.id)
  })

  it('should handle multiple invite acceptances', async () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey)
    const bobSecretKey = generateSecretKey()
    const bobPublicKey = getPublicKey(bobSecretKey)
    const bobOwnerPublicKey = getPublicKey(generateSecretKey())
    const charlieSecretKey = generateSecretKey()
    const charliePublicKey = getPublicKey(charlieSecretKey)
    const charlieOwnerPublicKey = getPublicKey(generateSecretKey())

    const { event: bobEvent } = await invite.accept(bobPublicKey, bobSecretKey, bobOwnerPublicKey)
    const { event: charlieEvent } = await invite.accept(charliePublicKey, charlieSecretKey, charlieOwnerPublicKey)

    const onSession = vi.fn()

    const mockSubscribe = (filter: any, callback: (event: any) => void) => {
      callback(bobEvent)
      callback(charlieEvent)
      return () => {}
    }

    invite.listen(alicePrivateKey, mockSubscribe, onSession)

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(onSession).toHaveBeenCalledTimes(2)

    const calls = onSession.mock.calls
    const bobCall = calls.find(([, identity]) => identity === bobPublicKey)
    const charlieCall = calls.find(([, identity]) => identity === charliePublicKey)

    expect(bobCall).toBeDefined()
    expect(charlieCall).toBeDefined()

    // Both use inviteePublicKey as identity (which is also their device ID)
    expect(bobCall![1]).toBe(bobPublicKey)
    expect(bobCall![0].name).toBe(bobEvent.id)

    expect(charlieCall![1]).toBe(charliePublicKey)
    expect(charlieCall![0].name).toBe(charlieEvent.id)
  })

  it('should create valid deletion/tombstone event', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey, 'device-1')
    const tombstone = invite.getDeletionEvent()

    expect(tombstone.kind).toBe(INVITE_EVENT_KIND)
    expect(tombstone.pubkey).toBe(alicePublicKey)

    // Tombstone should have d-tag
    const dTag = tombstone.tags.find(t => t[0] === 'd')
    expect(dTag).toBeDefined()
    expect(dTag![1]).toBe('double-ratchet/invites/device-1')

    // Tombstone should NOT have keys (that's what makes it a tombstone)
    expect(tombstone.tags.some(t => t[0] === 'ephemeralKey')).toBe(false)
    expect(tombstone.tags.some(t => t[0] === 'sharedSecret')).toBe(false)
  })

  it('should require device ID for getDeletionEvent', () => {
    const alicePrivateKey = generateSecretKey()
    const alicePublicKey = getPublicKey(alicePrivateKey)
    const invite = Invite.createNew(alicePublicKey) // no deviceId

    expect(() => invite.getDeletionEvent()).toThrow('Device ID is required')
  })

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
})
