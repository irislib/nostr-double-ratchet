import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { NdrRuntime } from "../src/NdrRuntime";
import { SessionManager } from "../src/SessionManager";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { MessageQueue } from "../src/MessageQueue";
import type { Rumor } from "../src/types";

const owner = "aa".repeat(32);
const rumor = (kind = 10451, v = 1, account = owner): Rumor => ({
  id: `${kind}-${v}-${account}`,
  pubkey: owner,
  kind,
  created_at: 1,
  tags: [],
  content: JSON.stringify({
    type: "private-contact-sync",
    v,
    document: { version: v, owner: account },
  }),
});
function runtime(storage = new InMemoryStorageAdapter()) {
  return new NdrRuntime({
    storage,
    nostrSubscribe: () => () => {},
    nostrPublish: vi.fn(async (event) => event as any),
  });
}
class TestRuntime extends NdrRuntime {
  install(manager: SessionManager) {
    this.sessionManager = manager;
    this.attachSessionManagerEvents(manager);
  }
  detach() {
    this.clearSessionManagerEvents();
    this.sessionManager = null;
  }
}

describe("runtime durable controls", () => {
  it("retires only this account's legacy plaintext controls before any session starts", async () => {
    const storage = new InMemoryStorageAdapter();
    for (const prefix of ["v1/message-queue/", "v1/discovery-queue/"]) {
      const queue = new MessageQueue(storage, prefix);
      for (const event of [
        rumor(),
        rumor(10452, 2),
        rumor(10451, 1, "bb".repeat(32)),
        { ...rumor(1), content: "message" },
      ])
        await queue.add("device", event);
    }
    await storage.put("signed-outbox/1060", { ciphertext: "opaque" });
    await storage.put("v1/message-queue/malformed", {
      event: { kind: 10451, content: "not json" },
    });
    const app = runtime(storage);
    expect(await app.retireLegacyPrivateContactSync(owner)).toBe(2);
    expect(app.getSessionManager()).toBeNull();
    expect(await storage.get("signed-outbox/1060")).toEqual({
      ciphertext: "opaque",
    });
    expect(await storage.list("v1/message-queue/")).toHaveLength(4);
    expect(await storage.list("v1/discovery-queue/")).toHaveLength(3);
    app.close();
  });

  it("rejects deletion failure and prevents concurrent initialization from bypassing retirement", async () => {
    class BlockedStorage extends InMemoryStorageAdapter {
      override async del() {
        /* simulate an adapter silently failing deletion */
      }
    }
    const storage = new BlockedStorage();
    await new MessageQueue(storage, "v1/message-queue/").add("device", rumor());
    const app = runtime(storage);
    const retirement = app.retireLegacyPrivateContactSync(owner);
    const initialization = app.initSessionManager(owner);
    await expect(retirement).rejects.toThrow("not saved");
    await expect(initialization).rejects.toThrow("not saved");
    expect(app.getSessionManager()).toBeNull();
    app.close();
  });

  it("attaches pre-init durable handlers and rejects ACK after the runtime is detached", async () => {
    const app = new TestRuntime({
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as any,
    });
    let finish!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const cleanup = app.onDurableSessionEvent([10452], handler);
    let callback: any;
    const unsubscribe = vi.fn();
    const manager = {
      onDurableEvent: vi.fn((_kinds, cb) => {
        callback = cb;
        return unsubscribe;
      }),
      onEventsAvailable: () => () => {},
      drainEvents: () => [],
    } as unknown as SessionManager;
    app.install(manager);
    expect(manager.onDurableEvent).toHaveBeenCalledWith(
      [10452],
      expect.any(Function),
    );
    const handling = callback(rumor(10452, 2), owner, {
      senderOwnerPubkey: owner,
    });
    app.detach();
    finish();
    await expect(handling).rejects.toThrow("Inactive");
    expect(unsubscribe).toHaveBeenCalledOnce();
    cleanup();
    app.close();
  });

  it("does not create an empty roster after an explicit discovery failure", async () => {
    const app = new NdrRuntime({
      nostrSubscribe: () => {
        throw new Error("relay unavailable");
      },
      nostrPublish: async (event) => event as any,
    });
    await expect(app.resolveBaseAppKeys(owner, 1)).rejects.toThrow(
      "relay unavailable",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    app.close();
  });

  it("forwards recipient-only sends without changing the owner argument", async () => {
    const app = new TestRuntime({
      nostrSubscribe: () => () => {},
      nostrPublish: async (event) => event as any,
    });
    const sendEvent = vi.fn(async () => rumor(21112));
    const manager = {
      sendEvent,
      getAllMessagePushAuthorPubkeys: () => [],
      onEventsAvailable: () => () => {},
      drainEvents: () => [],
    } as unknown as SessionManager;
    app.install(manager);
    const recipient = getPublicKey(generateSecretKey());
    await app.sendEvent(recipient, { kind: 21112, content: "call" }, owner, {
      includeLocalSiblings: false,
    });
    expect(sendEvent).toHaveBeenCalledWith(
      recipient,
      { kind: 21112, content: "call" },
      { includeLocalSiblings: false },
    );
    await expect(app.retireLegacyPrivateContactSync(owner)).rejects.toThrow(
      "before initializing",
    );
    app.detach();
    app.close();
  });
});
