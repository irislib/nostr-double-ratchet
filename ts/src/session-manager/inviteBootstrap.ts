import type { Session } from "../Session"
import { buildTypingRumor } from "../messageBuilders"

// The invite bootstrap is a typing rumor sent only to install the session
// on the inviter's side. It is not a "real" typing event, so we tag it
// with an expiration already in the past — receivers treat that as
// stop-typing (see iris-chat's `expiresAt <= nowSeconds` check and the
// equivalent guard in iris-chat-rs `apply_typing_event`), which avoids
// flashing a typing indicator for a chat the user has not actually
// started typing in.
export const INVITE_BOOTSTRAP_EXPIRATION_SECONDS = 1
export function planInviteBootstrapEvent(
  session: Session,
  recipientDevicePubkey?: string,
) {
  const expiresAt = INVITE_BOOTSTRAP_EXPIRATION_SECONDS
  const outerTags = recipientDevicePubkey ? [["p", recipientDevicePubkey]] : []

  return session.sendEvent(
    buildTypingRumor({ expiration: { expiresAt } }),
    outerTags,
  ).event
}
