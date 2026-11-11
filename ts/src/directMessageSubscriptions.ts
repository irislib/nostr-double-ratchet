import type { Filter } from "nostr-tools"

import {
  APP_KEYS_EVENT_KIND,
  INVITE_EVENT_KIND,
  INVITE_LIST_LABEL,
  INVITE_RESPONSE_KIND,
  MESSAGE_EVENT_KIND,
} from "./types.js"

export interface RegisteredDirectMessageSubscription {
  token: number
  addedAuthors: string[]
}

export interface RegisteredRuntimeSubscription {
  token: number
  addedAppKeysAuthors: string[]
  addedMessageAuthors: string[]
  addedMessageRecipients: string[]
  addedInviteResponseRecipients: string[]
}

export interface ProtocolDiscoveryFilterTargets {
  appKeysAuthors?: Iterable<string>
  inviteAuthors?: Iterable<string>
}

const normalizePubkey = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null
  return normalized
}

const normalizePubkeys = (values: Iterable<unknown>): string[] => {
  const pubkeys: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const pubkey = normalizePubkey(value)
    if (!pubkey || seen.has(pubkey)) continue
    seen.add(pubkey)
    pubkeys.push(pubkey)
  }
  return pubkeys
}

export function directMessageSubscriptionAuthors(filter: Filter): string[] {
  if (
    !Array.isArray(filter.kinds) ||
    !filter.kinds.includes(MESSAGE_EVENT_KIND)
  ) {
    return []
  }

  if (!Array.isArray(filter.authors)) {
    return []
  }

  return normalizePubkeys(filter.authors)
}

export function directMessageSubscriptionRecipients(filter: Filter): string[] {
  if (
    !Array.isArray(filter.kinds) ||
    !filter.kinds.includes(MESSAGE_EVENT_KIND)
  ) {
    return []
  }

  const recipients = (filter as Record<string, unknown>)["#p"]
  if (!Array.isArray(recipients)) {
    return []
  }

  return normalizePubkeys(recipients)
}

export function appKeysSubscriptionAuthors(filter: Filter): string[] {
  if (
    !Array.isArray(filter.kinds) ||
    !filter.kinds.includes(APP_KEYS_EVENT_KIND)
  ) {
    return []
  }

  if (!Array.isArray(filter.authors)) {
    return []
  }

  return normalizePubkeys(filter.authors)
}

export function buildDirectMessageBackfillFilter(
  authors: Iterable<string>,
  limit: number = 200,
): Filter {
  return {
    kinds: [MESSAGE_EVENT_KIND],
    authors: normalizePubkeys(authors),
    limit,
  }
}

/**
 * Sized for the tightest relays in common use: 131,072-byte frames (about
 * 1,950 hex authors per REQ), 2,047 items per filter, 20 subscriptions per
 * connection. One chunk per subscription stays well inside all three.
 */
export const MESSAGE_AUTHOR_FILTER_CHUNK_SIZE = 1_000
export const MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT = 12_000

export interface MessageAuthorSubscriptionPlan {
  /** One live subscription each. A small author set stays in a single filter. */
  filters: Filter[]
  /** Authors left out because the limit was reached, least important last. */
  dropped: string[]
}

/**
 * Split message authors, most important first, into filters every relay
 * accepts. Past `maxAuthors` the tail is dropped. An author always lands in
 * the chunk its key selects, so one ratchet step replaces one subscription,
 * not all of them.
 */
export function buildMessageAuthorSubscriptionFilters(
  authors: Iterable<string>,
  options: { chunkSize?: number; maxAuthors?: number } = {},
): MessageAuthorSubscriptionPlan {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? MESSAGE_AUTHOR_FILTER_CHUNK_SIZE))
  const maxAuthors = Math.max(0, Math.floor(options.maxAuthors ?? MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT))
  const ranked = normalizePubkeys(authors)
  const kept = ranked.slice(0, maxAuthors)
  const dropped = ranked.slice(maxAuthors)
  if (kept.length === 0) return { filters: [], dropped }

  // Aim for chunks four fifths full so uneven key distribution rarely needs another.
  let count = kept.length <= chunkSize ? 1 : Math.ceil((kept.length * 5) / (chunkSize * 4))
  for (;;) {
    const chunks: string[][] = Array.from({ length: count }, () => [])
    for (const author of kept) chunks[Number.parseInt(author.slice(0, 4), 16) % count]!.push(author)
    if (chunks.every((chunk) => chunk.length <= chunkSize)) {
      return {
        filters: chunks.filter((chunk) => chunk.length > 0)
          .map((chunk) => ({ kinds: [MESSAGE_EVENT_KIND], authors: chunk.sort() })),
        dropped,
      }
    }
    count += 1
  }
}

