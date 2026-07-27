use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use nostr::{Event, Keys, Kind};
use nostr_double_ratchet::{parse_invite_event, MESSAGE_EVENT_KIND};
use nostr_double_ratchet_pairwise::{
    MemoryStore, PairwiseActionKind, PairwiseError, PairwiseManager, PairwiseStore, RuntimeLimits,
};
use sha2::{Digest, Sha256};

fn runtime(keys: &Keys, store: Arc<MemoryStore>) -> PairwiseManager {
    PairwiseManager::open(store, keys.clone(), RuntimeLimits::default()).expect("runtime")
}

fn event_for_outer_id(manager: &mut PairwiseManager, outer_id: &str) -> (String, Event) {
    manager
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                let event = serde_json::from_str::<Event>(&event_json).ok()?;
                (event.id.to_hex() == outer_id).then_some((action.id, event))
            }
            _ => None,
        })
        .expect("pending publish")
}

fn delivery_ids(manager: &mut PairwiseManager) -> Vec<String> {
    manager
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .filter_map(|action| {
            matches!(action.kind, PairwiseActionKind::Delivery { .. }).then_some(action.id)
        })
        .collect()
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

fn establish_one_way(
    alice: &mut PairwiseManager,
    bob: &mut PairwiseManager,
    alice_keys: &Keys,
    bob_keys: &Keys,
) {
    let alice_invite_json = alice.current_invite_event_json().expect("Alice invite");
    let invite_event: Event = serde_json::from_str(&alice_invite_json).expect("invite JSON");
    bob.accept_invite_from_event(&invite_event, alice_keys.public_key(), 2_000_000_000)
        .expect("Bob accepts");

    let response = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .expect("durable response");
    let bootstrap = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .expect("durable expired-typing bootstrap");
    let response_event: Event = serde_json::from_str(&response.1).expect("response JSON");
    assert_eq!(response_event.kind, Kind::from(1059u16));
    alice
        .process_out_of_band_response(&response_event, bob_keys.public_key(), 2_000_000_001)
        .expect("Alice processes response");
    assert!(
        !alice
            .session_info(bob_keys.public_key())
            .expect("Alice responder session")
            .send_ready
    );

    let bootstrap_event: Event = serde_json::from_str(&bootstrap.1).expect("bootstrap JSON");
    alice
        .process_event_at(&bootstrap_event, 2_000_000_002)
        .expect("Alice processes bootstrap");
    assert!(
        alice
            .session_info(bob_keys.public_key())
            .expect("Alice bootstrapped session")
            .send_ready
    );
    assert!(alice
        .pending_actions()
        .expect("pending actions")
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));
    bob.ack_actions(&[response.0, bootstrap.0])
        .expect("ack handshake actions");
}

