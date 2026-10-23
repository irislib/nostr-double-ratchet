use nostr_double_ratchet::{
    DevicePubkey, GroupEventManager, GroupManagerSnapshot, GroupProtocol,
    GroupSenderKeyHandleResult, GroupSenderKeyMessage, GroupSenderKeyRecordSnapshot, GroupSnapshot,
    OwnerPubkey, SenderKeyState, UnixSeconds,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

struct CountingAllocator;
thread_local! { static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) }; }
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn record_allocation() {
    let _ = ALLOCATIONS.try_with(|count| count.set(count.get().map(|n| n + 1)));
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[test]
fn blind_search_exhaustion_has_constant_bookkeeping_allocations() {
    let local = OwnerPubkey::from_bytes([1; 32]);
    let sender = OwnerPubkey::from_bytes([2; 32]);
    let author = DevicePubkey::from_bytes([3; 32]);
    let mut groups = GroupEventManager::from_snapshot(GroupManagerSnapshot {
        local_owner_pubkey: local,
        groups: vec![GroupSnapshot {
            group_id: "allocation-test".into(),
            protocol: GroupProtocol::SenderKeyV1,
            name: "allocation test".into(),
            picture: None,
            about: None,
            created_by: sender,
            members: vec![local, sender],
            admins: vec![sender],
            revision: 1,
            created_at: UnixSeconds(1),
            updated_at: UnixSeconds(1),
        }],
        sender_keys: vec![GroupSenderKeyRecordSnapshot {
            group_id: "allocation-test".into(),
            sender_owner: sender,
            sender_device: author,
            sender_event_pubkey: author,
            sender_event_secret_key: None,
            latest_key_id: Some(1),
            states: vec![SenderKeyState::new(1, [23; 32], 0)],
            distribution_history: Vec::new(),
            distributed_to: Vec::new(),
            repair_snapshots: Vec::new(),
        }],
    })
    .unwrap();
    let before = groups.snapshot();
    let message = GroupSenderKeyMessage {
        group_id: "allocation-test".into(),
        sender_event_pubkey: author,
        key_id: 1,
        message_number: 0,
        encrypted_header: Some("hidden".into()),
        created_at: UnixSeconds(1),
        ciphertext: Vec::new(),
    };
    let mut cursor = None;
    let mut remaining = 10_002;
    ALLOCATIONS.with(|count| count.set(Some(0)));
    // A malformed payload isolates cursor/KDF bookkeeping from NIP44's own
    // per-attempt allocations. The consumed budget proves every trial ran.
    let result = groups.plan_sender_key_message_with_budget(message, &mut cursor, &mut remaining);
    let allocations = ALLOCATIONS.with(|count| count.replace(None).unwrap());
    let attempts = 10_002 - remaining;
    assert_eq!(attempts, 10_001);
    assert!(cursor.is_none());
    assert_eq!(groups.snapshot(), before);
    assert!(matches!(
        groups
            .apply_sender_key_receive_plan(result.unwrap().unwrap())
            .unwrap(),
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));
    assert_eq!(groups.snapshot(), before);
    eprintln!("blind_search_allocations attempts={attempts} allocations={allocations} maximum=16");
    assert!(
        allocations <= 16,
        "blind-search bookkeeping allocated {allocations} times"
    );
}
