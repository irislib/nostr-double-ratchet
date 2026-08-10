import { generateSecretKey, getEventHash, getPublicKey, nip44 } from 'nostr-tools'
import { getConversationKey } from 'nostr-tools/nip44'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
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
  /** The invitee's session private key, used only to prove control of the session key */
  inviteeSessionPrivateKey: Uint8Array
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
const SESSION_PROOF_DOMAIN = new TextEncoder().encode('NIP-118/session-proof/v1')
const now = () => Math.round(Date.now() / 1000)
const randomNow = () => Math.round(now() - Math.random() * TWO_DAYS)

function requireLowerHex(value: unknown, bytes: number, field: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

function sessionProofDigest(
  inviterIdentity: string,
  inviterEphemeral: string,
  inviteeIdentity: string,
  sessionKey: string,
  sharedSecret: string,
): Uint8Array {
  const values = [
    requireLowerHex(inviterIdentity, 32, 'inviter identity'),
    requireLowerHex(inviterEphemeral, 32, 'inviter ephemeral key'),
    requireLowerHex(inviteeIdentity, 32, 'invitee identity'),
    requireLowerHex(sessionKey, 32, 'session key'),
    requireLowerHex(sharedSecret, 32, 'shared secret'),
  ]
  const transcript = new Uint8Array(SESSION_PROOF_DOMAIN.length + values.length * 32)
  transcript.set(SESSION_PROOF_DOMAIN)
  let offset = SESSION_PROOF_DOMAIN.length
  for (const value of values) {
    transcript.set(hexToBytes(value), offset)
    offset += 32
  }
  return sha256(transcript)
}

function parseInviteResponseInnerRumor(json: string): Rumor {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid invite response inner rumor')
  }
  const expectedFields = ['content', 'created_at', 'id', 'kind', 'pubkey', 'tags']
  const actualFields = Object.keys(parsed).sort()
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new Error('Invalid invite response inner rumor')
  }
  const rumor = parsed as Rumor
  if (
    !/^[0-9a-f]{64}$/.test(rumor.id) ||
    !/^[0-9a-f]{64}$/.test(rumor.pubkey) ||
    typeof rumor.content !== 'string' ||
    !Number.isSafeInteger(rumor.created_at) ||
    rumor.created_at < 0 ||
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
    inviteeSessionPrivateKey,
    inviteePublicKey,
    inviteePrivateKey,
    inviterPublicKey,
    inviterEphemeralPublicKey,
    sharedSecret,
    ownerPublicKey,
    encrypt,
  } = params

  const sharedSecretBytes = hexToBytes(sharedSecret)

  if (getPublicKey(inviteeSessionPrivateKey) !== inviteeSessionPublicKey) {
    throw new Error('inviteeSessionPrivateKey does not match inviteeSessionPublicKey')
  }

  // Create the encrypt function
  const encryptFn = encrypt ?? (async (plaintext: string, pubkey: string) => {
    if (!inviteePrivateKey) {
      throw new Error('inviteePrivateKey is required when encrypt function is not provided')
    }
    return nip44.encrypt(plaintext, getConversationKey(inviteePrivateKey, pubkey))
  })

  // Create the payload
  // Note: deviceId is no longer needed - inviteePublicKey (identity) serves as device ID
  const sessionProof = bytesToHex(schnorr.sign(
    sessionProofDigest(
      inviterPublicKey,
      inviterEphemeralPublicKey,
      inviteePublicKey,
      inviteeSessionPublicKey,
      sharedSecret,
    ),
    inviteeSessionPrivateKey,
  ))
  const payload = JSON.stringify({
    sessionKey: inviteeSessionPublicKey,
    sessionProof,
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
  /** The inviter's identity public key (required when only a custom decrypt function is provided) */
  inviterPublicKey?: string
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
    inviterPublicKey,
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

  const parsed: unknown = JSON.parse(decryptedPayload)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid invite response payload')
  }
  const payload = parsed as Record<string, unknown>
  const allowedFields = new Set(['sessionKey', 'sessionProof', 'ownerPublicKey', 'deviceId'])
  if (Object.keys(payload).some((field) => !allowedFields.has(field))) {
    throw new Error('Invalid invite response payload')
  }
  const inviteeSessionPublicKey = requireLowerHex(payload.sessionKey, 32, 'session key')
  const sessionProof = requireLowerHex(payload.sessionProof, 64, 'invite session proof')
  const ownerPublicKey = payload.ownerPublicKey === undefined
    ? undefined
    : requireLowerHex(payload.ownerPublicKey, 32, 'owner public key')
  if (payload.deviceId !== undefined && typeof payload.deviceId !== 'string') {
    throw new Error('Invalid device id')
  }

  const resolvedInviterPublicKey = inviterPublicKey ??
    (inviterPrivateKey ? getPublicKey(inviterPrivateKey) : undefined)
  if (!resolvedInviterPublicKey) {
    throw new Error('inviterPublicKey is required when inviterPrivateKey is not provided')
  }
  const proofDigest = sessionProofDigest(
    resolvedInviterPublicKey,
    getPublicKey(inviterEphemeralPrivateKey),
    inviteeIdentity,
    inviteeSessionPublicKey,
    sharedSecret,
  )
  let validProof = false
  try {
    validProof = schnorr.verify(hexToBytes(sessionProof), proofDigest, hexToBytes(inviteeSessionPublicKey))
  } catch {
    validProof = false
  }
  if (!validProof) {
    throw new Error('Invalid invite session proof')
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
