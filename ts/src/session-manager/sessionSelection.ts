import type { Session } from "../Session.js"

export type SessionPriority = [number, number, number, number]
export type SendSessionPriority = [number, number, number, number, number]

export function sessionCanSend(session: Session): boolean {
  return Boolean(
    session.state.theirNextNostrPublicKey && session.state.ourCurrentNostrKey
  )
}

export function sessionCanReceive(session: Session): boolean {
  return Boolean(
    session.state.receivingChainKey ||
    session.state.theirCurrentNostrPublicKey ||
    session.state.receivingChainMessageNumber > 0
  )
}

export function sessionHasActivity(session: Session): boolean {
  return (
    session.state.sendingChainMessageNumber > 0 ||
    session.state.receivingChainMessageNumber > 0
  )
}

export function sessionPriority(session: Session): SessionPriority {
  const canSend = sessionCanSend(session)
  const canReceive = sessionCanReceive(session)
  const directionality =
    canSend && canReceive ? 3
    : canSend ? 2
    : canReceive ? 1
    : 0

  return [
    directionality,
    session.state.receivingChainMessageNumber,
    session.state.previousSendingChainMessageCount,
    session.state.sendingChainMessageNumber,
  ]
}

export function sendSessionPriority(
  session: Session,
  active: boolean,
): SendSessionPriority {
  const base = sessionPriority(session)
  return [
    base[0],
    active && sessionCanReceive(session) ? 1 : 0,
    base[1],
    base[2],
    base[3],
  ]
}

export function compareSessionPriority(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let i = 0; i < left.length; i += 1) {
    const diff = left[i] - right[i]
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export function sortedSendableSessionCandidates(
  activeSession: Session | undefined,
  inactiveSessions: readonly Session[],
): Array<{ session: Session; active: boolean; priority: SendSessionPriority }> {
  const candidates: Array<{
    session: Session
    active: boolean
    priority: SendSessionPriority
  }> = []

  if (activeSession && sessionCanSend(activeSession)) {
    candidates.push({
      session: activeSession,
      active: true,
      priority: sendSessionPriority(activeSession, true),
    })
  }

  for (const session of inactiveSessions) {
    if (!sessionCanSend(session)) {
      continue
    }
    candidates.push({
      session,
      active: false,
      priority: sendSessionPriority(session, false),
    })
  }

  candidates.sort((left, right) =>
    compareSessionPriority(right.priority, left.priority)
  )
  return candidates
}
