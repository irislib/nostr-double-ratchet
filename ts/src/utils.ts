import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import {
  Rumor,
  SessionState,
  ReactionPayload,
  REACTION_KIND,
  ReceiptPayload,
  ReceiptType,
  RECEIPT_KIND,
  TYPING_KIND,
  EXPIRATION_TAG,
  ExpirationOptions,
} from "./types.js";
import type { Session } from "./Session.js";
import { extract as hkdf_extract, expand as hkdf_expand } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const VERSION_NUMBER = 1;

export function serializeSessionState(state: SessionState): string {
  return JSON.stringify({
    version: VERSION_NUMBER,
    rootKey: bytesToHex(state.rootKey),
    theirCurrentNostrPublicKey: state.theirCurrentNostrPublicKey,
    theirNextNostrPublicKey: state.theirNextNostrPublicKey,
    ourCurrentNostrKey: state.ourCurrentNostrKey ? {
      publicKey: state.ourCurrentNostrKey.publicKey,
      privateKey: bytesToHex(state.ourCurrentNostrKey.privateKey),
    } : undefined,
    ourNextNostrKey: {
      publicKey: state.ourNextNostrKey.publicKey,
      privateKey: bytesToHex(state.ourNextNostrKey.privateKey),
    },
    receivingChainKey: state.receivingChainKey ? bytesToHex(state.receivingChainKey) : undefined,
    sendingChainKey: state.sendingChainKey ? bytesToHex(state.sendingChainKey) : undefined,
    sendingChainMessageNumber: state.sendingChainMessageNumber,
    receivingChainMessageNumber: state.receivingChainMessageNumber,
    previousSendingChainMessageCount: state.previousSendingChainMessageCount,
    skippedKeys: Object.fromEntries(
      Object.entries(state.skippedKeys).map(([pubKey, value]) => [
        pubKey,
        {
          headerKeys: value.headerKeys.map(bytes => bytesToHex(bytes)),
          messageKeys: Object.fromEntries(
            Object.entries(value.messageKeys).map(([msgIndex, bytes]) => [
              msgIndex,
              bytesToHex(bytes)
            ])
          )
        }
      ])
    ),
  });
}

export function deserializeSessionState(data: string): SessionState {
  const state = JSON.parse(data);
  
  // Handle version 0 (legacy format)
  if (!state.version) {
    const skippedKeys: SessionState['skippedKeys'] = {};
    
    // Migrate old skipped keys format to new structure
    if (state.skippedMessageKeys) {
      Object.entries(state.skippedMessageKeys).forEach(([pubKey, messageKeys]: [string, unknown]) => {
        skippedKeys[pubKey] = {
          headerKeys: state.skippedHeaderKeys?.[pubKey] || [],
          messageKeys: messageKeys as { [msgIndex: number]: Uint8Array }
        };
      });
    }
    
    return {
      rootKey: hexToBytes(state.rootKey),
      theirCurrentNostrPublicKey: state.theirCurrentNostrPublicKey,
      theirNextNostrPublicKey: state.theirNextNostrPublicKey,
      ourCurrentNostrKey: state.ourCurrentNostrKey ? {
        publicKey: state.ourCurrentNostrKey.publicKey,
        privateKey: hexToBytes(state.ourCurrentNostrKey.privateKey),
      } : undefined,
      ourNextNostrKey: {
        publicKey: state.ourNextNostrKey.publicKey,
        privateKey: hexToBytes(state.ourNextNostrKey.privateKey),
      },
      receivingChainKey: state.receivingChainKey ? hexToBytes(state.receivingChainKey) : undefined,
      sendingChainKey: state.sendingChainKey ? hexToBytes(state.sendingChainKey) : undefined,
      sendingChainMessageNumber: state.sendingChainMessageNumber,
      receivingChainMessageNumber: state.receivingChainMessageNumber,
      previousSendingChainMessageCount: state.previousSendingChainMessageCount,
      skippedKeys
    };
  }
  
  // Handle current version
  return {
    rootKey: hexToBytes(state.rootKey),
    theirCurrentNostrPublicKey: state.theirCurrentNostrPublicKey,
    theirNextNostrPublicKey: state.theirNextNostrPublicKey,
    ourCurrentNostrKey: state.ourCurrentNostrKey ? {
      publicKey: state.ourCurrentNostrKey.publicKey,
      privateKey: hexToBytes(state.ourCurrentNostrKey.privateKey),
    } : undefined,
    ourNextNostrKey: {
      publicKey: state.ourNextNostrKey.publicKey,
      privateKey: hexToBytes(state.ourNextNostrKey.privateKey),
    },
    receivingChainKey: state.receivingChainKey ? hexToBytes(state.receivingChainKey) : undefined,
    sendingChainKey: state.sendingChainKey ? hexToBytes(state.sendingChainKey) : undefined,
    sendingChainMessageNumber: state.sendingChainMessageNumber,
    receivingChainMessageNumber: state.receivingChainMessageNumber,
    previousSendingChainMessageCount: state.previousSendingChainMessageCount,
    skippedKeys: Object.fromEntries(
      Object.entries(state.skippedKeys || {}).map(([pubKey, value]) => [
        pubKey,
        {
          headerKeys: (value as { headerKeys: string[] }).headerKeys.map((hex: string) => hexToBytes(hex)),
          messageKeys: Object.fromEntries(
            Object.entries((value as { messageKeys: Record<string, string> }).messageKeys).map(([msgIndex, hex]) => [
              msgIndex,
              hexToBytes(hex as string)
            ])
          )
        }
      ])
    ),
  };
}

