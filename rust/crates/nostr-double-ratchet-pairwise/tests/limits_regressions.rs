use std::sync::Arc;

use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use nostr_double_ratchet_pairwise::{
    MemoryStore, PairwiseActionKind, PairwiseError, PairwiseManager, RuntimeLimits,
};
use nostr_double_ratchet_pairwise_codec::{
    EXPIRATION_TAG, MS_TAG, PROTOCOL_TAG, PROTOCOL_VALUE, VERSION_TAG, VERSION_VALUE,
};

fn runtime(keys: &Keys, limits: RuntimeLimits) -> PairwiseManager {
    runtime_with_store(keys, Arc::new(MemoryStore::default()), limits)
}

fn runtime_with_store(
    keys: &Keys,
    store: Arc<MemoryStore>,
    limits: RuntimeLimits,
) -> PairwiseManager {
    PairwiseManager::open(store, keys.clone(), limits).expect("runtime")
}

fn establish(
    alice: &mut PairwiseManager,
    bob: &mut PairwiseManager,
    alice_keys: &Keys,
    bob_keys: &Keys,
) {
    let invite: Event = serde_json::from_str(&alice.current_invite_event_json().unwrap()).unwrap();
    bob.accept_invite_from_event(&invite, alice_keys.public_key(), 2_000_000_120)
        .unwrap();
    let response = bob
        .pending_actions()
        .unwrap()
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    let bootstrap = bob
        .pending_actions()
        .unwrap()
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish {
                event_json,
                inner_event_id: None,
                ..
            } => Some((action.id, event_json)),
            _ => None,
        })
        .unwrap();
    alice
        .process_out_of_band_response(
            &serde_json::from_str(&response.1).unwrap(),
            bob_keys.public_key(),
            2_000_000_121,
        )
        .unwrap();
    alice
        .process_event_at(&serde_json::from_str(&bootstrap.1).unwrap(), 2_000_000_122)
        .unwrap();
    bob.ack_actions(&[response.0, bootstrap.0]).unwrap();
}

fn publish_for(manager: &mut PairwiseManager, outer_event_id: &str) -> Event {
    manager
        .pending_actions_at(0)
        .unwrap()
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                let event: Event = serde_json::from_str(&event_json).ok()?;
                (event.id.to_hex() == outer_event_id).then_some(event)
            }
            _ => None,
        })
        .expect("publish action")
}

fn strict_event(
    keys: &Keys,
    kind: u16,
    content: &str,
    seconds: u64,
    millis: u64,
    expiration: Option<u64>,
) -> nostr::UnsignedEvent {
    let mut tags = vec![
        Tag::parse([PROTOCOL_TAG, PROTOCOL_VALUE]).unwrap(),
        Tag::parse([VERSION_TAG, VERSION_VALUE]).unwrap(),
        Tag::parse([MS_TAG, millis.to_string().as_str()]).unwrap(),
    ];
    if let Some(expiration) = expiration {
        tags.push(Tag::parse([EXPIRATION_TAG, expiration.to_string().as_str()]).unwrap());
    }
    EventBuilder::new(Kind::from(kind), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(seconds))
        .build(keys.public_key())
}

#[test]
fn action_ids_are_unique_and_account_bound() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let peer_keys = Keys::generate();
    let peer = runtime(&peer_keys, RuntimeLimits::default());
    let invite: Event = serde_json::from_str(&peer.current_invite_event_json().unwrap()).unwrap();
    let mut alice = runtime(&alice_keys, RuntimeLimits::default());
    let mut bob = runtime(&bob_keys, RuntimeLimits::default());
    alice
        .accept_invite_from_event(&invite, peer_keys.public_key(), 2_000_000_110)
        .unwrap();
    bob.accept_invite_from_event(&invite, peer_keys.public_key(), 2_000_000_110)
        .unwrap();
    let alice_ids = alice
        .pending_actions()
        .unwrap()
        .into_iter()
        .map(|action| action.id)
        .collect::<Vec<_>>();
    let bob_ids = bob
        .pending_actions()
        .unwrap()
        .into_iter()
        .map(|action| action.id)
        .collect::<Vec<_>>();
    assert!(alice_ids
        .iter()
        .all(|id| id.contains(&alice_keys.public_key().to_hex())));
    assert!(bob_ids
        .iter()
        .all(|id| id.contains(&bob_keys.public_key().to_hex())));
    assert!(alice_ids.iter().all(|alice_id| !bob_ids.contains(alice_id)));
}

#[test]
fn configured_input_peer_and_outbound_limits_fail_before_mutation() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let bob = runtime(&bob_keys, RuntimeLimits::default());
    let bob_invite: Event =
        serde_json::from_str(&bob.current_invite_event_json().unwrap()).unwrap();

    let mut alice = runtime(
        &alice_keys,
        RuntimeLimits {
            max_peers: 0,
            ..RuntimeLimits::default()
        },
    );
    assert!(matches!(
        alice.accept_invite_from_event(&bob_invite, bob_keys.public_key(), 2_000_000_120),
        Err(PairwiseError::QueueFull { queue: "peers" })
    ));
    assert_eq!(alice.total_sessions(), 0);

    let mut alice = runtime(
        &alice_keys,
        RuntimeLimits {
            max_pending_outbound: 1,
            ..RuntimeLimits::default()
        },
    );
    assert!(matches!(
        alice.accept_invite_from_event(&bob_invite, bob_keys.public_key(), 2_000_000_121),
        Err(PairwiseError::QueueFull { queue: "outbound" })
    ));
    assert_eq!(alice.total_sessions(), 0);
    assert!(alice.pending_actions().unwrap().is_empty());

    let mut alice = runtime(&alice_keys, RuntimeLimits::default());
    let mut bob = runtime(
        &bob_keys,
        RuntimeLimits {
            max_text_bytes: 4,
            ..RuntimeLimits::default()
        },
    );
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);
    assert!(matches!(
        bob.send_text(
            alice_keys.public_key(),
            "12345",
            None,
            2_000_000_123,
            2_000_000_123_000,
        ),
        Err(PairwiseError::InputTooLarge { .. })
    ));
    assert!(bob
        .pending_actions()
        .unwrap()
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Publish { .. })));
}

