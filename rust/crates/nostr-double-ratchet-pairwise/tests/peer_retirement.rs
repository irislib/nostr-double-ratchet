use std::sync::Arc;

use nostr::{Event, Keys};
use nostr_double_ratchet_pairwise::{
    MemoryStore, PairwiseAction, PairwiseActionKind, PairwiseError, PairwiseManager, RuntimeLimits,
};

const NOW: u64 = 2_000_000_000;

fn runtime(keys: &Keys, store: Arc<MemoryStore>) -> PairwiseManager {
    PairwiseManager::open(store, keys.clone(), RuntimeLimits::default()).expect("runtime")
}

fn establish(
    inviter: &mut PairwiseManager,
    invitee: &mut PairwiseManager,
    inviter_keys: &Keys,
    invitee_keys: &Keys,
    offset: u64,
) {
    let invite: Event =
        serde_json::from_str(&inviter.current_invite_event_json().expect("invite event"))
            .expect("valid invite event");
    invitee
        .accept_invite_from_event(&invite, inviter_keys.public_key(), NOW + offset)
        .expect("accept invite");
    let actions = invitee.pending_actions().expect("invitee actions");
    let response = actions
        .iter()
        .find_map(|action| match &action.kind {
            PairwiseActionKind::OutOfBand { event_json, .. } => Some(event_json.clone()),
            _ => None,
        })
        .expect("invite response");
    let bootstrap = actions
        .iter()
        .find_map(|action| match &action.kind {
            PairwiseActionKind::Publish {
                event_json,
                inner_event_id: None,
                ..
            } => Some(event_json.clone()),
            _ => None,
        })
        .expect("bootstrap");
    inviter
        .process_out_of_band_response(
            &serde_json::from_str(&response).expect("response event"),
            invitee_keys.public_key(),
            NOW + offset + 1,
        )
        .expect("process response");
    inviter
        .process_event_at(
            &serde_json::from_str(&bootstrap).expect("bootstrap event"),
            NOW + offset + 2,
        )
        .expect("process bootstrap");
}

fn publish_event(actions: &[PairwiseAction], outer_event_id: &str) -> Event {
    actions
        .iter()
        .find_map(|action| match &action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                let event: Event = serde_json::from_str(event_json).ok()?;
                (event.id.to_hex() == outer_event_id).then_some(event)
            }
            _ => None,
        })
        .expect("publish event")
}

#[test]
fn retiring_one_peer_is_durable_and_prunes_only_its_sessions_and_actions() {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let carol_keys = Keys::generate();
    let alice_store = Arc::new(MemoryStore::default());
    let mut alice = runtime(&alice_keys, alice_store.clone());
    let mut bob = runtime(&bob_keys, Arc::new(MemoryStore::default()));
    let mut carol = runtime(&carol_keys, Arc::new(MemoryStore::default()));

    establish(&mut alice, &mut bob, &alice_keys, &bob_keys, 10);
    establish(&mut alice, &mut carol, &alice_keys, &carol_keys, 20);
    let bob_sender_keys = alice
        .session_info(bob_keys.public_key())
        .expect("Bob session")
        .tracked_sender_pubkeys;
    let carol_sender_keys = alice
        .session_info(carol_keys.public_key())
        .expect("Carol session")
        .tracked_sender_pubkeys;

    let outbound_to_bob = alice
        .send_text(
            bob_keys.public_key(),
            "must be pruned",
            None,
            NOW + 30,
            (NOW + 30) * 1_000,
        )
        .expect("queue outbound");
    let inbound_from_bob = bob
        .send_text(
            alice_keys.public_key(),
            "must not be delivered after retirement",
            None,
            NOW + 31,
            (NOW + 31) * 1_000,
        )
        .expect("Bob send");
    let inbound_event = publish_event(
        &bob.pending_actions().expect("Bob actions"),
        &inbound_from_bob.outer_event_id,
    );
    alice
        .process_event_at(&inbound_event, NOW + 32)
        .expect("queue Bob delivery");
    let replay_after_retirement = bob
        .send_text(
            alice_keys.public_key(),
            "retired ciphertext",
            None,
            NOW + 33,
            (NOW + 33) * 1_000,
        )
        .expect("Bob second send");
    let replay_event = publish_event(
        &bob.pending_actions().expect("Bob actions"),
        &replay_after_retirement.outer_event_id,
    );

    assert!(alice
        .retire_peer(bob_keys.public_key())
        .expect("retire Bob"));
    assert!(!alice
        .retire_peer(bob_keys.public_key())
        .expect("repeat retirement is idempotent"));
    assert_eq!(
        alice.known_peer_pubkeys(),
        vec![carol_keys.public_key().to_hex()]
    );
    assert!(alice.session_info(bob_keys.public_key()).is_none());
    assert!(alice.session_info(carol_keys.public_key()).is_some());
    assert_eq!(alice.total_sessions(), 1);

    let remaining = alice.pending_actions().expect("remaining actions");
    assert!(remaining.iter().all(|action| {
        let is_retired_publish = match &action.kind {
            PairwiseActionKind::Publish { event_json, .. } => {
                serde_json::from_str::<Event>(event_json)
                    .is_ok_and(|event| event.id.to_hex() == outbound_to_bob.outer_event_id)
            }
            _ => false,
        };
        !is_retired_publish
            && !matches!(
                &action.kind,
                PairwiseActionKind::Delivery {
                    peer_pubkey_hex,
                    ..
                } if peer_pubkey_hex == &bob_keys.public_key().to_hex()
            )
    }));
    let filters = remaining
        .iter()
        .filter_map(|action| match &action.kind {
            PairwiseActionKind::Subscribe { filter_json, .. } => Some(filter_json),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(bob_sender_keys
        .iter()
        .all(|sender| filters.iter().all(|filter| !filter.contains(sender))));
    assert!(carol_sender_keys
        .iter()
        .all(|sender| filters.iter().any(|filter| filter.contains(sender))));
    assert!(matches!(
        alice.process_event_at(&replay_event, NOW + 34),
        Err(PairwiseError::InvalidEvent(_))
    ));

    drop(alice);
    let reopened = runtime(&alice_keys, alice_store);
    assert_eq!(
        reopened.known_peer_pubkeys(),
        vec![carol_keys.public_key().to_hex()]
    );
    assert!(reopened.session_info(bob_keys.public_key()).is_none());
    assert!(reopened.session_info(carol_keys.public_key()).is_some());
}
