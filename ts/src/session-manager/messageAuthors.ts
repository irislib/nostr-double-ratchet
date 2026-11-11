import { METADATA_PRIVACY_VERSION } from "../metadataPrivacy.js"
import type { Session } from "../Session.js"
import type { UserRecordActor } from "./UserRecordActor.js"

export function sessionMessageAuthorPubkeys(session: Session): string[] {
  if (session.state.metadataPrivacyVersion !== METADATA_PRIVACY_VERSION) return []
  const authors = new Set<string>()
  if (session.state.theirCurrentNostrPublicKey) {
    authors.add(session.state.theirCurrentNostrPublicKey)
  }
  if (session.state.theirNextNostrPublicKey) {
    authors.add(session.state.theirNextNostrPublicKey)
  }
  for (const author of Object.keys(session.state.skippedKeys || {})) {
    authors.add(author)
  }
  return [...authors].sort()
}

export function collectMessagePushAuthorPubkeys(
  userRecord?: UserRecordActor,
): string[] {
  if (!userRecord) {
    return []
  }

  const authors = new Set<string>()
  for (const device of userRecord.devices.values()) {
    const sessions = [
      ...(device.activeSession ? [device.activeSession] : []),
      ...device.inactiveSessions,
    ]
    for (const session of sessions) {
      for (const author of sessionMessageAuthorPubkeys(session)) {
        authors.add(author)
      }
    }
  }
  return [...authors].sort()
}

/**
 * Message authors of these sessions, most important first: the live ratchet
 * keys of every session in the order given, then keys that only still have
 * missed messages from older ratchet periods. Subscriptions that hit a relay
 * limit drop from the end.
 */
export function prioritizedSessionMessageAuthorPubkeys(sessions: Iterable<Session>): string[] {
  const current = [...sessions].filter((session) => session.state.metadataPrivacyVersion === METADATA_PRIVACY_VERSION)
  const ranked = new Set<string>()
  for (const session of current) {
    if (session.state.theirCurrentNostrPublicKey) ranked.add(session.state.theirCurrentNostrPublicKey)
    if (session.state.theirNextNostrPublicKey) ranked.add(session.state.theirNextNostrPublicKey)
  }
  for (const session of current) {
    for (const author of Object.keys(session.state.skippedKeys || {})) ranked.add(author)
  }
  return [...ranked]
}

/** Active sessions of every device rank above inactive ones. */
export function collectPrioritizedMessageAuthorPubkeys(userRecords: Iterable<UserRecordActor>): string[] {
  const active: Session[] = []
  const inactive: Session[] = []
  for (const userRecord of userRecords) {
    for (const device of userRecord.devices.values()) {
      if (device.activeSession) active.push(device.activeSession)
      inactive.push(...device.inactiveSessions)
    }
  }
  return prioritizedSessionMessageAuthorPubkeys([...active, ...inactive])
}

export function collectAllMessagePushAuthorPubkeys(
  userRecords: Iterable<UserRecordActor>,
): string[] {
  const authors = new Set<string>()
  for (const userRecord of userRecords) {
    for (const author of collectMessagePushAuthorPubkeys(userRecord)) {
      authors.add(author)
    }
  }
  return [...authors].sort()
}
