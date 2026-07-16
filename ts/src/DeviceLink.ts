import { getPublicKey, generateSecretKey } from "nostr-tools";

import { Invite } from "./Invite.js";

export interface DeviceLinkRequest {
  requestPubkey: string;
  deviceAppKeyPubkey: string;
  requestSecret: string;
  requestedAt: number;
  deviceLabel?: string;
  clientLabel?: string;
}

export interface LocalDeviceLinkRequest extends DeviceLinkRequest {
  requestSecretKey: Uint8Array;
}

export interface CreatedDeviceLinkRequest {
  request: LocalDeviceLinkRequest;
  deviceAppKeySecretKey: Uint8Array;
  code: string;
}

export function createDeviceLinkRequest(
  options: {
    deviceAppKeySecretKey?: Uint8Array;
    requestSecretKey?: Uint8Array;
    requestedAt?: number;
    deviceLabel?: string;
    clientLabel?: string;
  } = {},
): CreatedDeviceLinkRequest {
  const deviceAppKeySecretKey =
    options.deviceAppKeySecretKey ?? generateSecretKey();
  const requestSecretKey = options.requestSecretKey ?? generateSecretKey();
  const requestSecret = hexFromBytes(requestSecretKey);
  const request: LocalDeviceLinkRequest = {
    requestPubkey: getPublicKey(requestSecretKey),
    requestSecretKey,
    deviceAppKeyPubkey: getPublicKey(deviceAppKeySecretKey),
    requestSecret,
    requestedAt: options.requestedAt ?? currentUnixSeconds(),
    ...(normalizeLabel(options.deviceLabel)
      ? { deviceLabel: normalizeLabel(options.deviceLabel)! }
      : {}),
    ...(normalizeLabel(options.clientLabel)
      ? { clientLabel: normalizeLabel(options.clientLabel)! }
      : {}),
  };
  return {
    request,
    deviceAppKeySecretKey,
    code: encodeCompactDeviceLinkRequest(request),
  };
}

export function encodeCompactDeviceLinkRequest(request: {
  deviceAppKeyPubkey: string;
  requestSecret?: string;
  requestSecretKey?: Uint8Array;
  requestedAt?: number;
  deviceLabel?: string;
  clientLabel?: string;
}): string {
  const requestSecret = request.requestSecretKey
    ? hexFromBytes(request.requestSecretKey)
    : request.requestSecret;
  if (
    !requestSecret ||
    !isHex32Bytes(request.deviceAppKeyPubkey) ||
    !isHex32Bytes(requestSecret)
  ) {
    throw new Error("Invalid compact device link request");
  }
  const metadata = encodeDeviceLinkMetadata({
    requestedAt: request.requestedAt,
    deviceLabel: request.deviceLabel,
    clientLabel: request.clientLabel,
  });
  return `${request.deviceAppKeyPubkey.toLowerCase()}.${requestSecret.toLowerCase()}.${metadata}`;
}

export function parseCompactDeviceLinkRequest(
  input: string,
): DeviceLinkRequest | null {
  const parts = input.trim().split(".");
  if (parts.length !== 3) return null;
  const [deviceAppKeyPubkey, requestSecret, encodedMetadata] = parts;
  if (!isHex32Bytes(deviceAppKeyPubkey) || !isHex32Bytes(requestSecret))
    return null;
  const metadata = decodeDeviceLinkMetadata(encodedMetadata);
  if (!metadata) return null;
  const requestSecretKey = bytesFromHex(requestSecret);
  try {
    getPublicKey(requestSecretKey);
  } catch {
    return null;
  }
  return {
    requestPubkey: getPublicKey(requestSecretKey),
    deviceAppKeyPubkey: deviceAppKeyPubkey.toLowerCase(),
    requestSecret: requestSecret.toLowerCase(),
    requestedAt: metadata.requestedAt ?? currentUnixSeconds(),
    ...(metadata.deviceLabel ? { deviceLabel: metadata.deviceLabel } : {}),
    ...(metadata.clientLabel ? { clientLabel: metadata.clientLabel } : {}),
  };
}

export function deterministicLinkInviteForDeviceLinkRequest(
  request: DeviceLinkRequest,
): Invite {
  if (
    !isHex32Bytes(request.deviceAppKeyPubkey) ||
    !isHex32Bytes(request.requestSecret)
  ) {
    throw new Error("Invalid compact device link request");
  }
  const rng = new StdRngCompat(bytesFromHex(request.requestSecret));
  const inviterEphemeralPrivateKey = rng.nextSecretKey();
  const sharedSecret = hexFromBytes(rng.nextSecretKey());
  const deviceAppKeyPubkey = request.deviceAppKeyPubkey.toLowerCase();
  return new Invite(
    getPublicKey(inviterEphemeralPrivateKey),
    sharedSecret,
    deviceAppKeyPubkey,
    inviterEphemeralPrivateKey,
    deviceAppKeyPubkey,
    1,
    [],
    0,
    "link",
  );
}