#[test]
fn handshake_send_receive_and_restart_without_app_keys() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let bob_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(&alice_keys, Arc::clone(&alice_store));
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store));

    establish_one_way(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let reverse = alice
        .send_text(
            bob_keys.public_key(),
            "reverse-ready",
            None,
            2_000_000_003,
            2_000_000_003_000,
        )
        .expect("responder sends immediately after bootstrap");
    let reverse_action = alice
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find(|action| match &action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                serde_json::from_str::<Event>(event_json)
                    .is_ok_and(|event| event.id.to_hex() == reverse.outer_event_id)
            }
            _ => false,
        })
        .expect("one reverse publish");
    let reverse_event = match &reverse_action.kind {
        PairwiseActionKind::Publish { event_json, .. } => {
            serde_json::from_str::<Event>(event_json).expect("reverse event")
        }
        _ => unreachable!(),
    };
    bob.process_event_at(&reverse_event, 2_000_000_004)
        .expect("Bob decrypts reverse message");
    alice
        .ack_actions(&[reverse_action.id])
        .expect("ack reverse publish");
    let reverse_delivery_ids = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .filter_map(|action| {
            matches!(action.kind, PairwiseActionKind::Delivery { .. }).then_some(action.id)
        })
        .collect::<Vec<_>>();
    assert_eq!(reverse_delivery_ids.len(), 1);
    bob.ack_actions(&reverse_delivery_ids)
        .expect("ack reverse delivery");

    let sent = bob
        .send_text(
            alice_keys.public_key(),
            "bitchat1:hello",
            None,
            2_000_000_005,
            2_000_000_005_000,
        )
        .expect("send");
    assert_eq!(sent.outer_event_id.len(), 64);

    let pending = bob.pending_actions().expect("pending actions");
    let publishes = pending
        .iter()
        .filter_map(|action| match &action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some(event_json),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(publishes.len(), 1);
    let outer: Event = serde_json::from_str(publishes[0]).expect("outer JSON");
    assert_eq!(outer.kind, Kind::from(MESSAGE_EVENT_KIND as u16));
    assert!(outer
        .tags
        .iter()
        .all(|tag| tag.as_slice().first().map(String::as_str) != Some("p")));

    drop(bob);
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store));
    let replayed = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find(|action| matches!(action.kind, PairwiseActionKind::Publish { .. }))
        .expect("unacked publish survives restart");
    let replayed_json = match &replayed.kind {
        PairwiseActionKind::Publish { event_json, .. } => event_json,
        _ => unreachable!(),
    };
    assert_eq!(replayed_json, publishes[0]);

    alice.process_event(&outer).expect("decrypt");
    let delivery = alice
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find(|action| matches!(action.kind, PairwiseActionKind::Delivery { .. }))
        .expect("durable delivery");
    match &delivery.kind {
        PairwiseActionKind::Delivery {
            peer_pubkey_hex,
            inner_event_json,
            ..
        } => {
            assert_eq!(peer_pubkey_hex, &bob_keys.public_key().to_hex());
            let inner: nostr::UnsignedEvent =
                serde_json::from_str(inner_event_json).expect("inner rumor");
            assert_eq!(inner.pubkey, bob_keys.public_key());
            assert_eq!(inner.content, "bitchat1:hello");
        }
        _ => unreachable!(),
    }

    drop(alice);
    let mut alice = runtime(&alice_keys, Arc::clone(&alice_store));
    assert!(alice
        .pending_actions()
        .expect("pending actions")
        .iter()
        .any(|action| action.id == delivery.id));
    alice
        .ack_actions(std::slice::from_ref(&delivery.id))
        .expect("ack delivery");
    drop(alice);
    let mut alice = runtime(&alice_keys, alice_store);
    assert!(!alice
        .pending_actions()
        .expect("pending actions")
        .iter()
        .any(|action| action.id == delivery.id));

    bob.ack_actions(&[replayed.id]).expect("ack publish");
    drop(bob);
    let mut bob = runtime(&bob_keys, bob_store);
    assert!(!bob
        .pending_actions()
        .expect("pending actions")
        .iter()
        .any(|action| matches!(action.kind, PairwiseActionKind::Publish { .. })));
}

#[test]
fn owner_claims_must_equal_the_device_identity() {
    let local_keys = Keys::generate();
    let peer_device = Keys::generate();
    let false_owner = Keys::generate();
    let mut runtime = runtime(&local_keys, Arc::new(MemoryStore::default()));

    let mut invite = nostr_double_ratchet::Invite::create_new(
        peer_device.public_key(),
        Some("peer".to_string()),
        None,
    )
    .expect("invite");
    invite.owner_public_key = Some(false_owner.public_key());
    invite.inviter_owner_pubkey = Some(nostr_double_ratchet::OwnerPubkey::from_bytes(
        false_owner.public_key().to_bytes(),
    ));
    let unsigned = nostr_double_ratchet::invite_unsigned_event(&invite).expect("unsigned invite");
    let signed = unsigned
        .sign_with_keys(&peer_device)
        .expect("signed invite");
    let parsed = parse_invite_event(&signed).expect("parse");

    let error = runtime
        .accept_invite(&parsed, peer_device.public_key(), 2_000_000_000)
        .expect_err("owner/device mismatch must fail");
    assert!(error.to_string().contains("owner"));
    assert!(runtime.known_peer_pubkeys().is_empty());
    assert!(runtime
        .pending_actions()
        .expect("pending actions")
        .iter()
        .all(|action| {
            !matches!(
                action.kind,
                PairwiseActionKind::OutOfBand { .. } | PairwiseActionKind::Publish { .. }
            )
        }));
}

#[test]
fn unsupported_protocol_kinds_are_rejected_without_state_change() {
    let keys = Keys::generate();
    let mut runtime = runtime(&keys, Arc::new(MemoryStore::default()));
    let event = nostr::EventBuilder::new(Kind::from(37368u16), "not accepted")
        .sign_with_keys(&keys)
        .expect("event");
    let before = runtime.pending_actions().expect("pending actions");
    assert!(runtime.process_event(&event).is_err());
    assert_eq!(runtime.pending_actions().expect("pending actions"), before);
}