export function deepCopyState(s: SessionState): SessionState {
  return {
    rootKey: new Uint8Array(s.rootKey),
    theirCurrentNostrPublicKey: s.theirCurrentNostrPublicKey,
    theirNextNostrPublicKey: s.theirNextNostrPublicKey,
    ourCurrentNostrKey: s.ourCurrentNostrKey
      ? {
          publicKey: s.ourCurrentNostrKey.publicKey,
          privateKey: new Uint8Array(s.ourCurrentNostrKey.privateKey),
        }
      : undefined,
    ourNextNostrKey: {
      publicKey: s.ourNextNostrKey.publicKey,
      privateKey: new Uint8Array(s.ourNextNostrKey.privateKey),
    },
    receivingChainKey: s.receivingChainKey ? new Uint8Array(s.receivingChainKey) : undefined,
    sendingChainKey: s.sendingChainKey ? new Uint8Array(s.sendingChainKey) : undefined,
    sendingChainMessageNumber: s.sendingChainMessageNumber,
    receivingChainMessageNumber: s.receivingChainMessageNumber,
    previousSendingChainMessageCount: s.previousSendingChainMessageCount,
    skippedKeys: Object.fromEntries(
      Object.entries(s.skippedKeys).map(([author, entry]) => [
        author,
        {
          headerKeys: entry.headerKeys.map((hk) => new Uint8Array(hk)),
          messageKeys: Object.fromEntries(
            Object.entries(entry.messageKeys).map(([n, mk]) => [n, new Uint8Array(mk)])
          ),
        },
      ])
    ),
  };
}


export async function* createEventStream(session: Session): AsyncGenerator<Rumor, void, unknown> {
  const messageQueue: Rumor[] = [];
  let resolveNext: ((_value: Rumor) => void) | null = null;

  const unsubscribe = session.onEvent((_event) => {
    if (resolveNext) {
      resolveNext(_event);
      resolveNext = null;
    } else {
      messageQueue.push(_event);
    }
  });

  try {
    while (true) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      } else {
        yield new Promise<Rumor>(resolve => {
          resolveNext = resolve;
        });
      }
    }
  } finally {
    unsubscribe();
  }
}

export function kdf(input1: Uint8Array, input2: Uint8Array = new Uint8Array(32), numOutputs: number = 1): Uint8Array[] {
  const prk = hkdf_extract(sha256, input1, input2);
  
  const outputs: Uint8Array[] = [];
  for (let i = 1; i <= numOutputs; i++) {
    outputs.push(hkdf_expand(sha256, prk, new Uint8Array([i]), 32));
  }
  return outputs;
}

