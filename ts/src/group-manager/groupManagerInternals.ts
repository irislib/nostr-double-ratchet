import type { GroupMetadata, GroupRosterFact } from "../GroupMeta.js";
import type { Rumor } from "../types.js";

export interface PendingSessionEvent {
  event: Rumor;
  fromOwnerPubkey: string;
  fromSenderDevicePubkey?: string;
}

export function getFirstTagValue(
  tags: string[][] | undefined,
  key: string,
): string | undefined {
  return tags?.find((tag) => tag[0] === key)?.[1];
}

export function isHex32(value: string): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function groupMetadataFromRosterFact(
  fact: GroupRosterFact,
): GroupMetadata {
  return {
    id: fact.group.id,
    name: fact.group.name,
    members: fact.group.members,
    admins: fact.group.admins,
    ...(fact.group.description && { description: fact.group.description }),
    ...(fact.group.picture && { picture: fact.group.picture }),
  };
}
