//! UniFFI bindings for the durable single-device pairwise runtime.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use nostr::{Event, Keys, PublicKey, SecretKey};
use nostr_double_ratchet::{parse_invite_event, parse_invite_url, Invite};
use nostr_double_ratchet_pairwise::{
    FileStore, PairwiseActionKind, PairwiseManager as RuntimeManager, RuntimeLimits,
};

mod error;
pub use error::NdrError;

const MAX_ENCODED_EVENT_BYTES: usize = 65_536;

uniffi::setup_scaffolding!();

#[uniffi::export]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiKeyPair {
    pub public_key_hex: String,
    pub private_key_hex: String,
}

#[uniffi::export]
pub fn generate_keypair() -> FfiKeyPair {
    let keys = Keys::generate();
    FfiKeyPair {
        public_key_hex: keys.public_key().to_hex(),
        private_key_hex: keys.secret_key().to_secret_hex(),
    }
}

#[uniffi::export]
pub fn derive_public_key(private_key_hex: String) -> Result<String, NdrError> {
    Ok(keys_from_private_hex(&private_key_hex)?
        .public_key()
        .to_hex())
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PairwiseAction {
    pub action_id: String,
    pub kind: String,
    pub subscription_id: Option<String>,
    pub filter_json: Option<String>,
    pub event_json: Option<String>,
    pub peer_pubkey_hex: Option<String>,
    pub inner_event_json: Option<String>,
    pub inner_event_id: Option<String>,
    pub outer_event_id: Option<String>,
    pub expires_at_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PairwiseAcceptResult {
    pub peer_pubkey_hex: String,
    pub created_new_session: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PairwiseSendResult {
    pub inner_event_id: String,
    pub outer_event_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct PairwiseSessionInfo {
    pub send_ready: bool,
    pub receive_ready: bool,
    pub tracked_sender_pubkeys: Vec<String>,
}

#[derive(uniffi::Object)]
pub struct PairwiseInvite {
    invite: Invite,
}

#[uniffi::export]
impl PairwiseInvite {
    #[uniffi::constructor]
    pub fn from_url(url: String) -> Result<Arc<Self>, NdrError> {
        ensure_input_size(url.len(), "invite URL")?;
        let invite =
            parse_invite_url(&url).map_err(|error| NdrError::InvalidEvent(error.to_string()))?;
        validate_pairwise_invite(&invite)?;
        Ok(Arc::new(Self { invite }))
    }

    #[uniffi::constructor]
    pub fn from_event_json(event_json: String) -> Result<Arc<Self>, NdrError> {
        let event = parse_event_json(&event_json, "invite event")?;
        let invite = parse_invite_event(&event)
            .map_err(|error| NdrError::InvalidEvent(error.to_string()))?;
        validate_pairwise_invite(&invite)?;
        Ok(Arc::new(Self { invite }))
    }

    pub fn to_url(&self, root: String) -> Result<String, NdrError> {
        nostr_double_ratchet::invite_url(&self.invite, &root)
            .map_err(|error| NdrError::InvalidEvent(error.to_string()))
    }

    pub fn get_peer_pubkey_hex(&self) -> String {
        self.invite.inviter_device_pubkey.to_hex()
    }
}

#[derive(uniffi::Object)]
pub struct PairwiseManager {
    inner: Mutex<RuntimeManager>,
}

#[uniffi::export]
impl PairwiseManager {
    #[uniffi::constructor]
    pub fn new_with_storage_path(
        our_pubkey_hex: String,
        our_identity_private_key_hex: String,
        storage_path: String,
    ) -> Result<Arc<Self>, NdrError> {
        let keys = validated_keys(&our_pubkey_hex, &our_identity_private_key_hex)?;
        let store = FileStore::new(PathBuf::from(storage_path))?;
        let runtime = RuntimeManager::open(Arc::new(store), keys, RuntimeLimits::default())?;
        Ok(Arc::new(Self {
            inner: Mutex::new(runtime),
        }))
    }

    pub fn current_invite_event_json(&self) -> Result<String, NdrError> {
        Ok(self.lock()?.current_invite_event_json()?)
    }

    pub fn current_invite_url(&self, root: String) -> Result<String, NdrError> {
        Ok(self.lock()?.current_invite_url(&root)?)
    }

    pub fn accept_invite_from_url(
        &self,
        invite_url: String,
        authenticated_peer_pubkey_hex: String,
    ) -> Result<PairwiseAcceptResult, NdrError> {
        ensure_input_size(invite_url.len(), "invite URL")?;
        let invite = parse_invite_url(&invite_url)
            .map_err(|error| NdrError::InvalidEvent(error.to_string()))?;
        let peer = parse_pubkey(&authenticated_peer_pubkey_hex)?;
        let result = self.lock()?.accept_invite(&invite, peer, unix_now())?;
        Ok(PairwiseAcceptResult {
            peer_pubkey_hex: result.peer_pubkey_hex,
            created_new_session: result.created_new_session,
        })
    }

    pub fn accept_invite_from_event_json(
        &self,
        event_json: String,
        authenticated_peer_pubkey_hex: String,
    ) -> Result<PairwiseAcceptResult, NdrError> {
        let event = parse_event_json(&event_json, "invite event")?;
        let peer = parse_pubkey(&authenticated_peer_pubkey_hex)?;
        let result = self
            .lock()?
            .accept_invite_from_event(&event, peer, unix_now())?;
        Ok(PairwiseAcceptResult {
            peer_pubkey_hex: result.peer_pubkey_hex,
            created_new_session: result.created_new_session,
        })
    }

    pub fn process_out_of_band_response(
        &self,
        event_json: String,
        authenticated_peer_pubkey_hex: String,
    ) -> Result<(), NdrError> {
        let event = parse_event_json(&event_json, "invite response")?;
        let peer = parse_pubkey(&authenticated_peer_pubkey_hex)?;
        Ok(self
            .lock()?
            .process_out_of_band_response(&event, peer, unix_now())?)
    }

    pub fn send_text(
        &self,
        peer_pubkey_hex: String,
        text: String,
        expires_at_seconds: Option<u64>,
    ) -> Result<PairwiseSendResult, NdrError> {
        let peer = parse_pubkey(&peer_pubkey_hex)?;
        let millis = unix_now_millis();
        let result =
            self.lock()?
                .send_text(peer, &text, expires_at_seconds, millis / 1_000, millis)?;
        Ok(PairwiseSendResult {
            inner_event_id: result.inner_event_id,
            outer_event_id: result.outer_event_id,
        })
    }

    pub fn process_event(&self, event_json: String) -> Result<(), NdrError> {
        let event = parse_event_json(&event_json, "relay event")?;
        Ok(self.lock()?.process_event(&event)?)
    }

    pub fn pending_actions(&self) -> Result<Vec<PairwiseAction>, NdrError> {
        Ok(self
            .lock()?
            .pending_actions()?
            .into_iter()
            .map(ffi_action)
            .collect())
    }

    pub fn pending_actions_at(&self, now_seconds: u64) -> Result<Vec<PairwiseAction>, NdrError> {
        Ok(self
            .lock()?
            .pending_actions_at(now_seconds)?
            .into_iter()
            .map(ffi_action)
            .collect())
    }

    pub fn ack_actions(&self, action_ids: Vec<String>) -> Result<(), NdrError> {
        Ok(self.lock()?.ack_actions(&action_ids)?)
    }

    pub fn session_info(
        &self,
        peer_pubkey_hex: String,
    ) -> Result<Option<PairwiseSessionInfo>, NdrError> {
        let peer = parse_pubkey(&peer_pubkey_hex)?;
        Ok(self
            .lock()?
            .session_info(peer)
            .map(|info| PairwiseSessionInfo {
                send_ready: info.send_ready,
                receive_ready: info.receive_ready,
                tracked_sender_pubkeys: info.tracked_sender_pubkeys,
            }))
    }

    pub fn known_peer_pubkeys(&self) -> Result<Vec<String>, NdrError> {
        Ok(self.lock()?.known_peer_pubkeys())
    }

    pub fn get_total_sessions(&self) -> Result<u64, NdrError> {
        Ok(self.lock()?.total_sessions())
    }

    pub fn get_our_pubkey_hex(&self) -> Result<String, NdrError> {
        Ok(self.lock()?.local_pubkey().to_hex())
    }
}

impl PairwiseManager {
    fn lock(&self) -> Result<MutexGuard<'_, RuntimeManager>, NdrError> {
        self.inner
            .lock()
            .map_err(|_| NdrError::Storage("pairwise manager mutex poisoned".to_string()))
    }
}

fn ffi_action(action: nostr_double_ratchet_pairwise::PairwiseAction) -> PairwiseAction {
    let mut output = PairwiseAction {
        action_id: action.id,
        kind: String::new(),
        subscription_id: None,
        filter_json: None,
        event_json: None,
        peer_pubkey_hex: None,
        inner_event_json: None,
        inner_event_id: None,
        outer_event_id: None,
        expires_at_seconds: None,
    };
    match action.kind {
        PairwiseActionKind::Publish {
            event_json,
            inner_event_id,
            ..
        } => {
            output.kind = "publish".to_string();
            output.outer_event_id = serde_json::from_str::<Event>(&event_json)
                .ok()
                .map(|event| event.id.to_hex());
            output.event_json = Some(event_json);
            output.inner_event_id = inner_event_id;
        }
        PairwiseActionKind::OutOfBand {
            peer_pubkey_hex,
            event_json,
            ..
        } => {
            output.kind = "out_of_band".to_string();
            output.peer_pubkey_hex = Some(peer_pubkey_hex);
            output.event_json = Some(event_json);
        }
        PairwiseActionKind::Subscribe {
            subscription_id,
            filter_json,
        } => {
            output.kind = "subscribe".to_string();
            output.subscription_id = Some(subscription_id);
            output.filter_json = Some(filter_json);
        }
        PairwiseActionKind::Unsubscribe { subscription_id } => {
            output.kind = "unsubscribe".to_string();
            output.subscription_id = Some(subscription_id);
        }
        PairwiseActionKind::Delivery {
            peer_pubkey_hex,
            inner_event_json,
            inner_event_id,
            outer_event_id,
            expires_at_seconds,
        } => {
            output.kind = "delivery".to_string();
            output.peer_pubkey_hex = Some(peer_pubkey_hex);
            output.inner_event_json = Some(inner_event_json);
            output.inner_event_id = Some(inner_event_id);
            output.outer_event_id = Some(outer_event_id);
            output.expires_at_seconds = expires_at_seconds;
        }
    }
    output
}

fn validate_pairwise_invite(invite: &Invite) -> Result<(), NdrError> {
    let device = invite.inviter_device_pubkey.to_bytes();
    let valid = invite
        .inviter_owner_pubkey
        .is_none_or(|owner| owner.to_bytes() == device)
        && invite
            .owner_public_key
            .is_none_or(|owner| owner.to_bytes() == device);
    if valid {
        Ok(())
    } else {
        Err(NdrError::PeerMismatch(
            "invite owner claim differs from device identity".to_string(),
        ))
    }
}

fn validated_keys(public_key_hex: &str, private_key_hex: &str) -> Result<Keys, NdrError> {
    let keys = keys_from_private_hex(private_key_hex)?;
    let expected = parse_pubkey(public_key_hex)?;
    if keys.public_key() != expected {
        return Err(NdrError::InvalidKey(
            "public key does not match private key".to_string(),
        ));
    }
    Ok(keys)
}

fn keys_from_private_hex(private_key_hex: &str) -> Result<Keys, NdrError> {
    let bytes =
        hex::decode(private_key_hex).map_err(|error| NdrError::InvalidKey(error.to_string()))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
        NdrError::InvalidKey("private key must contain exactly 32 bytes".to_string())
    })?;
    Ok(Keys::new(SecretKey::from_slice(&bytes)?))
}

fn parse_pubkey(value: &str) -> Result<PublicKey, NdrError> {
    PublicKey::parse(value).map_err(Into::into)
}

fn parse_event_json(value: &str, input: &'static str) -> Result<Event, NdrError> {
    ensure_input_size(value.len(), input)?;
    serde_json::from_str(value).map_err(Into::into)
}

fn ensure_input_size(size: usize, input: &'static str) -> Result<(), NdrError> {
    if size > MAX_ENCODED_EVENT_BYTES {
        return Err(NdrError::InvalidEvent(format!(
            "{input} exceeds the {MAX_ENCODED_EVENT_BYTES}-byte limit"
        )));
    }
    Ok(())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn manager(keys: &FfiKeyPair, path: &Path) -> Arc<PairwiseManager> {
        PairwiseManager::new_with_storage_path(
            keys.public_key_hex.clone(),
            keys.private_key_hex.clone(),
            path.to_string_lossy().into_owned(),
        )
        .expect("manager")
    }

    #[test]
    fn ffi_handshake_actions_are_pairwise_only_and_durable() {
        let alice_keys = generate_keypair();
        let bob_keys = generate_keypair();
        let directory = tempfile::tempdir().expect("tempdir");
        let alice_path = directory.path().join("alice");
        let bob_path = directory.path().join("bob");
        let alice = manager(&alice_keys, &alice_path);
        let bob = manager(&bob_keys, &bob_path);
        let invite_json = alice.current_invite_event_json().expect("invite");
        let inspected =
            PairwiseInvite::from_event_json(invite_json.clone()).expect("inspect invite");
        assert_eq!(inspected.get_peer_pubkey_hex(), alice_keys.public_key_hex);

        let accepted = bob
            .accept_invite_from_event_json(invite_json, alice_keys.public_key_hex.clone())
            .expect("accept");
        assert_eq!(accepted.peer_pubkey_hex, alice_keys.public_key_hex);
        assert!(accepted.created_new_session);

        let first = bob.pending_actions().expect("first pending");
        let second = bob.pending_actions().expect("second pending");
        assert_eq!(first, second, "pending actions are non-destructive");
        drop(bob);
        let bob = manager(&bob_keys, &bob_path);
        assert_eq!(
            bob.pending_actions().expect("pending after reopen"),
            first,
            "pending actions survive a physical FileStore reopen"
        );
        assert!(first.iter().any(|action| action.kind == "out_of_band"));
        assert!(first.iter().any(|action| action.kind == "publish"));
        for action in &first {
            let Some(event_json) = action.event_json.as_deref() else {
                continue;
            };
            let event: Event = serde_json::from_str(event_json).expect("event");
            match action.kind.as_str() {
                "out_of_band" => assert_eq!(event.kind, nostr::Kind::from(1059u16)),
                "publish" => assert_eq!(event.kind, nostr::Kind::from(1060u16)),
                other => panic!("event JSON on unexpected action {other}"),
            }
            assert_ne!(event.kind, nostr::Kind::from(37368u16));
        }

        let response = first
            .iter()
            .find(|action| action.kind == "out_of_band")
            .expect("response");
        assert_eq!(
            response.peer_pubkey_hex.as_deref(),
            Some(alice_keys.public_key_hex.as_str())
        );
        alice
            .process_out_of_band_response(
                response.event_json.clone().expect("response JSON"),
                bob_keys.public_key_hex.clone(),
            )
            .expect("response");
        let action_ids = first
            .into_iter()
            .map(|action| action.action_id)
            .collect::<Vec<_>>();
        bob.ack_actions(action_ids).expect("ack");
        drop(bob);
        let bob = manager(&bob_keys, &bob_path);
        assert!(bob
            .pending_actions()
            .expect("after ack")
            .iter()
            .all(|action| action.kind != "publish" && action.kind != "out_of_band"));
    }

    #[test]
    fn ffi_rejects_oversized_input_before_json_parse() {
        let keys = generate_keypair();
        let directory = tempfile::tempdir().expect("tempdir");
        let manager = manager(&keys, directory.path());
        let oversized = "x".repeat(MAX_ENCODED_EVENT_BYTES + 1);
        assert!(matches!(
            manager.process_event(oversized),
            Err(NdrError::InvalidEvent(_))
        ));
    }
}
