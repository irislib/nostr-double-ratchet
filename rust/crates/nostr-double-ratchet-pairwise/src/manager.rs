use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use nostr::{Event, Filter, Keys, Kind, PublicKey, UnsignedEvent};
use nostr_double_ratchet::{
    invite_response_event, invite_unsigned_event, invite_url, message_event, parse_invite_event,
    parse_invite_response_event, parse_message_event, DevicePubkey, Invite, OwnerPubkey,
    ProtocolContext, Session, UnixSeconds, INVITE_RESPONSE_KIND, MESSAGE_EVENT_KIND,
};
use nostr_double_ratchet_pairwise_codec::{
    self as pairwise_codec, EncodeOptions, PairwiseRumorKind,
};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

use crate::persistence::{open_state, seal_state};
use crate::state::{pairwise_owner_claim_is_valid, PairwiseState, PeerState, SessionRecord};
use crate::{
    PairwiseAcceptResult, PairwiseAction, PairwiseActionKind, PairwiseError, PairwiseSendResult,
    PairwiseSessionInfo, PairwiseStore, Result, RuntimeLimits,
};

const MESSAGE_SUBSCRIPTION_ID: &str = "ndr-pairwise-messages";

pub struct PairwiseManager {
    store: Arc<dyn PairwiseStore>,
    identity_keys: Keys,
    state: PairwiseState,
    limits: RuntimeLimits,
    installed_message_authors: Vec<String>,
}

impl PairwiseManager {
    pub fn open(
        store: Arc<dyn PairwiseStore>,
        identity_keys: Keys,
        limits: RuntimeLimits,
    ) -> Result<Self> {
        let payload = store.load()?;
        let is_new = payload.is_none();
        let state = match payload {
            Some(payload) => {
                let state = open_state(&payload, &identity_keys, &limits)?;
                store.cleanup(state.generation);
                state
            }
            None => {
                let mut invite = Invite::create_new(identity_keys.public_key(), None, None)?;
                let owner = OwnerPubkey::from_bytes(identity_keys.public_key().to_bytes());
                invite.inviter_owner_pubkey = Some(owner);
                invite.owner_public_key = Some(identity_keys.public_key());
                PairwiseState::new(identity_keys.public_key().to_hex(), invite)
            }
        };
        let mut manager = Self {
            store,
            identity_keys,
            state,
            limits,
            installed_message_authors: Vec::new(),
        };
        if is_new {
            manager.commit_next(manager.state.clone(), Vec::new())?;
        }
        manager.refresh_message_subscription(true)?;
        Ok(manager)
    }

    pub fn current_invite_event_json(&self) -> Result<String> {
        let unsigned = invite_unsigned_event(&self.state.local_invite)?;
        let event = unsigned.sign_with_keys(&self.identity_keys)?;
        serde_json::to_string(&event).map_err(Into::into)
    }

    pub fn current_invite_url(&self, root: &str) -> Result<String> {
        invite_url(&self.state.local_invite, root).map_err(Into::into)
    }

    pub fn accept_invite_from_event(
        &mut self,
        event: &Event,
        authenticated_peer: PublicKey,
        now: u64,
    ) -> Result<PairwiseAcceptResult> {
        ensure_event_size(event, self.limits.max_event_bytes, "invite event")?;
        let invite = parse_invite_event(event)?;
        self.accept_invite(&invite, authenticated_peer, now)
    }

