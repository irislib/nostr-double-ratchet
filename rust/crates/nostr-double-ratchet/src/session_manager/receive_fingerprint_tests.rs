use super::*;
use crate::{AppKeys, DeviceEntry, SerializableKeyPair, SkippedKeysEntry};

fn key(byte: u8) -> DevicePubkey {
    DevicePubkey::from_bytes([byte; 32])
}

fn pair(byte: u8) -> SerializableKeyPair {
    SerializableKeyPair {
        public_key: key(byte),
        private_key: [byte + 1; 32],
    }
}

fn state(byte: u8) -> SessionState {
    SessionState {
        metadata_privacy_version: crate::METADATA_PRIVACY_VERSION,
        root_key: [byte; 32],
        their_current_nostr_public_key: Some(key(byte + 1)),
        their_next_nostr_public_key: Some(key(byte + 2)),
        our_previous_nostr_key: Some(pair(byte + 3)),
        our_current_nostr_key: Some(pair(byte + 5)),
        our_next_nostr_key: pair(byte + 7),
        receiving_chain_key: Some([byte + 9; 32]),
        sending_chain_key: Some([byte + 10; 32]),
        sending_chain_message_number: 11,
        receiving_chain_message_number: 12,
        previous_sending_chain_message_count: 13,
        skipped_keys: BTreeMap::from([
            (
                key(90),
                SkippedKeysEntry {
                    message_keys: BTreeMap::from([(1, [91; 32]), (2, [92; 32])]),
                },
            ),
            (
                key(93),
                SkippedKeysEntry {
                    message_keys: BTreeMap::from([(3, [94; 32])]),
                },
            ),
        ]),
    }
}

fn owner_keys() -> nostr::Keys {
    nostr::Keys::new(nostr::SecretKey::from_slice(&[2; 32]).unwrap())
}

fn signed_devices(devices: &[DevicePubkey], at: u64) -> nostr::Event {
    let keys = owner_keys();
    AppKeys::new(
        devices
            .iter()
            .map(|key| DeviceEntry::new(key.to_nostr().unwrap(), at))
            .collect(),
    )
    .get_event_at(keys.public_key(), at)
    .sign_with_keys(&keys)
    .unwrap()
}

fn fixture() -> (SessionManager, OwnerPubkey, DevicePubkey) {
    let owner = OwnerPubkey::from_bytes(owner_keys().public_key().to_bytes());
    let device = DevicePubkey::from_secret_bytes([3; 32]).unwrap();
    let mut manager = SessionManager::new(OwnerPubkey::from_bytes([1; 32]), [1; 32]);
    manager
        .observe_peer_app_keys_event(signed_devices(&[device], 1), UnixSeconds(1))
        .unwrap();
    manager.import_session_state(owner, device, state(10), UnixSeconds(2));
    manager
        .users
        .get_mut(&owner)
        .unwrap()
        .devices
        .get_mut(&device)
        .unwrap()
        .inactive_sessions = vec![
        Session::from_state(state(30)),
        Session::from_state(state(50)),
    ];
    (manager, owner, device)
}

fn record(
    manager: &mut SessionManager,
    owner: OwnerPubkey,
    device: DevicePubkey,
) -> &mut DeviceRecord {
    manager
        .users
        .get_mut(&owner)
        .unwrap()
        .devices
        .get_mut(&device)
        .unwrap()
}