export function getMillisecondTimestamp(event: Rumor) {
  const msTag = event.tags?.find((tag: string[]) => tag[0] === "ms");
  if (msTag) {
    return parseInt(msTag[1]);
  }
  return event.created_at * 1000;
}

function ensureSafeIntegerSeconds(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number (unix seconds)`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer (unix seconds)`)
  }
  if (value < 0) {
    throw new Error(`${name} must be >= 0`)
  }
  return value
}

export function resolveExpirationSeconds(
  options: ExpirationOptions | undefined,
  nowSeconds: number
): number | undefined {
  if (!options) return undefined

  const hasExpiresAt = options.expiresAt !== undefined
  const hasTtl = options.ttlSeconds !== undefined
  if (hasExpiresAt && hasTtl) {
    throw new Error("Provide either expiresAt or ttlSeconds, not both")
  }

  if (hasExpiresAt) {
    return ensureSafeIntegerSeconds(options.expiresAt, "expiresAt")
  }

  if (hasTtl) {
    const ttl = ensureSafeIntegerSeconds(options.ttlSeconds, "ttlSeconds")
    return nowSeconds + ttl
  }

  return undefined
}

export function upsertExpirationTag(tags: string[][], expiresAtSeconds: number): void {
  const exp = ensureSafeIntegerSeconds(expiresAtSeconds, "expiresAt")
  for (let i = tags.length - 1; i >= 0; i--) {
    if (tags[i]?.[0] === EXPIRATION_TAG) {
      tags.splice(i, 1)
    }
  }
  tags.push([EXPIRATION_TAG, String(exp)])
}

export function getExpirationTimestampSeconds(event: { tags?: string[][] }): number | undefined {
  const expTag = event.tags?.find((tag) => tag[0] === EXPIRATION_TAG)
  if (!expTag) return undefined
  const value = Number(expTag[1])
  if (!Number.isFinite(value)) return undefined
  // NIP-40 is unix seconds; be strict about integers.
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

export function isExpired(event: { tags?: string[][] }, nowSeconds: number): boolean {
  const exp = getExpirationTimestampSeconds(event)
  return exp !== undefined && exp <= nowSeconds
}

/**
 * Parse a reaction from a rumor event.
 * Reactions are identified by kind 7 with emoji in content and messageId in ["e", ...] tag.
 * @param rumor An event-like object with kind, content, and tags
 * @returns The parsed ReactionPayload if valid, null otherwise
 */
export function parseReaction(rumor: { kind: number; content: string; tags?: string[][] }): ReactionPayload | null {
  if (rumor.kind !== REACTION_KIND) return null;
  const messageId = rumor.tags?.find(t => t[0] === "e")?.[1] || "";
  return { type: 'reaction', messageId, emoji: rumor.content };
}

/**
 * Check if a rumor event is a reaction.
 * @param rumor An event-like object with at least a kind field
 * @returns true if the event is a reaction
 */
export function isReaction(rumor: { kind: number }): boolean {
  return rumor.kind === REACTION_KIND;
}

const RECEIPT_STATUS_ORDER: Record<ReceiptType, number> = {
  delivered: 1,
  seen: 2,
};

export function isReceiptType(value: string): value is ReceiptType {
  return value === "delivered" || value === "seen";
}

export function shouldAdvanceReceiptStatus(
  current: ReceiptType | undefined,
  incoming: ReceiptType
): boolean {
  const currentOrder = current ? RECEIPT_STATUS_ORDER[current] ?? 0 : 0;
  const incomingOrder = RECEIPT_STATUS_ORDER[incoming] ?? 0;
  return incomingOrder > currentOrder;
}

export function parseReceipt(rumor: {
  kind: number;
  content: string;
  tags?: string[][];
}): ReceiptPayload | null {
  if (rumor.kind !== RECEIPT_KIND) return null;
  if (!isReceiptType(rumor.content)) return null;
  const messageIds =
    rumor.tags?.filter((tag) => tag[0] === "e").map((tag) => tag[1]) || [];
  if (messageIds.length === 0) return null;
  return {
    type: rumor.content,
    messageIds,
  };
}

export function isTyping(rumor: { kind: number }): boolean {
  return rumor.kind === TYPING_KIND;
}
