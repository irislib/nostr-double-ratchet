import { describe, expect, it } from "vitest";
import { AppKeys, applyAppKeysSnapshotPreservingLabels } from "../src/AppKeys";

const device = { identityPubkey: "11".repeat(32), createdAt: 1 };
function labeled(
  deviceLabel: string | undefined,
  clientLabel: string | undefined,
  updatedAt = 10,
) {
  const keys = new AppKeys([device]);
  keys.setDeviceLabels(
    device.identityPubkey,
    { deviceLabel, clientLabel },
    updatedAt,
  );
  return keys;
}

describe("ratcheted private device-label merge", () => {
  it.each([
    [labeled(undefined, "client"), labeled("", undefined), "", undefined, 10],
    [labeled("\ue000", "z"), labeled("𐀀", "a"), "𐀀", "a", 10],
    [labeled("device", "a"), labeled("device", "z"), "device", "z", 10],
    [
      labeled("device", "client"),
      labeled(undefined, undefined, 11),
      undefined,
      undefined,
      11,
    ],
  ])(
    "converges independent of receive order without losing clears or Unicode ordering",
    (left, right, deviceLabel, clientLabel, updatedAt) => {
      const expected = { deviceLabel, clientLabel, updatedAt };
      expect(left.merge(right).getDeviceLabels(device.identityPubkey)).toEqual(
        expected,
      );
      expect(right.merge(left).getDeviceLabels(device.identityPubkey)).toEqual(
        expected,
      );
      expect(
        applyAppKeysSnapshotPreservingLabels({
          currentAppKeys: left,
          currentCreatedAt: 20,
          incomingAppKeys: right,
          incomingCreatedAt: 20,
        }).appKeys.getDeviceLabels(device.identityPubkey),
      ).toEqual(expected);
    },
  );
});
