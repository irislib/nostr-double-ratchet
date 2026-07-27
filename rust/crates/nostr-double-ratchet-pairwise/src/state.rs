use std::collections::{BTreeMap, BTreeSet};

use nostr::PublicKey;
use nostr_double_ratchet::{DevicePubkey, Invite, Session, SessionState, MAX_SKIP};
use serde::{Deserialize, Serialize};

use crate::{PairwiseAction, PairwiseActionKind, PairwiseError, Result};

pub(crate) const STATE_SCHEMA_VERSION: u32 = 1;
pub(crate) const STORAGE_FORMAT_VERSION: u32 = 1;
pub const MAX_PERSISTED_STATE_BYTES: usize = 32 * 1024 * 1024;

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
    pub max_persisted_state_bytes: usize,
    pub max_total_tracked_sender_keys: usize,
    pub max_total_skipped_message_keys: usize,
    pub max_subscription_authors: usize,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            max_peers: 2_048,
            max_pending_outbound: 128,
            max_pending_deliveries: 128,
            max_seen_event_ids: 8_192,
            max_seen_inner_event_ids: 8_192,
            max_sessions_per_peer: 8,
            max_event_bytes: 65_536,
            max_inner_event_bytes: 65_536,
            max_text_bytes: 32_768,
            max_persisted_state_bytes: MAX_PERSISTED_STATE_BYTES,
            max_total_tracked_sender_keys: 8_192,
            max_total_skipped_message_keys: 32_768,
            max_subscription_authors: 4_096,
        }
    }
}

