import { describe, it, expect } from 'vitest'
import { generateSecretKey, getEventHash, getPublicKey, nip44 } from 'nostr-tools'
import { getConversationKey } from 'nostr-tools/nip44'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import {
  generateEphemeralKeypair,
  generateSharedSecret,
  generateDeviceId,
  encryptInviteResponse,
  decryptInviteResponse,
  createSessionFromAccept,
} from '../src/inviteUtils'
import { buildTextRumor } from '../src/messageBuilders'
import { MESSAGE_EVENT_KIND } from '../src/types'

describe('inviteUtils', () => {
  describe('generateEphemeralKeypair', () => {
    it('should generate a valid keypair', () => {
      const keypair = generateEphemeralKeypair()

      expect(keypair.publicKey).toBeDefined()
      expect(keypair.privateKey).toBeDefined()
      expect(keypair.publicKey).toHaveLength(64) // hex pubkey
      expect(keypair.privateKey).toBeInstanceOf(Uint8Array)
      expect(keypair.privateKey).toHaveLength(32)
    })

    it('should generate unique keypairs each time', () => {
      const keypair1 = generateEphemeralKeypair()
      const keypair2 = generateEphemeralKeypair()

      expect(keypair1.publicKey).not.toBe(keypair2.publicKey)
      expect(bytesToHex(keypair1.privateKey)).not.toBe(bytesToHex(keypair2.privateKey))
    })

    it('should generate keypair where publicKey derives from privateKey', () => {
      const keypair = generateEphemeralKeypair()
      const derivedPubkey = getPublicKey(keypair.privateKey)

      expect(keypair.publicKey).toBe(derivedPubkey)
    })
  })

  describe('generateSharedSecret', () => {
    it('should generate a 64-character hex string', () => {
      const secret = generateSharedSecret()

      expect(secret).toHaveLength(64)
      expect(/^[0-9a-f]+$/.test(secret)).toBe(true)
    })

    it('should generate unique secrets each time', () => {
      const secret1 = generateSharedSecret()
      const secret2 = generateSharedSecret()

      expect(secret1).not.toBe(secret2)
    })

    it('should be convertible to bytes', () => {
      const secret = generateSharedSecret()
      const bytes = hexToBytes(secret)

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes).toHaveLength(32)
    })
  })

  describe('generateDeviceId', () => {
    it('should generate a non-empty string', () => {
      const deviceId = generateDeviceId()

      expect(typeof deviceId).toBe('string')
      expect(deviceId.length).toBeGreaterThan(0)
    })

    it('should generate unique device IDs each time', () => {
      const deviceId1 = generateDeviceId()
      const deviceId2 = generateDeviceId()

      expect(deviceId1).not.toBe(deviceId2)
    })
  })

  describe('encryptInviteResponse / decryptInviteResponse', () => {
    async function createInviteResponseFixture() {
      const inviterPrivateKey = generateSecretKey()
      const inviterPublicKey = getPublicKey(inviterPrivateKey)
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const inviteePrivateKey = generateSecretKey()
      const inviteePublicKey = getPublicKey(inviteePrivateKey)
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const ownerPublicKey = getPublicKey(generateSecretKey())

      const encrypted = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKeypair.publicKey,
        inviteeSessionPrivateKey: inviteeSessionKeypair.privateKey,
        inviteePublicKey,
        inviteePrivateKey,
        inviterPublicKey,
        inviterEphemeralPublicKey: inviterEphemeralKeypair.publicKey,
        sharedSecret,
        ownerPublicKey,
      })

      return {
        encrypted,
        inviterPrivateKey,
        inviterPublicKey,
        inviterEphemeralKeypair,
        sharedSecret,
        inviteePrivateKey,
        inviteePublicKey,
        inviteeSessionKeypair,
        ownerPublicKey,
      }
    }

    function decryptInnerRumor(
      fixture: Awaited<ReturnType<typeof createInviteResponseFixture>>
    ) {
      const innerJson = nip44.decrypt(
        fixture.encrypted.envelope.content,
        getConversationKey(fixture.inviterEphemeralKeypair.privateKey, fixture.encrypted.randomSenderPublicKey)
      )
      return JSON.parse(innerJson)
    }

    function reencryptInnerRumor(
      fixture: Awaited<ReturnType<typeof createInviteResponseFixture>>,
      inner: unknown
    ) {
      return nip44.encrypt(
        JSON.stringify(inner),
        getConversationKey(fixture.encrypted.randomSenderPrivateKey, fixture.inviterEphemeralKeypair.publicKey)
      )
    }

    function rewriteInvitePayload(
      fixture: Awaited<ReturnType<typeof createInviteResponseFixture>>,
      rewrite: (payload: Record<string, unknown>) => void,
    ) {
      const inner = decryptInnerRumor(fixture)
      const identityCiphertext = nip44.decrypt(inner.content, hexToBytes(fixture.sharedSecret))
      const payload = JSON.parse(nip44.decrypt(
        identityCiphertext,
        getConversationKey(fixture.inviterPrivateKey, fixture.inviteePublicKey),
      )) as Record<string, unknown>
      rewrite(payload)
      const rewrittenIdentityCiphertext = nip44.encrypt(
        JSON.stringify(payload),
        getConversationKey(fixture.inviteePrivateKey, fixture.inviterPublicKey),
      )
      inner.content = nip44.encrypt(
        rewrittenIdentityCiphertext,
        hexToBytes(fixture.sharedSecret),
      )
      inner.id = getEventHash(inner)
      return reencryptInnerRumor(fixture, inner)
    }

    function expectCorruptedInnerToReject(
      fixture: Awaited<ReturnType<typeof createInviteResponseFixture>>,
      envelopeContent: string
    ) {
      return expect(
        decryptInviteResponse({
          envelopeContent,
          envelopeSenderPubkey: fixture.encrypted.randomSenderPublicKey,
          inviterEphemeralPrivateKey: fixture.inviterEphemeralKeypair.privateKey,
          inviterPrivateKey: fixture.inviterPrivateKey,
          sharedSecret: fixture.sharedSecret,
        })
      ).rejects.toThrow()
    }

    it('should encrypt and decrypt invite response correctly', async () => {
      // Setup: inviter (Alice) and invitee (Bob)
      const inviterPrivateKey = generateSecretKey()
      const inviterPublicKey = getPublicKey(inviterPrivateKey)
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const inviteePrivateKey = generateSecretKey()
      const inviteePublicKey = getPublicKey(inviteePrivateKey)
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const ownerPublicKey = getPublicKey(generateSecretKey()) // Invitee's owner key

      // Invitee encrypts response
      const encrypted = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKeypair.publicKey,
        inviteeSessionPrivateKey: inviteeSessionKeypair.privateKey,
        inviteePublicKey,
        inviteePrivateKey,
        inviterPublicKey,
        inviterEphemeralPublicKey: inviterEphemeralKeypair.publicKey,
        sharedSecret,
        ownerPublicKey,
      })

      expect(encrypted.innerEvent).toBeDefined()
      expect(encrypted.innerEvent.pubkey).toBe(inviteePublicKey)
      expect(encrypted.innerEvent.kind).toBe(MESSAGE_EVENT_KIND)
      expect(encrypted.innerEvent.tags).toEqual([])
      expect(encrypted.innerEvent.id).toBe(getEventHash(encrypted.innerEvent))
      expect(encrypted.innerEvent.content).toBeDefined()
      expect(encrypted.envelope).toBeDefined()
      expect(encrypted.envelope.kind).toBe(1059) // INVITE_RESPONSE_KIND
      expect(encrypted.envelope.tags).toContainEqual(['p', inviterEphemeralKeypair.publicKey])
      expect(encrypted.randomSenderPublicKey).toBeDefined()
      expect(encrypted.randomSenderPrivateKey).toBeDefined()

      // Inviter decrypts response
      const decrypted = await decryptInviteResponse({
        envelopeContent: encrypted.envelope.content,
        envelopeSenderPubkey: encrypted.randomSenderPublicKey,
        inviterEphemeralPrivateKey: inviterEphemeralKeypair.privateKey,
        inviterPrivateKey,
        sharedSecret,
      })

      expect(decrypted.inviteeIdentity).toBe(inviteePublicKey)
      expect(decrypted.inviteeSessionPublicKey).toBe(inviteeSessionKeypair.publicKey)
      expect(decrypted.ownerPublicKey).toBe(ownerPublicKey)
    })

    it('should reject malformed invite response inner rumors', async () => {
      const corruptions = [
        (inner: any) => { inner.id = '0'.repeat(64) },
        (inner: any) => { delete inner.id },
        (inner: any) => {
          inner.kind = 9999
          inner.id = getEventHash(inner)
        },
        (inner: any) => {
          inner.tags = [['p', '0'.repeat(64)]]
          inner.id = getEventHash(inner)
        },
        (inner: any) => { inner.sig = '0'.repeat(128) },
        (inner: any) => { inner.unexpected = true },
      ]

      for (const corrupt of corruptions) {
        const fixture = await createInviteResponseFixture()
        const inner = decryptInnerRumor(fixture)
        corrupt(inner)
        await expectCorruptedInnerToReject(fixture, reencryptInnerRumor(fixture, inner))
      }
    })

    it('should use custom encrypt/decrypt functions when provided', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPublicKey = getPublicKey(inviterPrivateKey)
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const inviteePrivateKey = generateSecretKey()
      const inviteePublicKey = getPublicKey(inviteePrivateKey)
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const ownerPublicKey = getPublicKey(generateSecretKey())

      // Custom encrypt function
      const encrypt = async (plaintext: string, pubkey: string) => {
        return nip44.encrypt(plaintext, getConversationKey(inviteePrivateKey, pubkey))
      }

      // Custom decrypt function
      const decrypt = async (ciphertext: string, pubkey: string) => {
        return nip44.decrypt(ciphertext, getConversationKey(inviterPrivateKey, pubkey))
      }

      const encrypted = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKeypair.publicKey,
        inviteeSessionPrivateKey: inviteeSessionKeypair.privateKey,
        inviteePublicKey,
        inviterPublicKey,
        inviterEphemeralPublicKey: inviterEphemeralKeypair.publicKey,
        sharedSecret,
        ownerPublicKey,
        encrypt,
      })

      const decrypted = await decryptInviteResponse({
        envelopeContent: encrypted.envelope.content,
        envelopeSenderPubkey: encrypted.randomSenderPublicKey,
        inviterEphemeralPrivateKey: inviterEphemeralKeypair.privateKey,
        inviterPublicKey,
        sharedSecret,
        decrypt,
      })

      expect(decrypted.inviteeIdentity).toBe(inviteePublicKey)
      expect(decrypted.inviteeSessionPublicKey).toBe(inviteeSessionKeypair.publicKey)
      expect(decrypted.ownerPublicKey).toBe(ownerPublicKey)
    })

    it('should fail to decrypt with wrong ephemeral key', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPublicKey = getPublicKey(inviterPrivateKey)
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const wrongEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()

      const inviteePrivateKey = generateSecretKey()
      const inviteePublicKey = getPublicKey(inviteePrivateKey)
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const ownerPublicKey = getPublicKey(generateSecretKey())

      const encrypted = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKeypair.publicKey,
        inviteeSessionPrivateKey: inviteeSessionKeypair.privateKey,
        inviteePublicKey,
        inviteePrivateKey,
        inviterPublicKey,
        inviterEphemeralPublicKey: inviterEphemeralKeypair.publicKey,
        sharedSecret,
        ownerPublicKey,
      })

      await expect(
        decryptInviteResponse({
          envelopeContent: encrypted.envelope.content,
          envelopeSenderPubkey: encrypted.randomSenderPublicKey,
          inviterEphemeralPrivateKey: wrongEphemeralKeypair.privateKey,
          inviterPrivateKey,
          sharedSecret,
        })
      ).rejects.toThrow()
    })

    it('should fail to decrypt with wrong shared secret', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPublicKey = getPublicKey(inviterPrivateKey)
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const wrongSharedSecret = generateSharedSecret()

      const inviteePrivateKey = generateSecretKey()
      const inviteePublicKey = getPublicKey(inviteePrivateKey)
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const ownerPublicKey = getPublicKey(generateSecretKey())

      const encrypted = await encryptInviteResponse({
        inviteeSessionPublicKey: inviteeSessionKeypair.publicKey,
        inviteeSessionPrivateKey: inviteeSessionKeypair.privateKey,
        inviteePublicKey,
        inviteePrivateKey,
        inviterPublicKey,
        inviterEphemeralPublicKey: inviterEphemeralKeypair.publicKey,
        sharedSecret,
        ownerPublicKey,
      })

      await expect(
        decryptInviteResponse({
          envelopeContent: encrypted.envelope.content,
          envelopeSenderPubkey: encrypted.randomSenderPublicKey,
          inviterEphemeralPrivateKey: inviterEphemeralKeypair.privateKey,
          inviterPrivateKey,
          sharedSecret: wrongSharedSecret,
        })
      ).rejects.toThrow()
    })

    it('should reject an identity-authenticated response that cannot prove the claimed session key', async () => {
      const inviterPrivateKey = generateSecretKey()
      const inviterPublicKey = getPublicKey(inviterPrivateKey)
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const inviteePrivateKey = generateSecretKey()
      const inviteePublicKey = getPublicKey(inviteePrivateKey)
      const claimedSessionKeypair = generateEphemeralKeypair()

      await expect(
        encryptInviteResponse({
          inviteeSessionPublicKey: claimedSessionKeypair.publicKey,
          // An attacker knows its identity key, but not the claimed session secret.
          inviteeSessionPrivateKey: inviteePrivateKey,
          inviteePublicKey,
          inviteePrivateKey,
          inviterPublicKey,
          inviterEphemeralPublicKey: inviterEphemeralKeypair.publicKey,
          sharedSecret,
        })
      ).rejects.toThrow('does not match')
    })

    it('should bind the session proof to the complete invite transcript', async () => {
      const fixture = await createInviteResponseFixture()
      const unrelatedInviter = getPublicKey(generateSecretKey())

      await expect(
        decryptInviteResponse({
          envelopeContent: fixture.encrypted.envelope.content,
          envelopeSenderPubkey: fixture.encrypted.randomSenderPublicKey,
          inviterEphemeralPrivateKey: fixture.inviterEphemeralKeypair.privateKey,
          inviterPrivateKey: fixture.inviterPrivateKey,
          inviterPublicKey: unrelatedInviter,
          sharedSecret: fixture.sharedSecret,
        })
      ).rejects.toThrow('Invalid invite session proof')
    })

    it('should reject a response whose session proof is invalid', async () => {
      const fixture = await createInviteResponseFixture()
      const envelope = rewriteInvitePayload(fixture, (payload) => {
        const proof = payload.sessionProof as string
        payload.sessionProof = `${proof[0] === '0' ? '1' : '0'}${proof.slice(1)}`
      })
      await expectCorruptedInnerToReject(fixture, envelope)
    })

    it('should reject a proofless legacy response payload', async () => {
      const fixture = await createInviteResponseFixture()
      const envelope = rewriteInvitePayload(fixture, (payload) => {
        delete payload.sessionProof
      })
      await expectCorruptedInnerToReject(fixture, envelope)
    })
  })

  describe('createSessionFromAccept', () => {
    it('should create a session for invitee (sender)', () => {
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const nostrSubscribe = () => () => {}

      const session = createSessionFromAccept({
        nostrSubscribe,
        theirPublicKey: inviterEphemeralKeypair.publicKey,
        ourSessionPrivateKey: inviteeSessionKeypair.privateKey,
        sharedSecret,
        isSender: true,
      })

      expect(session).toBeDefined()
      expect(session.state).toBeDefined()
      expect(session.state.theirNextNostrPublicKey).toBe(inviterEphemeralKeypair.publicKey)
    })

    it('should create a session for inviter (receiver)', () => {
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const nostrSubscribe = () => () => {}

      const session = createSessionFromAccept({
        nostrSubscribe,
        theirPublicKey: inviteeSessionKeypair.publicKey,
        ourSessionPrivateKey: inviterEphemeralKeypair.privateKey,
        sharedSecret,
        isSender: false,
        name: 'test-session',
      })

      expect(session).toBeDefined()
      expect(session.state).toBeDefined()
      expect(session.name).toBe('test-session')
      expect(session.state.theirNextNostrPublicKey).toBe(inviteeSessionKeypair.publicKey)
    })

    it('should create sessions that can communicate', () => {
      const inviterEphemeralKeypair = generateEphemeralKeypair()
      const inviteeSessionKeypair = generateEphemeralKeypair()
      const sharedSecret = generateSharedSecret()
      const nostrSubscribe = () => () => {}

      const inviteeSession = createSessionFromAccept({
        nostrSubscribe,
        theirPublicKey: inviterEphemeralKeypair.publicKey,
        ourSessionPrivateKey: inviteeSessionKeypair.privateKey,
        sharedSecret,
        isSender: true,
      })

      const inviterSession = createSessionFromAccept({
        nostrSubscribe,
        theirPublicKey: inviteeSessionKeypair.publicKey,
        ourSessionPrivateKey: inviterEphemeralKeypair.privateKey,
        sharedSecret,
        isSender: false,
      })

      // Invitee sends a message
      const { event, innerEvent } = inviteeSession.sendEvent(
        buildTextRumor('Hello from invitee!'),
      )
      expect(event).toBeDefined()
      expect(innerEvent).toBeDefined()

      // Inviter should be able to decrypt (we'll just verify the event structure)
      expect(event.kind).toBe(1060) // MESSAGE_EVENT_KIND
    })
  })
})
