use std::collections::BTreeSet;
use std::sync::Arc;

use nostr::{Event, Keys};
use nostr_double_ratchet::{parse_invite_event, Invite, UnixSeconds, MAX_SKIP};
use nostr_double_ratchet_pairwise::{
    MemoryStore, PairwiseAction, PairwiseActionKind, PairwiseError, PairwiseManager, PairwiseStore,
    RuntimeLimits,
};
use sha2::{Digest, Sha256};

fn runtime(keys: &Keys, store: Arc<MemoryStore>, limits: RuntimeLimits) -> PairwiseManager {
    PairwiseManager::open(store, keys.clone(), limits).expect("runtime")
}

fn pending(manager: &mut PairwiseManager) -> Vec<PairwiseAction> {
    manager.pending_actions_at(0).expect("pending actions")
}

fn invite_event(manager: &PairwiseManager) -> Event {
    serde_json::from_str(&manager.current_invite_event_json().expect("invite")).expect("event")
}

fn invite_rank(event: &Event, invitee: nostr::PublicKey) -> (u64, String) {
    let invite = parse_invite_event(event).expect("invite");
    let mut hash = Sha256::new();
    hash.update(invite.inviter_device_pubkey.to_bytes());
    hash.update(invite.inviter_ephemeral_public_key.to_bytes());
    hash.update(invite.shared_secret);
    hash.update(invite.created_at.get().to_be_bytes());
    hash.update(invitee.to_bytes());
    (invite.created_at.get(), hex::encode(hash.finalize()))
}

fn response_and_bootstrap(
    manager: &mut PairwiseManager,
) -> ((String, String, String), (String, String)) {
    let mut response = None;
    let mut bootstrap = None;
    for action in pending(manager) {
        match action.kind {
            PairwiseActionKind::OutOfBand {
                peer_pubkey_hex,
                event_json,
                ..
            } => response = Some((action.id, peer_pubkey_hex, event_json)),
            PairwiseActionKind::Publish {
                event_json,
                inner_event_id: None,
                ..
            } => bootstrap = Some((action.id, event_json)),
            _ => {}
        }
    }
    (response.expect("response"), bootstrap.expect("bootstrap"))
}

fn publish_for(manager: &mut PairwiseManager, outer_id: &str) -> Event {
    pending(manager)
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                let event: Event = serde_json::from_str(&event_json).ok()?;
                (event.id.to_hex() == outer_id).then_some(event)
            }
            _ => None,
        })
        .expect("publish")
}

fn establish(
    alice: &mut PairwiseManager,
    bob: &mut PairwiseManager,
    alice_keys: &Keys,
    bob_keys: &Keys,
) {
    bob.accept_invite_from_event(&invite_event(alice), alice_keys.public_key(), 2_000_100_000)
        .expect("accept");
    let (response, bootstrap) = response_and_bootstrap(bob);
    alice
        .process_out_of_band_response(
            &serde_json::from_str(&response.2).unwrap(),
            bob_keys.public_key(),
            2_000_100_001,
        )
        .expect("response");
    alice
        .process_event_at(&serde_json::from_str(&bootstrap.1).unwrap(), 2_000_100_002)
        .expect("bootstrap");
    assert!(pending(alice)
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));
    bob.ack_actions(&[response.0, bootstrap.0]).expect("ack");
}

#[test]
fn out_of_band_actions_keep_two_peer_identities_across_restart() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let carol_keys = Keys::generate();
    let bob_store = Arc::new(MemoryStore::default());
    let alice = runtime(
        &alice_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let carol = runtime(
        &carol_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store), RuntimeLimits::default());
    for (peer, invite) in [
        (alice_keys.public_key(), invite_event(&alice)),
        (carol_keys.public_key(), invite_event(&carol)),
    ] {
        bob.accept_invite_from_event(&invite, peer, 2_000_100_010)
            .expect("accept");
    }
    drop(bob);

    let mut bob = runtime(&bob_keys, bob_store, RuntimeLimits::default());
    let peers = pending(&mut bob)
        .into_iter()
        .filter_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand {
                peer_pubkey_hex, ..
            } => Some(peer_pubkey_hex),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        peers,
        [
            alice_keys.public_key().to_hex(),
            carol_keys.public_key().to_hex()
        ]
        .into()
    );
}

