import { finalizeEvent, VerifiedEvent, UnsignedEvent, verifyEvent, Filter } from "nostr-tools";
import { INVITE_EVENT_KIND, NostrSubscribe, Unsubscribe, EncryptFunction, DecryptFunction, INVITE_RESPONSE_KIND } from "./types.js";
import { Session } from "./Session.js";
import {
    generateEphemeralKeypair,
    generateSharedSecret,
    encryptInviteResponse,
    decryptInviteResponse,
    createSessionFromAccept,
} from "./inviteUtils.js";

const now = () => Math.round(Date.now() / 1000)
const PUBLIC_INVITE_D_TAG = "double-ratchet/invites/public"

function getInviteDTag(event: VerifiedEvent): string | undefined {
    return event.tags.find(([key]) => key === 'd')?.[1]
}

function isPublicInviteEvent(event: VerifiedEvent): boolean {
    return getInviteDTag(event) === PUBLIC_INVITE_D_TAG
}

export type InvitePurpose = "chat" | "link"

export interface InviteLinkOptions {
    purpose?: InvitePurpose
    ownerPubkey?: string
}

/**
 * Invite is a safe way to exchange session keys and initiate secret sessions.
 * 
 * It can be shared privately as an URL (e.g. QR code) or published as a Nostr event.
 * 
 * Even if inviter's or invitee's long-term private key (identity key) and the shared secret (link) is compromised,
 * forward secrecy is preserved as long as the session keys are not compromised.
 * 
 * Also make sure to keep the session key safe.
 */
export class Invite {
    constructor(
        public inviterEphemeralPublicKey: string,
        public sharedSecret: string,
        public inviter: string,
        public inviterEphemeralPrivateKey?: Uint8Array,
        public deviceId?: string,
        public maxUses?: number,
        public usedBy: string[] = [],
        public createdAt: number = now(),
        public purpose?: InvitePurpose,
        public ownerPubkey?: string,
    ) {
    }

    static createNew(
        inviter: string,
        deviceId?: string,
        maxUses?: number,
        options?: InviteLinkOptions
    ): Invite {
        if (!inviter) {
            throw new Error("Inviter public key is required");
        }
        const ephemeralKeypair = generateEphemeralKeypair();
        const sharedSecret = generateSharedSecret();
        return new Invite(
            ephemeralKeypair.publicKey,
            sharedSecret,
            inviter,
            ephemeralKeypair.privateKey,
            deviceId,
            maxUses,
            [],
            now(),
            options?.purpose,
            options?.ownerPubkey
        );
    }

    static fromUrl(url: string): Invite {
        const parsedUrl = new URL(url);
        const rawHash = parsedUrl.hash.slice(1);
        if (!rawHash) {
            throw new Error("No invite data found in the URL hash.");
        }

        const decodedHash = decodeURIComponent(rawHash);
        let data: {
            inviter?: string;
            ephemeralKey?: string;
            sharedSecret?: string;
            purpose?: string;
            owner?: string;
        };
        try {
            data = JSON.parse(decodedHash);
        } catch (err) {
            throw new Error("Invite data in URL hash is not valid JSON: " + err);
        }

        const {
            inviter,
            ephemeralKey,
            inviterEphemeralPublicKey,
            sharedSecret,
            purpose,
            owner,
            ownerPubkey,
        } = data as {
            inviter?: string;
            ephemeralKey?: string;
            inviterEphemeralPublicKey?: string;
            sharedSecret?: string;
            purpose?: string;
            owner?: string;
            ownerPubkey?: string;
        };
        const resolvedEphemeralKey = ephemeralKey || inviterEphemeralPublicKey;
        if (!inviter || !resolvedEphemeralKey || !sharedSecret) {
            throw new Error("Missing required fields (inviter, ephemeralKey, sharedSecret) in invite data.");
        }
        const resolvedOwner = owner || ownerPubkey;

        return new Invite(
            resolvedEphemeralKey,
            sharedSecret,
            inviter,
            undefined,
            undefined,
            undefined,
            [],
            now(),
            purpose === "link" || purpose === "chat" ? (purpose as InvitePurpose) : undefined,
            resolvedOwner && /^[0-9a-fA-F]{64}$/.test(resolvedOwner) ? resolvedOwner : undefined
        );
    }

