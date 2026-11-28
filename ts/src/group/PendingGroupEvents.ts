import type { VerifiedEvent } from "nostr-tools";
import type { StorageAdapter } from "../StorageAdapter.js";

// Bound serialized pending data per group, including space for an authenticated
// delivery acknowledgement. Admission fails explicitly; accepted events stay.
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
interface PendingDelivery { keyId: number; messageNumber: number }
interface PendingEvent {
  outer: VerifiedEvent;
  order: number;
  messageNumber: number;
  delivered?: PendingDelivery;
}

// Like the surrounding ratchet state, this inbox assumes one serialized writer
// per group/storage namespace. GroupManager supplies that serialization; direct
// Group users must serialize calls and must not share a namespace across tabs.
export class PendingGroupEvents {
  private serial: Promise<unknown> = Promise.resolve();
  private accounting?: { bytes: number; next: number };
  private keys?: Set<string>;

  constructor(private readonly storage: StorageAdapter, private readonly prefix: string) {}

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => { this.accounting = undefined; this.keys = undefined; });
    return result;
  }

  private async pendingKeys(): Promise<Set<string>> {
    return this.keys ??= new Set(await this.storage.list(this.prefix));
  }

  private size(key: string, event: PendingEvent): number {
    // Reserve the acknowledgement's maximum size up front, so a full inbox
    // can still finish delivery without needing more admission capacity.
    return new TextEncoder().encode(key + JSON.stringify({ ...event,
      delivered: { keyId: 0xffff_ffff, messageNumber: 0xffff_ffff } })).length;
  }

  private async read(key: string): Promise<PendingEvent> {
    const event = await this.storage.get<PendingEvent>(key);
    // LocalStorage keeps its legacy corrupt-JSON behavior for general callers.
    // A listed but unreadable inbox row cannot count as absent or free space.
    if (!event) throw new Error("Unreadable pending group ciphertext record");
    return event;
  }

  private async usage(): Promise<{ bytes: number; next: number }> {
    if (this.accounting) return this.accounting;
    const usage = { bytes: 0, next: 0 };
    for (const key of await this.pendingKeys()) {
      const event = await this.read(key);
      usage.bytes += this.size(key, event);
      usage.next = Math.max(usage.next, event.order + 1);
    }
    return this.accounting = usage;
  }

  private eventKey(sender: string, keyId: number | undefined, id: string): string {
    return `${this.prefix}${sender}/${keyId === undefined ? "*" : keyId >>> 0}/${id}`;
  }

  async enqueue(sender: string, keyId: number | undefined, outer: VerifiedEvent, messageNumber: number): Promise<void> {
    await this.locked(async () => {
      const key = this.eventKey(sender, keyId, outer.id);
      const keys = await this.pendingKeys();
      if (keys.has(key)) return;
      const usage = await this.usage();
      const event: PendingEvent = { outer, order: usage.next, messageNumber };
      const bytes = this.size(key, event);
      if (usage.bytes + bytes > MAX_PENDING_BYTES) {
        throw new Error("Group pending ciphertext storage is full; retry after sender-key repair");
      }
      await this.storage.put(key, event);
      keys.add(key);
      usage.bytes += bytes;
      usage.next++;
    });
  }

  async find(sender: string, keyId: number | undefined, id: string): Promise<{ key: string; event: PendingEvent } | undefined> {
    return this.locked(async () => {
      const key = this.eventKey(sender, keyId, id);
      if (!(await this.pendingKeys()).has(key)) return undefined;
      return { key, event: await this.read(key) };
    });
  }

  async acknowledge(key: string, event: PendingEvent, delivered: PendingDelivery): Promise<void> {
    await this.locked(() => this.storage.put(key, { ...event, delivered }));
  }

  async entries(sender: string, keyId: number): Promise<string[]> {
    return this.locked(async () => {
      const prefixes = [keyId >>> 0, "*"].map(bucket => `${this.prefix}${sender}/${bucket}/`);
      const entries: Array<{ key: string; order: number; messageNumber: number }> = [];
      for (const key of await this.pendingKeys()) {
        if (!prefixes.some(prefix => key.startsWith(prefix))) continue;
        const event = await this.read(key);
        entries.push({ key, order: event.order, messageNumber: event.messageNumber });
      }
      return entries.sort((a, b) => a.messageNumber - b.messageNumber || a.order - b.order).map(entry => entry.key);
    });
  }

  async get(key: string): Promise<VerifiedEvent> { return (await this.read(key)).outer; }

  async remove(key: string, known?: PendingEvent): Promise<void> {
    await this.locked(async () => {
      const keys = await this.pendingKeys();
      if (!keys.has(key)) return;
      const event = known ?? await this.read(key);
      await this.storage.del(key);
      keys.delete(key);
      if (this.accounting) this.accounting.bytes -= this.size(key, event);
    });
  }

  async removeSender(sender: string): Promise<void> {
    for (const key of await this.pendingKeys()) {
      if (key.startsWith(`${this.prefix}${sender}/`)) await this.remove(key);
    }
  }
}