#[test]
fn out_of_order_messages_and_skipped_keys_survive_restart() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(&alice_keys, Arc::clone(&alice_store));
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    establish_one_way(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let sends = ["one", "two", "three"]
        .into_iter()
        .enumerate()
        .map(|(index, body)| {
            bob.send_text(
                alice_keys.public_key(),
                body,
                None,
                2_000_000_010 + index as u64,
                2_000_000_010_000 + index as u64,
            )
            .expect("send")
        })
        .collect::<Vec<_>>();
    let events = sends
        .iter()
        .map(|send| event_for_outer_id(&mut bob, &send.outer_event_id).1)
        .collect::<Vec<_>>();

    alice
        .process_event_at(&events[2], 2_000_000_020)
        .expect("receive third first");
    drop(alice);
    let mut alice = runtime(&alice_keys, Arc::clone(&alice_store));
    alice
        .process_event_at(&events[0], 2_000_000_021)
        .expect("receive first from skipped key");
    alice
        .process_event_at(&events[1], 2_000_000_022)
        .expect("receive second from skipped key");

    let bodies = alice
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .filter_map(|action| match action.kind {
            PairwiseActionKind::Delivery {
                inner_event_json, ..
            } => serde_json::from_str::<nostr::UnsignedEvent>(&inner_event_json)
                .ok()
                .map(|event| event.content),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(bodies, vec!["three", "one", "two"]);
}

#[test]
fn outer_and_inner_replays_do_not_duplicate_delivery_across_restart() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(&alice_keys, Arc::clone(&alice_store));
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    establish_one_way(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let mut inner = nostr_double_ratchet_pairwise_codec::message_event(
        bob_keys.public_key(),
        "same rumor",
        nostr_double_ratchet_pairwise_codec::EncodeOptions::new(2_000_000_030, 2_000_000_030_000),
    )
    .expect("inner");
    inner.ensure_id();
    let first = bob
        .send_unsigned_event(alice_keys.public_key(), inner.clone(), 2_000_000_030)
        .expect("first encryption");
    let second = bob
        .send_unsigned_event(alice_keys.public_key(), inner, 2_000_000_031)
        .expect("second encryption");
    let first_event = event_for_outer_id(&mut bob, &first.outer_event_id).1;
    let second_event = event_for_outer_id(&mut bob, &second.outer_event_id).1;

    alice.process_event(&first_event).expect("first receive");
    alice.process_event(&first_event).expect("outer replay");
    assert_eq!(delivery_ids(&mut alice).len(), 1);
    drop(alice);
    let mut alice = runtime(&alice_keys, Arc::clone(&alice_store));
    alice
        .process_event(&second_event)
        .expect("same inner id, fresh outer");
    assert_eq!(delivery_ids(&mut alice).len(), 1);
    let first_delivery = delivery_ids(&mut alice);
    alice.ack_actions(&first_delivery).expect("ack delivery");
    alice
        .process_event(&second_event)
        .expect("outer replay after delivery ack");
    assert!(delivery_ids(&mut alice).is_empty());
}

#[test]
fn expired_message_advances_ratchet_without_delivery() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = runtime(&alice_keys, Arc::new(MemoryStore::default()));
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    establish_one_way(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let expired = bob
        .send_text(
            alice_keys.public_key(),
            "expired",
            Some(1),
            2_000_000_040,
            2_000_000_040_000,
        )
        .expect("expired send");
    alice
        .process_event_at(
            &event_for_outer_id(&mut bob, &expired.outer_event_id).1,
            2_000_000_050,
        )
        .expect("expired receive");
    assert!(delivery_ids(&mut alice).is_empty());

    let live = bob
        .send_text(
            alice_keys.public_key(),
            "live",
            None,
            2_000_000_041,
            2_000_000_041_000,
        )
        .expect("live send");
    alice
        .process_event_at(
            &event_for_outer_id(&mut bob, &live.outer_event_id).1,
            2_000_000_051,
        )
        .expect("live receive after expired");
    assert_eq!(delivery_ids(&mut alice).len(), 1);
}

#[test]
fn delivery_capacity_failure_does_not_advance_receive_state() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let limits = RuntimeLimits {
        max_pending_deliveries: 1,
        ..RuntimeLimits::default()
    };
    let mut alice =
        PairwiseManager::open(alice_store, alice_keys.clone(), limits).expect("Alice runtime");
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    establish_one_way(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let first = bob
        .send_text(
            alice_keys.public_key(),
            "one",
            None,
            2_000_000_060,
            2_000_000_060_000,
        )
        .expect("first");
    let second = bob
        .send_text(
            alice_keys.public_key(),
            "two",
            None,
            2_000_000_061,
            2_000_000_061_000,
        )
        .expect("second");
    let first_event = event_for_outer_id(&mut bob, &first.outer_event_id).1;
    let second_event = event_for_outer_id(&mut bob, &second.outer_event_id).1;
    alice.process_event(&first_event).expect("first receive");
    assert!(matches!(
        alice.process_event(&second_event),
        Err(PairwiseError::QueueFull { queue: "delivery" })
    ));
    let first_delivery = delivery_ids(&mut alice);
    alice.ack_actions(&first_delivery).expect("clear capacity");
    alice
        .process_event(&second_event)
        .expect("retry succeeds from unchanged state");
    assert_eq!(delivery_ids(&mut alice).len(), 1);
}

struct FaultStore {
    inner: MemoryStore,
    fail_commit: AtomicBool,
}

impl FaultStore {
    fn new() -> Self {
        Self {
            inner: MemoryStore::default(),
            fail_commit: AtomicBool::new(false),
        }
    }

    fn set_failure(&self, fail: bool) {
        self.fail_commit.store(fail, Ordering::SeqCst);
    }
}

impl PairwiseStore for FaultStore {
    fn load(&self) -> Result<Option<Vec<u8>>, PairwiseError> {
        self.inner.load()
    }

    fn commit(&self, generation: u64, payload: &[u8]) -> Result<(), PairwiseError> {
        if self.fail_commit.load(Ordering::SeqCst) {
            return Err(PairwiseError::Storage(
                "injected commit failure".to_string(),
            ));
        }
        self.inner.commit(generation, payload)
    }
}

#[test]
fn commit_failures_roll_back_handshake_send_receive_and_ack() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let alice_store = Arc::new(FaultStore::new());
    let bob_store = Arc::new(FaultStore::new());
    let mut alice = PairwiseManager::open(
        Arc::clone(&alice_store) as Arc<dyn PairwiseStore>,
        alice_keys.clone(),
        RuntimeLimits::default(),
    )
    .expect("Alice runtime");
    let mut bob = PairwiseManager::open(
        Arc::clone(&bob_store) as Arc<dyn PairwiseStore>,
        bob_keys.clone(),
        RuntimeLimits::default(),
    )
    .expect("Bob runtime");
    let alice_invite: Event =
        serde_json::from_str(&alice.current_invite_event_json().unwrap()).unwrap();

    bob_store.set_failure(true);
    assert!(bob
        .accept_invite_from_event(&alice_invite, alice_keys.public_key(), 2_000_000_070)
        .is_err());
    assert_eq!(bob.total_sessions(), 0);
    assert!(bob.pending_actions().expect("pending actions").is_empty());
    bob_store.set_failure(false);
    bob.accept_invite_from_event(&alice_invite, alice_keys.public_key(), 2_000_000_070)
        .expect("handshake retry");
    let response = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    let bootstrap = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    alice
        .process_out_of_band_response(
            &serde_json::from_str(&response.1).unwrap(),
            bob_keys.public_key(),
            2_000_000_071,
        )
        .unwrap();
    alice
        .process_event_at(&serde_json::from_str(&bootstrap.1).unwrap(), 2_000_000_072)
        .unwrap();
    bob.ack_actions(&[response.0, bootstrap.0]).unwrap();

    bob_store.set_failure(true);
    assert!(bob
        .send_text(
            alice_keys.public_key(),
            "rollback",
            None,
            2_000_000_073,
            2_000_000_073_000,
        )
        .is_err());
    assert!(bob
        .pending_actions()
        .expect("pending actions")
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Publish { .. })));
    bob_store.set_failure(false);
    let send = bob
        .send_text(
            alice_keys.public_key(),
            "rollback",
            None,
            2_000_000_073,
            2_000_000_073_000,
        )
        .expect("send retry");
    let event = event_for_outer_id(&mut bob, &send.outer_event_id).1;

    alice_store.set_failure(true);
    assert!(alice.process_event(&event).is_err());
    assert!(delivery_ids(&mut alice).is_empty());
    alice_store.set_failure(false);
    alice.process_event(&event).expect("receive retry");
    let deliveries = delivery_ids(&mut alice);
    alice_store.set_failure(true);
    assert!(alice.ack_actions(&deliveries).is_err());
    assert_eq!(delivery_ids(&mut alice), deliveries);
    alice_store.set_failure(false);
    alice.ack_actions(&deliveries).expect("ack retry");
    assert!(delivery_ids(&mut alice).is_empty());
}

