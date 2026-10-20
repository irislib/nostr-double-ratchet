import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { getPublicKey, nip44 } from "nostr-tools";

export const METADATA_PRIVACY_VERSION = 2;
export const METADATA_PRIVACY_TAG = ["v", String(METADATA_PRIVACY_VERSION)];

/** A format marker, not authentication: callers must also verify the event. */
export function hasMetadataPrivacyVersion(event: { tags: string[][] }): boolean {
  const versions = event.tags.filter(tag => tag[0] === "v");
  return versions.length === 1 &&
    versions[0].length === 2 && versions[0][1] === String(METADATA_PRIVACY_VERSION);
}

const DOMAIN = utf8ToBytes("NIP-118/responder-key-blinding/v2");
const ORDER = schnorr.Point.Fn.ORDER;

function scalar(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function scalarBytes(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

function responderTweak(
  ourSecret: Uint8Array,
  theirPublic: string,
  inviterPublic: string,
  initiatorPublic: string,
): bigint {
  const shared = nip44.getConversationKey(ourSecret, theirPublic);
  const tweak = scalar(sha256(concatBytes(
    DOMAIN, shared, hexToBytes(inviterPublic), hexToBytes(initiatorPublic),
  )));
  // Reject the negligible invalid-scalar cases; never fall back to the public invite key.
  if (tweak === 0n || tweak >= ORDER) throw new Error("Invalid responder key tweak");
  return tweak;
}

/**
 * Blind the public invite key with a DH-secret tweak unique to this acceptance.
 * Only the inviter knows the resulting private key. The initiator derives its
 * public key, while relay observers cannot link it to the announced invite.
 */
export function privateResponderPublicKey(
  initiatorSecret: Uint8Array,
  inviterPublic: string,
): string {
  const tweak = responderTweak(initiatorSecret, inviterPublic, inviterPublic, getPublicKey(initiatorSecret));
  const base = schnorr.utils.lift_x(BigInt(`0x${inviterPublic}`));
  const point = base.add(schnorr.Point.BASE.multiply(tweak));
  if (point.equals(schnorr.Point.ZERO)) throw new Error("Invalid blinded responder key");
  return bytesToHex(schnorr.utils.pointToBytes(point));
}

export function privateResponderSecretKey(
  inviterSecret: Uint8Array,
  initiatorPublic: string,
): Uint8Array {
  const inviterPublic = getPublicKey(inviterSecret);
  const tweak = responderTweak(inviterSecret, initiatorPublic, inviterPublic, initiatorPublic);
  const secret = scalar(inviterSecret);
  // Nostr public keys are x-only: normalize the original secret to the even-Y point.
  const normalized = schnorr.Point.BASE.multiply(secret).y % 2n === 0n ? secret : ORDER - secret;
  const blinded = (normalized + tweak) % ORDER;
  if (blinded === 0n) throw new Error("Invalid blinded responder key");
  return scalarBytes(blinded);
}
