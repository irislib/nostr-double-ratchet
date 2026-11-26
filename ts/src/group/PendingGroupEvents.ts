import type { VerifiedEvent } from "nostr-tools";
import type { StorageAdapter } from "../StorageAdapter.js";

// A storage-backed inbox, not a lossy ciphertext cache. Bound total serialized
// bytes per group (including record/key overhead); reject admission explicitly
// when full so the caller can retry after repair, just as on a storage failure.
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

interface PendingEvent {
  outer: VerifiedEvent;
  order: number;
  messageNumber: number;
}

export class PendingGroupEvents {
  private serial: Promise<unknown> = Promise.resolve();
  private accounting?: { bytes: number; next: number };

  constructor(private readonly storage: StorageAdapter, private readonly prefix: string) {}

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => { this.accounting = undefined; });
    return result;
  }

  private size(key: string, event: PendingEvent): number {
    return new TextEncoder().encode(key + JSON.stringify(event)).length;
  }

  private async usage(): Promise<{ bytes: number; next: number }> {
    if (this.accounting) return this.accounting;
    const usage = { bytes: 0, next: 0 };
    for (const key of await this.storage.list(this.prefix)) {
      const event = await this.storage.get<PendingEvent>(key);
      if (!event) continue;
      usage.bytes += this.size(key, event);
      usage.next = Math.max(usage.next, event.order + 1);
    }
    // Failed reads must not cache an empty or partial inbox.
    return this.accounting = usage;
  }

  async enqueue(sender: string, keyId: number | undefined, outer: VerifiedEvent, messageNumber: number): Promise<void> {
    await this.locked(async () => {
      const key = `${this.prefix}${sender}/${keyId === undefined ? "*" : keyId >>> 0}/${outer.id}`;
      if (await this.storage.get(key)) return;
      const usage = await this.usage();
      const event: PendingEvent = { outer, order: usage.next, messageNumber };
      const bytes = this.size(key, event);
      if (usage.bytes + bytes > MAX_PENDING_BYTES) {
        throw new Error("Group pending ciphertext storage is full; retry after sender-key repair");
      }
      await this.storage.put(key, event);
      usage.bytes += bytes;
      usage.next++;
    });
  }

  async entries(sender: string, keyId: number): Promise<string[]> {
    return this.locked(async () => {
      // Retain only ordering metadata while enumerating. Read ciphertexts one
      // at a time during the drain. The byte quota also bounds this key list.
      const entries: Array<{ key: string; order: number; messageNumber: number }> = [];
      for (const bucket of [keyId >>> 0, "*"]) {
        for (const key of await this.storage.list(`${this.prefix}${sender}/${bucket}/`)) {
          const event = await this.storage.get<PendingEvent>(key);
          if (event) entries.push({ key, order: event.order, messageNumber: event.messageNumber });
        }
      }
      return entries.sort((a, b) => a.messageNumber - b.messageNumber || a.order - b.order).map(entry => entry.key);
    });
  }

  async get(key: string): Promise<VerifiedEvent | undefined> {
    return (await this.storage.get<PendingEvent>(key))?.outer;
  }

  async remove(key: string): Promise<void> {
    await this.locked(async () => {
      const event = await this.storage.get<PendingEvent>(key);
      if (!event) return;
      await this.storage.del(key);
      if (this.accounting) this.accounting.bytes -= this.size(key, event);
    });
  }

  async removeSender(sender: string): Promise<void> {
    for (const key of await this.storage.list(`${this.prefix}${sender}/`)) await this.remove(key);
  }
}
