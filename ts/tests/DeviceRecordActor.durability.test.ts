import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools";
import { Session } from "../src/Session";
import { MessageQueue } from "../src/MessageQueue";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { buildTextRumor } from "../src/messageBuilders";
import { serializeSessionState, deserializeSessionState } from "../src/utils";
import { DeviceRecordActor } from "../src/session-manager/DeviceRecordActor";

describe("queued message durability", () => {
  it("retains the queued message and avoids publication when saving the ratchet fails", async () => {
    const aliceKey = generateSecretKey();
    const bobKey = generateSecretKey();
    const secret = generateSecretKey();
    const alice = Session.init(getPublicKey(bobKey), aliceKey, true, secret);
    const bob = Session.init(getPublicKey(aliceKey), bobKey, false, secret);
    const queue = new MessageQueue(new InMemoryStorageAdapter(), "failed-save/");
    let failSave = true;
    const received: string[] = [];
    const actor = new DeviceRecordActor(getPublicKey(bobKey), {
      ownerPubkey: getPublicKey(bobKey),
      ourOwnerPubkey: getPublicKey(aliceKey),
      ourDeviceId: getPublicKey(aliceKey),
      identityKey: aliceKey,
      messageQueue: queue,
      user: {
        isDeviceAuthorized: () => true,
        onDeviceRumor: () => {},
        onDeviceDirty: async () => { if (failSave) throw new Error("storage unavailable"); },
      },
      nostr: {
        subscribe: () => () => {},
        publish: async (event) => { received.push(bob.receiveEvent(event as VerifiedEvent)!.content); },
      },
    });
    actor.installSession(alice, false, { persist: false });
    await queue.add(getPublicKey(bobKey), buildTextRumor("durable queued message"));
    await actor.flushMessageQueue();
    expect(received).toEqual([]);
    expect(await queue.getForTarget(getPublicKey(bobKey))).toHaveLength(1);
    failSave = false;
    await actor.flushMessageQueue();
    expect(received).toEqual(["durable queued message"]);
    expect(await queue.getForTarget(getPublicKey(bobKey))).toHaveLength(0);
  });

  it("can send after restarting immediately after a queued message is published", async () => {
    const aliceKey = generateSecretKey();
    const bobKey = generateSecretKey();
    const secret = generateSecretKey();
    const alice = Session.init(getPublicKey(bobKey), aliceKey, true, secret);
    const bob = Session.init(getPublicKey(aliceKey), bobKey, false, secret);
    const queue = new MessageQueue(new InMemoryStorageAdapter(), "queued-restart/");
    const disk = new InMemoryStorageAdapter();
    await disk.put("session", serializeSessionState(alice.state));
    let stopped = false;
    const actor = new DeviceRecordActor(getPublicKey(bobKey), {
      ownerPubkey: getPublicKey(bobKey),
      ourOwnerPubkey: getPublicKey(aliceKey),
      ourDeviceId: getPublicKey(aliceKey),
      identityKey: aliceKey,
      messageQueue: queue,
      user: {
        isDeviceAuthorized: () => true,
        onDeviceRumor: () => {},
        onDeviceDirty: async () => {
          if (!stopped) await disk.put("session", serializeSessionState(alice.state));
        },
      },
      nostr: {
        subscribe: () => () => {},
        publish: async (event) => {
          expect(bob.receiveEvent(event as VerifiedEvent)?.content).toBe("before interruption");
          // The network accepted the message, then this process lost its storage handle.
          stopped = true;
        },
      },
    });
    actor.installSession(alice, false, { persist: false });
    const queued = buildTextRumor("before interruption");
    await queue.add(getPublicKey(bobKey), queued);
    await actor.flushMessageQueue();

    const restored = new Session(deserializeSessionState((await disk.get<string>("session"))!));
    const next = restored.sendEvent(buildTextRumor("after restart")).event;
    expect(bob.receiveEvent(next)?.content).toBe("after restart");
  });
});
