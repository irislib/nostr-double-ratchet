mod support;
use support::SessionManagerCompatExt;

use nostr_double_ratchet::{
    RelayGap, Result, RosterSnapshotDecision, SessionManagerSnapshot, UnixSeconds,
};
use support::{
    context, manager_device, manager_device_snapshot, manager_observe_invite_response,
    manager_public_device_invite, manager_receive_delivery, manager_user_snapshot, payload_text,
    prepared_targets, provisional_owner_pubkey, restore_manager, roster_for, session_manager,
};

fn assert_gap(prepared: &nostr_double_ratchet::PreparedSend, expected: RelayGap) {
    assert!(
        prepared.relay_gaps.contains(&expected),
        "missing relay gap {expected:?} in {:?}",
        prepared.relay_gaps
    );
}

#[test]
fn local_device_invite_is_stable_and_owned() -> Result<()> {
    let alice = manager_device(1, 11);
    let mut manager = session_manager(&alice);

    let mut first_ctx = context(1, 1_800_000_000);
    let first = manager.ensure_local_invite(&mut first_ctx)?.clone();
    let mut second_ctx = context(2, 1_800_000_001);
    let second = manager.ensure_local_invite(&mut second_ctx)?.clone();

    assert_eq!(first, second);
    assert_eq!(first.inviter_device_pubkey, alice.device_pubkey);
    assert_eq!(first.inviter_owner_pubkey, Some(alice.owner_pubkey));
    assert!(first.inviter_ephemeral_private_key.is_some());
    Ok(())
}

#[test]
fn latest_roster_controls_authorized_device_roster() -> Result<()> {
    let alice1 = manager_device(2, 21);
    let alice2 = manager_device(2, 22);
    let alice3 = manager_device(2, 23);
    let mut manager = session_manager(&alice1);

    assert_eq!(
        manager.apply_local_roster(roster_for(&[&alice1, &alice2], 10)),
        RosterSnapshotDecision::Advanced
    );
    assert_eq!(
        manager.apply_local_roster(roster_for(&[&alice1], 9)),
        RosterSnapshotDecision::Stale
    );
    assert_eq!(
        manager.apply_local_roster(roster_for(&[&alice1, &alice3], 10)),
        RosterSnapshotDecision::MergedEqualTimestamp
    );
    assert_eq!(
        manager.apply_local_roster(roster_for(&[&alice1, &alice3], 11)),
        RosterSnapshotDecision::Advanced
    );

    let snapshot = manager.snapshot();
    let local_user = manager_user_snapshot(&snapshot, alice1.owner_pubkey);
    assert_eq!(local_user.devices.len(), 3);

    let alice2_record = manager_device_snapshot(local_user, alice2.device_pubkey);
    assert!(!alice2_record.authorized);
    assert!(alice2_record.is_stale);
    assert_eq!(alice2_record.stale_since, Some(UnixSeconds(11)));

    let alice3_record = manager_device_snapshot(local_user, alice3.device_pubkey);
    assert!(alice3_record.authorized);
    assert!(!alice3_record.is_stale);
    Ok(())
}

#[test]
fn invite_is_rejected_until_roster_authorizes_device() -> Result<()> {
    let alice = manager_device(3, 31);
    let bob = manager_device(4, 41);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    let bob_invite = manager_public_device_invite(&mut bob_manager, &bob, 10, 1_800_000_100)?;
    assert!(alice_manager
        .observe_device_invite(bob_invite.clone())
        .is_err());

    let mut send_ctx = context(11, 1_800_000_101);
    let before_auth =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"hi".to_vec())?;
    assert!(before_auth.deliveries.is_empty());
    assert_gap(
        &before_auth,
        RelayGap::MissingRoster {
            owner_pubkey: bob.owner_pubkey,
        },
    );

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 12));
    alice_manager.observe_device_invite(bob_invite)?;
    let mut send_ctx = context(12, 1_800_000_102);
    let after_auth =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"usable".to_vec())?;

    assert_eq!(after_auth.deliveries.len(), 1);
    assert_eq!(after_auth.invite_responses.len(), 1);
    assert!(after_auth.relay_gaps.is_empty());
    Ok(())
}