#[test]
fn one_persisted_invite_supports_two_independent_peers_across_reopen() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let carol_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let bob_store = Arc::new(MemoryStore::default());
    let carol_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(
        &alice_keys,
        Arc::clone(&alice_store),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store), RuntimeLimits::default());
    let mut carol = runtime(
        &carol_keys,
        Arc::clone(&carol_store),
        RuntimeLimits::default(),
    );
    let shared_invite = invite_event(&alice);

    bob.accept_invite_from_event(&shared_invite, alice_keys.public_key(), 2_000_100_011)
        .expect("Bob accepts Alice's persisted invite");
    carol
        .accept_invite_from_event(&shared_invite, alice_keys.public_key(), 2_000_100_011)
        .expect("Carol accepts the same persisted invite");
    let (bob_response, bob_bootstrap) = response_and_bootstrap(&mut bob);
    let (carol_response, carol_bootstrap) = response_and_bootstrap(&mut carol);
    alice
        .process_out_of_band_response(
            &serde_json::from_str(&bob_response.2).unwrap(),
            bob_keys.public_key(),
            2_000_100_012,
        )
        .expect("Alice authenticates Bob");
    alice
        .process_out_of_band_response(
            &serde_json::from_str(&carol_response.2).unwrap(),
            carol_keys.public_key(),
            2_000_100_012,
        )
        .expect("Alice authenticates Carol");
    let alice_pending = pending(&mut alice);
    drop(alice);
    drop(bob);
    drop(carol);

    let mut alice = runtime(&alice_keys, alice_store, RuntimeLimits::default());
    let mut bob = runtime(&bob_keys, bob_store, RuntimeLimits::default());
    let mut carol = runtime(&carol_keys, carol_store, RuntimeLimits::default());
    assert_eq!(alice.total_sessions(), 2);
    assert_eq!(
        alice
            .known_peer_pubkeys()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        [
            bob_keys.public_key().to_hex(),
            carol_keys.public_key().to_hex(),
        ]
        .into()
    );
    assert_eq!(pending(&mut alice), alice_pending);
    assert_eq!(
        response_and_bootstrap(&mut bob),
        (bob_response.clone(), bob_bootstrap.clone())
    );
    assert_eq!(
        response_and_bootstrap(&mut carol),
        (carol_response.clone(), carol_bootstrap.clone())
    );

    alice
        .process_event_at(
            &serde_json::from_str(&bob_bootstrap.1).unwrap(),
            2_000_100_013,
        )
        .expect("Bob bootstrap");
    alice
        .process_event_at(
            &serde_json::from_str(&carol_bootstrap.1).unwrap(),
            2_000_100_013,
        )
        .expect("Carol bootstrap");
    bob.ack_actions(&[bob_response.0, bob_bootstrap.0]).unwrap();
    carol
        .ack_actions(&[carol_response.0, carol_bootstrap.0])
        .unwrap();

    for (peer_keys, peer, text, millis) in [
        (&bob_keys, &mut bob, "to Bob", 2_000_100_014_000),
        (&carol_keys, &mut carol, "to Carol", 2_000_100_014_001),
    ] {
        let sent = alice
            .send_text(peer_keys.public_key(), text, None, 2_000_100_014, millis)
            .unwrap();
        peer.process_event_at(
            &publish_for(&mut alice, &sent.outer_event_id),
            2_000_100_015,
        )
        .expect("peer decrypts only its independent session");
        assert!(pending(peer).iter().any(|action| matches!(
            &action.kind,
            PairwiseActionKind::Delivery {
                inner_event_json,
                ..
            } if inner_event_json.contains(text)
        )));
    }
}

