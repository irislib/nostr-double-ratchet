import { type VerifiedEvent } from "nostr-tools";
import { type NostrPublish, type NostrPublisherOptions } from "./types.js";

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

  const localPublish: NostrPublish = async (event, innerEventId) => {
    let signed: VerifiedEvent;
    if ("sig" in event && event.sig) {
      signed = event as VerifiedEvent;
    } else if (options.nostrSign) {
      signed = await options.nostrSign(event);
    } else {
      // Legacy combined callbacks also provide the signed owner event. Without
      // a separate signer their result must still be awaited for compatibility.
      return publish(event, innerEventId);
    }

    const report = (error: unknown) => {
      try {
        options.onPublishError?.({ event: signed, innerEventId, error });
      } catch {
        // An error observer must not create an unhandled transport rejection.
      }
    };
    try {
      if (options.nostrEnqueue) await options.nostrEnqueue(signed, innerEventId);
    } catch (error) {
      report(error);
      throw error;
    }
    try {
      void publish(signed, innerEventId).catch(report);
    } catch (error) {
      report(error);
    }
    return signed;
  };
  localPublishers.add(localPublish);
  return localPublish;
}