#[test]
fn prepare_send_fans_out_to_recipient_devices_and_local_siblings() -> Result<()> {
    let alice1 = manager_device(5, 51);
    let alice2 = manager_device(5, 52);
    let bob1 = manager_device(6, 61);
    let bob2 = manager_device(6, 62);

    let mut alice_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob1_manager = session_manager(&bob1);
    let mut bob2_manager = session_manager(&bob2);

    alice_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 20));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut alice2_manager,
        &alice2,
        20,
        1_800_000_200,
    )?)?;

    alice_manager.observe_peer_roster(bob1.owner_pubkey, roster_for(&[&bob1, &bob2], 21));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob1_manager,
        &bob1,
        21,
        1_800_000_201,
    )?)?;
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob2_manager,
        &bob2,
        22,
        1_800_000_202,
    )?)?;

    let mut send_ctx = context(23, 1_800_000_203);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob1.owner_pubkey, b"fanout".to_vec())?;

    let targets: std::collections::BTreeSet<_> = prepared_targets(&prepared).into_iter().collect();
    assert_eq!(prepared.deliveries.len(), 3);
    assert_eq!(prepared.invite_responses.len(), 3);
    assert!(prepared.relay_gaps.is_empty());
    assert!(targets.contains(&(bob1.owner_pubkey, bob1.device_pubkey)));
    assert!(targets.contains(&(bob2.owner_pubkey, bob2.device_pubkey)));
    assert!(targets.contains(&(alice1.owner_pubkey, alice2.device_pubkey)));
    assert!(!targets.contains(&(alice1.owner_pubkey, alice1.device_pubkey)));
    Ok(())
}

#[test]
fn prepare_send_bootstraps_from_public_invite_and_returns_invite_response() -> Result<()> {
    let alice = manager_device(7, 71);
    let bob = manager_device(8, 81);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 30));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob_manager,
        &bob,
        30,
        1_800_000_300,
    )?)?;

    let mut send_ctx = context(31, 1_800_000_301);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"hello".to_vec())?;
    assert_eq!(prepared.deliveries.len(), 1);
    assert_eq!(prepared.invite_responses.len(), 1);

    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 29));
    let mut observe_ctx = context(32, 1_800_000_302);
    let observed = manager_observe_invite_response(
        &mut bob_manager,
        &mut observe_ctx,
        &prepared.invite_responses[0],
    )?;
    assert!(observed.is_some());

    let mut receive_ctx = context(33, 1_800_000_303);
    let received = manager_receive_delivery(
        &mut bob_manager,
        &mut receive_ctx,
        alice.owner_pubkey,
        &prepared.deliveries[0],
    )?
    .expect("expected received message");
    assert_eq!(payload_text(&received.payload), "hello");
    Ok(())
}

