import type { Session } from "../Session.js"
import type { UserRecordActor } from "./UserRecordActor.js"

export function sessionMessageAuthorPubkeys(session: Session): string[] {
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