export function buildDirectMessageRecipientBackfillFilter(
  recipients: Iterable<string>,
  limit: number = 200,
): Filter {
  return {
    kinds: [MESSAGE_EVENT_KIND],
    "#p": normalizePubkeys(recipients),
    limit,
  }
}

export function buildAppKeysBackfillFilter(
  authors: Iterable<string>,
  limit: number = 200,
): Filter {
  return {
    kinds: [APP_KEYS_EVENT_KIND],
    authors: normalizePubkeys(authors),
    limit,
  }
}

export function buildInviteBackfillFilter(
  authors: Iterable<string>,
  limit: number = 200,
): Filter {
  return {
    kinds: [INVITE_EVENT_KIND],
    authors: normalizePubkeys(authors),
    "#l": [INVITE_LIST_LABEL],
    limit,
  }
}

export function inviteResponseSubscriptionRecipients(filter: Filter): string[] {
  if (
    !Array.isArray(filter.kinds) ||
    !filter.kinds.includes(INVITE_RESPONSE_KIND)
  ) {
    return []
  }

  const recipients = (filter as Record<string, unknown>)["#p"]
  if (!Array.isArray(recipients)) {
    return []
  }

  return normalizePubkeys(recipients)
}

export function buildInviteResponseBackfillFilter(
  recipients: Iterable<string>,
  limit: number = 200,
): Filter {
  return {
    kinds: [INVITE_RESPONSE_KIND],
    "#p": normalizePubkeys(recipients),
    limit,
  }
}

export function buildRuntimeBackfillFilters(
  registered: Pick<
    RegisteredRuntimeSubscription,
    | "addedAppKeysAuthors"
    | "addedMessageAuthors"
    | "addedMessageRecipients"
    | "addedInviteResponseRecipients"
  >,
  limit: number = 200,
): Filter[] {
  const filters: Filter[] = []
  if (registered.addedAppKeysAuthors.length > 0) {
    filters.push(
      buildAppKeysBackfillFilter(registered.addedAppKeysAuthors, limit),
    )
  }
  if (registered.addedMessageAuthors.length > 0) {
    filters.push(
      buildDirectMessageBackfillFilter(registered.addedMessageAuthors, limit),
    )
  }
  if (registered.addedMessageRecipients.length > 0) {
    filters.push(
      buildDirectMessageRecipientBackfillFilter(
        registered.addedMessageRecipients,
        limit,
      ),
    )
  }
  if (registered.addedInviteResponseRecipients.length > 0) {
    filters.push(
      buildInviteResponseBackfillFilter(
        registered.addedInviteResponseRecipients,
        limit,
      ),
    )
  }
  return filters
}

export function buildProtocolDiscoveryFilters(
  targets: ProtocolDiscoveryFilterTargets,
  limit: number = 256,
): Filter[] {
  const filters: Filter[] = []
  const appKeysAuthors = Array.from(targets.appKeysAuthors ?? [])
  const inviteAuthors = Array.from(targets.inviteAuthors ?? [])
  if (appKeysAuthors.length > 0) {
    filters.push(buildAppKeysBackfillFilter(appKeysAuthors, limit))
  }
  if (inviteAuthors.length > 0) {
    filters.push(buildInviteBackfillFilter(inviteAuthors, limit))
  }
  return filters
}

export class DirectMessageSubscriptionTracker {
  private nextToken = 1
  private authorsByToken = new Map<number, string[]>()
  private authorRefCounts = new Map<string, number>()

