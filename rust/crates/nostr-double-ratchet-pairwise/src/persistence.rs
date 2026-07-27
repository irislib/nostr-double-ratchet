use nostr::nips::nip44::{self, Version};
use nostr::Keys;

use crate::state::{PairwiseState, StorageEnvelope, STORAGE_FORMAT_VERSION};
use crate::{PairwiseError, Result, RuntimeLimits};

pub(crate) fn seal_state(
    state: &PairwiseState,
    identity_keys: &Keys,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let plaintext = serde_json::to_string(state)?;
    ensure_state_size(plaintext.len(), max_bytes)?;
    let ciphertext = nip44::encrypt(
        identity_keys.secret_key(),
        &identity_keys.public_key(),
        plaintext,
        Version::V2,
    )
    .map_err(|error| PairwiseError::Crypto(error.to_string()))?;
    let envelope = StorageEnvelope {
        format_version: STORAGE_FORMAT_VERSION,
        generation: state.generation,
        identity_pubkey_hex: identity_keys.public_key().to_hex(),
        ciphertext,
    };
    let payload = serde_json::to_vec(&envelope)?;
    ensure_state_size(payload.len(), max_bytes)?;
    Ok(payload)
}

pub(crate) fn open_state(
    payload: &[u8],
    identity_keys: &Keys,
    limits: &RuntimeLimits,
) -> Result<PairwiseState> {
    ensure_state_size(payload.len(), limits.max_persisted_state_bytes)?;
    let envelope: StorageEnvelope = serde_json::from_slice(payload)
        .map_err(|error| PairwiseError::CorruptState(error.to_string()))?;
    if envelope.format_version != STORAGE_FORMAT_VERSION {
        return Err(PairwiseError::UnsupportedFormat(envelope.format_version));
    }
    let expected = identity_keys.public_key().to_hex();
    if envelope.identity_pubkey_hex != expected {
        return Err(PairwiseError::IdentityMismatch {
            expected,
            actual: envelope.identity_pubkey_hex,
        });
    }
    let plaintext = nip44::decrypt(
        identity_keys.secret_key(),
        &identity_keys.public_key(),
        &envelope.ciphertext,
    )
    .map_err(|error| PairwiseError::CorruptState(error.to_string()))?;
    let state: PairwiseState = serde_json::from_str(&plaintext)
        .map_err(|error| PairwiseError::CorruptState(error.to_string()))?;
    if state.generation != envelope.generation {
        return Err(PairwiseError::CorruptState(
            "encrypted state generation does not match envelope".to_string(),
        ));
    }
    state.validate(identity_keys.public_key(), limits)?;
    Ok(state)
}

fn ensure_state_size(size: usize, max_bytes: usize) -> Result<()> {
    if size > max_bytes {
        return Err(PairwiseError::CorruptState(
            "persisted pairwise state exceeds configured size limit".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use nostr_double_ratchet::{Invite, OwnerPubkey};

    use super::*;
    use crate::state::MAX_PERSISTED_STATE_BYTES;

    fn state(keys: &Keys) -> PairwiseState {
        let mut invite =
            Invite::create_new(keys.public_key(), None, None).expect("create local invite");
        let owner = OwnerPubkey::from_bytes(keys.public_key().to_bytes());
        invite.inviter_owner_pubkey = Some(owner);
        invite.owner_public_key = Some(keys.public_key());
        PairwiseState::new(keys.public_key().to_hex(), invite)
    }

    #[test]
    fn state_is_encrypted_and_authenticated_to_identity() {
        let alice = Keys::generate();
        let bob = Keys::generate();
        let state = state(&alice);
        let payload = seal_state(&state, &alice, MAX_PERSISTED_STATE_BYTES).expect("seal");
        let payload_text = String::from_utf8(payload.clone()).expect("JSON");
        assert!(!payload_text.contains(&hex::encode(state.local_invite.shared_secret)));
        assert!(matches!(
            open_state(&payload, &bob, &RuntimeLimits::default()),
            Err(PairwiseError::IdentityMismatch { .. })
        ));
        let restored = open_state(&payload, &alice, &RuntimeLimits::default()).expect("open state");
        assert_eq!(restored.local_pubkey_hex, alice.public_key().to_hex());
    }

    #[test]
    fn state_corruption_fails_closed() {
        let keys = Keys::generate();
        let state = state(&keys);
        let mut payload = seal_state(&state, &keys, MAX_PERSISTED_STATE_BYTES).expect("seal");
        let position = payload.len() / 2;
        payload[position] ^= 1;
        assert!(open_state(&payload, &keys, &RuntimeLimits::default()).is_err());
    }
}