#[test]
fn every_session_state_field_changes_the_receive_fingerprint() {
    let (manager, owner, device) = fixture();
    let before: crate::ReceiveInputFingerprint = manager.receive_input_fingerprint(owner);
    let mutations: &[(&str, fn(&mut SessionState))] = &[
        ("version", |s| s.metadata_privacy_version ^= 1),
        ("root", |s| s.root_key[31] ^= 1),
        ("their current absent", |s| {
            s.their_current_nostr_public_key = None
        }),
        ("their current value", |s| {
            s.their_current_nostr_public_key = Some(key(200))
        }),
        ("their next absent", |s| {
            s.their_next_nostr_public_key = None
        }),
        ("their next value", |s| {
            s.their_next_nostr_public_key = Some(key(200))
        }),
        ("our previous absent", |s| s.our_previous_nostr_key = None),
        ("our previous public", |s| {
            s.our_previous_nostr_key.as_mut().unwrap().public_key = key(200)
        }),
        ("our previous private", |s| {
            s.our_previous_nostr_key.as_mut().unwrap().private_key[31] ^= 1
        }),
        ("our current absent", |s| s.our_current_nostr_key = None),
        ("our current public", |s| {
            s.our_current_nostr_key.as_mut().unwrap().public_key = key(200)
        }),
        ("our current private", |s| {
            s.our_current_nostr_key.as_mut().unwrap().private_key[31] ^= 1
        }),
        ("our next public", |s| {
            s.our_next_nostr_key.public_key = key(200)
        }),
        ("our next private", |s| {
            s.our_next_nostr_key.private_key[31] ^= 1
        }),
        ("receiving absent", |s| s.receiving_chain_key = None),
        ("receiving value", |s| {
            s.receiving_chain_key.as_mut().unwrap()[31] ^= 1
        }),
        ("sending absent", |s| s.sending_chain_key = None),
        ("sending value", |s| {
            s.sending_chain_key.as_mut().unwrap()[31] ^= 1
        }),
        ("send counter", |s| s.sending_chain_message_number += 1),
        ("receive counter", |s| s.receiving_chain_message_number += 1),
        ("previous count", |s| {
            s.previous_sending_chain_message_count += 1
        }),
        ("skipped empty", |s| s.skipped_keys.clear()),
        ("skipped sender", |s| {
            let entry = s.skipped_keys.remove(&key(90)).unwrap();
            s.skipped_keys.insert(key(200), entry);
        }),
        ("skipped entry absent", |s| {
            s.skipped_keys.remove(&key(90));
        }),
        ("skipped empty entry", |s| {
            s.skipped_keys.insert(key(200), SkippedKeysEntry::default());
        }),
        ("skipped number", |s| {
            let entry = s.skipped_keys.get_mut(&key(90)).unwrap();
            let value = entry.message_keys.remove(&1).unwrap();
            entry.message_keys.insert(9, value);
        }),
        ("skipped value", |s| {
            s.skipped_keys
                .get_mut(&key(90))
                .unwrap()
                .message_keys
                .get_mut(&1)
                .unwrap()[31] ^= 1
        }),
        ("skipped message absent", |s| {
            s.skipped_keys
                .get_mut(&key(90))
                .unwrap()
                .message_keys
                .remove(&1);
        }),
        ("skipped message added", |s| {
            s.skipped_keys
                .get_mut(&key(90))
                .unwrap()
                .message_keys
                .insert(9, [99; 32]);
        }),
        ("skipped messages empty", |s| {
            s.skipped_keys
                .get_mut(&key(90))
                .unwrap()
                .message_keys
                .clear()
        }),
    ];
    for slot in 0..3 {
        for (name, mutate) in mutations {
            let mut changed = manager.clone();
            let record = record(&mut changed, owner, device);
            let session = if slot == 0 {
                record.active_session.as_mut().unwrap()
            } else {
                &mut record.inactive_sessions[slot - 1]
            };
            mutate(&mut session.state);
            assert!(
                changed.receive_input_fingerprint(owner) != before,
                "ignored {name} in trial slot {slot}"
            );
        }
    }
}

#[test]
fn device_authorization_and_session_trial_order_are_bound() {
    let (manager, owner, device) = fixture();
    let before = manager.receive_input_fingerprint(owner);
    let mutations: &[(&str, fn(&mut DeviceRecord))] = &[
        ("authorized", |r| r.authorized = false),
        ("stale", |r| r.is_stale = true),
        ("active absent", |r| r.active_session = None),
        ("inactive empty", |r| r.inactive_sessions.clear()),
        ("inactive order", |r| r.inactive_sessions.swap(0, 1)),
        ("active trial order", |r| {
            std::mem::swap(
                r.active_session.as_mut().unwrap(),
                &mut r.inactive_sessions[0],
            )
        }),
        ("inactive count", |r| {
            r.inactive_sessions.push(r.inactive_sessions[0].clone())
        }),
    ];
    for (name, mutate) in mutations {
        let mut changed = manager.clone();
        mutate(record(&mut changed, owner, device));
        assert!(
            changed.receive_input_fingerprint(owner) != before,
            "ignored {name}"
        );
    }
    let mut changed = manager.clone();
    let devices = &mut changed.users.get_mut(&owner).unwrap().devices;
    let entry = devices.remove(&device).unwrap();
    devices.insert(key(200), entry);
    assert!(
        changed.receive_input_fingerprint(owner) != before,
        "device map key must be bound"
    );
    changed.users.get_mut(&owner).unwrap().devices.clear();
    assert!(
        changed.receive_input_fingerprint(owner) != before,
        "device count must be bound"
    );
}

