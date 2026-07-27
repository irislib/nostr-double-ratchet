use std::sync::Arc;

use nostr::{Event, Keys};
use nostr_double_ratchet_pairwise::{
    FileStore, MemoryStore, PairwiseActionKind, PairwiseError, PairwiseManager, RuntimeLimits,
};

#[test]
fn stale_manager_cannot_recreate_a_cleaned_generation_or_replace_newer_state() {
    let directory = tempfile::tempdir().expect("tempdir");
    let local_keys = Keys::generate();
    let peer_keys = Keys::generate();
    let mut current = PairwiseManager::open(
        Arc::new(FileStore::new(directory.path()).expect("current store")),
        local_keys.clone(),
        RuntimeLimits::default(),
    )
    .expect("current manager");
    let mut stale = PairwiseManager::open(
        Arc::new(FileStore::new(directory.path()).expect("stale store")),
        local_keys.clone(),
        RuntimeLimits::default(),
    )
    .expect("stale manager");
    let peer = PairwiseManager::open(
        Arc::new(MemoryStore::default()),
        peer_keys.clone(),
        RuntimeLimits::default(),
    )
    .expect("peer manager");
    let invite: Event =
        serde_json::from_str(&peer.current_invite_event_json().expect("invite JSON"))
            .expect("invite event");

    current
        .accept_invite_from_event(&invite, peer_keys.public_key(), 2_000_000_000)
        .expect("current manager accepts");
    let action_ids = current
        .pending_actions()
        .expect("pending actions")
        .into_iter()
        .map(|action| action.id)
        .collect::<Vec<_>>();
    assert!(!action_ids.is_empty());
    current
        .ack_actions(&action_ids)
        .expect("advance to generation 3");
    assert!(current
        .pending_actions()
        .expect("pending after ack")
        .is_empty());

    assert!(matches!(
        stale.accept_invite_from_event(&invite, peer_keys.public_key(), 2_000_000_001),
        Err(PairwiseError::Storage(_))
    ));

    let mut reopened = PairwiseManager::open(
        Arc::new(FileStore::new(directory.path()).expect("reopen store")),
        local_keys,
        RuntimeLimits::default(),
    )
    .expect("reopen latest manager");
    assert_eq!(reopened.total_sessions(), 1);
    assert!(reopened
        .pending_actions()
        .expect("reopened pending")
        .iter()
        .all(|action| !matches!(
            action.kind,
            PairwiseActionKind::OutOfBand { .. } | PairwiseActionKind::Publish { .. }
        )));
}
