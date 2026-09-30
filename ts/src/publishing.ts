import { type VerifiedEvent } from "nostr-tools";
import { type NostrPublish, type NostrPublisherOptions, type NostrPublishContext, type Rumor } from "./types.js";

import { GROUP_ROSTER_FACT_KIND } from "./GroupMeta.js";

/** Recover policy scope from queued plaintext without changing durable queue formats. */
export function groupPublicationContext(event: Pick<Rumor, "kind" | "tags">): NostrPublishContext | undefined {
  // Membership controls must reach recipients even when removing the sender.
  if (event.kind === GROUP_ROSTER_FACT_KIND) return undefined;
  const groupId = event.tags?.find((tag) => tag[0] === "l")?.[1];
  return groupId ? { groupId } : undefined;
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
