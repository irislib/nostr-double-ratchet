export interface PendingInviteResponse {
  eventId: string;
  ownerPublicKey: string;
  deviceId: string;
  inviteeSessionPublicKey: string;
  ephemeralPrivateKey: Uint8Array;
  sharedSecret: string;
}

export const MAX_PENDING_DIRECT_MESSAGES = 1000;