#[test]
fn repeated_invite_replays_exact_response_and_bootstrap_without_duplicate_session() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let bob_store = Arc::new(MemoryStore::default());
    let alice = runtime(&alice_keys, Arc::new(MemoryStore::default()));
    let mut bob = runtime(&bob_keys, Arc::clone(&bob_store));
    let invite: Event = serde_json::from_str(&alice.current_invite_event_json().unwrap()).unwrap();
    let first = bob
        .accept_invite_from_event(&invite, alice_keys.public_key(), 2_000_000_080)
        .expect("first accept");
    assert!(first.created_new_session);
    let response = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    let bootstrap = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    bob.ack_actions(&[response.0.clone(), bootstrap.0.clone()])
        .expect("handshake handed off");
    drop(bob);

    let mut bob = runtime(&bob_keys, bob_store);
    let repeated = bob
        .accept_invite_from_event(&invite, alice_keys.public_key(), 2_000_000_081)
        .expect("repeat accept");
    assert!(!repeated.created_new_session);
    assert_eq!(bob.total_sessions(), 1);
    let replayed_response = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some(event_json),
            _ => None,
        })
        .expect("response requeued");
    let replayed_bootstrap = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some(event_json),
            _ => None,
        })
        .expect("bootstrap requeued");
    assert_eq!(replayed_response, response.1);
    assert_eq!(replayed_bootstrap, bootstrap.1);
}

