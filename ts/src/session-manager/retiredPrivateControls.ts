import type { StorageAdapter } from "../StorageAdapter.js";
import type { QueueEntry } from "../MessageQueue.js";

/** Retire only identifiable plaintext V1 contact controls after the app saves V2. */
export async function retireLegacyPrivateContactSync(
  storage: StorageAdapter,
  owner: string,
): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(owner))
    throw new Error("Invalid contact-sync owner");
  let removed = 0;
  for (const prefix of ["v1/message-queue/", "v1/discovery-queue/"]) {
    for (const key of await storage.list(prefix)) {
      if (!key.startsWith(prefix)) continue;
      const entry = await storage.get<QueueEntry>(key);
      if (entry?.event?.kind !== 10451) continue;
      let content;
      try {
        content = JSON.parse(entry.event.content);
      } catch {
        continue;
      }
      if (
        content?.type !== "private-contact-sync" ||
        content.v !== 1 ||
        content.document?.version !== 1 ||
        content.document?.owner !== owner
      )
        continue;
      await storage.del(key);
      if ((await storage.get(key)) !== undefined)
        throw new Error("Legacy private control retirement was not saved");
      removed += 1;
    }
  }
  return removed;
}