    pub fn accept_invite(
        &mut self,
        invite: &Invite,
        authenticated_peer: PublicKey,
        now: u64,
    ) -> Result<PairwiseAcceptResult> {
        let encoded_invite = serde_json::to_vec(invite)?;
        ensure_size(encoded_invite.len(), self.limits.max_event_bytes, "invite")?;
        validate_invite_peer(invite, authenticated_peer)?;
        let peer_hex = authenticated_peer.to_hex();
        ensure_peer_capacity(&self.state, &self.limits, &peer_hex)?;
        let handshake_id = handshake_id(invite);

        if let Some(response_json) = self
            .state
            .peers
            .get(&peer_hex)
            .and_then(|peer| {
                peer.sessions
                    .iter()
                    .find(|session| session.handshake_id == handshake_id)
            })
            .and_then(|session| session.invite_response_event_json.clone())
        {
            let mut next = self.state.clone();
            if !has_pending_event(&next, &response_json) {
                ensure_outbound_capacity(&next, &self.limits, 1)?;
                push_action(
                    &mut next,
                    PairwiseActionKind::OutOfBand {
                        event_json: response_json,
                    },
                );
                self.commit_next(next, self.installed_message_authors.clone())?;
            }
            return Ok(PairwiseAcceptResult {
                peer_pubkey_hex: peer_hex,
                created_new_session: false,
            });
        }

        ensure_outbound_capacity(&self.state, &self.limits, 2)?;
        let mut rng = OsRng;
        let mut context = ProtocolContext::new(UnixSeconds(now), &mut rng);
        let local_device = DevicePubkey::from_bytes(self.identity_keys.public_key().to_bytes());
        let local_owner = OwnerPubkey::from_bytes(self.identity_keys.public_key().to_bytes());
        let (mut session, response) = invite.accept_with_owner_context(
            &mut context,
            local_device,
            self.identity_keys.secret_key().to_secret_bytes(),
            Some(local_owner),
        )?;
        let response_event = invite_response_event(&response)?;
        let response_json = serde_json::to_string(&response_event)?;

        let mut bootstrap = pairwise_codec::typing_event(
            self.identity_keys.public_key(),
            EncodeOptions::new(now, now.saturating_mul(1_000)).with_expiration(1),
        )?;
        bootstrap.ensure_id();
        let bootstrap_payload = serde_json::to_vec(&bootstrap)?;
        let plan = session.plan_send(&bootstrap_payload, UnixSeconds(now))?;
        let envelope = session.apply_send(plan).envelope;
        let bootstrap_event = message_event(&envelope)?;
        validate_relay_publish(&bootstrap_event)?;
        ensure_event_size(
            &bootstrap_event,
            self.limits.max_event_bytes,
            "bootstrap event",
        )?;

        let mut next = self.state.clone();
        let peer = next
            .peers
            .entry(peer_hex.clone())
            .or_insert_with(|| PeerState {
                peer_pubkey_hex: peer_hex.clone(),
                sessions: Vec::new(),
            });
        let created_new_session = peer.insert_session(
            SessionRecord {
                handshake_id,
                handshake_created_at: invite.created_at.get(),
                state: session.state,
                invite_response_event_json: Some(response_json.clone()),
            },
            self.limits.max_sessions_per_peer,
        );
        push_action(
            &mut next,
            PairwiseActionKind::OutOfBand {
                event_json: response_json,
            },
        );
        push_action(
            &mut next,
            PairwiseActionKind::Publish {
                event_json: serde_json::to_string(&bootstrap_event)?,
                inner_event_id: None,
            },
        );
        let authors =
            refresh_subscription_actions(&mut next, &self.installed_message_authors, false)?;
        self.commit_next(next, authors)?;

        Ok(PairwiseAcceptResult {
            peer_pubkey_hex: peer_hex,
            created_new_session,
        })
    }

    pub fn process_out_of_band_response(
        &mut self,
        event: &Event,
        authenticated_peer: PublicKey,
        now: u64,
    ) -> Result<()> {
        ensure_event_size(event, self.limits.max_event_bytes, "invite response event")?;
        if event.kind != Kind::from(INVITE_RESPONSE_KIND as u16) {
            return Err(PairwiseError::InvalidEvent(
                "out-of-band response must be kind 1059".to_string(),
            ));
        }
        let envelope = parse_invite_response_event(event)?;
        if envelope.recipient != self.state.local_invite.inviter_ephemeral_public_key {
            return Err(PairwiseError::InvalidEvent(
                "invite response recipient does not match local invite".to_string(),
            ));
        }
        let event_id = event.id.to_hex();
        if self.state.has_seen_event(&event_id) {
            return Ok(());
        }

        let mut invite = self.state.local_invite.clone();
        let mut rng = OsRng;
        let mut context = ProtocolContext::new(UnixSeconds(now), &mut rng);
        let response = invite.process_response(
            &mut context,
            &envelope,
            self.identity_keys.secret_key().to_secret_bytes(),
        )?;
        validate_response_peer(&response, authenticated_peer)?;

        let peer_hex = authenticated_peer.to_hex();
        ensure_peer_capacity(&self.state, &self.limits, &peer_hex)?;
        let mut next = self.state.clone();
        next.local_invite = invite;
        let peer = next
            .peers
            .entry(peer_hex.clone())
            .or_insert_with(|| PeerState {
                peer_pubkey_hex: peer_hex,
                sessions: Vec::new(),
            });
        peer.insert_session(
            SessionRecord {
                handshake_id: handshake_id(&next.local_invite),
                handshake_created_at: next.local_invite.created_at.get(),
                state: response.session.state,
                invite_response_event_json: None,
            },
            self.limits.max_sessions_per_peer,
        );
        next.push_seen_event(event_id, self.limits.max_seen_event_ids);
        let authors =
            refresh_subscription_actions(&mut next, &self.installed_message_authors, false)?;
        self.commit_next(next, authors)
    }