#[test]
fn effective_authorization_is_bound_even_when_record_flags_do_not_change() {
    let (manager, owner, device) = fixture();
    let before = manager.receive_input_fingerprint(owner);
    assert!(manager
        .authorized_devices_for_owner(owner)
        .contains(&device));
    let mut without_proof = manager.clone();
    without_proof.verified_peer_app_keys = VerifiedAppKeysIndex::default();
    assert!(without_proof.users[&owner].devices[&device].authorized);
    assert!(without_proof.authorized_devices_for_owner(owner).is_empty());
    assert!(without_proof.receive_input_fingerprint(owner) != before);
    let mut without_projection = manager.clone();
    without_projection.users.get_mut(&owner).unwrap().roster = None;
    assert!(without_projection.receive_input_fingerprint(owner) != before);
    let extra = DevicePubkey::from_secret_bytes([4; 32]).unwrap();
    let mut expanded = manager.clone();
    expanded
        .verified_peer_app_keys
        .ingest(signed_devices(&[device, extra], 3), 3)
        .unwrap();
    expanded
        .users
        .get_mut(&owner)
        .unwrap()
        .roster
        .as_mut()
        .unwrap()
        .devices
        .push(AuthorizedDevice::new(extra, UnixSeconds(3)));
    assert_eq!(expanded.users[&owner].devices.len(), 1);
    assert!(expanded.receive_input_fingerprint(owner) != before);
}

#[test]
fn owner_existence_and_owner_migration_change_fingerprints() {
    let (mut manager, owner, _) = fixture();
    let missing = OwnerPubkey::from_bytes([80; 32]);
    let other = OwnerPubkey::from_bytes([81; 32]);
    let absent = manager.receive_input_fingerprint(missing);
    assert!(absent != manager.receive_input_fingerprint(other));
    manager.user_record_mut(missing);
    assert!(absent != manager.receive_input_fingerprint(missing));
    let owner_before = manager.receive_input_fingerprint(owner);
    let device = DevicePubkey::from_secret_bytes([5; 32]).unwrap();
    let provisional = crate::owner_pubkey_from_device_pubkey(device);
    let provisional_before = manager.receive_input_fingerprint(provisional);
    manager.import_claimed_session_state(owner, device, state(70), UnixSeconds(4));
    let provisional_imported = manager.receive_input_fingerprint(provisional);
    assert!(provisional_before != provisional_imported);
    assert!(manager.receive_input_fingerprint(owner) == owner_before);
    manager
        .observe_peer_app_keys_event(signed_devices(&[device], 5), UnixSeconds(5))
        .unwrap();
    assert!(manager.receive_input_fingerprint(owner) != owner_before);
    assert!(manager.receive_input_fingerprint(provisional) != provisional_imported);
    assert!(manager.users[&owner].devices[&device]
        .active_session
        .is_some());
}

#[test]
fn unrelated_owners_and_bookkeeping_do_not_invalidate_receive_inputs() {
    let (mut manager, owner, device) = fixture();
    let before = manager.receive_input_fingerprint(owner);
    let unrelated = DevicePubkey::from_secret_bytes([6; 32]).unwrap();
    manager.import_session_state(
        crate::owner_pubkey_from_device_pubkey(unrelated),
        unrelated,
        state(70),
        UnixSeconds(8),
    );
    assert!(manager.receive_input_fingerprint(owner) == before);
    manager
        .observe_peer_app_keys_event(signed_devices(&[device], 9), UnixSeconds(9))
        .unwrap();
    assert!(
        manager.receive_input_fingerprint(owner) == before,
        "same effective roster must remain stable"
    );
    let record = record(&mut manager, owner, device);
    record.last_activity = Some(UnixSeconds(100));
    record.created_at = UnixSeconds(101);
    record.stale_since = Some(UnixSeconds(102));
    record.invite_response_generated = !record.invite_response_generated;
    record.claimed_owner_pubkey = Some(OwnerPubkey::from_bytes([99; 32]));
    record.active_session.as_mut().unwrap().name = "display label".into();
    assert!(manager.receive_input_fingerprint(owner) == before);
}

#[test]
fn identical_serialized_state_reloads_with_the_same_fingerprint() {
    let (manager, owner, _) = fixture();
    let before = manager.receive_input_fingerprint(owner);
    let snapshot = manager.snapshot();
    let restored = SessionManager::from_snapshot(
        serde_json::from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap(),
        [1; 32],
    )
    .unwrap();
    assert!(restored.receive_input_fingerprint(owner) == before);
    assert_eq!(
        manager.snapshot(),
        snapshot,
        "fingerprinting must not mutate manager state"
    );
}
