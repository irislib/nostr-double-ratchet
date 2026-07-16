import { GROUP_ROSTER_FACT_KIND } from "../GroupMeta.js"
import {
  CHAT_SETTINGS_KIND,
  type ChatSettingsPayloadV1,
  type ExpirationOptions,
  type Rumor,
} from "../types.js"
import { resolveExpirationSeconds, upsertExpirationTag } from "../utils.js"

export type ExpirationOverride = ExpirationOptions | null | undefined

export interface ExpirationPolicyInput {
  kind: number
  nowSeconds: number
  tags: string[][]
  expirationOverride: ExpirationOverride
  defaultExpiration?: ExpirationOptions
  peerExpiration?: ExpirationOptions | null
  hasPeerExpiration: boolean
  groupExpiration?: ExpirationOptions | null
  hasGroupExpiration: boolean
}

export function expirationOverrideFromSendOptions(options: {
  expiration?: ExpirationOverride
  expiresAt?: number
  ttlSeconds?: number
}): ExpirationOverride {
  if (options.expiration !== undefined) {
    return options.expiration
  }

  if (options.expiresAt !== undefined || options.ttlSeconds !== undefined) {
    return { expiresAt: options.expiresAt, ttlSeconds: options.ttlSeconds }
  }

  return undefined
}

export function applyExpirationPolicy(input: ExpirationPolicyInput): void {
  if (
    input.kind === GROUP_ROSTER_FACT_KIND ||
    input.kind === CHAT_SETTINGS_KIND
  ) {
    return
  }

  if (input.expirationOverride === null) {
    return
  }

  let disabledByPolicy = false
  let effective: ExpirationOptions | undefined

  if (input.expirationOverride !== undefined) {
    effective = input.expirationOverride
  } else if (input.hasGroupExpiration) {
    if (input.groupExpiration === null) {
      disabledByPolicy = true
    } else {
      effective = input.groupExpiration
    }
  } else if (input.hasPeerExpiration) {
    if (input.peerExpiration === null) {
      disabledByPolicy = true
    } else {
      effective = input.peerExpiration
    }
  } else {
    effective = input.defaultExpiration
  }

  if (disabledByPolicy || !effective) {
    return
  }

  const expiresAt = resolveExpirationSeconds(effective, input.nowSeconds)
  if (expiresAt !== undefined) {
    upsertExpirationTag(input.tags, expiresAt)
  }
}

export interface ChatSettingsAdoption {
  peerPubkey: string
  options: ExpirationOptions | null | undefined
}

export function chatSettingsAdoptionForRumor(
  event: Rumor,
  fromOwnerPubkey: string,
  ownerPubkey: string,
): ChatSettingsAdoption | undefined {
  if (event.kind !== CHAT_SETTINGS_KIND) {
    return undefined
  }

  let payload: unknown
  try {
    payload = JSON.parse(event.content)
  } catch {
    return undefined
  }

  const settings = payload as Partial<ChatSettingsPayloadV1>
  if (settings?.type !== "chat-settings" || settings?.v !== 1) {
    return undefined
  }

  const recipientP = event.tags?.find((tag) => tag[0] === "p")?.[1]
  const peerPubkey =
    recipientP && recipientP !== ownerPubkey
      ? recipientP
      : fromOwnerPubkey && fromOwnerPubkey !== ownerPubkey
        ? fromOwnerPubkey
        : undefined

  if (!peerPubkey || peerPubkey === ownerPubkey) {
    return undefined
  }

  const ttl = settings.messageTtlSeconds
  if (ttl === undefined) {
    return { peerPubkey, options: undefined }
  }

  if (ttl === null || ttl === 0) {
    return { peerPubkey, options: null }
  }

  if (!Number.isFinite(ttl) || !Number.isSafeInteger(ttl) || ttl < 0) {
    return undefined
  }

  return { peerPubkey, options: { ttlSeconds: ttl } }
}