#[test]
fn repeated_same_millis_text_ids_remain_unique_after_restart() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let bob_store = Arc::new(MemoryStore::default());
    let alice = runtime(
        &alice_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store), RuntimeLimits::default());
    bob.accept_invite_from_event(
        &invite_event(&alice),
        alice_keys.public_key(),
        2_000_100_020,
    )
    .unwrap();
    let first = bob
        .send_text(
            alice_keys.public_key(),
            "same",
            None,
            2_000_100_021,
            2_000_100_021_000,
        )
        .unwrap();
    let second = bob
        .send_text(
            alice_keys.public_key(),
            "same",
            None,
            2_000_100_021,
            2_000_100_021_000,
        )
        .unwrap();
    drop(bob);
    let mut bob = runtime(&bob_keys, bob_store, RuntimeLimits::default());
    let third = bob
        .send_text(
            alice_keys.public_key(),
            "same",
            None,
            2_000_100_021,
            2_000_100_021_000,
        )
        .unwrap();
    assert_eq!(
        [
            first.inner_event_id,
            second.inner_event_id,
            third.inner_event_id
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
        .len(),
        3
    );
}

#[test]
fn subscription_ids_are_account_scoped_and_persisted() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let peer_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let bob_store = Arc::new(MemoryStore::default());
    let peer = runtime(
        &peer_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let invite = invite_event(&peer);
    let mut alice = runtime(
        &alice_keys,
        Arc::clone(&alice_store),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store), RuntimeLimits::default());
    alice
        .accept_invite_from_event(&invite, peer_keys.public_key(), 2_000_100_030)
        .unwrap();
    bob.accept_invite_from_event(&invite, peer_keys.public_key(), 2_000_100_030)
        .unwrap();
    let subscription_id = |manager: &mut PairwiseManager| {
        pending(manager)
            .into_iter()
            .find_map(|action| match action.kind {
                PairwiseActionKind::Subscribe {
                    subscription_id, ..
                } => Some(subscription_id),
                _ => None,
            })
            .expect("subscription")
    };
    let alice_id = subscription_id(&mut alice);
    let bob_id = subscription_id(&mut bob);
    assert_ne!(alice_id, bob_id);
    drop(alice);
    let mut alice = runtime(&alice_keys, alice_store, RuntimeLimits::default());
    assert_eq!(subscription_id(&mut alice), alice_id);
}

#[test]
fn response_replay_requires_the_original_authenticated_peer_after_restart() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let carol_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(
        &alice_keys,
        Arc::clone(&alice_store),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(
        &bob_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    bob.accept_invite_from_event(
        &invite_event(&alice),
        alice_keys.public_key(),
        2_000_100_040,
    )
    .unwrap();
    let response = response_and_bootstrap(&mut bob).0;
    let response_event: Event = serde_json::from_str(&response.2).unwrap();
    alice
        .process_out_of_band_response(&response_event, bob_keys.public_key(), 2_000_100_041)
        .unwrap();
    drop(alice);
    let mut alice = runtime(&alice_keys, alice_store, RuntimeLimits::default());
    assert!(matches!(
        alice.process_out_of_band_response(&response_event, carol_keys.public_key(), 2_000_100_042),
        Err(PairwiseError::PeerMismatch { .. })
    ));
}

#[test]
fn queued_delivery_expires_durably_before_callback_after_restart() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(
        &alice_keys,
        Arc::clone(&alice_store),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(
        &bob_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);
    let send = bob
        .send_text(
            alice_keys.public_key(),
            "short lived",
            Some(2_000_100_060),
            2_000_100_050,
            2_000_100_050_000,
        )
        .unwrap();
    alice
        .process_event_at(&publish_for(&mut bob, &send.outer_event_id), 2_000_100_051)
        .unwrap();
    assert!(alice
        .pending_actions_at(2_000_100_051)
        .unwrap()
        .iter()
        .any(|action| matches!(
            action.kind,
            PairwiseActionKind::Delivery {
                expires_at_seconds: Some(2_000_100_060),
                ..
            }
        )));
    drop(alice);

    let mut alice = runtime(
        &alice_keys,
        Arc::clone(&alice_store),
        RuntimeLimits::default(),
    );
    assert!(alice
        .pending_actions_at(2_000_100_060)
        .unwrap()
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));
    drop(alice);
    let mut alice = runtime(&alice_keys, alice_store, RuntimeLimits::default());
    assert!(pending(&mut alice)
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));
}

