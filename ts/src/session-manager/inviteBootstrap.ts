import type { VerifiedEvent } from "nostr-tools"
import type { Session } from "../Session.js"
import { buildTypingRumor } from "../messageBuilders.js"

// The invite bootstrap is a typing rumor sent only to install the session
// on the inviter's side. It is not a "real" typing event, so we tag it
// with an expiration already in the past — receivers treat that as
// stop-typing (see iris-chat's `expiresAt <= nowSeconds` check and the
// equivalent guard in iris-chat-rs `apply_typing_event`), which avoids
// flashing a typing indicator for a chat the user has not actually
// started typing in.
export const INVITE_BOOTSTRAP_EXPIRATION_SECONDS = 1
export const INVITE_BOOTSTRAP_RETRY_DELAYS_MS = [0, 500, 1500] as const

export function planInviteBootstrapEvents(
  session: Session,
  recipientDevicePubkey?: string,
): VerifiedEvent[] {
  const expiresAt = INVITE_BOOTSTRAP_EXPIRATION_SECONDS
  const outerTags = recipientDevicePubkey ? [["p", recipientDevicePubkey]] : []

  return INVITE_BOOTSTRAP_RETRY_DELAYS_MS.map(
    () => session.sendEvent(
      buildTypingRumor({ expiration: { expiresAt } }),
      outerTags,
    ).event
  )
}

export function scheduleInviteBootstrapRetryEvents(
  events: readonly VerifiedEvent[],
  publish: (event: VerifiedEvent) => Promise<void>,
  trackedTimeouts: Set<ReturnType<typeof setTimeout>>,
): void {
  events.slice(1).forEach((event, index) => {
    const timeout = setTimeout(() => {
      trackedTimeouts.delete(timeout)
      void publish(event).catch(() => {
        // Best-effort retry publish. A later inbound event can still recover the session.
      })
    }, INVITE_BOOTSTRAP_RETRY_DELAYS_MS[index + 1])

    trackedTimeouts.add(timeout)
  })
}
