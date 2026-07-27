import type { SenderKeyDistribution } from "../SenderKey.js";

export interface SenderKeyRepairSnapshot {
  keyId: number;
  distribution: SenderKeyDistribution;
  recipients: string[];
}

export function randomU32(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] >>> 0;
}

export function isHex32(value: string): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
