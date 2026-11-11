import { finalizeEvent, type UnsignedEvent, type VerifiedEvent } from "nostr-tools";
import type { Session } from "../../src/Session";
import type { Rumor } from "../../src/types";

/**
 * Older clients named the recipient device on the outer envelope. Sessions no
 * longer write that tag, so receive-compatibility tests re-sign the envelope
 * with the same ratchet key and the tag added.
 */
export function sendWithLegacyRecipientTag(
  session: Session,
  rumor: Partial<UnsignedEvent>,
  recipient: string,
): { event: VerifiedEvent; innerEvent: Rumor } {
  const signer = session.state.ourCurrentNostrKey!.privateKey;
  const { event, innerEvent } = session.sendEvent(rumor);
  return {
    innerEvent,
    event: finalizeEvent({
      kind: event.kind,
      content: event.content,
      created_at: event.created_at,
      tags: [...event.tags, ["p", recipient]],
    }, signer),
  };
}