    pub fn send_text(
        &mut self,
        peer: PublicKey,
        text: &str,
        expires_at: Option<u64>,
        now: u64,
        millis: u64,
    ) -> Result<PairwiseSendResult> {
        ensure_size(text.len(), self.limits.max_text_bytes, "message text")?;
        let mut inner = pairwise_codec::message_event(self.identity_keys.public_key(), text, {
            let options = EncodeOptions::new(now, millis);
            match expires_at {
                Some(expiration) => options.with_expiration(expiration),
                None => options,
            }
        })?;
        inner.ensure_id();
        self.send_unsigned_event(peer, inner, now)
    }

    pub fn send_unsigned_event(
        &mut self,
        peer: PublicKey,
        inner: UnsignedEvent,
        now: u64,
    ) -> Result<PairwiseSendResult> {
        ensure_outbound_capacity(&self.state, &self.limits, 1)?;
        let encoded = serde_json::to_vec(&inner)?;
        ensure_size(
            encoded.len(),
            self.limits.max_inner_event_bytes,
            "inner event",
        )?;
        let decoded = pairwise_codec::decode_strict(&encoded)?;
        self.send_inner_event(peer, decoded.event, now)
    }

    pub fn process_event(&mut self, event: &Event) -> Result<()> {
        self.process_event_at(event, unix_now())
    }

    pub fn process_event_at(&mut self, event: &Event, now: u64) -> Result<()> {
        ensure_event_size(event, self.limits.max_event_bytes, "relay event")?;
        if event.kind != Kind::from(MESSAGE_EVENT_KIND as u16) {
            return Err(PairwiseError::InvalidEvent(
                "pairwise relay input must be kind 1060".to_string(),
            ));
        }
        let event_id = event.id.to_hex();
        if self.state.has_seen_event(&event_id) {
            return Ok(());
        }
        let envelope = parse_message_event(event)?;

        let mut decrypted = None;
        for (peer_hex, peer) in &self.state.peers {
            for (session_index, record) in peer.sessions.iter().enumerate() {
                let session = Session::from_state(record.state.clone());
                if !session.matches_sender(envelope.sender) {
                    continue;
                }
                let mut rng = OsRng;
                let mut context =
                    ProtocolContext::new(UnixSeconds(event.created_at.as_secs()), &mut rng);
                if let Ok(plan) = session.plan_receive(&mut context, &envelope) {
                    decrypted = Some((peer_hex.clone(), session_index, plan));
                    break;
                }
            }
            if decrypted.is_some() {
                break;
            }
        }
        let Some((peer_hex, session_index, plan)) = decrypted else {
            return Err(PairwiseError::InvalidEvent(
                "message does not match an authenticated pairwise session".to_string(),
            ));
        };

        let decoded = pairwise_codec::decode_strict(&plan.payload)?;
        ensure_size(
            plan.payload.len(),
            self.limits.max_inner_event_bytes,
            "decrypted inner event",
        )?;
        let peer_pubkey = PublicKey::parse(&peer_hex)?;
        if decoded.event.pubkey != peer_pubkey {
            return Err(PairwiseError::PeerMismatch {
                expected: peer_hex,
                actual: decoded.event.pubkey.to_hex(),
            });
        }
        let inner_event_id = decoded
            .event
            .id
            .as_ref()
            .ok_or_else(|| PairwiseError::InvalidEvent("inner event is missing id".to_string()))?
            .to_hex();
        let should_deliver = matches!(
            decoded.kind,
            PairwiseRumorKind::Message { expiration, .. }
                if expiration.is_none_or(|expiration| expiration > now)
        );
        let inner_was_seen = self.state.has_seen_inner_event(&inner_event_id);
        if should_deliver
            && !inner_was_seen
            && self.state.pending_delivery_count() >= self.limits.max_pending_deliveries
        {
            return Err(PairwiseError::QueueFull { queue: "delivery" });
        }

        let mut next = self.state.clone();
        next.peers
            .get_mut(&peer_hex)
            .and_then(|peer| peer.sessions.get_mut(session_index))
            .ok_or_else(|| PairwiseError::CorruptState("selected session disappeared".to_string()))?
            .state = plan.next_state;
        next.push_seen_event(event_id.clone(), self.limits.max_seen_event_ids);
        next.push_seen_inner_event(inner_event_id.clone(), self.limits.max_seen_inner_event_ids);
        if should_deliver && !inner_was_seen {
            push_action(
                &mut next,
                PairwiseActionKind::Delivery {
                    peer_pubkey_hex: peer_hex,
                    inner_event_json: serde_json::to_string(&decoded.event)?,
                    inner_event_id,
                    outer_event_id: event_id,
                },
            );
        }
        let authors =
            refresh_subscription_actions(&mut next, &self.installed_message_authors, false)?;
        self.commit_next(next, authors)
    }

