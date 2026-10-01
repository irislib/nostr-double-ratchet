import type { Rumor, Unsubscribe } from "../types.js";
import type {
  OnDurableEventCallback,
  StoredDurableSessionEvent,
} from "./types.js";

export const DEFAULT_DURABLE_SESSION_KINDS = [
  10449, 10450, 10452, 10453,
] as const;
type Registration = { kinds: Set<number>; callback: OnDurableEventCallback };
type RecordWithInbox = {
  publicKey: string;
  pendingDurableEvents: Map<string, StoredDurableSessionEvent>;
};

/** The inbox shares each user's storage row with the advanced receiving ratchet. */
export class DurableSessionEvents {
  private readonly kinds = new Set<number>(DEFAULT_DURABLE_SESSION_KINDS);
  private readonly handlers = new Set<Registration>();
  private flushing?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private closed = false;
  private readonly pendingPersistence = new Map<string, number>();
  private generation = 0;

  constructor(
    private readonly records: () => Iterable<RecordWithInbox>,
    private readonly persist: (owner: string) => Promise<void>,
  ) {}

  handles(kind: number): boolean {
    return this.kinds.has(kind);
  }

  onEvent(
    kinds: readonly number[],
    callback: OnDurableEventCallback,
  ): Unsubscribe {
    if (this.closed) throw new Error("Session manager is closed");
    if (
      !kinds.length ||
      kinds.some((kind) => !Number.isSafeInteger(kind) || kind < 0)
    )
      throw new Error("Invalid durable event kinds");
    const registration = { kinds: new Set(kinds), callback };
    for (const kind of kinds) this.kinds.add(kind);
    this.handlers.add(registration);
    void this.flush();
    return () => {
      this.handlers.delete(registration);
    };
  }

  enqueue(record: RecordWithInbox, entry: StoredDurableSessionEvent): void {
    if (!record.pendingDurableEvents.has(entry.id))
      record.pendingDurableEvents.set(entry.id, structuredClone(entry));
    this.pendingPersistence.set(record.publicKey, ++this.generation);
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      if (
        !this.closed &&
        (this.pendingPersistence.size > 0 || this.hasDeliverable())
      ) {
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.flush();
        }, delay);
        this.retryTimer.unref?.();
      }
    });
    return this.flushing;
  }

  private matching(event: Rumor): Registration[] {
    return [...this.handlers].filter((handler) =>
      handler.kinds.has(event.kind),
    );
  }

  private hasDeliverable(): boolean {
    return [...this.records()].some((record) =>
      [...record.pendingDurableEvents.values()].some(
        (entry) => this.matching(entry.event).length,
      ),
    );
  }

  private async drain(): Promise<void> {
    try {
      for (const record of this.records()) {
        const entries = [...record.pendingDurableEvents.values()];
        if (!entries.length || this.closed) continue;
        // Persist even when no application handler exists. Never advance a saved
        // receive ratchet without saving its still-unacknowledged control too.
        const generation = this.pendingPersistence.get(record.publicKey);
        await this.persist(record.publicKey);
        if (this.pendingPersistence.get(record.publicKey) === generation)
          this.pendingPersistence.delete(record.publicKey);
        if (this.closed) return;
        for (const entry of entries) {
          if (record.pendingDurableEvents.get(entry.id) !== entry) continue;
          const handlers = this.matching(entry.event);
          if (!handlers.length) continue;
          try {
            for (const handler of handlers) {
              if (this.closed || !this.handlers.has(handler)) break;
              await handler.callback(
                structuredClone(entry.event),
                entry.sender,
                structuredClone(entry.meta),
              );
            }
            const currentHandlers = this.matching(entry.event);
            if (
              this.closed ||
              handlers.length !== currentHandlers.length ||
              handlers.some((handler) => !currentHandlers.includes(handler))
            )
              continue;
            record.pendingDurableEvents.delete(entry.id);
            try {
              await this.persist(record.publicKey);
            } catch (error) {
              // The application's write was durable, but our ACK was not. Replay
              // the same event ID, allowing its idempotent reducer to accept it.
              record.pendingDurableEvents.set(entry.id, entry);
              throw error;
            }
          } catch {
            this.failures += 1;
            // A failed or absent application must never consume the journal row.
          }
        }
      }
      if (!this.hasDeliverable()) this.failures = 0;
    } catch {
      this.failures += 1;
      // Keep the in-memory row. Disk retains either the previous ratchet or the
      // atomic advanced-ratchet + inbox bundle, so restart never loses the pair.
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.handlers.clear();
  }
}