#[test]
fn subscription_replacement_is_atomic_and_reopens_with_subscribe() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let bob_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(&alice_keys, RuntimeLimits::default());
    let mut bob = runtime_with_store(&bob_keys, Arc::clone(&bob_store), RuntimeLimits::default());
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);

    for manager in [&mut alice, &mut bob] {
        let action_ids = manager
            .pending_actions_at(0)
            .unwrap()
            .into_iter()
            .map(|action| action.id)
            .collect::<Vec<_>>();
        manager.ack_actions(&action_ids).unwrap();
    }

    let sent = alice
        .send_text(
            bob_keys.public_key(),
            "rotate sender key",
            None,
            2_000_000_130,
            2_000_000_130_000,
        )
        .unwrap();
    bob.process_event_at(
        &publish_for(&mut alice, &sent.outer_event_id),
        2_000_000_131,
    )
    .unwrap();

    let replacement_subscribe_id = bob
        .pending_actions_at(0)
        .unwrap()
        .into_iter()
        .find_map(|action| match action.kind {
            PairwiseActionKind::Subscribe { .. } => Some(action.id),
            _ => None,
        })
        .expect("replacement subscribe");
    assert!(bob
        .pending_actions_at(0)
        .unwrap()
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Unsubscribe { .. })));
    bob.ack_actions(&[replacement_subscribe_id]).unwrap();
    drop(bob);

    let mut reopened = runtime_with_store(&bob_keys, bob_store, RuntimeLimits::default());
    assert!(
        reopened
            .pending_actions_at(0)
            .unwrap()
            .iter()
            .any(|action| matches!(action.kind, PairwiseActionKind::Subscribe { .. })),
        "reopen must restore the desired subscription before a stale unsubscribe can replay"
    );
}

#[test]
fn custom_rumor_expiration_is_enforced_and_pruned() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = runtime(&alice_keys, RuntimeLimits::default());
    let mut bob = runtime(&bob_keys, RuntimeLimits::default());
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let queued = strict_event(
        &bob_keys,
        42,
        "queued custom",
        2_000_000_140,
        2_000_000_140_000,
        Some(2_000_000_150),
    );
    let queued = bob
        .send_unsigned_event(alice_keys.public_key(), queued, 2_000_000_140)
        .unwrap();
    alice
        .process_event_at(
            &publish_for(&mut bob, &queued.outer_event_id),
            2_000_000_141,
        )
        .unwrap();
    assert!(alice
        .pending_actions_at(2_000_000_141)
        .unwrap()
        .iter()
        .any(|action| matches!(
            action.kind,
            PairwiseActionKind::Delivery {
                expires_at_seconds: Some(2_000_000_150),
                ..
            }
        )));
    assert!(alice
        .pending_actions_at(2_000_000_150)
        .unwrap()
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));

    let already_expired = strict_event(
        &bob_keys,
        43,
        "expired custom",
        2_000_000_151,
        2_000_000_151_000,
        Some(2_000_000_152),
    );
    let already_expired = bob
        .send_unsigned_event(alice_keys.public_key(), already_expired, 2_000_000_151)
        .unwrap();
    alice
        .process_event_at(
            &publish_for(&mut bob, &already_expired.outer_event_id),
            2_000_000_152,
        )
        .unwrap();
    assert!(alice
        .pending_actions_at(2_000_000_152)
        .unwrap()
        .iter()
        .all(|action| !matches!(action.kind, PairwiseActionKind::Delivery { .. })));
}

#[test]
fn generic_message_reserves_millis_before_generated_text() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let mut alice = runtime(&alice_keys, RuntimeLimits::default());
    let mut bob = runtime(&bob_keys, RuntimeLimits::default());
    establish(&mut alice, &mut bob, &alice_keys, &bob_keys);

    let generic = strict_event(
        &bob_keys,
        14,
        "same",
        2_000_000_160,
        2_000_000_160_000,
        None,
    );
    let first = bob
        .send_unsigned_event(alice_keys.public_key(), generic, 2_000_000_160)
        .unwrap();
    let second = bob
        .send_text(
            alice_keys.public_key(),
            "same",
            None,
            2_000_000_160,
            2_000_000_160_000,
        )
        .unwrap();

    assert_ne!(first.inner_event_id, second.inner_event_id);
    alice
        .process_event_at(&publish_for(&mut bob, &first.outer_event_id), 2_000_000_161)
        .unwrap();
    alice
        .process_event_at(
            &publish_for(&mut bob, &second.outer_event_id),
            2_000_000_161,
        )
        .unwrap();
    assert_eq!(
        alice
            .pending_actions_at(2_000_000_161)
            .unwrap()
            .iter()
            .filter(|action| matches!(action.kind, PairwiseActionKind::Delivery { .. }))
            .count(),
        2
    );
}
