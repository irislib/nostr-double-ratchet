mod support;

use nostr_double_ratchet::{
    DevicePubkey, OwnerPubkey, SerializableKeyPair, SessionManager, SessionState, SkippedKeysEntry,
    UnixSeconds,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    time::Instant,
};
use support::{manager_device, observe_signed_peer_app_keys, session_manager};

struct CountingAllocator;
thread_local! { static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) }; }
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|count| count.set(count.get().map(|n| n + 1)));
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

fn key(n: u32) -> DevicePubkey {
    let mut bytes = [0; 32];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    DevicePubkey::from_bytes(bytes)
}

fn state(n: u32, skipped: usize) -> SessionState {
    SessionState {
        root_key: [0; 32],
        their_current_nostr_public_key: Some(key(n)),
        their_next_nostr_public_key: Some(key(n + 1)),
        our_previous_nostr_key: None,
        our_current_nostr_key: None,
        our_next_nostr_key: SerializableKeyPair {
            public_key: key(0),
            private_key: [1; 32],
        },
        receiving_chain_key: None,
        sending_chain_key: None,
        sending_chain_message_number: 0,
        receiving_chain_message_number: 0,
        previous_sending_chain_message_count: 0,
        skipped_keys: (0..skipped)
            .map(|i| {
                (
                    key(n + 2 + i as u32),
                    SkippedKeysEntry {
                        message_keys: (0..128).map(|j| (j, [2; 32])).collect(),
                    },
                )
            })
            .collect(),
    }
}

fn snapshot_sender(
    manager: &SessionManager,
    sender: DevicePubkey,
) -> Option<(OwnerPubkey, DevicePubkey, Option<OwnerPubkey>)> {
    for user in manager.snapshot().users {
        for device in user.devices {
            if device
                .active_session
                .iter()
                .chain(&device.inactive_sessions)
                .any(|s| {
                    s.their_current_nostr_public_key == Some(sender)
                        || s.their_next_nostr_public_key == Some(sender)
                        || s.skipped_keys.contains_key(&sender)
                })
            {
                return Some((
                    user.owner_pubkey,
                    device.device_pubkey,
                    device.claimed_owner_pubkey,
                ));
            }
        }
    }
    None
}

#[test]
fn sender_query_matches_snapshot_for_active_inactive_claimed_and_revoked_sessions() {
    let alice = manager_device(1, 11);
    let bob = manager_device(2, 22);
    let mut manager = session_manager(&alice);
    manager.import_claimed_session_state(
        bob.owner_pubkey,
        bob.device_pubkey,
        state(100, 2),
        UnixSeconds(1),
    );
    manager.import_claimed_session_state(
        bob.owner_pubkey,
        bob.device_pubkey,
        state(200, 2),
        UnixSeconds(2),
    );
    assert!(manager.roster(bob.owner_pubkey).is_none());
    for phase in 0..3 {
        if phase == 1 {
            observe_signed_peer_app_keys(&mut manager, &bob, &[&bob], 3).unwrap();
        }
        if phase == 2 {
            observe_signed_peer_app_keys(&mut manager, &bob, &[], 4).unwrap();
        }
        for sender in [
            key(100),
            key(101),
            key(102),
            key(200),
            key(201),
            key(202),
            key(999),
        ] {
            assert_eq!(
                manager.message_sender_record(sender).map(|r| (
                    r.owner_pubkey,
                    r.device_pubkey,
                    r.claimed_owner_pubkey
                )),
                snapshot_sender(&manager, sender)
            );
        }
        let snapshot = manager.snapshot();
        assert_eq!(
            manager.roster(bob.owner_pubkey),
            snapshot
                .users
                .iter()
                .find(|u| u.owner_pubkey == bob.owner_pubkey)
                .and_then(|u| u.roster.as_ref())
        );
    }
}

#[test]
fn many_session_sender_queries_do_not_allocate_or_clone_ratchet_keys() {
    let local = manager_device(3, 33);
    let mut manager = session_manager(&local);
    for i in 1..=256 {
        let device = key(i * 100);
        manager.import_session_state(
            OwnerPubkey::from_bytes(device.to_bytes()),
            device,
            state(i * 100, 8),
            UnixSeconds(1),
        );
    }
    let sender = key(25600);
    let expected = snapshot_sender(&manager, sender).unwrap();
    ALLOCATIONS.with(|count| count.set(Some(0)));
    let start = Instant::now();
    for _ in 0..100 {
        let record =
            std::hint::black_box(manager.message_sender_record(std::hint::black_box(sender)))
                .unwrap();
        assert_eq!(
            (
                record.owner_pubkey,
                record.device_pubkey,
                record.claimed_owner_pubkey
            ),
            expected
        );
    }
    let query_micros = start.elapsed().as_micros();
    let query_allocations = ALLOCATIONS.with(|count| count.replace(None).unwrap());
    ALLOCATIONS.with(|count| count.set(Some(0)));
    let start = Instant::now();
    for _ in 0..100 {
        assert_eq!(
            std::hint::black_box(snapshot_sender(&manager, sender)),
            Some(expected)
        );
    }
    let snapshot_micros = start.elapsed().as_micros();
    let snapshot_allocations = ALLOCATIONS.with(|count| count.replace(None).unwrap());
    assert_eq!(query_allocations, 0);
    assert!(snapshot_allocations > 100_000);
    println!("sessions=256 skipped_message_keys=262144 queries=100 query_us={query_micros} query_allocations={query_allocations} snapshot_us={snapshot_micros} snapshot_allocations={snapshot_allocations}");
}
