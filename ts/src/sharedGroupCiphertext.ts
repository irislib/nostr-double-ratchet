/**
 * Shared group ciphertext and pairwise ratchet carriers deliberately have the
 * same shape on the wire, so relay guards cannot tell them apart by tags.
 * Group ciphertext this process created or unwrapped is remembered by id.
 */
const MAX_REMEMBERED = 8192;
const remembered = new Set<string>();

export function markSharedGroupCiphertext(eventId: string): void {
  remembered.delete(eventId);
  remembered.add(eventId);
  if (remembered.size > MAX_REMEMBERED) {
    remembered.delete(remembered.values().next().value as string);
  }
}

export function isSharedGroupCiphertext(eventId: string | undefined): boolean {
  return eventId !== undefined && remembered.has(eventId);
}
