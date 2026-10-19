import { type VerifiedEvent } from "nostr-tools";
import { AppKeys, buildAppKeysFilter, type DeviceEntry } from "../AppKeys.js";
import { type NostrSubscribe, type Unsubscribe } from "../types.js";

export interface RegistrationSnapshot {
  event: VerifiedEvent;
  appKeys: AppKeys;
  ambiguous: boolean;
  commonDevices: DeviceEntry[];
}

// Registration must confirm an actual signed roster, not the equal-time union
// used for discovery: no relay stores that union on the owner's behalf.
export function waitForRegistrationSnapshot(
  owner: string,
  subscribe: NostrSubscribe,
  timeoutMs: number,
  ownerPrivateKey?: Uint8Array,
): Promise<RegistrationSnapshot | null> {
  return new Promise((resolve, reject) => {
    let latest: RegistrationSnapshot | null = null;
    let unsubscribe: Unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(latest);
    }, timeoutMs);
    try {
      unsubscribe = subscribe({ ...buildAppKeysFilter(owner), limit: 20 }, (event) => {
        if (event.pubkey !== owner) return;
        try {
          const appKeys = AppKeys.fromEvent(event, ownerPrivateKey);
          if (!latest || event.created_at > latest.event.created_at) {
            latest = { event, appKeys, ambiguous: false, commonDevices: appKeys.getAllDevices() };
          } else if (event.created_at === latest.event.created_at) {
            const membership = (keys: AppKeys) => keys.getAllDevices()
              .map(device => device.identityPubkey).sort().join(",");
            const ambiguous = latest.ambiguous || membership(latest.appKeys) !== membership(appKeys);
            const identities = new Set(appKeys.getAllDevices().map(device => device.identityPubkey));
            const commonDevices = latest.commonDevices.filter(device => identities.has(device.identityPubkey));
            latest = event.id < latest.event.id
              ? { event, appKeys, ambiguous, commonDevices } : { ...latest, ambiguous, commonDevices };
          }
        } catch {
          // Unverified or malformed rosters cannot authorize registration.
        }
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

export function registrationConflict(): Error {
  return new Error("Messaging devices changed during setup. Please try again.");
}

export const registrationConflictKey = (identity: string) => `v1/registration-conflict/${identity}`;