    pub fn pending_actions(&self) -> Vec<PairwiseAction> {
        self.state.pending_actions.clone()
    }

    pub fn ack_actions(&mut self, action_ids: &[String]) -> Result<()> {
        if action_ids.is_empty() {
            return Ok(());
        }
        let ids = action_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let mut next = self.state.clone();
        let before = next.pending_actions.len();
        next.pending_actions
            .retain(|action| !ids.contains(action.id.as_str()));
        if next.pending_actions.len() == before {
            return Ok(());
        }
        self.commit_next(next, self.installed_message_authors.clone())
    }

    pub fn known_peer_pubkeys(&self) -> Vec<String> {
        self.state.peers.keys().cloned().collect()
    }

    pub fn session_info(&self, peer: PublicKey) -> Option<PairwiseSessionInfo> {
        let peer = self.state.peers.get(&peer.to_hex())?;
        let tracked_sender_pubkeys = peer
            .tracked_sender_pubkeys()
            .into_iter()
            .map(|pubkey| pubkey.to_hex())
            .collect::<Vec<_>>();
        Some(PairwiseSessionInfo {
            send_ready: peer.preferred_send_session_index().is_some(),
            receive_ready: !tracked_sender_pubkeys.is_empty(),
            tracked_sender_pubkeys,
        })
    }

    pub fn total_sessions(&self) -> u64 {
        self.state
            .peers
            .values()
            .map(|peer| peer.sessions.len() as u64)
            .sum()
    }

    pub fn local_pubkey(&self) -> PublicKey {
        self.identity_keys.public_key()
    }

    fn send_inner_event(
        &mut self,
        peer: PublicKey,
        mut inner: UnsignedEvent,
        now: u64,
    ) -> Result<PairwiseSendResult> {
        if inner.pubkey != self.identity_keys.public_key() {
            return Err(PairwiseError::PeerMismatch {
                expected: self.identity_keys.public_key().to_hex(),
                actual: inner.pubkey.to_hex(),
            });
        }
        inner.ensure_id();
        inner.verify_id()?;
        let inner_event_id = inner
            .id
            .as_ref()
            .ok_or_else(|| PairwiseError::InvalidEvent("inner event is missing id".to_string()))?
            .to_hex();
        let peer_hex = peer.to_hex();
        let peer_state = self
            .state
            .peers
            .get(&peer_hex)
            .ok_or_else(|| PairwiseError::SessionNotReady(peer_hex.clone()))?;
        let session_index = peer_state
            .preferred_send_session_index()
            .ok_or_else(|| PairwiseError::SessionNotReady(peer_hex.clone()))?;
        let session = Session::from_state(peer_state.sessions[session_index].state.clone());
        let plan = session.plan_send(&serde_json::to_vec(&inner)?, UnixSeconds(now))?;
        let envelope = plan.envelope.clone();
        let event = message_event(&envelope)?;
        validate_relay_publish(&event)?;
        ensure_event_size(&event, self.limits.max_event_bytes, "relay event")?;

        let mut next = self.state.clone();
        next.peers
            .get_mut(&peer_hex)
            .and_then(|peer| peer.sessions.get_mut(session_index))
            .ok_or_else(|| PairwiseError::CorruptState("selected session disappeared".to_string()))?
            .state = plan.next_state;
        push_action(
            &mut next,
            PairwiseActionKind::Publish {
                event_json: serde_json::to_string(&event)?,
                inner_event_id: Some(inner_event_id.clone()),
            },
        );
        self.commit_next(next, self.installed_message_authors.clone())?;
        Ok(PairwiseSendResult {
            inner_event_id,
            outer_event_id: event.id.to_hex(),
        })
    }

