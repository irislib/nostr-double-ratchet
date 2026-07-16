import { generateSecretKey, getEventHash, getPublicKey, nip44 } from 'nostr-tools'
import { getConversationKey } from 'nostr-tools/nip44'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { Session } from './Session.js'
import { INVITE_RESPONSE_KIND, MESSAGE_EVENT_KIND, EncryptFunction, DecryptFunction, KeyPair, Rumor } from './types.js'

/**
 * Device payload for QR code / text code sharing.
 */
export interface DevicePayload {
  /** Ephemeral public key (64 hex chars) */
  ephemeralPubkey: string
  /** Shared secret (64 hex chars) */
  sharedSecret: string
  /** Device ID (16 hex chars) */
  deviceId: string
  /** Human-readable device label */
  deviceLabel: string
  /** Identity public key for this device (64 hex chars) */
  identityPubkey: string
}

/**
 * Generates a new ephemeral keypair for invites.
 * @returns A keypair with publicKey (hex string) and privateKey (Uint8Array)
 */
export function generateEphemeralKeypair(): KeyPair {
  const privateKey = generateSecretKey()
  const publicKey = getPublicKey(privateKey)
  return { publicKey, privateKey }
}

/**
 * Generates a new shared secret for invite handshakes.
 * @returns A 64-character hex string (32 bytes)
 */
export function generateSharedSecret(): string {
  return bytesToHex(generateSecretKey())
}

/**
 * Generates a unique device ID.
 * @returns A random device ID string
 */
export function generateDeviceId(): string {
  return bytesToHex(generateSecretKey()).slice(0, 16)
}

export interface EncryptInviteResponseParams {
  /** The invitee's session public key */
  inviteeSessionPublicKey: string
  /** The invitee's identity public key (also serves as device ID) */
  inviteePublicKey: string
  /** The invitee's identity private key (optional if encrypt function provided) */
  inviteePrivateKey?: Uint8Array
  /** The inviter's identity public key */
  inviterPublicKey: string
  /** The inviter's ephemeral public key */
  inviterEphemeralPublicKey: string
  /** The shared secret for the invite */
  sharedSecret: string
  /** The invitee's owner/Nostr identity public key (optional for single-device users) */
  ownerPublicKey?: string
  /** Optional custom encrypt function */
  encrypt?: EncryptFunction
}

export interface EncryptedInviteResponse {
  /** The inner event containing the encrypted payload */
  innerEvent: Rumor
  /** The outer envelope event */
  envelope: {
    kind: number
    pubkey: string
    content: string
    created_at: number
    tags: string[][]
  }
  /** The random sender's public key used for the envelope */
  randomSenderPublicKey: string
  /** The random sender's private key used for the envelope */
  randomSenderPrivateKey: Uint8Array
}

const TWO_DAYS = 2 * 24 * 60 * 60
const now = () => Math.round(Date.now() / 1000)
const randomNow = () => Math.round(now() - Math.random() * TWO_DAYS)

function parseInviteResponseInnerRumor(json: string): Rumor {
  const rumor = JSON.parse(json) as Rumor
  if (
    typeof rumor.id !== 'string' ||
    rumor.kind !== MESSAGE_EVENT_KIND ||
    !Array.isArray(rumor.tags) ||
    rumor.tags.length !== 0 ||
    getEventHash(rumor) !== rumor.id
  ) {
    throw new Error('Invalid invite response inner rumor')
  }

  return rumor
}

/**
 * Encrypts an invite response with two-layer encryption.
 *
 * Layer 1 (inner): Payload encrypted with DH key, then encrypted with shared secret.
 * Layer 2 (outer): Envelope encrypted with random key -> inviter ephemeral key.
 */
