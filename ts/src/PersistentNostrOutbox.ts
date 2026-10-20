import type { UnsignedEvent, VerifiedEvent } from "nostr-tools";
import type { StorageAdapter } from "./StorageAdapter.js";
import type { NostrPublishContext, NostrPublishError } from "./types.js";
import { hasMetadataPrivacyVersion } from "./metadataPrivacy.js";

function requiresPrivacyUpgrade(event: VerifiedEvent): boolean {
  return (event.kind === 1059 || event.kind === 1060) && !hasMetadataPrivacyVersion(event);
}

export interface PersistentNostrPublication {
  event: VerifiedEvent;
  innerEventId?: string;
  context?: NostrPublishContext;
}

export interface PersistentNostrOutboxOptions {
  /** Use account-scoped storage or an account-specific keyPrefix. One owner per prefix. */
  storage: StorageAdapter;
  /** Resolve only when a relay accepts this exact envelope; reject on failure or timeout. */
  publish: (event: VerifiedEvent, innerEventId?: string, context?: NostrPublishContext) => Promise<VerifiedEvent>;
  keyPrefix?: string;
  concurrency?: number;
  retryDelayMs?: number;
  onError?: (failure: NostrPublishError) => void;
  /** Optional durable application ACK. Failure retains the envelope for retry. */
  onPublished?: (publication: PersistentNostrPublication) => void | Promise<void>;
}

/** Optional durable relay handoff for NdrRuntime's nostrEnqueue/nostrPublish hooks.
 * Retries exact signed envelopes, never plaintext or a newly advanced ratchet.
 * Hosts retain control of relays, signing, publication policy and connectivity.
 */
export function createPersistentNostrOutbox(options: PersistentNostrOutboxOptions) {
  const prefix = options.keyPrefix ?? "v1/runtime-outbox/";
  const concurrency = options.concurrency ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  if (!prefix || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64 ||
    !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 2_147_483_647)
    throw new Error("Invalid outbox options");
  const keys = new Set<string>();
  const blocked = new Set<string>();
  const enqueuing = new Map<string, Promise<void>>();
  const attempts = new Map<string, Promise<VerifiedEvent>>();
  const writes = new Set<Promise<unknown>>();
  const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let active = 0;
  let closed = false;
  let loaded = false;
  let loading: Promise<void> | undefined;
  let retrying: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closedError = new Error("Nostr outbox is closed");
  let rejectClosed!: (error: Error) => void;
  const closedPromise = new Promise<never>((_, reject) => { rejectClosed = reject; });
  void closedPromise.catch(() => {});
  const assertOpen = () => { if (closed) throw closedError; };

  async function load() {
    assertOpen();
    if (loaded) return;
    if (!loading) loading = options.storage.list(prefix).then((stored) => {
      assertOpen();
      for (const key of stored) if (key.startsWith(prefix)) keys.add(key);
      loaded = true;
    }).finally(() => { loading = undefined; });
    await loading;
  }
  function write<T>(action: () => Promise<T>): Promise<T> {
    assertOpen();
    const promise = action();
    writes.add(promise);
    void promise.finally(() => writes.delete(promise)).catch(() => {});
    return promise;
  }
  function schedule() {
    if (closed || keys.size === 0) { clearTimeout(timer); timer = undefined; return; }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void retry().catch(() => {}).finally(schedule);
    }, retryDelayMs);
    timer.unref?.();
  }
  async function enqueue(event: VerifiedEvent, innerEventId?: string, context?: NostrPublishContext) {
    assertOpen();
    if (!event.id || !event.sig) throw new Error("Cannot queue an unsigned event");
    if (requiresPrivacyUpgrade(event)) throw new Error("Publication requires a new private handshake");
    const key = prefix + event.id;
    const existing = enqueuing.get(key);
    if (existing) return existing;
    const row: PersistentNostrPublication = structuredClone({ event, innerEventId, context });
    const pending = (async () => {
      await load();
      assertOpen();
      if (!keys.has(key)) {
        await write(() => options.storage.put(key, row));
        assertOpen();
        keys.add(key);
      }
      schedule();
    })().finally(() => enqueuing.delete(key));
    enqueuing.set(key, pending);
    return pending;
  }
  async function acquire() {
    assertOpen();
    if (active < concurrency) { active++; return; }
    await new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    assertOpen();
  }
  function release() {
    const next = waiting.shift();
    if (next && !closed) next.resolve();
    else active--;
  }
  function attempt(key: string): Promise<VerifiedEvent> {
    const existing = attempts.get(key);
    if (existing) return existing;
    const pending = (async () => {
      await acquire();
      let row: PersistentNostrPublication | undefined;
      try {
        assertOpen();
        await enqueuing.get(key);
        row = await options.storage.get<PersistentNostrPublication>(key);
        assertOpen();
        if (!row) { keys.delete(key); throw new Error("Outbox envelope is missing"); }
        if (requiresPrivacyUpgrade(row.event)) {
          // Preserve the original ciphertext for the host to inspect or replace.
          // It must neither reach the relay nor spin in the automatic retry loop.
          blocked.add(key);
          keys.delete(key);
          throw new Error("Publication requires a new private handshake");
        }
        const result = await Promise.race([
          options.publish(structuredClone(row.event), row.innerEventId, structuredClone(row.context)),
          closedPromise,
        ]);
        assertOpen();
        if (result.id !== row.event.id || result.sig !== row.event.sig)
          throw new Error("Relay acknowledged a different envelope");
        await options.onPublished?.(structuredClone(row));
        assertOpen();
        await write(() => options.storage.del(key));
        assertOpen();
        keys.delete(key);
        return row.event;
      } catch (error) {
        if (!closed && row) {
          try { options.onError?.({ event: structuredClone(row.event), innerEventId: row.innerEventId, error }); }
          catch { /* Error observers must not break retries. */ }
        }
        throw error;
      } finally { release(); schedule(); }
    })().finally(() => attempts.delete(key));
    attempts.set(key, pending);
    return pending;
  }
  async function publish(event: UnsignedEvent | VerifiedEvent, innerEventId?: string, context?: NostrPublishContext) {
    if (!("sig" in event) || !event.sig) throw new Error("Cannot queue an unsigned event");
    const key = prefix + event.id;
    await enqueue(event as VerifiedEvent, innerEventId, context);
    assertOpen();
    return attempt(key);
  }
  function retry(): Promise<void> {
    if (closed) return Promise.reject(closedError);
    if (retrying) return retrying;
    retrying = (async () => {
      await load();
      const remaining = [...keys].filter(key => !blocked.has(key));
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, async () => {
        while (!closed && index < remaining.length) {
          const key = remaining[index++];
          // A failure affects only this envelope; newer envelopes still get a turn.
          try { await attempt(key); } catch { /* Retain failed envelopes. */ }
        }
      }));
    })().finally(() => { retrying = undefined; schedule(); });
    return retrying;
  }
  async function close() {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    rejectClosed(closedError);
    for (const waiter of waiting.splice(0)) waiter.reject(closedError);
    // Do not wait for a disconnected transport. Only already-started storage
    // mutations may finish; late ACKs cannot delete rows or call application hooks.
    await Promise.allSettled([...writes]);
  }
  return { enqueue, publish, retry, close };
}
