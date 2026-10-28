use super::*;
use nostr::Tag;
use nostr_double_ratchet::{AppKeys, DeviceEntry, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT};
use support::signed_app_keys_for;

#[test]
fn peer_app_keys_preflight_matches_admission_and_restart_without_mutation() {
    let local = manager_device(1, 11);
    let peer = manager_device(2, 22);
    let other = manager_device(2, 23);
    let mut manager = session_manager(&local);
    let current = signed_app_keys_for(&peer, &[&peer], 100);
    // Construct a retired label tag only to test equivalent authorization.
    let mut relabeled = AppKeys::new(vec![DeviceEntry::new(peer.keys.public_key(), 100)])
        .get_event_at(peer.owner_keys.public_key(), 100);
    relabeled
        .tags
        .push(Tag::parse([APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT, "test-relabel"]).unwrap());
    relabeled.id = None;
    let relabeled = relabeled.sign_with_keys(&peer.owner_keys).unwrap();
    assert_ne!(current.id, relabeled.id);
    let empty = signed_app_keys_for(&peer, &[], 102);
    let cases = [
        ("new", current.clone(), true),
        ("older", signed_app_keys_for(&peer, &[&other], 99), false),
        ("exact", current.clone(), false),
        ("equivalent relabel", relabeled, false),
        (
            "equal-time conflict",
            signed_app_keys_for(&peer, &[&other], 100),
            true,
        ),
        ("conflicted exact replay", current, false),
        ("newer", signed_app_keys_for(&peer, &[&peer], 101), true),
        ("empty", empty.clone(), true),
        ("empty replay", empty, false),
    ];
    for (label, event, expected) in cases {
        let before = manager.snapshot();
        assert_eq!(
            manager
                .peer_app_keys_event_would_change(&event, UnixSeconds(102))
                .unwrap(),
            expected,
            "{label}"
        );
        assert_eq!(
            manager.snapshot(),
            before,
            "preflight mutated state: {label}"
        );
        assert_eq!(
            manager
                .observe_peer_app_keys_event(event.clone(), UnixSeconds(102))
                .unwrap(),
            expected,
            "{label}"
        );
        if !expected {
            assert_eq!(
                manager.snapshot(),
                before,
                "unchanged admission mutated state: {label}"
            );
        }
        manager = SessionManager::from_snapshot(manager.snapshot(), local.secret_key).unwrap();
        let restored = manager.snapshot();
        assert!(
            !manager
                .peer_app_keys_event_would_change(&event, UnixSeconds(102))
                .unwrap(),
            "restart replay: {label}"
        );
        assert!(
            !manager
                .observe_peer_app_keys_event(event, UnixSeconds(102))
                .unwrap(),
            "restart admission: {label}"
        );
        assert_eq!(
            manager.snapshot(),
            restored,
            "restart replay mutated state: {label}"
        );
    }
}

#[test]
fn peer_app_keys_preflight_rejects_invalid_evidence_without_mutation() {
    let local = manager_device(1, 11);
    let peer = manager_device(2, 22);
    let attacker = manager_device(3, 33);
    let mut manager = session_manager(&local);
    let current = signed_app_keys_for(&peer, &[&peer], 100);
    manager
        .observe_peer_app_keys_event(current.clone(), UnixSeconds(100))
        .unwrap();
    let mut forged = current;
    forged.sig = signed_app_keys_for(&attacker, &[&attacker], 100).sig;
    let future = signed_app_keys_for(&peer, &[&peer], 401);
    let mut malformed = AppKeys::new(Vec::new()).get_event_at(peer.owner_keys.public_key(), 100);
    malformed
        .tags
        .push(Tag::parse(["device", &peer.keys.public_key().to_hex(), "invalid-time"]).unwrap());
    malformed.id = None;
    let malformed = malformed.sign_with_keys(&peer.owner_keys).unwrap();
    let before = manager.snapshot();
    for (label, event) in [
        ("forged signature", forged),
        ("future", future),
        ("malformed", malformed),
    ] {
        assert!(
            manager
                .peer_app_keys_event_would_change(&event, UnixSeconds(100))
                .is_err(),
            "{label}"
        );
        assert_eq!(
            manager.snapshot(),
            before,
            "rejected preflight mutated state: {label}"
        );
        assert!(
            manager
                .observe_peer_app_keys_event(event, UnixSeconds(100))
                .is_err(),
            "{label}"
        );
        assert_eq!(
            manager.snapshot(),
            before,
            "rejected admission mutated state: {label}"
        );
    }
}

#[test]
fn peer_app_keys_preflight_does_not_copy_unrelated_heads_or_ratchets() {
    let local = manager_device(1, 11);
    let peer = manager_device(2, 22);
    let other = manager_device(2, 23);
    let mut manager = session_manager(&local);
    let current = signed_app_keys_for(&peer, &[&peer], 100);
    manager
        .observe_peer_app_keys_event(current.clone(), UnixSeconds(100))
        .unwrap();
    let events = [
        current,
        signed_app_keys_for(&peer, &[&other], 99),
        signed_app_keys_for(&peer, &[&other], 100),
        signed_app_keys_for(&peer, &[], 101),
    ];
    let expected = [false, false, true, true];
    let small = events.each_ref().map(|event| {
        measured_allocations(|| {
            manager
                .peer_app_keys_event_would_change(event, UnixSeconds(101))
                .unwrap()
        })
        .1
    });
    populate_unrelated_query_state(&mut manager);
    let before = manager.snapshot();
    assert!(before.verified_peer_app_keys_events.len() >= 97);
    for _ in 0..3 {
        for ((event, small), expected) in events.iter().zip(small).zip(expected) {
            let (actual, large) = measured_allocations(|| {
                manager
                    .peer_app_keys_event_would_change(event, UnixSeconds(101))
                    .unwrap()
            });
            assert_eq!(actual, expected);
            assert!(
                large <= small + 16,
                "unrelated state copied: small={small}, large={large}"
            );
        }
    }
    assert_eq!(manager.snapshot(), before);
}
