use super::{DeviceRecord, SessionManager, UserRecord};
use crate::{OwnerPubkey, SerializableKeyPair, Session, SessionState, SkippedKeysEntry};
use sha2::{Digest, Sha256};

/// Opaque equality token for local, ephemeral receive-result caching.
///
/// Do not persist or publish this token. It deliberately has no serialization,
/// byte accessor or Debug implementation. Callers must separately bind the exact
/// message envelope and receive context; this token describes manager inputs only.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ReceiveInputFingerprint([u8; 32]);

impl SessionManager {
    /// Fingerprint the inputs used by `receive` for one owner, in trial order.
    ///
    /// This reads borrowed ratchets without cloning or serializing secret state.
    /// Unrelated owners and display/activity bookkeeping do not affect the token.
    /// A restored manager with the same effective inputs produces the same token.
    pub fn receive_input_fingerprint(&self, owner: OwnerPubkey) -> ReceiveInputFingerprint {
        let mut writer = FingerprintWriter(Sha256::new());
        writer
            .0
            .update(b"nostr-double-ratchet/receive-input-fingerprint/v1\0");
        writer.0.update(owner.to_bytes());
        let user = self.users.get(&owner);
        writer.byte(u8::from(user.is_some()));
        // Use receive's existing proof-aware authorization projection.
        let authorized = self.authorized_devices_for_owner(owner);
        writer.len(authorized.len());
        for device in authorized {
            writer.0.update(device.to_bytes());
        }
        if let Some(UserRecord {
            owner_pubkey: _,
            roster: _,
            devices,
        }) = user
        {
            writer.len(devices.len());
            for (device, record) in devices {
                writer.0.update(device.to_bytes());
                let DeviceRecord {
                    device_pubkey: _,
                    authorized,
                    is_stale,
                    stale_since: _,
                    claimed_owner_pubkey: _,
                    public_invite: _,
                    invite_response_generated: _,
                    active_session,
                    inactive_sessions,
                    last_activity: _,
                    created_at: _,
                } = record;
                writer.byte(u8::from(*authorized));
                writer.byte(u8::from(*is_stale));
                writer.option(active_session.as_ref(), FingerprintWriter::session);
                writer.len(inactive_sessions.len());
                for session in inactive_sessions {
                    writer.session(session);
                }
            }
        }
        ReceiveInputFingerprint(writer.0.finalize().into())
    }
}

struct FingerprintWriter(Sha256);

impl FingerprintWriter {
    fn byte(&mut self, value: u8) {
        self.0.update([value]);
    }

    fn len(&mut self, value: usize) {
        self.0.update((value as u64).to_be_bytes());
    }

    fn option<T>(&mut self, value: Option<&T>, write: impl FnOnce(&mut Self, &T)) {
        match value {
            None => self.byte(0),
            Some(value) => {
                self.byte(1);
                write(self, value);
            }
        }
    }

    fn pair(&mut self, pair: &SerializableKeyPair) {
        let SerializableKeyPair {
            public_key,
            private_key,
        } = pair;
        self.0.update(public_key.to_bytes());
        self.0.update(private_key);
    }

    fn session(&mut self, session: &Session) {
        // Exhaustive patterns make future state additions require an explicit
        // cache-invalidation decision. A session's display name is not an input.
        let Session { state, name: _ } = session;
        let SessionState {
            metadata_privacy_version,
            root_key,
            their_current_nostr_public_key,
            their_next_nostr_public_key,
            our_previous_nostr_key,
            our_current_nostr_key,
            our_next_nostr_key,
            receiving_chain_key,
            sending_chain_key,
            sending_chain_message_number,
            receiving_chain_message_number,
            previous_sending_chain_message_count,
            skipped_keys,
        } = state;
        self.byte(*metadata_privacy_version);
        self.0.update(root_key);
        self.option(their_current_nostr_public_key.as_ref(), |writer, key| {
            writer.0.update(key.to_bytes())
        });
        self.option(their_next_nostr_public_key.as_ref(), |writer, key| {
            writer.0.update(key.to_bytes())
        });
        self.option(our_previous_nostr_key.as_ref(), FingerprintWriter::pair);
        self.option(our_current_nostr_key.as_ref(), FingerprintWriter::pair);
        self.pair(our_next_nostr_key);
        self.option(receiving_chain_key.as_ref(), |writer, key| {
            writer.0.update(key)
        });
        self.option(sending_chain_key.as_ref(), |writer, key| {
            writer.0.update(key)
        });
        self.0.update(sending_chain_message_number.to_be_bytes());
        self.0.update(receiving_chain_message_number.to_be_bytes());
        self.0
            .update(previous_sending_chain_message_count.to_be_bytes());
        self.len(skipped_keys.len());
        for (sender, entry) in skipped_keys {
            self.0.update(sender.to_bytes());
            let SkippedKeysEntry { message_keys } = entry;
            self.len(message_keys.len());
            for (number, key) in message_keys {
                self.0.update(number.to_be_bytes());
                self.0.update(key);
            }
        }
    }
}
