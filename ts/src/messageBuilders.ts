import { getEventHash } from "nostr-tools"

import {
  CHAT_MESSAGE_KIND,
  EXPIRATION_TAG,
  REACTION_KIND,
  RECEIPT_KIND,
  TYPING_KIND,
  type ExpirationOptions,
  type ReceiptType,
  type Rumor,
} from "./types.js"
import { resolveExpirationSeconds, upsertExpirationTag } from "./utils.js"

export const DUMMY_INNER_PUBKEY =
  "0000000000000000000000000000000000000000000000000000000000000000"

export interface RumorBuildOptions {
  pubkey?: string
  createdAt?: number
  nowMs?: number
  tags?: string[][]
  expiration?: ExpirationOptions | null
  ensureMsTag?: boolean
}

export interface RumorBuildInput extends RumorBuildOptions {
  kind: number
  content?: string
}

export function expirationTagForOptions(
  options: ExpirationOptions,
  nowSeconds: number,
): string[] | undefined {
  const expiresAt = resolveExpirationSeconds(options, nowSeconds)
  if (expiresAt === undefined) return undefined
  return [EXPIRATION_TAG, String(expiresAt)]
}

export function appendExpirationTag(
  tags: string[][],
  options: ExpirationOptions,
  nowSeconds: number,
): void {
  const tag = expirationTagForOptions(options, nowSeconds)
  if (tag) upsertExpirationTag(tags, Number(tag[1]))
}

export function ensureMsTag(tags: string[][], ms: number): string[][] {
  const next = cloneTags(tags)
  if (!next.some(([key]) => key === "ms")) {
    next.push(["ms", String(ms)])
  }
  return next
}

export function ensureRecipientTag(tags: string[][], recipientPubkey: string): string[][] {
  const next = cloneTags(tags)
  const hasRecipient = next.some(
    ([key, value]) => key === "p" && value === recipientPubkey,
  )
  if (!hasRecipient) {
    next.unshift(["p", recipientPubkey])
  }
  return next
}

export function buildRumorEvent(input: RumorBuildInput): Rumor {
  const nowMs = input.nowMs ?? Date.now()
  const createdAt = input.createdAt ?? Math.floor(nowMs / 1000)
  let tags = cloneTags(input.tags ?? [])

  if (input.ensureMsTag ?? true) {
    tags = ensureMsTag(tags, nowMs)
  }

  if (input.expiration !== undefined && input.expiration !== null) {
    appendExpirationTag(tags, input.expiration, createdAt)
  }

  const rumor: Rumor = {
    id: "",
    pubkey: input.pubkey ?? DUMMY_INNER_PUBKEY,
    created_at: createdAt,
    kind: input.kind,
    tags,
    content: input.content ?? "",
  }
  rumor.id = getEventHash(rumor)
  return rumor
}

export function buildDirectRumorEvent(
  authorPubkey: string,
  recipientPubkey: string,
  kind: number,
  content: string,
  tags: string[][] = [],
  options: Omit<RumorBuildOptions, "pubkey" | "tags"> = {},
): Rumor {
  return buildRumorEvent({
    ...options,
    pubkey: authorPubkey,
    kind,
    content,
    tags: ensureRecipientTag(tags, recipientPubkey),
  })
}

export function buildTextRumor(
  text: string,
  options: RumorBuildOptions = {},
): Rumor {
  return buildRumorEvent({
    ...options,
    kind: CHAT_MESSAGE_KIND,
    content: text,
  })
}

export function buildReplyRumor(
  text: string,
  replyTo: string,
  options: RumorBuildOptions = {},
): Rumor {
  return buildTextRumor(text, {
    ...options,
    tags: [...cloneTags(options.tags ?? []), eventReferenceTag(replyTo)],
  })
}

export function buildReactionRumor(
  messageId: string,
  emoji: string,
  options: RumorBuildOptions = {},
): Rumor {
  return buildRumorEvent({
    ...options,
    kind: REACTION_KIND,
    content: emoji,
    tags: [...cloneTags(options.tags ?? []), eventReferenceTag(messageId)],
  })
}

export function buildReceiptRumor(
  receiptType: ReceiptType,
  messageIds: string[],
  options: RumorBuildOptions = {},
): Rumor {
  return buildRumorEvent({
    ...options,
    kind: RECEIPT_KIND,
    content: receiptType,
    tags: [
      ...cloneTags(options.tags ?? []),
      ...messageIds.map((id) => eventReferenceTag(id)),
    ],
  })
}

export function buildTypingRumor(options: RumorBuildOptions = {}): Rumor {
  return buildRumorEvent({
    ...options,
    kind: TYPING_KIND,
    content: "typing",
  })
}

export function eventReferenceTag(messageId: string): string[] {
  return ["e", messageId]
}

function cloneTags(tags: string[][]): string[][] {
  return tags.map((tag) => [...tag])
}
