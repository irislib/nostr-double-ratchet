import type { StorageAdapter } from "../StorageAdapter.js";

/** Bounded, optional replay acceleration. Each of 256 slots stores one complete
 * authenticated outer ID. A collision or IO failure only misses the cache; it
 * cannot authorize delivery or suppress a different ciphertext. No key material
 * or plaintext is retained, and insertion happens after the receive-state save.
 */
export class ConsumedGroupEvents {
  constructor(private readonly storage: StorageAdapter, private readonly prefix: string) {}

  private key(id: string): string | undefined {
    return /^[0-9a-f]{64}$/.test(id) ? this.prefix + id.slice(0, 2) : undefined;
  }

  async has(id: string): Promise<boolean> {
    const key = this.key(id);
    if (!key) return false;
    try { return await this.storage.get<string>(key) === id; }
    catch { return false; }
  }

  async remember(id: string): Promise<void> {
    const key = this.key(id);
    if (!key) return;
    try { await this.storage.put(key, id); }
    catch { /* Optional acceleration cannot make a committed receive fail. */ }
  }
}