    fn refresh_message_subscription(&mut self, force: bool) -> Result<()> {
        let mut next = self.state.clone();
        let authors =
            refresh_subscription_actions(&mut next, &self.installed_message_authors, force)?;
        if next.pending_actions == self.state.pending_actions {
            self.installed_message_authors = authors;
            return Ok(());
        }
        self.commit_next(next, authors)
    }

    fn commit_next(
        &mut self,
        mut next: PairwiseState,
        installed_message_authors: Vec<String>,
    ) -> Result<()> {
        next.generation = self
            .state
            .generation
            .checked_add(1)
            .ok_or_else(|| PairwiseError::Storage("state generation overflow".to_string()))?;
        next.validate(self.identity_keys.public_key(), &self.limits)?;
        let payload = seal_state(&next, &self.identity_keys)?;
        self.store.commit(next.generation, &payload)?;
        self.state = next;
        self.installed_message_authors = installed_message_authors;
        Ok(())
    }
}

fn validate_invite_peer(invite: &Invite, authenticated_peer: PublicKey) -> Result<()> {
    let actual = invite.inviter_device_pubkey.to_nostr()?;
    if actual != authenticated_peer {
        return Err(PairwiseError::PeerMismatch {
            expected: authenticated_peer.to_hex(),
            actual: actual.to_hex(),
        });
    }
    if !pairwise_owner_claim_is_valid(invite) {
        return Err(PairwiseError::OwnerDeviceMismatch);
    }
    Ok(())
}

fn validate_response_peer(
    response: &nostr_double_ratchet::InviteResponse,
    authenticated_peer: PublicKey,
) -> Result<()> {
    if response.invitee_identity != authenticated_peer {
        return Err(PairwiseError::PeerMismatch {
            expected: authenticated_peer.to_hex(),
            actual: response.invitee_identity.to_hex(),
        });
    }
    let device = response.invitee_device_pubkey.to_bytes();
    if device != authenticated_peer.to_bytes()
        || response
            .invitee_owner_pubkey
            .is_some_and(|owner| owner.to_bytes() != device)
        || response
            .owner_public_key
            .is_some_and(|owner| owner != authenticated_peer)
    {
        return Err(PairwiseError::OwnerDeviceMismatch);
    }
    Ok(())
}

fn validate_relay_publish(event: &Event) -> Result<()> {
    if event.kind != Kind::from(MESSAGE_EVENT_KIND as u16) {
        return Err(PairwiseError::InvalidEvent(
            "relay publish must be kind 1060".to_string(),
        ));
    }
    event.verify()?;
    if event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().map(String::as_str) == Some("p"))
    {
        return Err(PairwiseError::InvalidEvent(
            "pairwise relay publish must not reveal a recipient key".to_string(),
        ));
    }
    Ok(())
}

fn ensure_outbound_capacity(
    state: &PairwiseState,
    limits: &RuntimeLimits,
    additional: usize,
) -> Result<()> {
    if state.pending_outbound_count().saturating_add(additional) > limits.max_pending_outbound {
        return Err(PairwiseError::QueueFull { queue: "outbound" });
    }
    Ok(())
}

fn ensure_peer_capacity(
    state: &PairwiseState,
    limits: &RuntimeLimits,
    peer_hex: &str,
) -> Result<()> {
    if !state.peers.contains_key(peer_hex) && state.peers.len() >= limits.max_peers {
        return Err(PairwiseError::QueueFull { queue: "peers" });
    }
    Ok(())
}

