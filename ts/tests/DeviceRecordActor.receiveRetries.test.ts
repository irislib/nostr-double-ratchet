import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { Session } from "../src/Session";
import { MessageQueue } from "../src/MessageQueue";
import { InMemoryStorageAdapter } from "../src/StorageAdapter";
import { DeviceRecordActor } from "../src/session-manager/DeviceRecordActor";
import { deepCopyState } from "../src/utils";

function pair() {
  const aliceKey = generateSecretKey();
  const bobKey = generateSecretKey();
  const secret = generateSecretKey();
  return {
    alice: Session.init(getPublicKey(bobKey), aliceKey, true, secret),
    bob: Session.init(getPublicKey(aliceKey), bobKey, false, secret),
  };
}

function device() {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const delivered = vi.fn();
  return {
    delivered,
    actor: new DeviceRecordActor(pubkey, {
      ownerPubkey: pubkey,
      ourOwnerPubkey: pubkey,
      ourDeviceId: pubkey,
      identityKey: key,
      user: {
        isDeviceAuthorized: () => true,
        onDeviceRumor: delivered,
        onDeviceDirty() {},
      },
      nostr: { subscribe: () => () => {}, publish: async () => {} },
      messageQueue: new MessageQueue(
        new InMemoryStorageAdapter(),
        "retry-test/",
      ),
    }),
  };
}

describe("pending ciphertext retries", () => {
  it("does not repeat decryption against unchanged sessions and still accepts a newly installed session", () => {
    const { alice, bob } = pair();
    const unrelated = pair().alice;
    const { actor, delivered } = device();
    actor.installSession(unrelated);
    const receive = vi.spyOn(unrelated, "receiveEvent");
    const { event } = alice.sendEvent({
      kind: 14,
      content: "arrived before the invite",
    });

    for (let i = 0; i < 30; i++)
      expect(actor.processReceivedEvent(event)).toBe(false);
    expect(receive).toHaveBeenCalledTimes(1);

    actor.installSession(bob, true);
    expect(actor.processReceivedEvent(event)).toBe(true);
    expect(delivered).toHaveBeenCalledWith(
      actor.deviceId,
      expect.objectContaining({ content: "arrived before the invite" }),
      event,
    );
  });

  it("retries an earlier rejected ciphertext after the same session's receive state is restored", () => {
    const { alice, bob } = pair();
    const unrelated = pair().alice;
    const { actor, delivered } = device();
    actor.installSession(unrelated);
    const { event } = alice.sendEvent({
      kind: 14,
      content: "recovered session",
    });
    expect(actor.processReceivedEvent(event)).toBe(false);
    unrelated.state = deepCopyState(bob.state);
    expect(actor.processReceivedEvent(event)).toBe(true);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("preserves out-of-order delivery and ratchet replies", () => {
    const { alice, bob } = pair();
    const { actor, delivered } = device();
    actor.installSession(bob);
    const first = alice.sendEvent({ kind: 14, content: "first" }).event;
    const second = alice.sendEvent({ kind: 14, content: "second" }).event;
    expect(actor.processReceivedEvent(second)).toBe(true);
    expect(actor.processReceivedEvent(first)).toBe(true);
    expect(
      alice.receiveEvent(bob.sendEvent({ kind: 14, content: "reply" }).event)
        ?.content,
    ).toBe("reply");
    expect(
      actor.processReceivedEvent(
        alice.sendEvent({ kind: 14, content: "next turn" }).event,
      ),
    ).toBe(true);
    expect(delivered.mock.calls.map(([, rumor]) => rumor.content)).toEqual([
      "second",
      "first",
      "next turn",
    ]);
  });
});