const currentUnixSeconds = (): number => Math.floor(Date.now() / 1000);

const isHex32Bytes = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value);

interface CompactDeviceLinkMetadata {
  v: 1;
  requestedAt?: number;
  deviceLabel?: string;
  clientLabel?: string;
}

const encodeDeviceLinkMetadata = (input: {
  requestedAt?: number;
  deviceLabel?: string;
  clientLabel?: string;
}): string => {
  const requestedAt =
    input.requestedAt !== undefined &&
    Number.isInteger(input.requestedAt) &&
    input.requestedAt >= 0
      ? Math.floor(input.requestedAt)
      : undefined;
  const metadata: CompactDeviceLinkMetadata = {
    v: 1,
    ...(requestedAt !== undefined ? { requestedAt } : {}),
    ...(normalizeLabel(input.deviceLabel)
      ? { deviceLabel: normalizeLabel(input.deviceLabel)! }
      : {}),
    ...(normalizeLabel(input.clientLabel)
      ? { clientLabel: normalizeLabel(input.clientLabel)! }
      : {}),
  };
  return base64UrlEncodeUtf8(JSON.stringify(metadata));
};

const decodeDeviceLinkMetadata = (
  input: string | undefined,
): CompactDeviceLinkMetadata | null => {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    const value = JSON.parse(
      base64UrlDecodeUtf8(input),
    ) as Partial<CompactDeviceLinkMetadata>;
    if (!value || value.v !== 1) return null;
    const requestedAt =
      value.requestedAt !== undefined &&
      Number.isInteger(value.requestedAt) &&
      value.requestedAt >= 0
        ? value.requestedAt
        : undefined;
    return {
      v: 1,
      ...(requestedAt !== undefined ? { requestedAt } : {}),
      ...(normalizeLabel(value.deviceLabel)
        ? { deviceLabel: normalizeLabel(value.deviceLabel)! }
        : {}),
      ...(normalizeLabel(value.clientLabel)
        ? { clientLabel: normalizeLabel(value.clientLabel)! }
        : {}),
    };
  } catch {
    return null;
  }
};

const normalizeLabel = (label: unknown): string | undefined => {
  if (typeof label !== "string") return undefined;
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, 96).join("");
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const base64UrlEncodeUtf8 = (value: string): string => {
  const bytes = textEncoder.encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const base64UrlDecodeUtf8 = (value: string): string => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return textDecoder.decode(bytes);
};

const hexFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const bytesFromHex = (hex: string): Uint8Array => {
  if (!isHex32Bytes(hex)) throw new Error("Invalid hex secret");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

class StdRngCompat {
  private readonly seed: Uint8Array;
  private blockCounter = 0n;
  private buffer = new Uint8Array();
  private offset = 0;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("StdRng seed must be 32 bytes");
    this.seed = seed;
  }

  nextSecretKey(): Uint8Array {
    for (let attempts = 0; attempts < 16; attempts += 1) {
      const candidate = this.nextBytes(32);
      try {
        getPublicKey(candidate);
        return candidate;
      } catch {
        // Try another deterministic block.
      }
    }
    throw new Error("Could not derive a valid deterministic link key");
  }

  private nextBytes(length: number): Uint8Array {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.buffer.length) {
        this.buffer = this.nextBlock();
        this.offset = 0;
      }
      const take = Math.min(length - written, this.buffer.length - this.offset);
      output.set(this.buffer.slice(this.offset, this.offset + take), written);
      this.offset += take;
      written += take;
    }
    return output;
  }

  private nextBlock(): Uint8Array<ArrayBuffer> {
    const block = chachaBlock(this.seed, this.blockCounter, 12);
    this.blockCounter += 1n;
    return block;
  }
}

const chachaBlock = (
  key: Uint8Array,
  counter: bigint,
  rounds: number,
): Uint8Array<ArrayBuffer> => {
  const state = new Uint32Array(16);
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;
  for (let index = 0; index < 8; index += 1) {
    state[4 + index] = readU32Le(key, index * 4);
  }
  state[12] = Number(counter & 0xffffffffn);
  state[13] = Number((counter >> 32n) & 0xffffffffn);
  state[14] = 0;
  state[15] = 0;

  const working = new Uint32Array(state);
  for (let index = 0; index < rounds / 2; index += 1) {
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }

  const output = new Uint8Array(64);
  for (let index = 0; index < 16; index += 1) {
    writeU32Le(output, index * 4, (working[index] + state[index]) >>> 0);
  }
  return output;
};

const quarterRound = (
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
): void => {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotateLeft(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotateLeft(state[b] ^ state[c], 7);
};

const rotateLeft = (value: number, shift: number): number =>
  ((value << shift) | (value >>> (32 - shift))) >>> 0;

const readU32Le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>>
  0;

const writeU32Le = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
};
