import { describe, expect, it, vi } from "vitest";
import {
  generateSecretKey,
  getPublicKey,
  type VerifiedEvent,
} from "nostr-tools";
import { Session } from "../src/Session";
import { SessionManager } from "../src/SessionManager";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import {
  generateEphemeralKeypair,
  generateSharedSecret,
} from "../src/inviteUtils";
import type { StoredUserRecord } from "../src/session-manager/types";

class ControlledStorage extends InMemoryStorageAdapter {
  failedKey?: string;
  override async put<T>(key: string, value: T): Promise<void> {
    if (key === this.failedKey) throw new Error("disk unavailable");
    await super.put(key, structuredClone(value));
  }
}
class Receiver extends SessionManager {
  async install(owner: string, device: string, session: Session) {
    this.getOrCreateUserRecord(owner)
      .ensureDevice(device)
      .installSession(session, false, { persist: false });
    await this.storeUserRecord(owner);
  }
}
function fixture() {
  const owner = getPublicKey(generateSecretKey());
  const key = generateSecretKey(),
    device = getPublicKey(key);
  const peerKey = generateSecretKey(),
    peer = getPublicKey(peerKey);
  const shared = generateSecretKey();
  const sender = Session.init(device, peerKey, true, shared);
  const session = Session.init(peer, key, false, shared);
  const storage = new ControlledStorage();
  const credentials = {
    ephemeralKeypair: generateEphemeralKeypair(),
    sharedSecret: generateSharedSecret(),
  };
  const create = () =>
    new Receiver(
      device,
      key,
      device,
      () => () => {},
      async (event) => event as VerifiedEvent,
      owner,
      credentials,
      storage,
    );
  const event = () =>
    sender.sendEvent(
      { kind: 10452, content: '{"type":"private-contact-sync-request","v":2}' },
      [["p", device]],
    ).event;
  return {
    owner,
    device,
    peer,
    sender,
    session,
    storage,
    create,
    event,
    row: `v1/user/${owner}`,
  };
}

describe("durable decrypted sibling controls", () => {
  it("does not expose a control before its advanced ratchet and journal are durably saved", async () => {
    const f = fixture();
    const first = f.create();
    const handler = vi.fn(async () => {});
    await first.init();
    await first.install(f.owner, f.peer, f.session);
    const before = structuredClone(await f.storage.get(f.row));
    first.onDurableEvent([10452], handler);
    f.storage.failedKey = f.row;
    const event = f.event();
    expect(first.processReceivedEvent(event)).toBe(true);
    await first.flushDurableSessionEvents();
    expect(handler).not.toHaveBeenCalled();
    expect(await f.storage.get(f.row)).toEqual(before);
    first.close();
    f.storage.failedKey = undefined;
    const restarted = f.create();
    restarted.onDurableEvent([10452], handler);
    try {
      await restarted.init();
      expect(restarted.processReceivedEvent(event)).toBe(true);
      await restarted.flushDurableSessionEvents();
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      restarted.close();
    }
  });

  it("retains controls without a handler, replays after restart, and excludes transcript listeners", async () => {
    const f = fixture();
    const first = f.create();
    const transcript = vi.fn();
    first.onEvent(transcript);
    await first.init();
    await first.install(f.owner, f.peer, f.session);
    first.processReceivedEvent(f.event());
    await first.flushDurableSessionEvents();
    const row = await f.storage.get<StoredUserRecord>(f.row);
    expect(row?.pendingDurableEvents).toHaveLength(1);
    expect(transcript).not.toHaveBeenCalled();
    first.close();
    const restarted = f.create();
    const handler = vi.fn(async () => {});
    restarted.onEvent(transcript);
    restarted.onDurableEvent([10452], handler);
    try {
      await restarted.init();
      await restarted.flushDurableSessionEvents();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 10452 }),
        f.owner,
        expect.objectContaining({
          senderOwnerPubkey: f.owner,
          senderDevicePubkey: f.peer,
        }),
      );
      expect(
        (await f.storage.get<StoredUserRecord>(f.row))?.pendingDurableEvents,
      ).toEqual([]);
      expect(transcript).not.toHaveBeenCalled();
    } finally {
      restarted.close();
    }
  });

  it("replays callback failures and failed durable acknowledgements with the same identity", async () => {
    const f = fixture();
    const first = f.create();
    const committed = new Set<string>();
    let failCallback = true;
    const handler = vi.fn(async (event: { id: string }) => {
      if (failCallback) throw new Error("app save failed");
      committed.add(event.id);
      f.storage.failedKey = f.row;
    });
    first.onDurableEvent([10452], handler);
    await first.init();
    await first.install(f.owner, f.peer, f.session);
    first.processReceivedEvent(f.event());
    await first.flushDurableSessionEvents();
    expect(committed.size).toBe(0);
    expect(
      (await f.storage.get<StoredUserRecord>(f.row))?.pendingDurableEvents,
    ).toHaveLength(1);
    failCallback = false;
    await first.flushDurableSessionEvents();
    expect(committed.size).toBe(1);
    first.close();
    f.storage.failedKey = undefined;
    const restarted = f.create();
    restarted.onDurableEvent([10452], async (event) => {
      committed.add(event.id);
    });
    try {
      await restarted.init();
      await restarted.flushDurableSessionEvents();
      expect(committed.size).toBe(1);
      expect(
        (await f.storage.get<StoredUserRecord>(f.row))?.pendingDurableEvents,
      ).toEqual([]);
    } finally {
      restarted.close();
    }
  });

  it("does not acknowledge a handler that completed after it was unregistered", async () => {
    const f = fixture();
    const receiver = f.create();
    let finish!: () => void, started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const remove = receiver.onDurableEvent([10452], async () => {
      started();
      await blocked;
    });
    try {
      await receiver.init();
      await receiver.install(f.owner, f.peer, f.session);
      receiver.processReceivedEvent(f.event());
      const flushing = receiver.flushDurableSessionEvents();
      await begun;
      remove();
      finish();
      await flushing;
      expect(
        (await f.storage.get<StoredUserRecord>(f.row))?.pendingDurableEvents,
      ).toHaveLength(1);
    } finally {
      receiver.close();
    }
  });
});
