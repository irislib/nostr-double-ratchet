mod support;

use base64::Engine;
use nostr::nips::nip44;
use nostr_double_ratchet::{DomainError, Error, Result, Session, UnixSeconds, MAX_SKIP};
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
fn far_ahead_receive_avoids_per_key_allocations_and_preserves_retry_state() -> Result<()> {
    let (_alice, _bob, mut sender, mut receiver) =
        support::direct_session_pair(61, 62, 1_700_500_000)?;
    let payload = b"direct receive allocation proof";
    let mut selected = Vec::new();
    for number in 0..=MAX_SKIP + 1 {
        let plan = sender.plan_send(payload, UnixSeconds(1_700_500_001))?;
        let envelope = sender.apply_send(plan).envelope;
        if number == 0 || number == MAX_SKIP || number == MAX_SKIP + 1 {
            selected.push(envelope);
        }
    }
    let first = &selected[0];
    let valid = &selected[1];
    let initially_too_far = &selected[2];
    let before = receiver.state.clone();
    let mut early_ctx = support::context(700, 1_700_500_002);
    assert!(matches!(
        receiver.plan_receive(&mut early_ctx, initially_too_far),
        Err(Error::Domain(DomainError::TooManySkippedMessages))
    ));
    assert_eq!(receiver.state, before);

    let mut damaged = valid.clone();
    let mut ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&damaged.ciphertext)
        .unwrap();
    assert_eq!(ciphertext[0], nip44::Version::V2.as_u8());
    *ciphertext.last_mut().unwrap() ^= 1;
    damaged.ciphertext = base64::engine::general_purpose::STANDARD.encode(ciphertext);
    let mut receive_ctx = support::context(701, 1_700_500_003);
    ALLOCATIONS.with(|count| count.set(Some(0)));
    let result = receiver.plan_receive(&mut receive_ctx, &damaged);
    let allocations = ALLOCATIONS.with(|count| count.replace(None).unwrap());
    assert!(matches!(
        result,
        Err(Error::Nip44(nip44::Error::V2(
            nip44::v2::ErrorV2::InvalidHmac
        )))
    ));
    assert_eq!(
        receiver.state, before,
        "failed authentication advanced state"
    );
    damaged.ciphertext = valid.ciphertext.clone();
    assert_eq!(&damaged, valid, "only the payload MAC may be damaged");

    // A failed receive must not poison either an immediate retry or a restored
    // session. The valid packet proves all skipped keys were really derived.
    receiver = Session::from_state(serde_json::from_str(&serde_json::to_string(&before)?)?);
    let mut valid_ctx = support::context(702, 1_700_500_004);
    let plan = receiver.plan_receive(&mut valid_ctx, valid)?;
    assert_eq!(receiver.state, before, "planning must remain non-mutating");
    assert_eq!(receiver.apply_receive(plan).payload, payload);
    assert_eq!(
        receiver.state.receiving_chain_message_number,
        MAX_SKIP as u32 + 1
    );
    assert_eq!(
        receiver
            .state
            .skipped_keys
            .values()
            .map(|entry| entry.message_keys.len())
            .sum::<usize>(),
        MAX_SKIP
    );

    // Reuse the exact formerly rejected packet after durable ratchet progress.
    receiver = Session::from_state(serde_json::from_str(&serde_json::to_string(
        &receiver.state,
    )?)?);
    let mut future_ctx = support::context(703, 1_700_500_005);
    let plan = receiver.plan_receive(&mut future_ctx, initially_too_far)?;
    assert_eq!(receiver.apply_receive(plan).payload, payload);
    let mut skipped_ctx = support::context(704, 1_700_500_006);
    let plan = receiver.plan_receive(&mut skipped_ctx, first)?;
    assert_eq!(receiver.apply_receive(plan).payload, payload);
    assert_eq!(
        receiver
            .state
            .skipped_keys
            .values()
            .map(|entry| entry.message_keys.len())
            .sum::<usize>(),
        MAX_SKIP - 1
    );

    // 1,000 skipped keys need BTreeMap nodes plus ordinary header/NIP44 work.
    // This leaves room for those allocations, but not one Vec per KDF step.
    const MAX_ALLOCATIONS: usize = 500;
    eprintln!("direct_receive_allocations skipped_keys={MAX_SKIP} allocations={allocations} maximum={MAX_ALLOCATIONS} invalid_hmac=true state_unchanged=true restored_retry=true skipped_recovery=true");
    assert!(allocations > 0, "allocation counter must observe real work");
    assert!(
        allocations <= MAX_ALLOCATIONS,
        "direct receive allocated {allocations} times while deriving skipped keys"
    );
    Ok(())
}