  registerFilter(filter: Filter): RegisteredDirectMessageSubscription {
    const token = this.nextToken++
    const authors = directMessageSubscriptionAuthors(filter)
    const addedAuthors = registerValues(
      authors,
      this.authorsByToken,
      this.authorRefCounts,
      token,
    )
    return { token, addedAuthors }
  }

  unregister(token: number): void {
    unregisterValues(token, this.authorsByToken, this.authorRefCounts)
  }

  trackedAuthors(): string[] {
    return Array.from(this.authorRefCounts.keys()).sort()
  }
}

export class RuntimeSubscriptionTracker {
  private nextToken = 1
  private appKeysAuthorsByToken = new Map<number, string[]>()
  private messageAuthorsByToken = new Map<number, string[]>()
  private messageRecipientsByToken = new Map<number, string[]>()
  private inviteResponseRecipientsByToken = new Map<number, string[]>()
  private appKeysAuthorRefCounts = new Map<string, number>()
  private messageAuthorRefCounts = new Map<string, number>()
  private messageRecipientRefCounts = new Map<string, number>()
  private inviteResponseRecipientRefCounts = new Map<string, number>()

  registerFilter(filter: Filter): RegisteredRuntimeSubscription {
    const token = this.nextToken++
    const addedAppKeysAuthors = registerValues(
      appKeysSubscriptionAuthors(filter),
      this.appKeysAuthorsByToken,
      this.appKeysAuthorRefCounts,
      token,
    )
    const addedMessageAuthors = registerValues(
      directMessageSubscriptionAuthors(filter),
      this.messageAuthorsByToken,
      this.messageAuthorRefCounts,
      token,
    )
    const addedMessageRecipients = registerValues(
      directMessageSubscriptionRecipients(filter),
      this.messageRecipientsByToken,
      this.messageRecipientRefCounts,
      token,
    )
    const addedInviteResponseRecipients = registerValues(
      inviteResponseSubscriptionRecipients(filter),
      this.inviteResponseRecipientsByToken,
      this.inviteResponseRecipientRefCounts,
      token,
    )

    return {
      token,
      addedAppKeysAuthors,
      addedMessageAuthors,
      addedMessageRecipients,
      addedInviteResponseRecipients,
    }
  }

  unregister(token: number): void {
    unregisterValues(
      token,
      this.appKeysAuthorsByToken,
      this.appKeysAuthorRefCounts,
    )
    unregisterValues(
      token,
      this.messageAuthorsByToken,
      this.messageAuthorRefCounts,
    )
    unregisterValues(
      token,
      this.messageRecipientsByToken,
      this.messageRecipientRefCounts,
    )
    unregisterValues(
      token,
      this.inviteResponseRecipientsByToken,
      this.inviteResponseRecipientRefCounts,
    )
  }

  trackedMessageAuthors(): string[] {
    return Array.from(this.messageAuthorRefCounts.keys()).sort()
  }

  trackedMessageRecipients(): string[] {
    return Array.from(this.messageRecipientRefCounts.keys()).sort()
  }

  trackedAppKeysAuthors(): string[] {
    return Array.from(this.appKeysAuthorRefCounts.keys()).sort()
  }

  trackedInviteResponseRecipients(): string[] {
    return Array.from(this.inviteResponseRecipientRefCounts.keys()).sort()
  }
}

function registerValues(
  values: string[],
  valuesByToken: Map<number, string[]>,
  refCounts: Map<string, number>,
  token: number,
): string[] {
  if (values.length === 0) {
    return []
  }

  valuesByToken.set(token, values)
  const addedValues: string[] = []
  for (const value of values) {
    const refCount = refCounts.get(value) || 0
    if (refCount === 0) {
      addedValues.push(value)
    }
    refCounts.set(value, refCount + 1)
  }
  return addedValues
}

function unregisterValues(
  token: number,
  valuesByToken: Map<number, string[]>,
  refCounts: Map<string, number>,
): void {
  const values = valuesByToken.get(token)
  if (!values) return

  valuesByToken.delete(token)
  for (const value of values) {
    const nextCount = Math.max((refCounts.get(value) || 1) - 1, 0)
    if (nextCount === 0) {
      refCounts.delete(value)
    } else {
      refCounts.set(value, nextCount)
    }
  }
}
