use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use nostr::nips::nip44;
use nostr::Keys;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::state::{
    LegacyStorageEnvelope, PairwiseState, LEGACY_STORAGE_FORMAT_VERSION, STORAGE_FORMAT_VERSION,
};
use crate::{PairwiseError, Result, RuntimeLimits};

const STORAGE_MAGIC: &[u8; 8] = b"NDRPWST\0";
const STORAGE_HEADER_BYTES: usize = 8 + 4 + 8 + 32 + 24;
const AEAD_TAG_BYTES: usize = 16;
const STORAGE_KEY_SALT: &[u8] = b"nostr-double-ratchet/pairwise-storage/salt/v2";
const STORAGE_KEY_INFO: &[u8] = b"nostr-double-ratchet/pairwise-storage/key/v2";

pub(crate) fn seal_state(
    state: &PairwiseState,
    identity_keys: &Keys,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let plaintext = serde_json::to_vec(state)?;
    ensure_state_size(plaintext.len(), max_bytes)?;
    let payload_len = STORAGE_HEADER_BYTES
        .checked_add(plaintext.len())
        .and_then(|size| size.checked_add(AEAD_TAG_BYTES))
        .ok_or_else(|| PairwiseError::CorruptState("persisted state size overflow".to_string()))?;
    ensure_state_size(payload_len, max_bytes)?;

    let mut nonce = [0_u8; 24];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| PairwiseError::Crypto("generate pairwise storage nonce".to_string()))?;
    let header = storage_header(
        state.generation,
        identity_keys.public_key().to_bytes(),
        nonce,
    );
    let cipher = storage_cipher(identity_keys)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .map_err(|_| PairwiseError::Crypto("encrypt pairwise state".to_string()))?;
    let mut payload = Vec::with_capacity(payload_len);
    payload.extend_from_slice(&header);
    payload.extend_from_slice(&ciphertext);
    Ok(payload)
}

pub(crate) fn open_state(
    payload: &[u8],
    identity_keys: &Keys,
    limits: &RuntimeLimits,
) -> Result<PairwiseState> {
    ensure_state_size(payload.len(), limits.max_persisted_state_bytes)?;
    if payload.starts_with(STORAGE_MAGIC) {
        open_current_state(payload, identity_keys, limits)
    } else {
        open_legacy_state(payload, identity_keys, limits)
    }
}

pub(crate) fn is_legacy_state_payload(payload: &[u8]) -> bool {
    !payload.starts_with(STORAGE_MAGIC)
}

fn open_current_state(
    payload: &[u8],
    identity_keys: &Keys,
    limits: &RuntimeLimits,
) -> Result<PairwiseState> {
    if payload.len() < STORAGE_HEADER_BYTES + AEAD_TAG_BYTES {
        return Err(PairwiseError::CorruptState(
            "persisted pairwise state is truncated".to_string(),
        ));
    }
    let version = parse_u32(&payload[8..12]);
    if version != STORAGE_FORMAT_VERSION {
        return Err(PairwiseError::UnsupportedFormat(version));
    }
    let generation = parse_u64(&payload[12..20]);
    let stored_identity = &payload[20..52];
    let expected_identity = identity_keys.public_key().to_bytes();
    if stored_identity != expected_identity {
        return Err(PairwiseError::IdentityMismatch {
            expected: hex::encode(expected_identity),
            actual: hex::encode(stored_identity),
        });
    }
    let header = &payload[..STORAGE_HEADER_BYTES];
    let nonce = XNonce::from_slice(&header[52..76]);
    let plaintext = storage_cipher(identity_keys)?
        .decrypt(
            nonce,
            Payload {
                msg: &payload[STORAGE_HEADER_BYTES..],
                aad: header,
            },
        )
        .map_err(|_| {
            PairwiseError::CorruptState(
                "persisted pairwise state authentication failed".to_string(),
            )
        })?;
    ensure_state_size(plaintext.len(), limits.max_persisted_state_bytes)?;
    decode_and_validate_state(&plaintext, generation, identity_keys, limits)
}

