import type { StorageAdapter } from "../StorageAdapter.js";

const RETENTION_MS = 60 * 60 * 1000;
interface Receipt { id: string; expiresAt: number }

/** Bounded, optional replay acceleration. Each of 256 slots stores one complete
 * authenticated outer ID. A collision or IO failure only misses the cache; it
 * cannot authorize delivery or suppress a different ciphertext. No key material
 * or plaintext is retained, and insertion happens after the receive-state save.
 */
export class ConsumedGroupEvents {
  private nextSweep = 0;
  constructor(private readonly storage: StorageAdapter, private readonly prefix: string) {}

  private key(id: string): string | undefined {
    return /^[0-9a-f]{64}$/.test(id) ? this.prefix + id.slice(0, 2) : undefined;
  }

  private valid(value: unknown, now: number): value is Receipt {
    const row = value as Receipt | undefined;
    return !!row && typeof row.id === "string" && /^[0-9a-f]{64}$/.test(row.id) &&
      Number.isSafeInteger(row.expiresAt) && row.expiresAt > now && row.expiresAt <= now + RETENTION_MS;
  }

  private async slots(): Promise<string[]> {
    return (await this.storage.list(this.prefix)).filter(key =>
      /^[0-9a-f]{2}$/.test(key.slice(this.prefix.length)));
  }

  private async sweep(now: number): Promise<void> {
    if (now < this.nextSweep) return;
    this.nextSweep = now + RETENTION_MS;
    // One bounded sweep on first use after restart, then at most hourly.
    // No background timer or promise of erasure while the application is closed.
    for (const key of await this.slots()) {
      if (!this.valid(await this.storage.get(key), now)) await this.storage.del(key);
    }
  }

  /** Explicit lifecycle erase must report failure, unlike optional cache IO. */
  async clear(): Promise<void> {
    for (const key of await this.slots()) await this.storage.del(key);
    this.nextSweep = 0;
  }

  async has(id: string): Promise<boolean> {
    const key = this.key(id);
    if (!key) return false;
    try {
      const now = Date.now();
      await this.sweep(now);
      const row = await this.storage.get<Receipt>(key);
      return this.valid(row, now) && row.id === id;
    }
    catch { return false; }
  }

  async remember(id: string): Promise<void> {
    const key = this.key(id);
    if (!key) return;
    try { await this.storage.put(key, { id, expiresAt: Date.now() + RETENTION_MS }); }
    catch { /* Optional acceleration cannot make a committed receive fail. */ }
  }
}
