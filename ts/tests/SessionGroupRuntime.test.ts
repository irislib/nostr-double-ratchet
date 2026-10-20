import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { SessionGroupRuntime } from "../src/RuntimeGroupController";
import type { OnEventCallback } from "../src/SessionManager";
import type { Rumor } from "../src/types";

class FakeSessionManager {
  readonly ownerPubkey: string;
  readonly devicePubkey: string;
  private readonly callbacks = new Set<OnEventCallback>();
  peer: FakeSessionManager | null = null;
  private durable?: OnEventCallback;
  onDurableEvent(_kinds: readonly number[], callback: OnEventCallback) {
    this.durable = callback;
    return () => { this.durable = undefined; };
  }
  async flushDurableSessionEvents() {}

  constructor(ownerPubkey: string, devicePubkey: string) {
    this.ownerPubkey = ownerPubkey;
    this.devicePubkey = devicePubkey;
  }

  onEvent(callback: OnEventCallback) {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  async sendEvent(recipientOwnerPubkey: string, rumor: Rumor): Promise<Rumor> {
    if (this.peer && this.peer.ownerPubkey === recipientOwnerPubkey) {
      this.peer.emit(rumor, this.ownerPubkey, this.devicePubkey);
    }
    return rumor;
  }

  private emit(
    rumor: Rumor,
    senderOwnerPubkey: string,
    senderDevicePubkey: string,
  ): void {
    if (rumor.kind === 21113) return;
    for (const callback of this.callbacks) {
      callback(rumor, senderOwnerPubkey, {
        senderOwnerPubkey,
        senderDevicePubkey,
      } as Parameters<OnEventCallback>[2]);
    }
  }
}

describe("SessionGroupRuntime", () => {
  it("attaches group transport to an existing SessionManager", async () => {
    const aliceOwnerPubkey = getPublicKey(generateSecretKey());
    const bobOwnerPubkey = getPublicKey(generateSecretKey());
    const aliceDevicePubkey = getPublicKey(generateSecretKey());
    const bobDevicePubkey = getPublicKey(generateSecretKey());

    const aliceSessionManager = new FakeSessionManager(
      aliceOwnerPubkey,
      aliceDevicePubkey,
    );
    const bobSessionManager = new FakeSessionManager(
      bobOwnerPubkey,
      bobDevicePubkey,
    );
    aliceSessionManager.peer = bobSessionManager;
    bobSessionManager.peer = aliceSessionManager;

    const aliceGroups = new SessionGroupRuntime({
      sessionManager: aliceSessionManager as never,
      ourOwnerPubkey: aliceOwnerPubkey,
      ourDevicePubkey: aliceDevicePubkey,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as never,
    });
    const bobGroups = new SessionGroupRuntime({
      sessionManager: bobSessionManager as never,
      ourOwnerPubkey: bobOwnerPubkey,
      ourDevicePubkey: bobDevicePubkey,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as never,
    });

    try {
      const created = await aliceGroups.createGroup(
        "SessionManager Group",
        [bobOwnerPubkey],
        {
          fanoutMetadata: false,
        },
      );
      await bobGroups.syncGroups([created.group]);

      const sent = await aliceGroups.sendGroupMessage(
        created.group.id,
        "hello from session runtime",
      );
      const decrypted = await bobGroups
        .getGroupManager()!
        .handleOuterEvent(sent.outer);

      expect(aliceGroups.getGroupManager()?.managedGroupIds()).toContain(
        created.group.id,
      );
      expect(bobGroups.getGroupManager()?.managedGroupIds()).toContain(
        created.group.id,
      );
      expect(sent.inner.content).toBe("hello from session runtime");
      expect(decrypted?.inner.content).toBe("hello from session runtime");
      expect(
        aliceGroups.getGroupManager()?.knownSenderEventPubkeys().length,
      ).toBeGreaterThan(0);
      expect(
        bobGroups.getGroupManager()?.knownSenderEventPubkeys().length,
      ).toBeGreaterThan(0);

      await bobGroups.syncGroups([]);
      expect(bobGroups.getGroupManager()?.managedGroupIds()).not.toContain(
        created.group.id,
      );
    } finally {
      aliceGroups.close();
      bobGroups.close();
    }
  });

  it("delivers same-owner group messages to a sibling device via sender-key self-copy", async () => {
    const ownerPubkey = getPublicKey(generateSecretKey());
    const deviceAPubkey = getPublicKey(generateSecretKey());
    const deviceBPubkey = getPublicKey(generateSecretKey());

    const deviceASessionManager = new FakeSessionManager(
      ownerPubkey,
      deviceAPubkey,
    );
    const deviceBSessionManager = new FakeSessionManager(
      ownerPubkey,
      deviceBPubkey,
    );
    deviceASessionManager.peer = deviceBSessionManager;
    deviceBSessionManager.peer = deviceASessionManager;

    const deviceAGroups = new SessionGroupRuntime({
      sessionManager: deviceASessionManager as never,
      ourOwnerPubkey: ownerPubkey,
      ourDevicePubkey: deviceAPubkey,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as never,
    });
    const deviceBGroups = new SessionGroupRuntime({
      sessionManager: deviceBSessionManager as never,
      ourOwnerPubkey: ownerPubkey,
      ourDevicePubkey: deviceBPubkey,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as never,
    });

    try {
      const created = await deviceAGroups.createGroup("Self Group", [], {
        fanoutMetadata: false,
      });
      await deviceBGroups.syncGroups([created.group]);

      const sent = await deviceAGroups.sendGroupMessage(
        created.group.id,
        "hello sibling device",
      );
      const decrypted = await deviceBGroups
        .getGroupManager()!
        .handleOuterEvent(sent.outer);

      expect(decrypted?.inner.content).toBe("hello sibling device");
    } finally {
      deviceAGroups.close();
      deviceBGroups.close();
    }
  });

  it("emits pairwise group-tagged sender-copy rumors from another device", async () => {
    const ownerPubkey = getPublicKey(generateSecretKey());
    const deviceAPubkey = getPublicKey(generateSecretKey());
    const deviceBPubkey = getPublicKey(generateSecretKey());

    const deviceASessionManager = new FakeSessionManager(
      ownerPubkey,
      deviceAPubkey,
    );
    const deviceBSessionManager = new FakeSessionManager(
      ownerPubkey,
      deviceBPubkey,
    );
    deviceASessionManager.peer = deviceBSessionManager;
    deviceBSessionManager.peer = deviceASessionManager;

    const deviceAGroups = new SessionGroupRuntime({
      sessionManager: deviceASessionManager as never,
      ourOwnerPubkey: ownerPubkey,
      ourDevicePubkey: deviceAPubkey,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as never,
    });
    const deviceBGroups = new SessionGroupRuntime({
      sessionManager: deviceBSessionManager as never,
      ourOwnerPubkey: ownerPubkey,
      ourDevicePubkey: deviceBPubkey,
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as never,
    });

    try {
      const created = await deviceAGroups.createGroup("Self Group", [], {
        fanoutMetadata: false,
      });
      await deviceBGroups.syncGroups([created.group]);

      const seen: Rumor[] = [];
      const stop = deviceBGroups.onGroupEvent((event) => {
        seen.push(event.inner);
      });

      const rumor: Rumor = {
        kind: 14,
        content: "pairwise fallback",
        created_at: Math.floor(Date.now() / 1000),
        tags: [["l", created.group.id], ["ms", String(Date.now())]],
        pubkey: deviceAPubkey,
        id: crypto.randomUUID(),
      };
      await deviceASessionManager.sendEvent(ownerPubkey, rumor);

      expect(seen.map((event) => event.content)).toContain("pairwise fallback");
      stop();
    } finally {
      deviceAGroups.close();
      deviceBGroups.close();
    }
  });
});
