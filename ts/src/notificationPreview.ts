import type { VerifiedEvent } from "nostr-tools"

import { Session } from "./Session.js"
import type { Rumor, SessionState } from "./types.js"
import { deepCopyState, deserializeSessionState } from "./utils.js"

export interface SessionPreviewCandidate<TContext = unknown> {
  state: SessionState | string
  chatId?: string
  context?: TContext
}

export interface SessionEventPreview<TContext = unknown> {
  outerEvent: VerifiedEvent
  rumor: Rumor
  candidate: SessionPreviewCandidate<TContext>
  candidateIndex: number
  chatId?: string
  context?: TContext
}

function copyCandidateState(candidate: SessionPreviewCandidate): SessionState {
  return typeof candidate.state === "string"
    ? deserializeSessionState(candidate.state)
    : deepCopyState(candidate.state)
}

export function decryptSessionEventPreview<TContext = unknown>(
  outerEvent: VerifiedEvent,
  candidates: Iterable<SessionPreviewCandidate<TContext>>,
): SessionEventPreview<TContext> | null {
  let candidateIndex = 0
  for (const candidate of candidates) {
    try {
      const session = new Session(copyCandidateState(candidate))
      const rumor = session.receiveEvent(outerEvent)
      if (rumor) {
        return {
          outerEvent,
          rumor,
          candidate,
          candidateIndex,
          chatId: candidate.chatId,
          context: candidate.context,
        }
      }
    } catch {
      // Keep scanning; service workers often have stale inactive sessions.
    }
    candidateIndex += 1
  }
  return null
}
