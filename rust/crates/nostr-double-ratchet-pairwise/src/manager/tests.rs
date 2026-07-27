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
    let authors = refresh_subscription_actions(&mut state, &[], true, &RuntimeLimits::default())
        .expect("refresh");
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
    let invite: Event = serde_json::from_str(&alice.current_invite_event_json().unwrap()).unwrap();
    bob.accept_invite_from_event(&invite, alice_keys.public_key(), 2_000_000_000)
        .unwrap();
    let response = bob
        .state
        .pending_actions
        .iter()
        .find_map(|action| match &action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some(event_json.clone()),
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
            2_000_000_001,
        )
        .unwrap();
    alice
        .process_event_at(&serde_json::from_str(&bootstrap).unwrap(), 2_000_000_002)
        .unwrap();
}

fn encrypt_unchecked(
    sender: &mut PairwiseManager,
    peer: PublicKey,
    mut inner: UnsignedEvent,
    now: u64,
    recipient: Option<DevicePubkey>,
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
    let mut envelope = plan.envelope;
    envelope.recipient = recipient;
    let event = message_event(&envelope).unwrap();
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
        EncodeOptions::new(2_000_000_010, 2_000_000_010_000),
    )
    .unwrap();
    let forged_outer = encrypt_unchecked(
        &mut bob,
        alice_keys.public_key(),
        forged,
        2_000_000_010,
        None,
    );
    assert!(matches!(
        alice.process_event_at(&forged_outer, 2_000_000_011),
        Err(PairwiseError::PeerMismatch { .. })
    ));
    assert!(alice
        .pending_actions()
        .expect("pending actions")
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));

    let legacy = nostr::EventBuilder::new(Kind::from(14u16), "legacy")
        .custom_created_at(nostr::Timestamp::from(2_000_000_012))
        .build(bob_keys.public_key());
    let legacy_outer = encrypt_unchecked(
        &mut bob,
        alice_keys.public_key(),
        legacy,
        2_000_000_012,
        None,
    );
    assert!(alice
        .process_event_at(&legacy_outer, 2_000_000_013)
        .is_err());

    let live = bob
        .send_text(
            alice_keys.public_key(),
            "valid after rejects",
            None,
            2_000_000_014,
            2_000_000_014_000,
        )
        .unwrap();
    let live_event = bob
        .pending_actions()
        .expect("pending actions")
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
        .process_event_at(&live_event, 2_000_000_015)
        .expect("skipped rejected message keys remain recoverable");
    assert_eq!(
        alice
            .pending_actions()
            .expect("pending actions")
            .iter()
            .filter(|action| matches!(action.kind, PairwiseActionKind::Delivery { .. }))
            .count(),
        1
    );
}

#[test]
fn receive_rejects_authenticated_outer_recipient_tag_without_advancing() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = test_manager(&alice_keys);
    let mut bob = test_manager(&bob_keys);
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let tagged_inner = pairwise_codec::message_event(
        bob_keys.public_key(),
        "recipient leak",
        EncodeOptions::new(2_000_000_020, 2_000_000_020_000),
    )
    .unwrap();
    let tagged_outer = encrypt_unchecked(
        &mut bob,
        alice_keys.public_key(),
        tagged_inner,
        2_000_000_020,
        Some(DevicePubkey::from_bytes(alice_keys.public_key().to_bytes())),
    );
    assert!(matches!(
        alice.process_event_at(&tagged_outer, 2_000_000_021),
        Err(PairwiseError::InvalidEvent(_))
    ));
    assert!(alice
        .pending_actions()
        .expect("pending")
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));

    let live = bob
        .send_text(
            alice_keys.public_key(),
            "valid after tagged reject",
            None,
            2_000_000_022,
            2_000_000_022_000,
        )
        .unwrap();
    let event = bob
        .pending_actions()
        .unwrap()
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
        .process_event_at(&event, 2_000_000_023)
        .expect("recipient-tag rejection did not advance receiver");
}

#[test]
fn fresh_later_invite_recovers_asymmetric_state_loss_and_retires_old_ciphertext() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = test_manager(&alice_keys);
    let mut bob = test_manager(&bob_keys);
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);
    let old_invite_created_at = alice.state.local_invite.created_at.get();
    let old_action_ids = bob
        .state
        .pending_actions
        .iter()
        .filter(|action| action_session_id(&action.kind).is_some())
        .map(|action| action.id.clone())
        .collect::<BTreeSet<_>>();
    let old_send = alice
        .send_text(
            bob_keys.public_key(),
            "retired ciphertext",
            None,
            2_000_000_030,
            2_000_000_030_000,
        )
        .unwrap();
    let old_event = alice
        .pending_actions()
        .unwrap()
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                let event: Event = serde_json::from_str(&event_json).ok()?;
                (event.id.to_hex() == old_send.outer_event_id).then_some(event)
            }
            _ => None,
        })
        .unwrap();

    let mut reset_alice = test_manager(&alice_keys);
    let mut next = reset_alice.state.clone();
    next.local_invite.created_at = UnixSeconds(old_invite_created_at + 1);
    reset_alice.commit_next(next, Vec::new()).unwrap();
    let fresh_invite: Event =
        serde_json::from_str(&reset_alice.current_invite_event_json().unwrap()).unwrap();
    bob.accept_invite_from_event(&fresh_invite, alice_keys.public_key(), 2_000_000_031)
        .expect("later shared handshake replaces the lost session");
    assert_eq!(bob.total_sessions(), 1);
    assert!(bob
        .state
        .pending_actions
        .iter()
        .all(|action| !old_action_ids.contains(&action.id)));
    assert!(bob.process_event_at(&old_event, 2_000_000_032).is_err());

    let response = bob
        .state
        .pending_actions
        .iter()
        .find_map(|action| match &action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some(event_json.clone()),
            _ => None,
        })
        .unwrap();
    let bootstrap = bob
        .state
        .pending_actions
        .iter()
        .find_map(|action| match &action.kind {
            PairwiseActionKind::Publish {
                event_json,
                inner_event_id: None,
                ..
            } => Some(event_json.clone()),
            _ => None,
        })
        .unwrap();
    reset_alice
        .process_out_of_band_response(
            &serde_json::from_str(&response).unwrap(),
            bob_keys.public_key(),
            2_000_000_033,
        )
        .unwrap();
    reset_alice
        .process_event_at(&serde_json::from_str(&bootstrap).unwrap(), 2_000_000_034)
        .unwrap();
    let live = reset_alice
        .send_text(
            bob_keys.public_key(),
            "recovered",
            None,
            2_000_000_035,
            2_000_000_035_000,
        )
        .unwrap();
    let live_event = reset_alice
        .pending_actions()
        .unwrap()
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                let event: Event = serde_json::from_str(&event_json).ok()?;
                (event.id.to_hex() == live.outer_event_id).then_some(event)
            }
            _ => None,
        })
        .unwrap();
    bob.process_event_at(&live_event, 2_000_000_036)
        .expect("recovered winner works bidirectionally");
}