#[test]
fn non_message_rumor_is_delivered_with_expiration_while_bootstrap_stays_suppressed() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = runtime(
        &alice_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let mut bob = runtime(
        &bob_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let mut typing = nostr_double_ratchet_pairwise_codec::typing_event(
        bob_keys.public_key(),
        nostr_double_ratchet_pairwise_codec::EncodeOptions::new(2_000_100_061, 2_000_100_061_000)
            .with_expiration(2_000_100_070),
    )
    .unwrap();
    typing.ensure_id();
    let sent = bob
        .send_unsigned_event(alice_keys.public_key(), typing, 2_000_100_061)
        .unwrap();
    alice
        .process_event_at(&publish_for(&mut bob, &sent.outer_event_id), 2_000_100_062)
        .unwrap();
    let delivery = pending(&mut alice)
        .into_iter()
        .find(|action| matches!(action.kind, PairwiseActionKind::Delivery { .. }))
        .expect("typing delivery");
    match delivery.kind {
        PairwiseActionKind::Delivery {
            inner_event_json,
            expires_at_seconds,
            ..
        } => {
            let inner: nostr::UnsignedEvent = serde_json::from_str(&inner_event_json).unwrap();
            assert_eq!(inner.kind, nostr::Kind::from(25u16));
            assert_eq!(expires_at_seconds, Some(2_000_100_070));
        }
        _ => unreachable!(),
    }
}

#[test]
fn reusable_invite_recovers_when_accepting_peer_loses_state() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let carol_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(
        &alice_keys,
        Arc::clone(&alice_store),
        RuntimeLimits::default(),
    );
    let alice_invite = invite_event(&alice);
    let mut bob = runtime(
        &bob_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    bob.accept_invite_from_event(&alice_invite, alice_keys.public_key(), 2_000_100_068)
        .unwrap();
    let (old_response, old_bootstrap) = response_and_bootstrap(&mut bob);
    let old_response_event: Event = serde_json::from_str(&old_response.2).unwrap();
    alice
        .process_out_of_band_response(&old_response_event, bob_keys.public_key(), 2_000_100_068)
        .unwrap();
    alice
        .process_event_at(
            &serde_json::from_str(&old_bootstrap.1).unwrap(),
            2_000_100_069,
        )
        .unwrap();
    bob.ack_actions(&[old_response.0.clone(), old_bootstrap.0])
        .unwrap();
    let orphan = alice
        .send_text(
            bob_keys.public_key(),
            "old session",
            None,
            2_000_100_070,
            2_000_100_070_000,
        )
        .unwrap();

    let mut reset_bob = runtime(
        &bob_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    reset_bob
        .accept_invite_from_event(&alice_invite, alice_keys.public_key(), 2_000_100_071)
        .unwrap();
    let (response, bootstrap) = response_and_bootstrap(&mut reset_bob);
    alice
        .process_out_of_band_response(
            &serde_json::from_str(&response.2).unwrap(),
            bob_keys.public_key(),
            2_000_100_072,
        )
        .unwrap();
    drop(alice);
    let mut alice = runtime(&alice_keys, alice_store, RuntimeLimits::default());
    alice
        .process_out_of_band_response(&old_response_event, bob_keys.public_key(), 2_000_100_072)
        .expect("retired response replay remains idempotently bound after reopen");
    assert!(matches!(
        alice.process_out_of_band_response(
            &old_response_event,
            carol_keys.public_key(),
            2_000_100_072,
        ),
        Err(PairwiseError::PeerMismatch { .. })
    ));
    assert!(pending(&mut alice).iter().all(|action| !matches!(
        &action.kind,
        PairwiseActionKind::Publish {
            inner_event_id: Some(inner_id),
            ..
        } if inner_id == &orphan.inner_event_id
    )));
    alice
        .process_event_at(&serde_json::from_str(&bootstrap.1).unwrap(), 2_000_100_073)
        .unwrap();
    assert_eq!(alice.total_sessions(), 1);

    let live = alice
        .send_text(
            bob_keys.public_key(),
            "new session",
            None,
            2_000_100_074,
            2_000_100_074_000,
        )
        .unwrap();
    reset_bob
        .process_event_at(
            &publish_for(&mut alice, &live.outer_event_id),
            2_000_100_075,
        )
        .expect("new peer state decrypts");
}

#[test]
fn newer_handshake_retires_older_session_and_its_pending_actions_atomically() {
    let peer_keys = Keys::generate();
    let receiver_keys = Keys::generate();
    let first_peer = runtime(
        &peer_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let second_peer = runtime(
        &peer_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let limits = RuntimeLimits {
        max_sessions_per_peer: 1,
        ..RuntimeLimits::default()
    };
    let mut receiver = runtime(&receiver_keys, Arc::new(MemoryStore::default()), limits);
    let first_invite = invite_event(&first_peer);
    let second_invite = invite_event(&second_peer);
    let (older, newer) = if invite_rank(&first_invite, receiver_keys.public_key())
        < invite_rank(&second_invite, receiver_keys.public_key())
    {
        (first_invite, second_invite)
    } else {
        (second_invite, first_invite)
    };
    receiver
        .accept_invite_from_event(&older, peer_keys.public_key(), 2_000_100_080)
        .unwrap();
    let retired_action_ids = pending(&mut receiver)
        .into_iter()
        .filter(|action| {
            matches!(
                action.kind,
                PairwiseActionKind::Publish { .. } | PairwiseActionKind::OutOfBand { .. }
            )
        })
        .map(|action| action.id)
        .collect::<BTreeSet<_>>();
    receiver
        .accept_invite_from_event(&newer, peer_keys.public_key(), 2_000_100_081)
        .expect("newer shared handshake wins even with older actions pending");
    assert_eq!(receiver.total_sessions(), 1);
    let live_actions = pending(&mut receiver)
        .into_iter()
        .filter(|action| {
            matches!(
                action.kind,
                PairwiseActionKind::Publish { .. } | PairwiseActionKind::OutOfBand { .. }
            )
        })
        .map(|action| action.id)
        .collect::<BTreeSet<_>>();
    assert_eq!(live_actions.len(), 2);
    assert!(live_actions.is_disjoint(&retired_action_ids));
    assert!(receiver
        .accept_invite_from_event(&older, peer_keys.public_key(), 2_000_100_082)
        .is_err());
    assert_eq!(
        pending(&mut receiver)
            .into_iter()
            .filter(|action| matches!(
                action.kind,
                PairwiseActionKind::Publish { .. } | PairwiseActionKind::OutOfBand { .. }
            ))
            .map(|action| action.id)
            .collect::<BTreeSet<_>>(),
        live_actions
    );
}

#[test]
fn far_future_invite_is_rejected_before_any_state_or_action_mutation() {
    let peer_keys = Keys::generate();
    let receiver_keys = Keys::generate();
    let future_peer = runtime(
        &peer_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let mut future_invite: Invite = parse_invite_event(&invite_event(&future_peer)).unwrap();
    future_invite.created_at = UnixSeconds(2_000_100_090 + 601);
    let mut receiver = runtime(
        &receiver_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let before = pending(&mut receiver);
    assert!(matches!(
        receiver.accept_invite(&future_invite, peer_keys.public_key(), 2_000_100_090),
        Err(PairwiseError::InvalidEvent(_))
    ));
    assert_eq!(receiver.total_sessions(), 0);
    assert_eq!(pending(&mut receiver), before);
}

struct OversizedStore;

impl PairwiseStore for OversizedStore {
    fn load(&self) -> Result<Option<Vec<u8>>, PairwiseError> {
        Ok(Some(vec![0; 65]))
    }

    fn commit(&self, _generation: u64, _payload: &[u8]) -> Result<(), PairwiseError> {
        Ok(())
    }
}

#[test]
fn custom_limits_reject_unsafe_queue_and_state_sizes_before_use() {
    let keys = Keys::generate();
    let invalid = RuntimeLimits {
        max_pending_outbound: MAX_SKIP + 1,
        ..RuntimeLimits::default()
    };
    assert!(matches!(
        PairwiseManager::open(Arc::new(MemoryStore::default()), keys.clone(), invalid),
        Err(PairwiseError::InvalidLimits)
    ));
    let small_state = RuntimeLimits {
        max_persisted_state_bytes: 64,
        ..RuntimeLimits::default()
    };
    assert!(matches!(
        PairwiseManager::open(Arc::new(OversizedStore), keys, small_state),
        Err(PairwiseError::CorruptState(_))
    ));
}

#[test]
fn global_subscription_author_limit_rolls_back_second_ratchet_chain() {
    let first_peer_keys = Keys::generate();
    let second_peer_keys = Keys::generate();
    let receiver_keys = Keys::generate();
    let first_peer = runtime(
        &first_peer_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let second_peer = runtime(
        &second_peer_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    let limits = RuntimeLimits {
        max_total_tracked_sender_keys: 2,
        max_subscription_authors: 1,
        ..RuntimeLimits::default()
    };
    let mut receiver = runtime(&receiver_keys, Arc::new(MemoryStore::default()), limits);
    receiver
        .accept_invite_from_event(
            &invite_event(&first_peer),
            first_peer_keys.public_key(),
            2_000_100_110,
        )
        .unwrap();
    let first_ids = pending(&mut receiver)
        .into_iter()
        .filter(|action| {
            matches!(
                action.kind,
                PairwiseActionKind::Publish { .. } | PairwiseActionKind::OutOfBand { .. }
            )
        })
        .map(|action| action.id)
        .collect::<Vec<_>>();
    receiver.ack_actions(&first_ids).unwrap();
    assert!(matches!(
        receiver.accept_invite_from_event(
            &invite_event(&second_peer),
            second_peer_keys.public_key(),
            2_000_100_111
        ),
        Err(PairwiseError::QueueFull {
            queue: "subscription-authors"
        })
    ));
    assert_eq!(receiver.total_sessions(), 1);
    assert_eq!(
        receiver.known_peer_pubkeys(),
        vec![first_peer_keys.public_key().to_hex()]
    );
}

#[test]
fn global_skipped_key_limit_rejects_receive_without_advancing_state() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let limits = RuntimeLimits {
        max_total_skipped_message_keys: 1,
        ..RuntimeLimits::default()
    };
    let mut alice = runtime(&alice_keys, Arc::new(MemoryStore::default()), limits);
    let mut bob = runtime(
        &bob_keys,
        Arc::new(MemoryStore::default()),
        RuntimeLimits::default(),
    );
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);
    let sends = (0..3)
        .map(|index| {
            bob.send_text(
                alice_keys.public_key(),
                &format!("message {index}"),
                None,
                2_000_100_120,
                2_000_100_120_000 + index,
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let events = sends
        .iter()
        .map(|send| publish_for(&mut bob, &send.outer_event_id))
        .collect::<Vec<_>>();
    assert!(matches!(
        alice.process_event_at(&events[2], 2_000_100_121),
        Err(PairwiseError::CorruptState(_))
    ));
    alice
        .process_event_at(&events[0], 2_000_100_122)
        .expect("failed receive did not advance");
}