#[test]
fn simultaneous_invites_converge_and_each_send_has_one_ciphertext() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = runtime(&alice_keys, Arc::new(MemoryStore::default()));
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    let alice_invite: Event =
        serde_json::from_str(&alice.current_invite_event_json().unwrap()).unwrap();
    let bob_invite: Event =
        serde_json::from_str(&bob.current_invite_event_json().unwrap()).unwrap();

    alice
        .accept_invite_from_event(&bob_invite, bob_keys.public_key(), 2_000_000_090)
        .expect("Alice accepts Bob");
    bob.accept_invite_from_event(&alice_invite, alice_keys.public_key(), 2_000_000_090)
        .expect("Bob accepts Alice");

    let alice_response = alice
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    let alice_bootstrap = alice
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    let bob_response = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    let bob_bootstrap = bob
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();

    if invite_rank(&alice_invite, bob_keys.public_key())
        > invite_rank(&bob_invite, alice_keys.public_key())
    {
        assert!(bob
            .process_out_of_band_response(
                &serde_json::from_str(&alice_response.1).unwrap(),
                alice_keys.public_key(),
                2_000_000_091,
            )
            .is_err());
        alice
            .process_out_of_band_response(
                &serde_json::from_str(&bob_response.1).unwrap(),
                bob_keys.public_key(),
                2_000_000_091,
            )
            .expect("Alice installs shared winning handshake");
        alice
            .process_out_of_band_response(
                &serde_json::from_str(&bob_response.1).unwrap(),
                bob_keys.public_key(),
                2_000_000_091,
            )
            .expect("winning response replay is idempotent");
        alice
            .process_event_at(
                &serde_json::from_str(&bob_bootstrap.1).unwrap(),
                2_000_000_092,
            )
            .expect("Alice decrypts winning bootstrap");
        assert!(bob
            .process_event_at(
                &serde_json::from_str(&alice_bootstrap.1).unwrap(),
                2_000_000_092,
            )
            .is_err());
    } else {
        assert!(alice
            .process_out_of_band_response(
                &serde_json::from_str(&bob_response.1).unwrap(),
                bob_keys.public_key(),
                2_000_000_091,
            )
            .is_err());
        bob.process_out_of_band_response(
            &serde_json::from_str(&alice_response.1).unwrap(),
            alice_keys.public_key(),
            2_000_000_091,
        )
        .expect("Bob installs shared winning handshake");
        bob.process_out_of_band_response(
            &serde_json::from_str(&alice_response.1).unwrap(),
            alice_keys.public_key(),
            2_000_000_091,
        )
        .expect("winning response replay is idempotent");
        bob.process_event_at(
            &serde_json::from_str(&alice_bootstrap.1).unwrap(),
            2_000_000_092,
        )
        .expect("Bob decrypts winning bootstrap");
        assert!(alice
            .process_event_at(
                &serde_json::from_str(&bob_bootstrap.1).unwrap(),
                2_000_000_092,
            )
            .is_err());
    }
    assert_eq!(alice.total_sessions(), 1);
    assert_eq!(bob.total_sessions(), 1);
    assert!(delivery_ids(&mut alice).is_empty());
    assert!(delivery_ids(&mut bob).is_empty());
    alice
        .ack_actions(&[alice_response.0, alice_bootstrap.0])
        .unwrap();
    bob.ack_actions(&[bob_response.0, bob_bootstrap.0]).unwrap();

    let alice_send = alice
        .send_text(
            bob_keys.public_key(),
            "alice",
            None,
            2_000_000_093,
            2_000_000_093_000,
        )
        .expect("Alice send");
    let alice_publish_count = alice
        .pending_actions()
        .expect("pending actions")
        .iter()
        .filter(|action| matches!(action.kind, PairwiseActionKind::Publish { .. }))
        .count();
    assert_eq!(alice_publish_count, 1);
    bob.process_event(&event_for_outer_id(&mut alice, &alice_send.outer_event_id).1)
        .expect("Bob decrypts selected session");

    let bob_send = bob
        .send_text(
            alice_keys.public_key(),
            "bob",
            None,
            2_000_000_094,
            2_000_000_094_000,
        )
        .expect("Bob send");
    let bob_publish_count = bob
        .pending_actions()
        .expect("pending actions")
        .iter()
        .filter(|action| matches!(action.kind, PairwiseActionKind::Publish { .. }))
        .count();
    assert_eq!(bob_publish_count, 1);
    alice
        .process_event(&event_for_outer_id(&mut bob, &bob_send.outer_event_id).1)
        .expect("Alice decrypts selected session");
    assert_eq!(delivery_ids(&mut alice).len(), 1);
    assert_eq!(delivery_ids(&mut bob).len(), 1);
}