fn ensure_event_size(event: &Event, limit: usize, input: &'static str) -> Result<()> {
    let encoded = serde_json::to_vec(event)?;
    ensure_size(encoded.len(), limit, input)
}

fn ensure_size(size: usize, limit: usize, input: &'static str) -> Result<()> {
    if size > limit {
        return Err(PairwiseError::InputTooLarge { input, limit });
    }
    Ok(())
}

fn push_action(state: &mut PairwiseState, kind: PairwiseActionKind) {
    let action = state.next_action(kind);
    state.pending_actions.push(action);
}

fn has_pending_event(state: &PairwiseState, event_json: &str) -> bool {
    state
        .pending_actions
        .iter()
        .any(|action| match &action.kind {
            PairwiseActionKind::Publish {
                event_json: pending,
                ..
            }
            | PairwiseActionKind::OutOfBand {
                event_json: pending,
            } => pending == event_json,
            _ => false,
        })
}

fn message_authors(state: &PairwiseState) -> Vec<String> {
    let mut authors = BTreeSet::new();
    for peer in state.peers.values() {
        authors.extend(
            peer.tracked_sender_pubkeys()
                .into_iter()
                .map(|pubkey| pubkey.to_hex()),
        );
    }
    authors.into_iter().collect()
}

fn refresh_subscription_actions(
    state: &mut PairwiseState,
    installed_authors: &[String],
    force: bool,
) -> Result<Vec<String>> {
    let authors = message_authors(state);
    if !force && authors == installed_authors {
        return Ok(authors);
    }
    state.pending_actions.retain(|action| match &action.kind {
        PairwiseActionKind::Subscribe {
            subscription_id, ..
        }
        | PairwiseActionKind::Unsubscribe { subscription_id } => {
            subscription_id != MESSAGE_SUBSCRIPTION_ID
        }
        _ => true,
    });
    if !installed_authors.is_empty() {
        push_action(
            state,
            PairwiseActionKind::Unsubscribe {
                subscription_id: MESSAGE_SUBSCRIPTION_ID.to_string(),
            },
        );
    }
    if !authors.is_empty() {
        let pubkeys = authors
            .iter()
            .map(|author| PublicKey::parse(author))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let filter = Filter::new()
            .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
            .authors(pubkeys);
        push_action(
            state,
            PairwiseActionKind::Subscribe {
                subscription_id: MESSAGE_SUBSCRIPTION_ID.to_string(),
                filter_json: serde_json::to_string(&filter)?,
            },
        );
    }
    Ok(authors)
}

