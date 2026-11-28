import { expand } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import * as nip44 from "nostr-tools/nip44";
import { base64Encode } from "../base64.js";

/** Prepare one NIP-44 v2 envelope for multiple sender-key trials. This is only
 * a negative filter: a MAC match still uses the canonical decryptor, including
 * its authentication, padding and version checks, before accepting plaintext.
 * No key, plaintext or prepared envelope survives the current search call.
 */
export function senderKeyTrial(ciphertextBytes: Uint8Array): (key: Uint8Array) => string | null {
  if (ciphertextBytes.length < 99 || ciphertextBytes[0] !== 2) {
    throw new Error("Invalid sender-key NIP-44 payload");
  }
  const nonce = ciphertextBytes.subarray(1, 33);
  const authenticated = ciphertextBytes.subarray(1, -32);
  const mac = ciphertextBytes.subarray(-32);
  let payload: string | undefined;
  return key => {
    // NIP-44 v2 expands 76 bytes: ChaCha key[0:32], nonce[32:44],
    // HMAC key[44:76]. Authenticate nonce || encrypted padded content.
    const expanded = expand(sha256, key, nonce, 76);
    const calculated = hmac(sha256, expanded.subarray(44), authenticated);
    let difference = 0;
    for (let i = 0; i < 32; i++) difference |= calculated[i] ^ mac[i];
    expanded.fill(0);
    calculated.fill(0);
    if (difference !== 0) return null;
    payload ??= base64Encode(ciphertextBytes);
    return nip44.v2.decrypt(payload, key);
  };
}
