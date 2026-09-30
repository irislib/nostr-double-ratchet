import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { AppKeys } from "../src/AppKeys";
import { createRuntime } from "./helpers/runtime";
import { MockRelay } from "./helpers/mockRelay";

describe("known AppKeys snapshots", () => {
  it.each(["runtime", "session manager"] as const)(
    "%s preserves owner and peer labels in independent snapshots",
    async (reader) => {
      const ownerPrivateKey = generateSecretKey();
      const ownerPubkey = getPublicKey(ownerPrivateKey);
      const peerPubkey = getPublicKey(generateSecretKey());
      const runtime = createRuntime({ relay: new MockRelay(), ownerPrivateKey });
      try {
        await runtime.initForOwner(ownerPubkey);
        for (const [pubkey, name, createdAt] of [
          [ownerPubkey, "My laptop", 100],
          [peerPubkey, "Peer phone", 200],
        ] as const) {
          const appKeys = new AppKeys([{ identityPubkey: pubkey, createdAt }]);
          appKeys.setDeviceLabels(pubkey, {
            deviceLabel: name,
            clientLabel: "Iris Chat",
          }, createdAt + 1);
          await runtime.applyTrustedAppKeysSnapshot({ ownerPubkey: pubkey, appKeys, createdAt });
        }
        const getSnapshots = () => reader === "runtime"
          ? runtime.getKnownAppKeysSnapshots()
          : runtime.getSessionManager()!.getKnownAppKeysSnapshots();
        const snapshots = getSnapshots();
        expect(snapshots).toHaveLength(2);
        for (const [pubkey, name, createdAt] of [
          [ownerPubkey, "My laptop", 100],
          [peerPubkey, "Peer phone", 200],
        ] as const) {
          const snapshot = snapshots.find(entry => entry.ownerPubkey === pubkey)!;
          expect(snapshot.createdAt).toBe(createdAt);
          expect(snapshot.appKeys.getDeviceLabels(pubkey)).toEqual({
            deviceLabel: name, clientLabel: "Iris Chat", updatedAt: createdAt + 1,
          });
          snapshot.appKeys.setDeviceLabels(pubkey, { deviceLabel: "Changed snapshot" }, createdAt + 2);
          snapshot.appKeys.getAllDevices()[0].createdAt = 999;
          const unchanged = getSnapshots().find(entry => entry.ownerPubkey === pubkey)!;
          expect(unchanged.appKeys.getDeviceLabels(pubkey)?.deviceLabel).toBe(name);
          expect(unchanged.appKeys.getAllDevices()[0].createdAt).toBe(createdAt);
        }
      } finally {
        runtime.close();
      }
    },
  );
});