#[test]
fn removed_device_is_excluded_from_send_and_receive() -> Result<()> {
    let alice = manager_device(9, 91);
    let bob = manager_device(10, 101);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 40));
    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 40));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob_manager,
        &bob,
        41,
        1_800_000_401,
    )?)?;
    bob_manager.observe_device_invite(manager_public_device_invite(
        &mut alice_manager,
        &alice,
        42,
        1_800_000_402,
    )?)?;

    let mut alice_send_ctx = context(43, 1_800_000_403);
    let first =
        alice_manager.prepare_send(&mut alice_send_ctx, bob.owner_pubkey, b"a1".to_vec())?;
    let mut bob_observe_ctx = context(44, 1_800_000_404);
    manager_observe_invite_response(
        &mut bob_manager,
        &mut bob_observe_ctx,
        &first.invite_responses[0],
    )?;
    let mut bob_receive_ctx = context(45, 1_800_000_405);
    manager_receive_delivery(
        &mut bob_manager,
        &mut bob_receive_ctx,
        alice.owner_pubkey,
        &first.deliveries[0],
    )?;

    let mut bob_send_ctx = context(46, 1_800_000_406);
    let delayed =
        bob_manager.prepare_send(&mut bob_send_ctx, alice.owner_pubkey, b"late".to_vec())?;

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[], 50));
    let mut after_removal_ctx = context(47, 1_800_000_407);
    let after_removal =
        alice_manager.prepare_send(&mut after_removal_ctx, bob.owner_pubkey, b"after".to_vec())?;
    assert!(after_removal.deliveries.is_empty());

    let mut receive_ctx = context(48, 1_800_000_408);
    let received = manager_receive_delivery(
        &mut alice_manager,
        &mut receive_ctx,
        bob.owner_pubkey,
        &delayed.deliveries[0],
    )?;
    assert!(received.is_none());
    Ok(())
}

#[test]
fn snapshot_roundtrip_preserves_established_active_sessions_without_new_bootstrap() -> Result<()> {
    let alice = manager_device(11, 111);
    let bob = manager_device(12, 121);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 60));
    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 60));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob_manager,
        &bob,
        60,
        1_800_000_500,
    )?)?;
    bob_manager.observe_device_invite(manager_public_device_invite(
        &mut alice_manager,
        &alice,
        61,
        1_800_000_501,
    )?)?;

    let mut alice_send_ctx = context(62, 1_800_000_502);
    let first =
        alice_manager.prepare_send(&mut alice_send_ctx, bob.owner_pubkey, b"boot".to_vec())?;
    let mut bob_observe_ctx = context(63, 1_800_000_503);
    manager_observe_invite_response(
        &mut bob_manager,
        &mut bob_observe_ctx,
        &first.invite_responses[0],
    )?;
    let mut bob_receive_ctx = context(64, 1_800_000_504);
    manager_receive_delivery(
        &mut bob_manager,
        &mut bob_receive_ctx,
        alice.owner_pubkey,
        &first.deliveries[0],
    )?;

    let restored_alice = restore_manager(&alice_manager.snapshot(), alice.secret_key)?;
    let restored_bob = restore_manager(&bob_manager.snapshot(), bob.secret_key)?;
    let mut restored_alice = restored_alice;
    let mut restored_bob = restored_bob;

    let mut send_ctx = context(65, 1_800_000_505);
    let prepared =
        restored_alice.prepare_send(&mut send_ctx, bob.owner_pubkey, b"after-restore".to_vec())?;
    assert!(prepared.invite_responses.is_empty());

    let mut receive_ctx = context(66, 1_800_000_506);
    let received = manager_receive_delivery(
        &mut restored_bob,
        &mut receive_ctx,
        alice.owner_pubkey,
        &prepared.deliveries[0],
    )?
    .expect("expected received message");
    assert_eq!(payload_text(&received.payload), "after-restore");
    Ok(())
}

#[test]
fn peer_device_added_after_conversation_bootstraps_only_new_device() -> Result<()> {
    let alice = manager_device(13, 131);
    let bob1 = manager_device(14, 141);
    let bob2 = manager_device(14, 142);

    let mut alice_manager = session_manager(&alice);
    let mut bob1_manager = session_manager(&bob1);
    let mut bob2_manager = session_manager(&bob2);

    alice_manager.observe_peer_roster(bob1.owner_pubkey, roster_for(&[&bob1], 70));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob1_manager,
        &bob1,
        70,
        1_800_000_600,
    )?)?;

    let mut boot_ctx = context(71, 1_800_000_601);
    let first = alice_manager.prepare_send(&mut boot_ctx, bob1.owner_pubkey, b"first".to_vec())?;
    assert_eq!(first.invite_responses.len(), 1);

    alice_manager.observe_peer_roster(bob1.owner_pubkey, roster_for(&[&bob1, &bob2], 72));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob2_manager,
        &bob2,
        72,
        1_800_000_602,
    )?)?;

    let mut send_ctx = context(73, 1_800_000_603);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob1.owner_pubkey, b"second".to_vec())?;
    assert_eq!(prepared.deliveries.len(), 2);
    assert_eq!(prepared.invite_responses.len(), 1);
    Ok(())
}