#[test]
fn full_delivery_queue_still_allows_expired_control_to_advance_ratchet() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let limits = RuntimeLimits {
        max_pending_deliveries: 1,
        ..RuntimeLimits::default()
    };
    let mut alice =
        PairwiseManager::open(Arc::new(MemoryStore::default()), alice_keys.clone(), limits)
            .expect("Alice");
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    establish_one_way(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let first = bob
        .send_text(
            alice_keys.public_key(),
            "fills queue",
            None,
            2_000_000_100,
            2_000_000_100_000,
        )
        .unwrap();
    alice
        .process_event(&event_for_outer_id(&mut bob, &first.outer_event_id).1)
        .unwrap();
    assert_eq!(delivery_ids(&mut alice).len(), 1);

    let mut typing = nostr_double_ratchet_pairwise_codec::typing_event(
        bob_keys.public_key(),
        nostr_double_ratchet_pairwise_codec::EncodeOptions::new(2_000_000_101, 2_000_000_101_000)
            .with_expiration(1),
    )
    .unwrap();
    typing.ensure_id();
    let control = bob
        .send_unsigned_event(alice_keys.public_key(), typing, 2_000_000_101)
        .unwrap();
    alice
        .process_event_at(
            &event_for_outer_id(&mut bob, &control.outer_event_id).1,
            2_000_000_102,
        )
        .expect("expired control advances despite full delivery queue");
    assert_eq!(delivery_ids(&mut alice).len(), 1);

    let next = bob
        .send_text(
            alice_keys.public_key(),
            "after control",
            None,
            2_000_000_103,
            2_000_000_103_000,
        )
        .unwrap();
    let next_event = event_for_outer_id(&mut bob, &next.outer_event_id).1;
    assert!(matches!(
        alice.process_event(&next_event),
        Err(PairwiseError::QueueFull { queue: "delivery" })
    ));
    let pending = delivery_ids(&mut alice);
    alice.ack_actions(&pending).unwrap();
    alice
        .process_event(&next_event)
        .expect("next message decrypts after capacity recovery");
    assert_eq!(delivery_ids(&mut alice).len(), 1);
}