export async function encryptInviteResponse(params: EncryptInviteResponseParams): Promise<EncryptedInviteResponse> {
  const {
    inviteeSessionPublicKey,
    inviteePublicKey,
    inviteePrivateKey,
    inviterPublicKey,
    inviterEphemeralPublicKey,
    sharedSecret,
    ownerPublicKey,
    encrypt,
  } = params

  const sharedSecretBytes = hexToBytes(sharedSecret)

  // Create the encrypt function
  const encryptFn = encrypt ?? (async (plaintext: string, pubkey: string) => {
    if (!inviteePrivateKey) {
      throw new Error('inviteePrivateKey is required when encrypt function is not provided')
    }
    return nip44.encrypt(plaintext, getConversationKey(inviteePrivateKey, pubkey))
  })

  // Create the payload
  // Note: deviceId is no longer needed - inviteePublicKey (identity) serves as device ID
  const payload = JSON.stringify({
    sessionKey: inviteeSessionPublicKey,
    ...(ownerPublicKey && { ownerPublicKey }),
  })

  // Encrypt with DH key (invitee -> inviter)
  const dhEncrypted = await encryptFn(payload, inviterPublicKey)

  // Encrypt with shared secret
  const innerEvent: Rumor = {
    id: '',
    pubkey: inviteePublicKey,
    content: nip44.encrypt(dhEncrypted, sharedSecretBytes),
    created_at: now(),
    kind: MESSAGE_EVENT_KIND,
    tags: [],
  }
  innerEvent.id = getEventHash(innerEvent)

  // Create a random keypair for the envelope sender
  const randomSenderPrivateKey = generateSecretKey()
  const randomSenderPublicKey = getPublicKey(randomSenderPrivateKey)

  // Encrypt the inner event with the random key -> inviter ephemeral key
  const innerJson = JSON.stringify(innerEvent)
  const envelope = {
    kind: INVITE_RESPONSE_KIND,
    pubkey: randomSenderPublicKey,
    content: nip44.encrypt(innerJson, getConversationKey(randomSenderPrivateKey, inviterEphemeralPublicKey)),
    created_at: randomNow(),
    tags: [['p', inviterEphemeralPublicKey]],
  }

  return {
    innerEvent,
    envelope,
    randomSenderPublicKey,
    randomSenderPrivateKey,
  }
}

export interface DecryptInviteResponseParams {
  /** The encrypted envelope content */
  envelopeContent: string
  /** The envelope sender's public key */
  envelopeSenderPubkey: string
  /** The inviter's ephemeral private key */
  inviterEphemeralPrivateKey: Uint8Array
  /** The inviter's identity private key (optional if decrypt function provided) */
  inviterPrivateKey?: Uint8Array
  /** The shared secret for the invite */
  sharedSecret: string
  /** Optional custom decrypt function */
  decrypt?: DecryptFunction
}

export interface DecryptedInviteResponse {
  /** The invitee's identity public key (also serves as device ID) */
  inviteeIdentity: string
  /** The invitee's session public key */
  inviteeSessionPublicKey: string
  /** The invitee's owner/Nostr identity public key (optional for backward compat) */
  ownerPublicKey?: string
}

/**
 * Decrypts an invite response.
 */
export async function decryptInviteResponse(params: DecryptInviteResponseParams): Promise<DecryptedInviteResponse> {
  const {
    envelopeContent,
    envelopeSenderPubkey,
    inviterEphemeralPrivateKey,
    inviterPrivateKey,
    sharedSecret,
    decrypt,
  } = params

  const sharedSecretBytes = hexToBytes(sharedSecret)

  // Decrypt the outer envelope
  const decrypted = nip44.decrypt(
    envelopeContent,
    getConversationKey(inviterEphemeralPrivateKey, envelopeSenderPubkey)
  )
  const innerEvent = parseInviteResponseInnerRumor(decrypted)

  const inviteeIdentity = innerEvent.pubkey

  // Decrypt the inner content using shared secret
  const dhEncrypted = nip44.decrypt(innerEvent.content, sharedSecretBytes)

  // Create the decrypt function
  const decryptFn = decrypt ?? (async (ciphertext: string, pubkey: string) => {
    if (!inviterPrivateKey) {
      throw new Error('inviterPrivateKey is required when decrypt function is not provided')
    }
    return nip44.decrypt(ciphertext, getConversationKey(inviterPrivateKey, pubkey))
  })

  // Decrypt using DH key
  const decryptedPayload = await decryptFn(dhEncrypted, inviteeIdentity)

  let inviteeSessionPublicKey: string
  let ownerPublicKey: string | undefined

  try {
    const parsed = JSON.parse(decryptedPayload)
    inviteeSessionPublicKey = parsed.sessionKey
    ownerPublicKey = parsed.ownerPublicKey
  } catch {
    // Backward compatibility: plain session key
    inviteeSessionPublicKey = decryptedPayload
  }

  return {
    inviteeIdentity,
    inviteeSessionPublicKey,
    ownerPublicKey,
  }
}

export interface CreateSessionFromAcceptParams {
  /** The other party's public key */
  theirPublicKey: string
  /** Our session private key */
  ourSessionPrivateKey: Uint8Array
  /** The shared secret (hex string) */
  sharedSecret: string
  /** Whether we are the sender (initiator) */
  isSender: boolean
  /** Optional session name */
  name?: string
}

/**
 * Creates a Session from invite acceptance parameters.
 */
export function createSessionFromAccept(params: CreateSessionFromAcceptParams): Session {
  const {
    theirPublicKey,
    ourSessionPrivateKey,
    sharedSecret,
    isSender,
    name,
  } = params

  const sharedSecretBytes = hexToBytes(sharedSecret)
  return Session.init(theirPublicKey, ourSessionPrivateKey, isSender, sharedSecretBytes, name)
}