fn open_legacy_state(
    payload: &[u8],
    identity_keys: &Keys,
    limits: &RuntimeLimits,
) -> Result<PairwiseState> {
    let envelope: LegacyStorageEnvelope = serde_json::from_slice(payload)
        .map_err(|error| PairwiseError::CorruptState(error.to_string()))?;
    if envelope.format_version != LEGACY_STORAGE_FORMAT_VERSION {
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
    ensure_state_size(plaintext.len(), limits.max_persisted_state_bytes)?;
    decode_and_validate_state(
        plaintext.as_bytes(),
        envelope.generation,
        identity_keys,
        limits,
    )
}

fn decode_and_validate_state(
    plaintext: &[u8],
    generation: u64,
    identity_keys: &Keys,
    limits: &RuntimeLimits,
) -> Result<PairwiseState> {
    let state: PairwiseState = serde_json::from_slice(plaintext)
        .map_err(|error| PairwiseError::CorruptState(error.to_string()))?;
    if state.generation != generation {
        return Err(PairwiseError::CorruptState(
            "encrypted state generation does not match envelope".to_string(),
        ));
    }
    state.validate(identity_keys.public_key(), limits)?;
    Ok(state)
}

fn storage_cipher(identity_keys: &Keys) -> Result<XChaCha20Poly1305> {
    let conversation_key =
        nip44::v2::ConversationKey::derive(identity_keys.secret_key(), &identity_keys.public_key())
            .map_err(|_| PairwiseError::Crypto("derive canonical identity key".to_string()))?;
    let mut identity_material = [0_u8; 32];
    identity_material.copy_from_slice(conversation_key.as_bytes());
    let derivation = Hkdf::<Sha256>::new(Some(STORAGE_KEY_SALT), &identity_material);
    let mut storage_key = [0_u8; 32];
    let derivation_result = derivation.expand(STORAGE_KEY_INFO, &mut storage_key);
    identity_material.zeroize();
    derivation_result
        .map_err(|_| PairwiseError::Crypto("derive pairwise storage key".to_string()))?;
    let cipher = XChaCha20Poly1305::new_from_slice(&storage_key);
    storage_key.zeroize();
    cipher.map_err(|_| PairwiseError::Crypto("initialize pairwise storage cipher".to_string()))
}

fn storage_header(generation: u64, identity: [u8; 32], nonce: [u8; 24]) -> [u8; 76] {
    let mut header = [0_u8; STORAGE_HEADER_BYTES];
    header[..8].copy_from_slice(STORAGE_MAGIC);
    header[8..12].copy_from_slice(&STORAGE_FORMAT_VERSION.to_be_bytes());
    header[12..20].copy_from_slice(&generation.to_be_bytes());
    header[20..52].copy_from_slice(&identity);
    header[52..76].copy_from_slice(&nonce);
    header
}

fn parse_u32(bytes: &[u8]) -> u32 {
    let mut value = [0_u8; 4];
    value.copy_from_slice(bytes);
    u32::from_be_bytes(value)
}

fn parse_u64(bytes: &[u8]) -> u64 {
    let mut value = [0_u8; 8];
    value.copy_from_slice(bytes);
    u64::from_be_bytes(value)
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
    use std::sync::Arc;

    use nostr_double_ratchet::{Invite, OwnerPubkey};

    use super::*;
    use crate::state::MAX_PERSISTED_STATE_BYTES;
    use crate::{FileStore, PairwiseManager, PairwiseStore};

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
        assert!(!payload
            .windows(state.local_invite.shared_secret.len())
            .any(|window| window == state.local_invite.shared_secret));
        let encoded_secret = hex::encode(state.local_invite.shared_secret);
        assert!(!payload
            .windows(encoded_secret.len())
            .any(|window| window == encoded_secret.as_bytes()));
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
        let payload = seal_state(&state, &keys, MAX_PERSISTED_STATE_BYTES).expect("seal");
        for position in [12, 52, STORAGE_HEADER_BYTES, payload.len() / 2] {
            let mut corrupted = payload.clone();
            corrupted[position] ^= 1;
            assert!(
                open_state(&corrupted, &keys, &RuntimeLimits::default()).is_err(),
                "corruption at byte {position} must fail closed"
            );
        }
    }

    #[test]
    fn legal_state_larger_than_nip44_plaintext_limit_roundtrips() {
        let keys = Keys::generate();
        let mut state = state(&keys);
        state.seen_event_ids = (0..2_048).map(|index| format!("{index:064x}")).collect();
        let plaintext = serde_json::to_vec(&state).expect("state JSON");
        assert!(plaintext.len() > 65_408);
        state
            .validate(keys.public_key(), &RuntimeLimits::default())
            .expect("legal runtime state");

        let payload =
            seal_state(&state, &keys, MAX_PERSISTED_STATE_BYTES).expect("seal large state");
        let restored =
            open_state(&payload, &keys, &RuntimeLimits::default()).expect("open large state");
        assert_eq!(restored.seen_event_ids, state.seen_event_ids);
    }

    #[test]
    fn legacy_nip44_state_is_read_and_migrated_on_manager_open() {
        let keys = Keys::generate();
        let mut state = state(&keys);
        state.generation = 1;
        let legacy_payload = legacy_seal_state(&state, &keys);
        let directly_restored =
            open_state(&legacy_payload, &keys, &RuntimeLimits::default()).expect("legacy read");
        assert_eq!(directly_restored.generation, 1);

        let directory = tempfile::tempdir().expect("state directory");
        let store = Arc::new(FileStore::new(directory.path()).expect("file store"));
        store
            .commit(state.generation, &legacy_payload)
            .expect("seed legacy state");
        let manager = PairwiseManager::open(store.clone(), keys.clone(), RuntimeLimits::default())
            .expect("migrate manager");
        assert_eq!(manager.local_pubkey(), keys.public_key());
        let migrated = store
            .load()
            .expect("load migrated state")
            .expect("migrated payload");
        assert!(migrated.starts_with(STORAGE_MAGIC));
        let restored =
            open_state(&migrated, &keys, &RuntimeLimits::default()).expect("open migrated");
        assert_eq!(restored.generation, 2);
    }

    #[test]
    fn equivalent_bip340_secret_encodings_share_storage_key() {
        let canonical = Keys::new(
            nostr::SecretKey::from_slice(&{
                let mut scalar = [0_u8; 32];
                scalar[31] = 1;
                scalar
            })
            .expect("scalar one"),
        );
        let negated = Keys::new(
            nostr::SecretKey::from_slice(
                &hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140")
                    .expect("negated scalar"),
            )
            .expect("valid negated scalar"),
        );
        assert_eq!(canonical.public_key(), negated.public_key());

        let state = state(&canonical);
        let payload =
            seal_state(&state, &canonical, MAX_PERSISTED_STATE_BYTES).expect("canonical seal");
        open_state(&payload, &negated, &RuntimeLimits::default())
            .expect("equivalent scalar opens current format");

        let mut legacy_state = state;
        legacy_state.generation = 1;
        let legacy_payload = legacy_seal_state(&legacy_state, &canonical);
        let directory = tempfile::tempdir().expect("state directory");
        let store = Arc::new(FileStore::new(directory.path()).expect("file store"));
        store
            .commit(legacy_state.generation, &legacy_payload)
            .expect("seed legacy state");
        PairwiseManager::open(store.clone(), negated.clone(), RuntimeLimits::default())
            .expect("migrate with equivalent scalar");
        let migrated = store
            .load()
            .expect("load migrated")
            .expect("migrated payload");
        open_state(&migrated, &canonical, &RuntimeLimits::default())
            .expect("canonical scalar reopens equivalent-scalar migration");
    }

    fn legacy_seal_state(state: &PairwiseState, keys: &Keys) -> Vec<u8> {
        let plaintext = serde_json::to_string(state).expect("legacy state JSON");
        let ciphertext = nip44::encrypt(
            keys.secret_key(),
            &keys.public_key(),
            plaintext,
            nip44::Version::V2,
        )
        .expect("legacy encryption");
        serde_json::to_vec(&LegacyStorageEnvelope {
            format_version: LEGACY_STORAGE_FORMAT_VERSION,
            generation: state.generation,
            identity_pubkey_hex: keys.public_key().to_hex(),
            ciphertext,
        })
        .expect("legacy envelope")
    }
}
