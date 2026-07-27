use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use nostr::{Event, Filter, Keys, Kind, PublicKey, UnsignedEvent};
use nostr_double_ratchet::{
    invite_response_event, invite_unsigned_event, invite_url, message_event, parse_invite_event,
    parse_invite_response_event, parse_message_event, DevicePubkey, Invite, OwnerPubkey,
    ProtocolContext, Session, UnixSeconds, INVITE_RESPONSE_KIND, MESSAGE_EVENT_KIND,
};
use nostr_double_ratchet_pairwise_codec::{self as pairwise_codec, EncodeOptions};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

use crate::persistence::{is_legacy_state_payload, open_state, seal_state};
use crate::state::{pairwise_owner_claim_is_valid, PairwiseState, PeerState, SessionRecord};
use crate::{
    PairwiseAcceptResult, PairwiseAction, PairwiseActionKind, PairwiseError, PairwiseSendResult,
    PairwiseSessionInfo, PairwiseStore, Result, RuntimeLimits,
};

const MAX_INVITE_FUTURE_SKEW_SECONDS: u64 = 10 * 60;

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
        limits.validate()?;
        let payload = store.load()?;
        let mut needs_storage_commit = payload.is_none();
        let state = match payload {
            Some(payload) => {
                needs_storage_commit = is_legacy_state_payload(&payload);
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
        if needs_storage_commit {
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
        if invite.created_at.get() > now.saturating_add(MAX_INVITE_FUTURE_SKEW_SECONDS) {
            return Err(PairwiseError::InvalidEvent(
                "invite timestamp is unreasonably far in the future".to_string(),
            ));
        }
        let peer_hex = authenticated_peer.to_hex();
        ensure_peer_capacity(&self.state, &self.limits, &peer_hex)?;
        let handshake_id = handshake_id(invite, self.identity_keys.public_key());

        if let Some((response_json, bootstrap_json)) = self
            .state
            .peers
            .get(&peer_hex)
            .and_then(|peer| {
                peer.sessions
                    .iter()
                    .find(|session| session.handshake_id == handshake_id)
            })
            .and_then(|session| {
                Some((
                    session.invite_response_event_json.clone()?,
                    session.bootstrap_event_json.clone()?,
                ))
            })
        {
            let mut next = self.state.clone();
            let response_missing =
                !has_pending_out_of_band_event(&next, &peer_hex, &handshake_id, &response_json);
            let bootstrap_missing =
                !has_pending_publish_event(&next, &handshake_id, &bootstrap_json);
            let missing = usize::from(response_missing) + usize::from(bootstrap_missing);
            if missing > 0 {
                ensure_outbound_capacity(&next, &self.limits, missing)?;
                if response_missing {
                    push_action(
                        &mut next,
                        PairwiseActionKind::OutOfBand {
                            peer_pubkey_hex: peer_hex.clone(),
                            session_id: handshake_id.clone(),
                            event_json: response_json,
                        },
                    );
                }
                if bootstrap_missing {
                    push_action(
                        &mut next,
                        PairwiseActionKind::Publish {
                            session_id: handshake_id.clone(),
                            event_json: bootstrap_json,
                            inner_event_id: None,
                        },
                    );
                }
                self.commit_next(next, self.installed_message_authors.clone())?;
            }
            return Ok(PairwiseAcceptResult {
                peer_pubkey_hex: peer_hex,
                created_new_session: false,
            });
        }

        ensure_winning_handshake(
            &self.state,
            &peer_hex,
            invite.created_at.get(),
            &handshake_id,
        )?;
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
        let bootstrap_json = serde_json::to_string(&bootstrap_event)?;

        let mut next = self.state.clone();
        let (created_new_session, retired) = {
            let peer = next
                .peers
                .entry(peer_hex.clone())
                .or_insert_with(|| PeerState {
                    peer_pubkey_hex: peer_hex.clone(),
                    sessions: Vec::new(),
                });
            peer.install_session(
                SessionRecord {
                    handshake_id: handshake_id.clone(),
                    handshake_created_at: invite.created_at.get(),
                    state: session.state,
                    invite_response_event_json: Some(response_json.clone()),
                    bootstrap_event_json: Some(bootstrap_json.clone()),
                    accepted_response_event_id: None,
                },
                self.limits.max_sessions_per_peer,
            )?
        };
        retire_sessions(&mut next, retired);
        ensure_outbound_capacity(&next, &self.limits, 2)?;
        push_action(
            &mut next,
            PairwiseActionKind::OutOfBand {
                peer_pubkey_hex: peer_hex.clone(),
                session_id: handshake_id.clone(),
                event_json: response_json,
            },
        );
        push_action(
            &mut next,
            PairwiseActionKind::Publish {
                session_id: handshake_id,
                event_json: bootstrap_json,
                inner_event_id: None,
            },
        );
        let authors = refresh_subscription_actions(
            &mut next,
            &self.installed_message_authors,
            false,
            &self.limits,
        )?;
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
        let authenticated_peer_hex = authenticated_peer.to_hex();
        if self.state.has_seen_event(&event_id) {
            return match self.state.response_event_peers.get(&event_id) {
                Some(bound_peer) if bound_peer == &authenticated_peer_hex => Ok(()),
                Some(bound_peer) => Err(PairwiseError::PeerMismatch {
                    expected: bound_peer.clone(),
                    actual: authenticated_peer_hex,
                }),
                None => Err(PairwiseError::InvalidEvent(
                    "seen response is missing authenticated peer binding".to_string(),
                )),
            };
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

        let peer_hex = authenticated_peer_hex;
        let response_handshake_id = handshake_id(&invite, authenticated_peer);
        ensure_peer_capacity(&self.state, &self.limits, &peer_hex)?;
        ensure_winning_handshake(
            &self.state,
            &peer_hex,
            invite.created_at.get(),
            &response_handshake_id,
        )?;
        let mut next = self.state.clone();
        next.local_invite = invite;
        let retired = {
            let peer = next
                .peers
                .entry(peer_hex.clone())
                .or_insert_with(|| PeerState {
                    peer_pubkey_hex: peer_hex.clone(),
                    sessions: Vec::new(),
                });
            peer.install_session(
                SessionRecord {
                    handshake_id: response_handshake_id,
                    handshake_created_at: next.local_invite.created_at.get(),
                    state: response.session.state,
                    invite_response_event_json: None,
                    bootstrap_event_json: None,
                    accepted_response_event_id: Some(event_id.clone()),
                },
                self.limits.max_sessions_per_peer,
            )?
            .1
        };
        retire_sessions(&mut next, retired);
        next.response_event_peers.insert(event_id.clone(), peer_hex);
        next.push_seen_event(event_id, self.limits.max_seen_event_ids);
        let authors = refresh_subscription_actions(
            &mut next,
            &self.installed_message_authors,
            false,
            &self.limits,
        )?;
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
        let next_millis = self
            .state
            .last_message_millis
            .checked_add(1)
            .ok_or_else(|| {
                PairwiseError::InvalidEvent("message timestamp exhausted".to_string())
            })?;
        let message_millis = millis.max(next_millis);
        let mut inner = pairwise_codec::message_event(self.identity_keys.public_key(), text, {
            let options = EncodeOptions::new(now, message_millis);
            match expires_at {
                Some(expiration) => options.with_expiration(expiration),
                None => options,
            }
        })?;
        inner.ensure_id();
        self.validate_and_send_unsigned_event(peer, inner, now, Some(message_millis))
    }

    pub fn send_unsigned_event(
        &mut self,
        peer: PublicKey,
        inner: UnsignedEvent,
        now: u64,
    ) -> Result<PairwiseSendResult> {
        self.validate_and_send_unsigned_event(peer, inner, now, None)
    }

    fn validate_and_send_unsigned_event(
        &mut self,
        peer: PublicKey,
        inner: UnsignedEvent,
        now: u64,
        message_millis: Option<u64>,
    ) -> Result<PairwiseSendResult> {
        ensure_outbound_capacity(&self.state, &self.limits, 1)?;
        let encoded = serde_json::to_vec(&inner)?;
        ensure_size(
            encoded.len(),
            self.limits.max_inner_event_bytes,
            "inner event",
        )?;
        let decoded = pairwise_codec::decode_strict(&encoded)?;
        self.send_inner_event(peer, decoded.event, now, message_millis.or(decoded.millis))
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
        event.verify()?;
        let event_id = event.id.to_hex();
        if self.state.has_seen_event(&event_id) {
            return Ok(());
        }
        let envelope = parse_message_event(event)?;
        if envelope.recipient.is_some() {
            return Err(PairwiseError::InvalidEvent(
                "pairwise relay input must not reveal a recipient key".to_string(),
            ));
        }

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
        let expires_at_seconds = decoded.expiration;
        let should_deliver = expires_at_seconds.is_none_or(|expiration| expiration > now);
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
                    expires_at_seconds,
                },
            );
        }
        let authors = refresh_subscription_actions(
            &mut next,
            &self.installed_message_authors,
            false,
            &self.limits,
        )?;
        self.commit_next(next, authors)
    }

    pub fn pending_actions(&mut self) -> Result<Vec<PairwiseAction>> {
        self.pending_actions_at(unix_now())
    }

    pub fn pending_actions_at(&mut self, now: u64) -> Result<Vec<PairwiseAction>> {
        let mut next = self.state.clone();
        next.pending_actions.retain(|action| {
            !matches!(
                action.kind,
                PairwiseActionKind::Delivery {
                    expires_at_seconds: Some(expiration),
                    ..
                } if expiration <= now
            )
        });
        if next.pending_actions.len() != self.state.pending_actions.len() {
            self.commit_next(next, self.installed_message_authors.clone())?;
        }
        Ok(self.state.pending_actions.clone())
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

    pub fn retire_peer(&mut self, peer: PublicKey) -> Result<bool> {
        let peer_hex = peer.to_hex();
        let mut next = self.state.clone();
        let Some(retired_peer) = next.peers.remove(&peer_hex) else {
            return Ok(false);
        };
        retire_sessions(&mut next, retired_peer.sessions);
        next.pending_actions.retain(|action| {
            !matches!(
                &action.kind,
                PairwiseActionKind::Delivery {
                    peer_pubkey_hex,
                    ..
                } if peer_pubkey_hex == &peer_hex
            )
        });
        let authors = refresh_subscription_actions(
            &mut next,
            &self.installed_message_authors,
            false,
            &self.limits,
        )?;
        self.commit_next(next, authors)?;
        Ok(true)
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
        message_millis: Option<u64>,
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
        let session_id = peer_state.sessions[session_index].handshake_id.clone();
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
        if let Some(message_millis) = message_millis {
            next.last_message_millis = next.last_message_millis.max(message_millis);
        }
        push_action(
            &mut next,
            PairwiseActionKind::Publish {
                session_id,
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
        let authors = refresh_subscription_actions(
            &mut next,
            &self.installed_message_authors,
            force,
            &self.limits,
        )?;
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
        let payload = seal_state(
            &next,
            &self.identity_keys,
            self.limits.max_persisted_state_bytes,
        )?;
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

fn ensure_winning_handshake(
    state: &PairwiseState,
    peer_hex: &str,
    incoming_created_at: u64,
    incoming_session_id: &str,
) -> Result<()> {
    let Some(peer) = state.peers.get(peer_hex) else {
        return Ok(());
    };
    if peer
        .winning_rank()
        .is_some_and(|winning_rank| winning_rank > (incoming_created_at, incoming_session_id))
    {
        return Err(PairwiseError::InvalidEvent(
            "handshake is older than the active pairwise session".to_string(),
        ));
    }
    Ok(())
}

fn retire_sessions(state: &mut PairwiseState, retired: Vec<SessionRecord>) {
    if retired.is_empty() {
        return;
    }
    let session_ids = retired
        .iter()
        .map(|session| session.handshake_id.as_str())
        .collect::<BTreeSet<_>>();
    state.pending_actions.retain(|action| {
        action_session_id(&action.kind).is_none_or(|session_id| !session_ids.contains(session_id))
    });
}

fn action_session_id(kind: &PairwiseActionKind) -> Option<&str> {
    match kind {
        PairwiseActionKind::Publish { session_id, .. }
        | PairwiseActionKind::OutOfBand { session_id, .. } => Some(session_id),
        _ => None,
    }
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

fn has_pending_out_of_band_event(
    state: &PairwiseState,
    peer_pubkey_hex: &str,
    session_id: &str,
    event_json: &str,
) -> bool {
    state
        .pending_actions
        .iter()
        .any(|action| match &action.kind {
            PairwiseActionKind::OutOfBand {
                peer_pubkey_hex: pending_peer,
                session_id: pending_session,
                event_json: pending,
            } => {
                pending_peer == peer_pubkey_hex
                    && pending_session == session_id
                    && pending == event_json
            }
            _ => false,
        })
}

fn has_pending_publish_event(state: &PairwiseState, session_id: &str, event_json: &str) -> bool {
    state.pending_actions.iter().any(|action| {
        matches!(
            &action.kind,
            PairwiseActionKind::Publish {
                session_id: pending_session,
                event_json: pending,
                ..
            } if pending_session == session_id && pending == event_json
        )
    })
}

fn message_authors(state: &PairwiseState, limits: &RuntimeLimits) -> Result<Vec<String>> {
    let mut authors = BTreeSet::new();
    for peer in state.peers.values() {
        authors.extend(
            peer.tracked_sender_pubkeys()
                .into_iter()
                .map(|pubkey| pubkey.to_hex()),
        );
        if authors.len() > limits.max_subscription_authors {
            return Err(PairwiseError::QueueFull {
                queue: "subscription-authors",
            });
        }
    }
    Ok(authors.into_iter().collect())
}

fn refresh_subscription_actions(
    state: &mut PairwiseState,
    installed_authors: &[String],
    force: bool,
    limits: &RuntimeLimits,
) -> Result<Vec<String>> {
    let authors = message_authors(state, limits)?;
    let subscription_id = state.message_subscription_id.clone();
    let has_pending_subscribe = state.pending_actions.iter().any(|action| {
        matches!(
            &action.kind,
            PairwiseActionKind::Subscribe {
                subscription_id: pending,
                ..
            } if pending == &subscription_id
        )
    });
    let has_pending_unsubscribe = state.pending_actions.iter().any(|action| {
        matches!(
            &action.kind,
            PairwiseActionKind::Unsubscribe {
                subscription_id: pending,
            } if pending == &subscription_id
        )
    });
    if installed_authors.is_empty()
        && (has_pending_subscribe || (authors.is_empty() && has_pending_unsubscribe))
    {
        return Ok(authors);
    }
    if !force && authors == installed_authors {
        return Ok(authors);
    }
    state.pending_actions.retain(|action| match &action.kind {
        PairwiseActionKind::Subscribe {
            subscription_id: pending,
            ..
        }
        | PairwiseActionKind::Unsubscribe {
            subscription_id: pending,
        } => pending != &subscription_id,
        _ => true,
    });
    if authors.is_empty() && !installed_authors.is_empty() {
        push_action(
            state,
            PairwiseActionKind::Unsubscribe {
                subscription_id: subscription_id.clone(),
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
                subscription_id,
                filter_json: serde_json::to_string(&filter)?,
            },
        );
    }
    Ok(authors)
}

fn handshake_id(invite: &Invite, invitee: PublicKey) -> String {
    let mut hash = Sha256::new();
    hash.update(invite.inviter_device_pubkey.to_bytes());
    hash.update(invite.inviter_ephemeral_public_key.to_bytes());
    hash.update(invite.shared_secret);
    hash.update(invite.created_at.get().to_be_bytes());
    hash.update(invitee.to_bytes());
    hex::encode(hash.finalize())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests;
