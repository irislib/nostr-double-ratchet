use super::*;

fn snapshot_can_send(manager: &SessionManager, owner: OwnerPubkey, device: DevicePubkey) -> bool {
    manager
        .snapshot()
        .users
        .iter()
        .find(|user| user.owner_pubkey == owner)
        .and_then(|user| {
            user.devices
                .iter()
                .find(|record| record.device_pubkey == device)
        })
        .is_some_and(|record| {
            record.authorized
                && !record.is_stale
                && (record.active_session.is_some()
                    || !record.inactive_sessions.is_empty()
                    || record.public_invite.is_some())
        })
}

fn assert_readiness(
    manager: &SessionManager,
    owner: OwnerPubkey,
    device: DevicePubkey,
    expected: bool,
) {
    assert_eq!(snapshot_can_send(manager, owner, device), expected);
    assert_eq!(manager.can_send_to_device(owner, device), expected);
    assert!(!manager.can_send_to_device(owner, key(999)));
}

#[test]
fn borrowed_readiness_matches_snapshot_for_missing_revoked_stale_and_send_paths() {
    let local = manager_device(1, 11);
    let peer = manager_device(2, 22);
    let mut manager = session_manager(&local);
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, false);
    manager.import_claimed_session_state(
        peer.owner_pubkey,
        peer.device_pubkey,
        state(100, 2),
        UnixSeconds(1),
    );
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, false);
    observe_signed_peer_app_keys(&mut manager, &peer, &[&peer], 2).unwrap();
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, true);

    // An inactive session remains a readiness path, even without an active one.
    let mut snapshot = manager.snapshot();
    let record = snapshot
        .users
        .iter_mut()
        .find(|user| user.owner_pubkey == peer.owner_pubkey)
        .unwrap()
        .devices
        .iter_mut()
        .find(|record| record.device_pubkey == peer.device_pubkey)
        .unwrap();
    record
        .inactive_sessions
        .push(record.active_session.take().unwrap());
    manager = SessionManager::from_snapshot(snapshot, local.secret_key).unwrap();
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, true);

    let mut snapshot = manager.snapshot();
    snapshot
        .users
        .iter_mut()
        .find(|user| user.owner_pubkey == peer.owner_pubkey)
        .unwrap()
        .devices
        .iter_mut()
        .find(|record| record.device_pubkey == peer.device_pubkey)
        .unwrap()
        .inactive_sessions
        .clear();
    manager = SessionManager::from_snapshot(snapshot, local.secret_key).unwrap();
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, false);
    let mut peer_manager = session_manager(&peer);
    let invite = peer_manager
        .ensure_local_invite(&mut support::context(7, 3))
        .unwrap()
        .clone();
    manager
        .observe_device_invite(peer.owner_pubkey, invite)
        .unwrap();
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, true);

    observe_signed_peer_app_keys(&mut manager, &peer, &[], 4).unwrap();
    let snapshot = manager.snapshot();
    let record = snapshot
        .users
        .iter()
        .find(|user| user.owner_pubkey == peer.owner_pubkey)
        .unwrap()
        .devices
        .iter()
        .find(|record| record.device_pubkey == peer.device_pubkey)
        .unwrap();
    assert!(!record.authorized && record.is_stale && record.public_invite.is_some());
    assert_readiness(&manager, peer.owner_pubkey, peer.device_pubkey, false);
}

#[test]
fn borrowed_readiness_allocates_nothing_with_unrelated_ratchets() {
    let local = manager_device(1, 11);
    let peer = manager_device(2, 22);
    let mut manager = session_manager(&local);
    manager.import_claimed_session_state(
        peer.owner_pubkey,
        peer.device_pubkey,
        state(100, 4),
        UnixSeconds(1),
    );
    observe_signed_peer_app_keys(&mut manager, &peer, &[&peer], 2).unwrap();
    for populated in [false, true] {
        if populated {
            populate_unrelated_query_state(&mut manager);
        }
        let before = manager.snapshot();
        let (_, allocations) = measured_allocations(|| {
            for _ in 0..100 {
                assert!(std::hint::black_box(
                    manager.can_send_to_device(peer.owner_pubkey, peer.device_pubkey)
                ));
                assert!(!std::hint::black_box(
                    manager.can_send_to_device(peer.owner_pubkey, key(999))
                ));
                assert!(!std::hint::black_box(manager.can_send_to_device(
                    OwnerPubkey::from_bytes(key(998).to_bytes()),
                    key(998)
                )));
            }
        });
        assert_eq!(allocations, 0, "populated={populated}");
        assert_eq!(manager.snapshot(), before);
    }
}
