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

const normalizeAuthor = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null
  return normalized
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

  const authors: string[] = []
  const seen = new Set<string>()
  for (const author of filter.authors) {
    const normalized = normalizeAuthor(author)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    authors.push(normalized)
  }
  return authors
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

  const normalizedRecipients: string[] = []
  const seen = new Set<string>()
  for (const recipient of recipients) {
    const normalized = normalizeAuthor(recipient)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedRecipients.push(normalized)
  }
  return normalizedRecipients
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

  const authors: string[] = []
  const seen = new Set<string>()
  for (const author of filter.authors) {
    const normalized = normalizeAuthor(author)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    authors.push(normalized)
  }
  return authors
}

export function buildDirectMessageBackfillFilter(
  authors: Iterable<string>,
  limit: number = 200,
): Filter {
  const normalizedAuthors: string[] = []
  const seen = new Set<string>()
  for (const author of authors) {
    const normalized = normalizeAuthor(author)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedAuthors.push(normalized)
  }

  return {
    kinds: [MESSAGE_EVENT_KIND],
    authors: normalizedAuthors,
    limit,
  }
}

export function buildDirectMessageRecipientBackfillFilter(
  recipients: Iterable<string>,
  limit: number = 200,
): Filter {
  const normalizedRecipients: string[] = []
  const seen = new Set<string>()
  for (const recipient of recipients) {
    const normalized = normalizeAuthor(recipient)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedRecipients.push(normalized)
  }

  return {
    kinds: [MESSAGE_EVENT_KIND],
    "#p": normalizedRecipients,
    limit,
  }
}

export function buildAppKeysBackfillFilter(
  authors: Iterable<string>,
  limit: number = 200,
): Filter {
  const normalizedAuthors: string[] = []
  const seen = new Set<string>()
  for (const author of authors) {
    const normalized = normalizeAuthor(author)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedAuthors.push(normalized)
  }

  return {
    kinds: [APP_KEYS_EVENT_KIND],
    authors: normalizedAuthors,
    limit,
  }
}

export function buildInviteBackfillFilter(
  authors: Iterable<string>,
  limit: number = 200,
): Filter {
  const normalizedAuthors: string[] = []
  const seen = new Set<string>()
  for (const author of authors) {
    const normalized = normalizeAuthor(author)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedAuthors.push(normalized)
  }

  return {
    kinds: [INVITE_EVENT_KIND],
    authors: normalizedAuthors,
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

  const normalizedRecipients: string[] = []
  const seen = new Set<string>()
  for (const recipient of recipients) {
    const normalized = normalizeAuthor(recipient)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedRecipients.push(normalized)
  }
  return normalizedRecipients
}

export function buildInviteResponseBackfillFilter(
  recipients: Iterable<string>,
  limit: number = 200,
): Filter {
  const normalizedRecipients: string[] = []
  const seen = new Set<string>()
  for (const recipient of recipients) {
    const normalized = normalizeAuthor(recipient)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedRecipients.push(normalized)
  }

  return {
    kinds: [INVITE_RESPONSE_KIND],
    "#p": normalizedRecipients,
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
    if (authors.length === 0) {
      return { token, addedAuthors: [] }
    }

    this.authorsByToken.set(token, authors)
    const addedAuthors: string[] = []
    for (const author of authors) {
      const refCount = this.authorRefCounts.get(author) || 0
      if (refCount === 0) {
        addedAuthors.push(author)
      }
      this.authorRefCounts.set(author, refCount + 1)
    }

    return { token, addedAuthors }
  }

  unregister(token: number): void {
    const authors = this.authorsByToken.get(token)
    if (!authors) return

    this.authorsByToken.delete(token)
    for (const author of authors) {
      const nextCount = Math.max((this.authorRefCounts.get(author) || 1) - 1, 0)
      if (nextCount === 0) {
        this.authorRefCounts.delete(author)
      } else {
        this.authorRefCounts.set(author, nextCount)
      }
    }
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