#[test]
fn newer_public_invite_supersedes_older_one() -> Result<()> {
    let alice = manager_device(15, 151);
    let bob = manager_device(16, 161);
    let mut manager = session_manager(&alice);

    manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 80));

    let newer = support::custom_public_device_invite(&bob, 80, 1_800_000_700)?;
    let older = support::custom_public_device_invite(&bob, 81, 1_800_000_699)?;
    manager.observe_device_invite(newer.clone())?;
    manager.observe_device_invite(older)?;

    let snapshot = manager.snapshot();
    let bob_record = manager_device_snapshot(
        manager_user_snapshot(&snapshot, bob.owner_pubkey),
        bob.device_pubkey,
    );
    assert_eq!(
        bob_record
            .public_invite
            .as_ref()
            .map(|invite| invite.created_at),
        Some(newer.created_at)
    );
    Ok(())
}

#[test]
fn verified_roster_proof_installs_session_under_owner() -> Result<()> {
    let alice = manager_device(19, 191);
    let bob = manager_device(20, 201);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 82));
    bob_manager.observe_device_invite(manager_public_device_invite(
        &mut alice_manager,
        &alice,
        82,
        1_800_000_820,
    )?)?;

    let mut send_ctx = context(83, 1_800_000_821);
    let prepared =
        bob_manager.prepare_send(&mut send_ctx, alice.owner_pubkey, b"owner-claim".to_vec())?;

    let mut observe_ctx = context(84, 1_800_000_822);
    let observed = manager_observe_invite_response(
        &mut alice_manager,
        &mut observe_ctx,
        &prepared.invite_responses[0],
    )?
    .expect("invite response should be processed");
    assert_eq!(observed.owner_pubkey, bob.owner_pubkey);

    let snapshot = alice_manager.snapshot();
    let verified_user = manager_user_snapshot(&snapshot, bob.owner_pubkey);
    let verified_device = manager_device_snapshot(verified_user, bob.device_pubkey);
    assert!(verified_device.active_session.is_some());
    assert!(snapshot
        .users
        .iter()
        .all(|user| user.owner_pubkey != provisional_owner_pubkey(bob.device_pubkey)));
    Ok(())
}

#[test]
fn snapshot_is_deterministic_for_users_devices_and_sessions() -> Result<()> {
    let alice1 = manager_device(17, 171);
    let alice2 = manager_device(17, 172);
    let bob1 = manager_device(18, 181);

    let mut left = session_manager(&alice1);
    let mut right = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob1_manager = session_manager(&bob1);

    for manager in [&mut left, &mut right] {
        manager.apply_local_roster(roster_for(&[&alice1, &alice2], 90));
        manager.observe_peer_roster(bob1.owner_pubkey, roster_for(&[&bob1], 91));
        manager.observe_device_invite(manager_public_device_invite(
            &mut alice2_manager,
            &alice2,
            90,
            1_800_000_800,
        )?)?;
        manager.observe_device_invite(manager_public_device_invite(
            &mut bob1_manager,
            &bob1,
            91,
            1_800_000_801,
        )?)?;
    }

    let left_snapshot: SessionManagerSnapshot = left.snapshot();
    let right_snapshot: SessionManagerSnapshot = right.snapshot();
    assert_eq!(
        serde_json::to_string(&left_snapshot)?,
        serde_json::to_string(&right_snapshot)?
    );
    Ok(())
}