fn handshake_id(invite: &Invite) -> String {
    let mut hash = Sha256::new();
    hash.update(invite.inviter_device_pubkey.to_bytes());
    hash.update(invite.inviter_ephemeral_public_key.to_bytes());
    hash.update(invite.shared_secret);
    hash.update(invite.created_at.get().to_be_bytes());
    hex::encode(hash.finalize())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::MemoryStore;

    #[test]
    fn relay_publish_invariant_rejects_long_term_recipient_tag() {
        let keys = Keys::generate();
        let recipient = Keys::generate();
        let event = nostr::EventBuilder::new(Kind::from(MESSAGE_EVENT_KIND as u16), "ciphertext")
            .tag(nostr::Tag::parse(["p", recipient.public_key().to_hex().as_str()]).expect("p tag"))
            .sign_with_keys(&keys)
            .expect("signed");
        assert!(validate_relay_publish(&event).is_err());
    }

    #[test]
    fn subscription_filter_is_message_only_and_uses_ephemeral_authors() {
        let mut state = PairwiseState::new(
            Keys::generate().public_key().to_hex(),
            Invite::create_new(Keys::generate().public_key(), None, None).expect("invite"),
        );
        let authors =
            refresh_subscription_actions(&mut state, &[], true).expect("subscription refresh");
        assert!(authors.is_empty());
        assert!(state.pending_actions.is_empty());
    }

    fn test_manager(keys: &Keys) -> PairwiseManager {
        PairwiseManager::open(
            Arc::new(MemoryStore::default()),
            keys.clone(),
            RuntimeLimits::default(),
        )
        .expect("manager")
    }

    fn establish(
        alice: &mut PairwiseManager,
        bob: &mut PairwiseManager,
        alice_keys: &Keys,
        bob_keys: &Keys,
    ) {
        let invite: Event =
            serde_json::from_str(&alice.current_invite_event_json().unwrap()).unwrap();
        bob.accept_invite_from_event(&invite, alice_keys.public_key(), 1_710_000_000)
            .unwrap();
        let response = bob
            .state
            .pending_actions
            .iter()
            .find_map(|action| match &action.kind {
                PairwiseActionKind::OutOfBand { event_json } => Some(event_json.clone()),
                _ => None,
            })
            .unwrap();
        let bootstrap = bob
            .state
            .pending_actions
            .iter()
            .find_map(|action| match &action.kind {
                PairwiseActionKind::Publish { event_json, .. } => Some(event_json.clone()),
                _ => None,
            })
            .unwrap();
        alice
            .process_out_of_band_response(
                &serde_json::from_str(&response).unwrap(),
                bob_keys.public_key(),
                1_710_000_001,
            )
            .unwrap();
        alice
            .process_event_at(&serde_json::from_str(&bootstrap).unwrap(), 1_710_000_002)
            .unwrap();
    }

    fn encrypt_unchecked(
        sender: &mut PairwiseManager,
        peer: PublicKey,
        mut inner: UnsignedEvent,
        now: u64,
    ) -> Event {
        inner.ensure_id();
        let peer_hex = peer.to_hex();
        let session_index = sender.state.peers[&peer_hex]
            .preferred_send_session_index()
            .expect("send session");
        let session = Session::from_state(
            sender.state.peers[&peer_hex].sessions[session_index]
                .state
                .clone(),
        );
        let plan = session
            .plan_send(&serde_json::to_vec(&inner).unwrap(), UnixSeconds(now))
            .unwrap();
        let event = message_event(&plan.envelope).unwrap();
        let mut next = sender.state.clone();
        next.peers.get_mut(&peer_hex).unwrap().sessions[session_index].state = plan.next_state;
        sender
            .commit_next(next, sender.installed_message_authors.clone())
            .unwrap();
        event
    }

    #[test]
    fn receive_rejects_forged_author_and_legacy_rumor_without_state_advance() {
        let alice_keys = Keys::generate();
        let bob_keys = Keys::generate();
        let attacker_keys = Keys::generate();
        let mut alice = test_manager(&alice_keys);
        let mut bob = test_manager(&bob_keys);
        establish(&mut alice, &mut bob, &alice_keys, &bob_keys);

        let forged = pairwise_codec::message_event(
            attacker_keys.public_key(),
            "forged",
            EncodeOptions::new(1_710_000_010, 1_710_000_010_000),
        )
        .unwrap();
        let forged_outer =
            encrypt_unchecked(&mut bob, alice_keys.public_key(), forged, 1_710_000_010);
        assert!(matches!(
            alice.process_event_at(&forged_outer, 1_710_000_011),
            Err(PairwiseError::PeerMismatch { .. })
        ));
        assert!(alice
            .pending_actions()
            .iter()
            .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));

        let legacy = nostr::EventBuilder::new(Kind::from(14u16), "legacy")
            .custom_created_at(nostr::Timestamp::from(1_710_000_012))
            .build(bob_keys.public_key());
        let legacy_outer =
            encrypt_unchecked(&mut bob, alice_keys.public_key(), legacy, 1_710_000_012);
        assert!(alice
            .process_event_at(&legacy_outer, 1_710_000_013)
            .is_err());

        let live = bob
            .send_text(
                alice_keys.public_key(),
                "valid after rejects",
                None,
                1_710_000_014,
                1_710_000_014_000,
            )
            .unwrap();
        let live_event = bob
            .pending_actions()
            .into_iter()
            .find_map(|action| match action.kind {
                PairwiseActionKind::Publish { event_json, .. } => {
                    let event: Event = serde_json::from_str(&event_json).ok()?;
                    (event.id.to_hex() == live.outer_event_id).then_some(event)
                }
                _ => None,
            })
            .unwrap();
        alice
            .process_event_at(&live_event, 1_710_000_015)
            .expect("skipped rejected message keys remain recoverable");
        assert_eq!(
            alice
                .pending_actions()
                .iter()
                .filter(|action| matches!(action.kind, PairwiseActionKind::Delivery { .. }))
                .count(),
            1
        );
    }
}
