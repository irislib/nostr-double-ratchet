import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { Session } from "../src/Session";
import { buildTextRumor } from "../src/messageBuilders";
import { deserializeSessionState, serializeSessionState } from "../src/utils";
import { bytesToHex } from "@noble/hashes/utils";
import { privateResponderPublicKey, privateResponderSecretKey } from "../src/metadataPrivacy";
import { sessionMessageAuthorPubkeys } from "../src/session-manager/messageAuthors";
import { GROUP_SENDER_KEY_DISTRIBUTION_KIND } from "../src/GroupMeta";

describe("public invite transcript privacy", () => {
  it("never signs replies with the publicly announced invite key, including after restore", () => {
    const inviteSecret = generateSecretKey();
    const invitePublic = getPublicKey(inviteSecret);
    const initiatorSecret = generateSecretKey();
    const initiatorPublic = getPublicKey(initiatorSecret);
    const aliceIdentity = getPublicKey(generateSecretKey());
    const bobIdentity = getPublicKey(generateSecretKey());
    const sharedSecret = generateSecretKey();
    let alice = Session.init(invitePublic, initiatorSecret, true, sharedSecret);
    let bob = Session.init(initiatorPublic, inviteSecret, false, sharedSecret);

    for (let turn = 0; turn < 8; turn++) {
      const sending = turn % 2 === 0 ? alice : bob;
      const receiving = turn % 2 === 0 ? bob : alice;
      const senderIdentity = turn % 2 === 0 ? aliceIdentity : bobIdentity;
      const recipient = turn % 2 === 0 ? bobIdentity : aliceIdentity;
      const { event } = sending.sendEvent(
        {
          ...buildTextRumor(`turn ${turn}`, { pubkey: senderIdentity }),
          kind: [14, GROUP_SENDER_KEY_DISTRIBUTION_KIND, 21112, 40][turn % 4],
        },
        [["p", recipient]],
      );
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).not.toBe(invitePublic);
      expect(event.tags.filter(tag => tag[0] === "p")).toEqual([["p", recipient]]);
      expect(JSON.stringify(event)).not.toContain(senderIdentity);
      expect(receiving.receiveEvent(event)?.content).toBe(`turn ${turn}`);
      alice = new Session(deserializeSessionState(serializeSessionState(alice.state)));
      bob = new Session(deserializeSessionState(serializeSessionState(bob.state)));
    }
  });
});

it.each([
  [1, "dc9923d79b3ddc1389600085ad7224dbec36f6fd63597a1d1fd3e3e1128196f1", "4912fca7bc08b6038f448a07d8025c6856b5471636676ebcb67f629709643dda"],
  [6, "dcaebdd6c4d364d27dba489acc336383ded31cfa6ad68b58ce4307e7c697069b", "d39901b9c513ae5b82bfd2128dc3569eadcd6cce9f1bdb8c55397092e33f267d"],
])("matches shared Rust blinding vector for inviter secret %s", (lastByte, publicKey, secretKey) => {
  const inviter = new Uint8Array(32);
  inviter[31] = Number(lastByte);
  const initiator = new Uint8Array(32);
  initiator[31] = 21;
  expect(privateResponderPublicKey(initiator, getPublicKey(inviter))).toBe(publicKey);
  const secret = privateResponderSecretKey(inviter, getPublicKey(initiator));
  expect(bytesToHex(secret)).toBe(secretKey);
  expect(getPublicKey(secret)).toBe(publicKey);
  initiator[31] = 22;
  expect(privateResponderPublicKey(initiator, getPublicKey(inviter))).not.toBe(publicKey);
});

it("rejects unversioned state and arbitrary outer identity tags without advancing", () => {
  const session = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey());
  const before = serializeSessionState(session.state);
  for (const tags of [
    [["owner", getPublicKey(generateSecretKey())]],
    [["p", getPublicKey(generateSecretKey())], ["p", getPublicKey(generateSecretKey())]],
  ]) expect(() => session.sendEvent(buildTextRumor("private"), tags)).toThrow("Only one delivery recipient");
  expect(serializeSessionState(session.state)).toBe(before);
  const legacy = JSON.parse(before);
  delete legacy.metadataPrivacyVersion;
  const restored = new Session(deserializeSessionState(JSON.stringify(legacy)));
  expect(sessionMessageAuthorPubkeys(restored)).toEqual([]);
  expect(() => restored.sendEvent(buildTextRumor("private"))).toThrow("new private handshake");
});