    static deserialize(json: string): Invite {
        const data = JSON.parse(json);
        return new Invite(
            data.inviterEphemeralPublicKey,
            data.sharedSecret,
            data.inviter,
            data.inviterEphemeralPrivateKey ? new Uint8Array(data.inviterEphemeralPrivateKey) : undefined,
            data.deviceId,
            data.maxUses,
            data.usedBy,
            data.createdAt,
            data.purpose,
            data.ownerPubkey,
        );
    }

    static fromEvent(event: VerifiedEvent): Invite {
        if (!event.sig) {
            throw new Error("Event is not signed");
        }
        if (!verifyEvent(event)) {
            throw new Error("Event signature is invalid");
        }
        const { tags } = event;

        if (!tags) {
            throw new Error("Invalid invite event: missing tags");
        }

        const inviterEphemeralPublicKey = tags.find(([key]) => key === 'ephemeralKey')?.[1];
        const sharedSecret = tags.find(([key]) => key === 'sharedSecret')?.[1];
        const inviter = event.pubkey;

        // Extract deviceId from the "d" tag (format: double-ratchet/invites/<deviceId>)
        const deviceTag = tags.find(([key]) => key === 'd')?.[1]
        const rawDeviceId = deviceTag?.split('/')?.[2]
        const deviceId = rawDeviceId === 'public' ? undefined : rawDeviceId

        if (!inviterEphemeralPublicKey || !sharedSecret) {
            throw new Error("Invalid invite event: missing session key or sharedSecret");
        }

        return new Invite(
            inviterEphemeralPublicKey,
            sharedSecret,
            inviter,
            undefined, // inviterEphemeralPrivateKey not available when parsing from event
            deviceId
        );
    }

    static fromUser(user: string, subscribe: NostrSubscribe, onInvite: (_invite: Invite) => void): Unsubscribe {
        const filter: Filter = {
            kinds: [INVITE_EVENT_KIND],
            authors: [user],
            "#l": ["double-ratchet/invites"]
        };
        const seenIds = new Set<string>()
        let latestPublic: { invite: Invite; createdAt: number; eventId: string } | null = null
        let latestOther: { invite: Invite; createdAt: number; eventId: string } | null = null
        let emittedEventId: string | null = null
        let settleTimer: ReturnType<typeof setTimeout> | null = null

        const preferredInvite = () => latestPublic ?? latestOther
        const scheduleEmit = () => {
            if (settleTimer) {
                clearTimeout(settleTimer)
            }
            settleTimer = setTimeout(() => {
                settleTimer = null
                const next = preferredInvite()
                if (!next || next.eventId === emittedEventId) {
                    return
                }
                emittedEventId = next.eventId
                onInvite(next.invite)
            }, 100)
        }

        const unsub = subscribe(filter, (event) => {
            if (event.pubkey !== user) return;
            if (seenIds.has(event.id)) return
            seenIds.add(event.id)
            try {
                const inviteLink = Invite.fromEvent(event);
                const candidate = {
                    invite: inviteLink,
                    createdAt: event.created_at,
                    eventId: event.id,
                }
                if (isPublicInviteEvent(event)) {
                    if (!latestPublic || event.created_at >= latestPublic.createdAt) {
                        latestPublic = candidate
                    }
                } else if (!latestOther || event.created_at >= latestOther.createdAt) {
                    latestOther = candidate
                }
                scheduleEmit()
            } catch {
            }
        });

        return () => {
            if (settleTimer) {
                clearTimeout(settleTimer)
                settleTimer = null
            }
            unsub()
        };
    }

