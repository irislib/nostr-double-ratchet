use std::collections::{BTreeMap, BTreeSet};

use nostr::PublicKey;
use nostr_double_ratchet::{DevicePubkey, Invite, Session, SessionState};
use serde::{Deserialize, Serialize};

use crate::{PairwiseAction, PairwiseActionKind, PairwiseError, Result};

pub(crate) const STATE_SCHEMA_VERSION: u32 = 1;
pub(crate) const STORAGE_FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug)]
pub struct RuntimeLimits {
    pub max_peers: usize,
    pub max_pending_outbound: usize,
    pub max_pending_deliveries: usize,
    pub max_seen_event_ids: usize,
    pub max_seen_inner_event_ids: usize,
    pub max_sessions_per_peer: usize,
    pub max_event_bytes: usize,
    pub max_inner_event_bytes: usize,
    pub max_text_bytes: usize,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            max_peers: 2_048,
            max_pending_outbound: 1_024,
            max_pending_deliveries: 1_024,
            max_seen_event_ids: 8_192,
            max_seen_inner_event_ids: 8_192,
            max_sessions_per_peer: 8,
            max_event_bytes: 65_536,
            max_inner_event_bytes: 65_536,
            max_text_bytes: 32_768,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PairwiseState {
    pub schema_version: u32,
    pub generation: u64,
    pub local_pubkey_hex: String,
    pub local_invite: Invite,
    pub peers: BTreeMap<String, PeerState>,
    pub seen_event_ids: Vec<String>,
    pub seen_inner_event_ids: Vec<String>,
    pub pending_actions: Vec<PairwiseAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PeerState {
    pub peer_pubkey_hex: String,
    pub sessions: Vec<SessionRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct SessionRecord {
    pub handshake_id: String,
    pub handshake_created_at: u64,
    pub state: SessionState,
    pub invite_response_event_json: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StorageEnvelope {
    pub format_version: u32,
    pub generation: u64,
    pub identity_pubkey_hex: String,
    pub ciphertext: String,
}

impl PairwiseState {
    pub fn new(local_pubkey_hex: String, local_invite: Invite) -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            generation: 0,
            local_pubkey_hex,
            local_invite,
            peers: BTreeMap::new(),
            seen_event_ids: Vec::new(),
            seen_inner_event_ids: Vec::new(),
            pending_actions: Vec::new(),
        }
    }

    pub fn validate(&self, expected_pubkey: PublicKey, limits: &RuntimeLimits) -> Result<()> {
        if self.schema_version != STATE_SCHEMA_VERSION {
            return Err(PairwiseError::UnsupportedSchema(self.schema_version));
        }
        let expected_hex = expected_pubkey.to_hex();
        if self.local_pubkey_hex != expected_hex {
            return Err(PairwiseError::IdentityMismatch {
                expected: expected_hex,
                actual: self.local_pubkey_hex.clone(),
            });
        }
        if self.local_invite.inviter != expected_pubkey
            || self.local_invite.inviter_device_pubkey.to_bytes() != expected_pubkey.to_bytes()
        {
            return Err(PairwiseError::CorruptState(
                "local invite identity does not match state identity".to_string(),
            ));
        }
        if !pairwise_owner_claim_is_valid(&self.local_invite) {
            return Err(PairwiseError::CorruptState(
                "local invite contains a non-pairwise owner claim".to_string(),
            ));
        }
        if self.pending_outbound_count() > limits.max_pending_outbound {
            return Err(PairwiseError::CorruptState(
                "pending outbound queue exceeds configured limit".to_string(),
            ));
        }
        if self.pending_delivery_count() > limits.max_pending_deliveries {
            return Err(PairwiseError::CorruptState(
                "pending delivery queue exceeds configured limit".to_string(),
            ));
        }
        if self.seen_event_ids.len() > limits.max_seen_event_ids {
            return Err(PairwiseError::CorruptState(
                "seen-event set exceeds configured limit".to_string(),
            ));
        }
        if self.seen_inner_event_ids.len() > limits.max_seen_inner_event_ids {
            return Err(PairwiseError::CorruptState(
                "seen-inner-event set exceeds configured limit".to_string(),
            ));
        }
        if self.peers.len() > limits.max_peers
            || self.local_invite.used_by.len() > limits.max_peers
            || self.local_invite.used_response_contents.len() > limits.max_peers
        {
            return Err(PairwiseError::CorruptState(
                "peer or invite replay metadata exceeds configured limit".to_string(),
            ));
        }
        for action in &self.pending_actions {
            match &action.kind {
                PairwiseActionKind::Publish { event_json, .. }
                | PairwiseActionKind::OutOfBand { event_json }
                    if event_json.len() > limits.max_event_bytes =>
                {
                    return Err(PairwiseError::CorruptState(
                        "pending event exceeds configured size limit".to_string(),
                    ));
                }
                PairwiseActionKind::Delivery {
                    inner_event_json, ..
                } if inner_event_json.len() > limits.max_inner_event_bytes => {
                    return Err(PairwiseError::CorruptState(
                        "pending inner event exceeds configured size limit".to_string(),
                    ));
                }
                _ => {}
            }
        }
        for (peer_hex, peer) in &self.peers {
            if peer_hex != &peer.peer_pubkey_hex {
                return Err(PairwiseError::CorruptState(
                    "peer map key does not match peer identity".to_string(),
                ));
            }
            PublicKey::parse(peer_hex)
                .map_err(|error| PairwiseError::CorruptState(error.to_string()))?;
            if peer.sessions.is_empty() || peer.sessions.len() > limits.max_sessions_per_peer {
                return Err(PairwiseError::CorruptState(
                    "peer has an invalid number of sessions".to_string(),
                ));
            }
            let mut ids = BTreeSet::new();
            if peer
                .sessions
                .iter()
                .any(|session| !ids.insert(session.handshake_id.as_str()))
            {
                return Err(PairwiseError::CorruptState(
                    "peer contains duplicate handshake identifiers".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub fn next_action(&mut self, kind: PairwiseActionKind) -> PairwiseAction {
        let id = format!(
            "pairwise-action:{}:{}",
            self.local_pubkey_hex,
            uuid::Uuid::new_v4()
        );
        PairwiseAction { id, kind }
    }

    pub fn pending_outbound_count(&self) -> usize {
        self.pending_actions
            .iter()
            .filter(|action| {
                matches!(
                    action.kind,
                    PairwiseActionKind::Publish { .. } | PairwiseActionKind::OutOfBand { .. }
                )
            })
            .count()
    }

    pub fn pending_delivery_count(&self) -> usize {
        self.pending_actions
            .iter()
            .filter(|action| matches!(action.kind, PairwiseActionKind::Delivery { .. }))
            .count()
    }

    pub fn push_seen_event(&mut self, event_id: String, limit: usize) {
        if self.seen_event_ids.iter().any(|seen| seen == &event_id) {
            return;
        }
        self.seen_event_ids.push(event_id);
        if self.seen_event_ids.len() > limit {
            let excess = self.seen_event_ids.len() - limit;
            self.seen_event_ids.drain(0..excess);
        }
    }

    pub fn has_seen_event(&self, event_id: &str) -> bool {
        self.seen_event_ids.iter().any(|seen| seen == event_id)
    }

    pub fn push_seen_inner_event(&mut self, event_id: String, limit: usize) {
        if self
            .seen_inner_event_ids
            .iter()
            .any(|seen| seen == &event_id)
        {
            return;
        }
        self.seen_inner_event_ids.push(event_id);
        if self.seen_inner_event_ids.len() > limit {
            let excess = self.seen_inner_event_ids.len() - limit;
            self.seen_inner_event_ids.drain(0..excess);
        }
    }

    pub fn has_seen_inner_event(&self, event_id: &str) -> bool {
        self.seen_inner_event_ids
            .iter()
            .any(|seen| seen == event_id)
    }
}

impl PeerState {
    pub fn insert_session(&mut self, record: SessionRecord, max_sessions: usize) -> bool {
        if self
            .sessions
            .iter()
            .any(|session| session.handshake_id == record.handshake_id)
        {
            return false;
        }
        self.sessions.push(record);
        self.sessions.sort_by(|left, right| {
            (left.handshake_created_at, left.handshake_id.as_str())
                .cmp(&(right.handshake_created_at, right.handshake_id.as_str()))
        });
        if self.sessions.len() > max_sessions {
            let excess = self.sessions.len() - max_sessions;
            self.sessions.drain(0..excess);
        }
        true
    }

    pub fn preferred_send_session_index(&self) -> Option<usize> {
        self.sessions
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, record)| {
                Session::from_state(record.state.clone())
                    .can_send()
                    .then_some(index)
            })
    }

    pub fn tracked_sender_pubkeys(&self) -> Vec<PublicKey> {
        let mut senders = BTreeSet::new();
        for record in &self.sessions {
            for device in session_sender_keys(&record.state) {
                if let Ok(pubkey) = device.to_nostr() {
                    senders.insert(pubkey);
                }
            }
        }
        senders.into_iter().collect()
    }
}

pub(crate) fn session_sender_keys(state: &SessionState) -> Vec<DevicePubkey> {
    let mut keys = BTreeSet::new();
    keys.extend(state.their_current_nostr_public_key);
    keys.extend(state.their_next_nostr_public_key);
    keys.extend(state.skipped_keys.keys().copied());
    keys.into_iter().collect()
}

pub(crate) fn pairwise_owner_claim_is_valid(invite: &Invite) -> bool {
    let device_bytes = invite.inviter_device_pubkey.to_bytes();
    invite
        .inviter_owner_pubkey
        .is_none_or(|owner| owner.to_bytes() == device_bytes)
        && invite
            .owner_public_key
            .is_none_or(|owner| owner.to_bytes() == device_bytes)
}