impl RuntimeLimits {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.max_sessions_per_peer == 0
            || self.max_seen_event_ids == 0
            || self.max_seen_inner_event_ids == 0
            || self.max_pending_outbound > MAX_SKIP
            || self.max_persisted_state_bytes == 0
            || self.max_persisted_state_bytes > MAX_PERSISTED_STATE_BYTES
            || self.max_total_tracked_sender_keys == 0
            || self.max_total_skipped_message_keys == 0
            || self.max_subscription_authors == 0
            || self.max_subscription_authors > self.max_total_tracked_sender_keys
        {
            return Err(PairwiseError::InvalidLimits);
        }
        Ok(())
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
    pub response_event_peers: BTreeMap<String, String>,
    pub pending_actions: Vec<PairwiseAction>,
    pub last_message_millis: u64,
    pub message_subscription_id: String,
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
    pub bootstrap_event_json: Option<String>,
    pub accepted_response_event_id: Option<String>,
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
            response_event_peers: BTreeMap::new(),
            pending_actions: Vec::new(),
            last_message_millis: 0,
            message_subscription_id: format!("ndr-pairwise-{}", uuid::Uuid::new_v4().simple()),
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
        if self.message_subscription_id.is_empty()
            || self.message_subscription_id.len() > 64
            || self
                .message_subscription_id
                .contains(&self.local_pubkey_hex)
        {
            return Err(PairwiseError::CorruptState(
                "message subscription id is invalid".to_string(),
            ));
        }
        if self.response_event_peers.len() > limits.max_seen_event_ids {
            return Err(PairwiseError::CorruptState(
                "response-peer bindings exceed configured limit".to_string(),
            ));
        }
        for (event_id, peer_pubkey_hex) in &self.response_event_peers {
            if !self.seen_event_ids.contains(event_id) || PublicKey::parse(peer_pubkey_hex).is_err()
            {
                return Err(PairwiseError::CorruptState(
                    "response-peer binding is invalid".to_string(),
                ));
            }
        }
        if self.peers.len() > limits.max_peers
            || self.local_invite.used_by.len() > limits.max_peers
            || self.local_invite.used_response_contents.len() > limits.max_peers
        {
            return Err(PairwiseError::CorruptState(
                "peer or invite replay metadata exceeds configured limit".to_string(),
            ));
        }
        let action_prefix = format!("pairwise-action:{}:", self.local_pubkey_hex);
        let mut action_ids = BTreeSet::new();
        for action in &self.pending_actions {
            if !action.id.starts_with(&action_prefix) || !action_ids.insert(action.id.as_str()) {
                return Err(PairwiseError::CorruptState(
                    "pending action id is invalid or duplicated".to_string(),
                ));
            }
            match &action.kind {
                PairwiseActionKind::Publish {
                    session_id,
                    event_json,
                    inner_event_id,
                } => {
                    let Some((_, session)) = self.session(session_id) else {
                        return Err(PairwiseError::CorruptState(
                            "publish action references a retired session".to_string(),
                        ));
                    };
                    if event_json.len() > limits.max_event_bytes
                        || (inner_event_id.is_none()
                            && session.bootstrap_event_json.as_deref() != Some(event_json.as_str()))
                    {
                        return Err(PairwiseError::CorruptState(
                            "pending publish does not match its session".to_string(),
                        ));
                    }
                }
                PairwiseActionKind::OutOfBand {
                    peer_pubkey_hex,
                    session_id,
                    event_json,
                } => {
                    if event_json.len() > limits.max_event_bytes {
                        return Err(PairwiseError::CorruptState(
                            "pending event exceeds configured size limit".to_string(),
                        ));
                    }
                    let Some(peer) = self.peers.get(peer_pubkey_hex) else {
                        return Err(PairwiseError::CorruptState(
                            "out-of-band action references an unknown peer".to_string(),
                        ));
                    };
                    if PublicKey::parse(peer_pubkey_hex).is_err()
                        || !peer.sessions.iter().any(|session| {
                            session.handshake_id == *session_id
                                && session.invite_response_event_json.as_deref()
                                    == Some(event_json.as_str())
                        })
                    {
                        return Err(PairwiseError::CorruptState(
                            "out-of-band action does not match its authenticated peer".to_string(),
                        ));
                    }
                }
                PairwiseActionKind::Delivery {
                    inner_event_json, ..
                } if inner_event_json.len() > limits.max_inner_event_bytes => {
                    return Err(PairwiseError::CorruptState(
                        "pending inner event exceeds configured size limit".to_string(),
                    ));
                }
                PairwiseActionKind::Subscribe {
                    subscription_id,
                    filter_json,
                } if subscription_id != &self.message_subscription_id
                    || filter_json.len() > limits.max_event_bytes =>
                {
                    return Err(PairwiseError::CorruptState(
                        "pending subscription action is invalid".to_string(),
                    ));
                }
                PairwiseActionKind::Unsubscribe { subscription_id }
                    if subscription_id != &self.message_subscription_id =>
                {
                    return Err(PairwiseError::CorruptState(
                        "pending unsubscription action is invalid".to_string(),
                    ));
                }
                _ => {}
            }
        }
        let mut handshake_ids = BTreeSet::new();
        let mut tracked_sender_keys = BTreeSet::new();
        let mut skipped_message_keys = 0usize;
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
            if !peer
                .sessions
                .windows(2)
                .all(|sessions| sessions[0].rank() < sessions[1].rank())
            {
                return Err(PairwiseError::CorruptState(
                    "peer sessions are not in deterministic handshake order".to_string(),
                ));
            }
            for session in &peer.sessions {
                match (
                    &session.invite_response_event_json,
                    &session.bootstrap_event_json,
                    &session.accepted_response_event_id,
                ) {
                    (Some(response), Some(bootstrap), None)
                        if response.len() <= limits.max_event_bytes
                            && bootstrap.len() <= limits.max_event_bytes => {}
                    (None, None, Some(event_id))
                        if self.response_event_peers.get(event_id) == Some(peer_hex) => {}
                    _ => {
                        return Err(PairwiseError::CorruptState(
                            "session has incomplete or oversized bootstrap events".to_string(),
                        ));
                    }
                }
                if session.handshake_id.len() != 64
                    || hex::decode(&session.handshake_id).is_err()
                    || !handshake_ids.insert(session.handshake_id.as_str())
                {
                    return Err(PairwiseError::CorruptState(
                        "session handshake identity is invalid".to_string(),
                    ));
                }
                tracked_sender_keys.extend(session_sender_keys(&session.state));
                for skipped in session.state.skipped_keys.values() {
                    skipped_message_keys = skipped_message_keys
                        .checked_add(skipped.message_keys.len())
                        .ok_or_else(|| {
                            PairwiseError::CorruptState(
                                "skipped-message key count overflow".to_string(),
                            )
                        })?;
                }
            }
        }
        if tracked_sender_keys.len() > limits.max_total_tracked_sender_keys
            || tracked_sender_keys.len() > limits.max_subscription_authors
            || skipped_message_keys > limits.max_total_skipped_message_keys
        {
            return Err(PairwiseError::CorruptState(
                "global ratchet-key limits exceeded".to_string(),
            ));
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Option<(&str, &SessionRecord)> {
        self.peers.iter().find_map(|(peer_hex, peer)| {
            peer.sessions
                .iter()
                .find(|session| session.handshake_id == session_id)
                .map(|session| (peer_hex.as_str(), session))
        })
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
            for removed in self.seen_event_ids.drain(0..excess) {
                self.response_event_peers.remove(&removed);
            }
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
    pub fn winning_rank(&self) -> Option<(u64, &str)> {
        self.sessions.last().map(SessionRecord::rank)
    }

    pub fn install_session(
        &mut self,
        record: SessionRecord,
        max_sessions: usize,
    ) -> Result<(bool, Vec<SessionRecord>)> {
        let incoming_rank = record.rank();
        if self
            .winning_rank()
            .is_some_and(|winning_rank| winning_rank > incoming_rank)
        {
            return Err(PairwiseError::InvalidEvent(
                "handshake is older than the active pairwise session".to_string(),
            ));
        }
        let existing = self
            .sessions
            .iter()
            .position(|session| session.handshake_id == record.handshake_id);
        let created = existing.is_none();
        if existing.is_some_and(|index| {
            self.sessions[index].handshake_created_at != record.handshake_created_at
        }) {
            return Err(PairwiseError::CorruptState(
                "matching handshake ids have different timestamps".to_string(),
            ));
        }
        let mut retired = std::mem::take(&mut self.sessions);
        self.sessions.push(record);
        self.sessions
            .sort_by(|left, right| left.rank().cmp(&right.rank()));
        if self.sessions.len() > max_sessions {
            return Err(PairwiseError::QueueFull { queue: "sessions" });
        }
        Ok((created, std::mem::take(&mut retired)))
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

impl SessionRecord {
    pub fn rank(&self) -> (u64, &str) {
        (self.handshake_created_at, self.handshake_id.as_str())
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