    static waitFor(
        user: string,
        subscribe: NostrSubscribe,
        timeoutMs = 500
    ): Promise<Invite | null> {
        return new Promise((resolve) => {
            let latestPublic: { invite: Invite; createdAt: number } | null = null
            let latestOther: { invite: Invite; createdAt: number } | null = null
            const preferredInvite = () => latestPublic?.invite ?? latestOther?.invite ?? null

            const timeout = setTimeout(() => {
                unsubscribe()
                resolve(preferredInvite())
            }, timeoutMs)

            const unsubscribe = subscribe(
                {
                    kinds: [INVITE_EVENT_KIND],
                    authors: [user],
                    "#l": ["double-ratchet/invites"],
                },
                (event) => {
                    if (event.pubkey !== user) return
                    try {
                        const invite = Invite.fromEvent(event)
                        if (isPublicInviteEvent(event)) {
                            if (!latestPublic || event.created_at >= latestPublic.createdAt) {
                                latestPublic = { invite, createdAt: event.created_at }
                            }
                        } else if (!latestOther || event.created_at >= latestOther.createdAt) {
                            latestOther = { invite, createdAt: event.created_at }
                        }
                    } catch {
                        // Ignore invalid or tombstoned invites.
                    }

                    clearTimeout(timeout)
                    setTimeout(() => {
                        unsubscribe()
                        resolve(preferredInvite())
                    }, 100)
                }
            )
        })
    }

    /**
     * Save Invite as JSON. Includes the inviter's session private key, so don't share this.
     */
    serialize(): string {
        return JSON.stringify({
            inviterEphemeralPublicKey: this.inviterEphemeralPublicKey,
            sharedSecret: this.sharedSecret,
            inviter: this.inviter,
            inviterEphemeralPrivateKey: this.inviterEphemeralPrivateKey ? Array.from(this.inviterEphemeralPrivateKey) : undefined,
            deviceId: this.deviceId,
            maxUses: this.maxUses,
            usedBy: this.usedBy,
            createdAt: this.createdAt,
            purpose: this.purpose,
            ownerPubkey: this.ownerPubkey,
        });
    }

    /**
     * Invite parameters are in the URL's hash so they are not sent to the server.
     */
    getUrl(root = "https://chat.iris.to") {
        const data = {
            inviter: this.inviter,
            ephemeralKey: this.inviterEphemeralPublicKey,
            sharedSecret: this.sharedSecret,
            ...(this.purpose ? { purpose: this.purpose } : {}),
            ...(this.ownerPubkey ? { owner: this.ownerPubkey } : {}),
        };
        const url = new URL(root);
        url.hash = encodeURIComponent(JSON.stringify(data));
        return url.toString();
    }

    getEvent(): UnsignedEvent {
        if (!this.deviceId) {
            throw new Error("Device ID is required");
        }
        return {
            kind: INVITE_EVENT_KIND,
            pubkey: this.inviter,
            content: "",
            created_at: this.createdAt,
            tags: [
                ['ephemeralKey', this.inviterEphemeralPublicKey],
                ['sharedSecret', this.sharedSecret],
                ['d', 'double-ratchet/invites/' + this.deviceId],
                ['l', 'double-ratchet/invites']
            ],
        };
    }

