import { getPublicKey, finalizeEvent } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import {
  AppKeys,
  APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
} from "../../src/AppKeys";

/** Test-only old-format producer: production only retains legacy decoding. */
export function legacyAppKeysEvent(appKeys: AppKeys, ownerKey: Uint8Array) {
  const event = appKeys.getEvent(ownerKey);
  const key = nip44.v2.utils.getConversationKey(
    ownerKey,
    getPublicKey(ownerKey),
  );
  event.tags.push([
    APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
    nip44.v2.encrypt(
      JSON.stringify({
        type: "app-keys-labels",
        v: 1,
        deviceLabels: appKeys.getAllDeviceLabels(),
      }),
      key,
    ),
  ]);
  return finalizeEvent(event, ownerKey);
}
