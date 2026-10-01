import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type VerifiedEvent,
} from "nostr-tools";
import { AppKeys } from "../src/AppKeys";
import { NdrRuntime } from "../src/NdrRuntime";

async function fixture() {
  const secret = generateSecretKey(),
    owner = getPublicKey(secret);
  let received: VerifiedEvent | undefined;
  const runtime = new NdrRuntime({
    nostrSubscribe: (filter, onEvent) => {
      if (
        received &&
        filter.kinds?.includes(37368) &&
        filter.authors?.includes(owner)
      )
        onEvent(received);
      return () => {};
    },
    nostrPublish: async (event) => event as VerifiedEvent,
    appKeysFastTimeoutMs: 20,
  });
  await runtime.initForOwner(owner);
  const device = runtime.getState().currentDevicePubkey!;
  const peer = getPublicKey(generateSecretKey());
  const keys = (devices: string[]) =>
    new AppKeys(
      devices.map((identityPubkey) => ({ identityPubkey, createdAt: 1 })),
    );
  const server = (devices: string[], createdAt: number) => {
    received = finalizeEvent(
      keys(devices).getEvent({ ownerPubkey: owner, createdAt }),
      secret,
    );
  };
  const apply = async (devices: string[], createdAt: number) => {
    const appKeys = keys(devices);
    appKeys.setDeviceLabels(
      device,
      { deviceLabel: "Private laptop", clientLabel: "Iris" },
      50,
    );
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: owner,
      appKeys,
      createdAt,
    });
  };
  return { runtime, owner, device, peer, server, apply };
}

describe("registration base snapshot ordering", () => {
  it.each([0, 5])(
    "keeps the applied newer roster over stale synchronous subscription data with timeout %s",
    async (timeoutMs) => {
      const f = await fixture();
      try {
        await f.apply([f.device, f.peer], 200);
        f.server([f.device], 100);
        const prepared = await f.runtime.prepareRegistration({
          ownerPubkey: f.owner,
          timeoutMs,
        });
        expect(
          prepared.baseDevices.map((device) => device.identityPubkey).sort(),
        ).toEqual([f.device, f.peer].sort());
        expect(prepared.appKeys.getDeviceLabels(f.device)?.deviceLabel).toBe(
          "Private laptop",
        );
      } finally {
        f.runtime.close();
      }
    },
  );

  it("merges equal-time membership and keeps private local labels", async () => {
    const f = await fixture();
    try {
      await f.apply([f.device], 200);
      f.server([f.peer], 200);
      const base = await f.runtime.resolveBaseAppKeys(f.owner, 0);
      expect(
        base
          .getAllDevices()
          .map((device) => device.identityPubkey)
          .sort(),
      ).toEqual([f.device, f.peer].sort());
      expect(base.getDeviceLabels(f.device)?.deviceLabel).toBe(
        "Private laptop",
      );
    } finally {
      f.runtime.close();
    }
  });

  it("honors a newer server revocation while preserving remaining private labels", async () => {
    const f = await fixture();
    try {
      await f.apply([f.device, f.peer], 200);
      f.server([f.device], 300);
      const base = await f.runtime.resolveBaseAppKeys(f.owner, 0);
      expect(
        base.getAllDevices().map((device) => device.identityPubkey),
      ).toEqual([f.device]);
      expect(base.getDeviceLabels(f.device)?.deviceLabel).toBe(
        "Private laptop",
      );
      base.setDeviceLabels(
        f.device,
        { deviceLabel: "Changed return value" },
        99,
      );
      expect(
        f.runtime.getAppKeysManager()?.getDeviceLabels(f.device)?.deviceLabel,
      ).toBe("Private laptop");
    } finally {
      f.runtime.close();
    }
  });

  it("compares against the latest applied snapshot after the subscription wait completes", async () => {
    const f = await fixture();
    try {
      await f.apply([f.device], 100);
      f.server([f.device], 100);
      const pending = f.runtime.resolveBaseAppKeys(f.owner, 20);
      await f.apply([f.device, f.peer], 200);
      expect(
        (await pending)
          .getAllDevices()
          .map((device) => device.identityPubkey)
          .sort(),
      ).toEqual([f.device, f.peer].sort());
    } finally {
      f.runtime.close();
    }
  });
});
