import { type VerifiedEvent } from "nostr-tools";
import { type NostrPublish, type NostrPublisherOptions, type NostrPublishContext, type Rumor } from "./types.js";

import { GROUP_ROSTER_FACT_KIND } from "./GroupMeta.js";

/** Group rosters and shared group ciphertext are local intermediates, never relay traffic. */
export function isForbiddenGroupRelayEvent(event: Pick<Rumor, "kind" | "tags">): boolean {
  if ([10445, 10446, 10447, 21113].includes(event.kind)) return true;
  if (event.kind === GROUP_ROSTER_FACT_KIND && event.tags.some(tag => tag[0] === "type" && tag[1] === "group_roster")) return true;
  if (event.kind !== 1060 && event.kind !== 1059) return false;
  const recipients = event.tags.filter(tag => tag[0] === "p");
  return recipients.length !== 1 || !/^[a-f0-9]{64}$/i.test(recipients[0][1] || "");
}

/** Preserve canonical group delivery tracking while the ratchet rumor has its own authenticated ID. */
export function groupPublicationInnerEventId(event: Pick<Rumor, "id" | "kind" | "tags">): string {
  if (event.kind === 21113 && event.tags.some(tag => tag[0] === "l")) {
    const id = event.tags.find(tag => tag[0] === "e" && tag[3] === "group-message")?.[1];
    if (id && /^[a-f0-9]{64}$/i.test(id)) return id;
  }
  return event.id;
}

/** Recover group or direct policy scope from queued plaintext without changing durable queue formats. */
export function groupPublicationContext(event: Pick<Rumor, "kind" | "tags"> & Partial<Pick<Rumor, "created_at">>): NostrPublishContext | undefined {
  // Membership controls must reach recipients even when removing the sender.
  if (event.kind === GROUP_ROSTER_FACT_KIND) return undefined;
  const groupId = event.tags?.find((tag) => tag[0] === "l")?.[1];
  if (groupId) {
    const recipient = event.tags?.find(tag => tag[0] === "p")?.[1];
    return recipient && /^[a-f0-9]{64}$/.test(recipient) && Number.isSafeInteger(event.created_at) && event.created_at! >= 0
      ? { groupId, recipientOwnerPubkey: recipient, createdAt: event.created_at! } : { groupId };
  }
  const recipientOwnerPubkey = event.tags?.find((tag) => tag[0] === "p")?.[1];
  return recipientOwnerPubkey && /^[a-f0-9]{64}$/.test(recipientOwnerPubkey) &&
    Number.isSafeInteger(event.created_at) && event.created_at! >= 0
    ? { recipientOwnerPubkey, createdAt: event.created_at! } : undefined;
}

const localPublishers = new WeakSet<NostrPublish>();

/**
 * Separate local signing/durable handoff from relay acknowledgement.
 * Hosts own retrying enqueued envelopes and retiring them after delivery.
 */
export function createNostrPublisher(
  publish: NostrPublish,
  options: NostrPublisherOptions = {},
): NostrPublish {
  if (localPublishers.has(publish)) return publish;

  const localPublish: NostrPublish = async (event, innerEventId, context) => {
    if (isForbiddenGroupRelayEvent(event)) throw new Error("Shared group relay publication is forbidden");
    let signed: VerifiedEvent;
    if ("sig" in event && event.sig) {
      signed = event as VerifiedEvent;
    } else if (options.nostrSign) {
      signed = await options.nostrSign(event);
    } else {
      // Legacy combined callbacks also provide the signed owner event. Without
      // a separate signer their result must still be awaited for compatibility.
      return publish(event, innerEventId, context);
    }

    const report = (error: unknown) => {
      try {
        options.onPublishError?.({ event: signed, innerEventId, error });
      } catch {
        // An error observer must not create an unhandled transport rejection.
      }
    };
    try {
      if (options.nostrEnqueue) await options.nostrEnqueue(signed, innerEventId, context);
    } catch (error) {
      report(error);
      throw error;
    }
    try {
      void publish(signed, innerEventId, context).catch(report);
    } catch (error) {
      report(error);
    }
    return signed;
  };
  localPublishers.add(localPublish);
  return localPublish;
}