    /**
     * Creates a tombstone event that replaces the invite, signaling device revocation.
     * The tombstone has the same d-tag but no keys, making it invalid as an invite.
     */
    getDeletionEvent(): UnsignedEvent {
        if (!this.deviceId) {
            throw new Error("Device ID is required");
        }
        return {
            kind: INVITE_EVENT_KIND,
            pubkey: this.inviter,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', 'double-ratchet/invites/' + this.deviceId],
                ['l', 'double-ratchet/invites'],
            ],
        };
    }

    /**
     * Called by the invitee. Accepts the invite and creates a new session with the inviter.
     *
     * @param inviteePublicKey - The invitee's identity public key (also serves as device ID)
     * @param encryptor - The invitee's secret key or a signing/encrypt function
     * @param ownerPublicKey - The invitee's owner/Nostr identity public key (optional for single-device users)
     * @returns An object containing the new session and an event to be published
     *
     * 1. Inner event: No signature, content encrypted with DH(inviter, invitee).
     *    Purpose: Authenticate invitee. Contains invitee session key and ownerPublicKey.
     * 2. Envelope: No signature, content encrypted with DH(inviter, random key).
     *    Purpose: Contains inner event. Hides invitee from others who might have the shared Nostr key.

     * Note: You need to publish the returned event on Nostr using NDK or another Nostr system of your choice,
     * so the inviter can create the session on their side.
     */
    async accept(
        inviteePublicKey: string,
        encryptor: Uint8Array | EncryptFunction,
        ownerPublicKey?: string,
    ): Promise<{ session: Session, event: VerifiedEvent }> {
        const inviteeSessionKeypair = generateEphemeralKeypair();
        const inviterPublicKey = this.inviter || this.inviterEphemeralPublicKey;

        const session = createSessionFromAccept({
            theirPublicKey: this.inviterEphemeralPublicKey,
            ourSessionPrivateKey: inviteeSessionKeypair.privateKey,
            sharedSecret: this.sharedSecret,
            isSender: true,
        });

        const encrypt = typeof encryptor === 'function' ? encryptor : undefined;
        const inviteePrivateKey = typeof encryptor === 'function' ? undefined : encryptor;

        const encrypted = await encryptInviteResponse({
            inviteeSessionPublicKey: inviteeSessionKeypair.publicKey,
            inviteePublicKey,
            inviteePrivateKey,
            inviterPublicKey,
            inviterEphemeralPublicKey: this.inviterEphemeralPublicKey,
            sharedSecret: this.sharedSecret,
            ownerPublicKey,
            encrypt,
        });

        return { session, event: finalizeEvent(encrypted.envelope, encrypted.randomSenderPrivateKey) };
    }

    listen(decryptor: Uint8Array | DecryptFunction, nostrSubscribe: NostrSubscribe, onSession: (_session: Session, _identity: string) => void): Unsubscribe {
        if (!this.inviterEphemeralPrivateKey) {
            throw new Error("Inviter session key is not available");
        }

        // Nostr relays and test harnesses may deliver/re-publish the same response event multiple times.
        // Deduplicate by event id so we don't create multiple sessions for the same acceptance.
        const seenEventIds = new Set<string>();

        const filter = {
            kinds: [INVITE_RESPONSE_KIND],
            '#p': [this.inviterEphemeralPublicKey],
        };

        return nostrSubscribe(filter, async (event) => {
            try {
                if (seenEventIds.has(event.id)) {
                    return;
                }
                seenEventIds.add(event.id);

                if (this.maxUses && this.usedBy.length >= this.maxUses) {
                    return;
                }

                const decrypt = typeof decryptor === 'function' ? decryptor : undefined;
                const inviterPrivateKey = typeof decryptor === 'function' ? undefined : decryptor;

                const decrypted = await decryptInviteResponse({
                    envelopeContent: event.content,
                    envelopeSenderPubkey: event.pubkey,
                    inviterEphemeralPrivateKey: this.inviterEphemeralPrivateKey!,
                    inviterPrivateKey,
                    sharedSecret: this.sharedSecret,
                    decrypt,
                });

                this.usedBy.push(decrypted.inviteeIdentity);

                const session = createSessionFromAccept({
                    theirPublicKey: decrypted.inviteeSessionPublicKey,
                    ourSessionPrivateKey: this.inviterEphemeralPrivateKey!,
                    sharedSecret: this.sharedSecret,
                    isSender: false,
                    name: event.id,
                });

                // inviteeIdentity serves as both identity and device ID
                onSession(session, decrypted.inviteeIdentity);
            } catch {
                // Failed to process invite response
            }
        });
    }
}
