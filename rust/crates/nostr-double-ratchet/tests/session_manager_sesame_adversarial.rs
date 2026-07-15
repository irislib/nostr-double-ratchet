mod support;

use nostr_double_ratchet::{
    DomainError, Error, RelayGap, Result, RosterSnapshotDecision, UnixSeconds, UserRecordSnapshot,
};
use support::{
    context, direct_session_pair, manager_device, manager_device_snapshot,
    manager_observe_invite_response, manager_public_device_invite, manager_receive_delivery,
    manager_user_snapshot, mutate_text, provisional_owner_pubkey, restore_manager, roster_for,
    send_text, session_manager, signed_app_keys_for, snapshot,
};

#[test]
fn missing_roster_surfaces_gap_not_hidden_failure() -> Result<()> {
    let alice = manager_device(21, 211);
    let bob = manager_device(22, 221);
    let mut alice_manager = session_manager(&alice);

    let mut send_ctx = context(1, 1_810_000_000);
    let prepared = alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"gap".to_vec())?;
    assert_eq!(
        prepared.relay_gaps,
        vec![RelayGap::MissingRoster {
            owner_pubkey: bob.owner_pubkey
        }]
    );
    assert!(prepared.deliveries.is_empty());
    Ok(())
}

#[test]
fn missing_device_invite_surfaces_gap_not_hidden_failure() -> Result<()> {
    let alice = manager_device(23, 231);
    let bob = manager_device(24, 241);
    let mut alice_manager = session_manager(&alice);

    alice_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 10), UnixSeconds(10))?;

    let mut send_ctx = context(2, 1_810_000_010);
    let prepared = alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"gap".to_vec())?;
    assert_eq!(
        prepared.relay_gaps,
        vec![RelayGap::MissingDeviceInvite {
            owner_pubkey: bob.owner_pubkey,
            device_pubkey: bob.device_pubkey,
        }]
    );
    assert!(prepared.deliveries.is_empty());
    Ok(())
}

#[test]
fn restore_rejects_mismatched_local_secret_key() -> Result<()> {
    let alice = manager_device(25, 251);
    let wrong = manager_device(26, 161);
    let manager = session_manager(&alice);
    let snapshot = manager.snapshot();

    let result = nostr_double_ratchet::SessionManager::from_snapshot(snapshot, wrong.secret_key);
    assert!(matches!(
        result,
        Err(Error::Domain(DomainError::InvalidState(_)))
    ));
    Ok(())
}

#[test]
fn malformed_device_invite_observation_does_not_corrupt_state() -> Result<()> {
    let alice = manager_device(27, 171);
    let bob = manager_device(28, 181);
    let mut manager = session_manager(&alice);
    let before = snapshot(&manager.snapshot());

    let mut wrong_owner_invite = support::custom_public_device_invite(&bob, 3, 1_810_000_020)?;
    wrong_owner_invite.inviter_owner_pubkey = Some(alice.owner_pubkey);
    let result = manager.observe_device_invite(bob.owner_pubkey, wrong_owner_invite);
    assert!(result.is_err());
    assert_eq!(snapshot(&manager.snapshot()), before);
    Ok(())
}

#[test]
fn invite_response_without_owner_claim_is_rejected_for_session_manager() -> Result<()> {
    let alice = manager_device(29, 191);
    let bob = manager_device(30, 192);
    let mut alice_manager = session_manager(&alice);

    let public_invite = manager_public_device_invite(&mut alice_manager, &alice, 4, 1_810_000_021)?;
    let mut accept_ctx = context(5, 1_810_000_022);
    let (_session, envelope) =
        public_invite.accept_with_context(&mut accept_ctx, bob.device_pubkey, bob.secret_key)?;

    let mut observe_ctx = context(6, 1_810_000_023);
    let result = manager_observe_invite_response(&mut alice_manager, &mut observe_ctx, &envelope);
    assert!(matches!(
        result,
        Err(Error::Domain(DomainError::InvalidState(message)))
            if message.contains("missing owner claim")
    ));
    Ok(())
}

#[test]
fn invite_response_replay_is_rejected_and_state_unchanged() -> Result<()> {
    let alice = manager_device(7, 71);
    let bob = manager_device(8, 81);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 20), UnixSeconds(20))?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 20, 1_810_000_100)?,
    )?;

    let mut send_ctx = context(4, 1_810_000_101);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"hello".to_vec())?;

    let mut observe_ctx = context(5, 1_810_000_102);
    manager_observe_invite_response(
        &mut bob_manager,
        &mut observe_ctx,
        &prepared.invite_responses[0],
    )?;
    let after_first = snapshot(&bob_manager.snapshot());

    let mut replay_ctx = context(6, 1_810_000_103);
    let replay = manager_observe_invite_response(
        &mut bob_manager,
        &mut replay_ctx,
        &prepared.invite_responses[0],
    );
    assert!(matches!(
        replay,
        Err(Error::Domain(DomainError::InviteAlreadyUsed))
    ));
    assert_eq!(snapshot(&bob_manager.snapshot()), after_first);
    Ok(())
}

#[test]
fn message_replay_on_active_session_is_rejected_without_corruption() -> Result<()> {
    let alice = manager_device(9, 91);
    let bob = manager_device(10, 101);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 30), UnixSeconds(30))?;
    bob_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&alice, &[&alice], 30), UnixSeconds(30))?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 30, 1_810_000_200)?,
    )?;
    bob_manager.observe_device_invite(
        alice.owner_pubkey,
        manager_public_device_invite(&mut alice_manager, &alice, 31, 1_810_000_201)?,
    )?;

    let mut send_ctx = context(7, 1_810_000_202);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"hello".to_vec())?;
    let mut observe_ctx = context(8, 1_810_000_203);
    manager_observe_invite_response(
        &mut bob_manager,
        &mut observe_ctx,
        &prepared.invite_responses[0],
    )?;
    let mut receive_ctx = context(9, 1_810_000_204);
    manager_receive_delivery(
        &mut bob_manager,
        &mut receive_ctx,
        alice.owner_pubkey,
        &prepared.deliveries[0],
    )?;
    let after_first = snapshot(&bob_manager.snapshot());

    let mut replay_ctx = context(10, 1_810_000_205);
    let replay = manager_receive_delivery(
        &mut bob_manager,
        &mut replay_ctx,
        alice.owner_pubkey,
        &prepared.deliveries[0],
    );
    assert!(replay.is_err());
    assert_eq!(snapshot(&bob_manager.snapshot()), after_first);
    Ok(())
}

#[test]
fn partial_restore_with_cached_invite_but_no_roster_still_surfaces_missing_roster_gap() -> Result<()>
{
    let alice = manager_device(33, 231);
    let bob = manager_device(34, 241);
    let mut manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 40, 1_810_000_300)?,
    )?;

    let snapshot = manager.snapshot();
    let mut restored = restore_manager(&snapshot, alice.secret_key)?;
    let mut send_ctx = context(11, 1_810_000_301);
    let prepared = restored.prepare_send(&mut send_ctx, bob.owner_pubkey, b"fresh".to_vec())?;
    assert_eq!(
        prepared.relay_gaps,
        vec![RelayGap::MissingRoster {
            owner_pubkey: bob.owner_pubkey
        }]
    );
    Ok(())
}

#[test]
fn stale_roster_replay_does_not_resurrect_removed_device() -> Result<()> {
    let alice = manager_device(35, 101);
    let bob = manager_device(36, 111);
    let mut manager = session_manager(&alice);

    manager.observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 50), UnixSeconds(50))?;
    manager.observe_peer_app_keys_event(signed_app_keys_for(&bob, &[], 51), UnixSeconds(51))?;
    assert!(!manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 50), UnixSeconds(51),)?);

    let snapshot = manager.snapshot();
    let bob_record = manager_device_snapshot(
        manager_user_snapshot(&snapshot, bob.owner_pubkey),
        bob.device_pubkey,
    );
    assert!(!bob_record.authorized);
    assert!(bob_record.is_stale);
    Ok(())
}

#[test]
fn pruned_stale_device_is_not_sendable_after_late_old_invite_observation() -> Result<()> {
    let alice = manager_device(11, 111);
    let bob = manager_device(12, 121);
    let mut manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    manager.observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 60), UnixSeconds(60))?;
    let old_invite = manager_public_device_invite(&mut bob_manager, &bob, 60, 1_810_000_400)?;
    manager.observe_device_invite(bob.owner_pubkey, old_invite.clone())?;
    manager.observe_peer_app_keys_event(signed_app_keys_for(&bob, &[], 61), UnixSeconds(61))?;
    manager.prune_stale(UnixSeconds(61 + 8 * 24 * 60 * 60));

    manager.observe_device_invite(bob.owner_pubkey, old_invite)?;
    let mut send_ctx = context(12, 1_810_000_401);
    let prepared = manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"fresh".to_vec())?;
    assert!(prepared.deliveries.is_empty());
    assert!(prepared.invite_responses.is_empty());
    Ok(())
}

#[test]
fn late_message_after_pruned_stale_record_is_ignored() -> Result<()> {
    let alice = manager_device(13, 131);
    let bob = manager_device(14, 141);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 70), UnixSeconds(70))?;
    bob_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&alice, &[&alice], 70), UnixSeconds(70))?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 70, 1_810_000_500)?,
    )?;
    bob_manager.observe_device_invite(
        alice.owner_pubkey,
        manager_public_device_invite(&mut alice_manager, &alice, 71, 1_810_000_501)?,
    )?;

    let mut alice_send_ctx = context(13, 1_810_000_502);
    let first =
        alice_manager.prepare_send(&mut alice_send_ctx, bob.owner_pubkey, b"boot".to_vec())?;
    let mut bob_observe_ctx = context(14, 1_810_000_503);
    manager_observe_invite_response(
        &mut bob_manager,
        &mut bob_observe_ctx,
        &first.invite_responses[0],
    )?;
    let mut bob_receive_ctx = context(15, 1_810_000_504);
    manager_receive_delivery(
        &mut bob_manager,
        &mut bob_receive_ctx,
        alice.owner_pubkey,
        &first.deliveries[0],
    )?;

    let mut bob_send_ctx = context(16, 1_810_000_505);
    let delayed =
        bob_manager.prepare_send(&mut bob_send_ctx, alice.owner_pubkey, b"late".to_vec())?;

    alice_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[], 72), UnixSeconds(72))?;
    alice_manager.prune_stale(UnixSeconds(72 + 8 * 24 * 60 * 60));

    let mut receive_ctx = context(17, 1_810_000_506);
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
fn unverified_owner_claim_is_parked_under_device_owner_until_roster_arrives() -> Result<()> {
    let alice = manager_device(41, 141);
    let bob = manager_device(42, 142);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    bob_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&alice, &[&alice], 90), UnixSeconds(90))?;
    bob_manager.observe_device_invite(
        alice.owner_pubkey,
        manager_public_device_invite(&mut alice_manager, &alice, 90, 1_810_000_900)?,
    )?;

    let mut send_ctx = context(18, 1_810_000_901);
    let prepared =
        bob_manager.prepare_send(&mut send_ctx, alice.owner_pubkey, b"owner-claim".to_vec())?;

    let mut observe_ctx = context(19, 1_810_000_902);
    let observed = manager_observe_invite_response(
        &mut alice_manager,
        &mut observe_ctx,
        &prepared.invite_responses[0],
    )?
    .expect("invite response should be processed");

    assert_eq!(
        observed.owner_pubkey,
        provisional_owner_pubkey(bob.device_pubkey)
    );

    let snapshot = alice_manager.snapshot();
    let parked_user = manager_user_snapshot(&snapshot, provisional_owner_pubkey(bob.device_pubkey));
    let parked_device = manager_device_snapshot(parked_user, bob.device_pubkey);
    assert_eq!(parked_device.claimed_owner_pubkey, Some(bob.owner_pubkey));
    assert!(parked_device.active_session.is_some());
    Ok(())
}

#[test]
fn claimed_session_import_cannot_impersonate_owner_before_roster_verification() -> Result<()> {
    let local = manager_device(43, 143);
    let claimed_owner = manager_device(44, 144);
    let attacker = manager_device(45, 145);
    let (sender, _, mut sender_session, receiver_session) =
        direct_session_pair(145, 146, 1_810_001_000)?;
    assert_eq!(sender.device_pubkey, attacker.device_pubkey);

    let mut manager = session_manager(&local);
    let imported = manager.import_claimed_session_state(
        claimed_owner.owner_pubkey,
        attacker.device_pubkey,
        receiver_session.state,
        UnixSeconds(1_810_001_001),
    );
    let provisional_owner = provisional_owner_pubkey(attacker.device_pubkey);
    assert_eq!(imported.owner_pubkey, provisional_owner);
    assert_eq!(
        imported.claimed_owner_pubkey,
        Some(claimed_owner.owner_pubkey)
    );

    let parked_snapshot = manager.snapshot();
    assert!(parked_snapshot
        .users
        .iter()
        .all(|user| user.owner_pubkey != claimed_owner.owner_pubkey));
    let parked_record = manager_device_snapshot(
        manager_user_snapshot(&parked_snapshot, provisional_owner),
        attacker.device_pubkey,
    );
    assert!(parked_record.authorized);
    assert_eq!(
        parked_record.claimed_owner_pubkey,
        Some(claimed_owner.owner_pubkey)
    );

    let mut first_send_ctx = context(20, 1_810_001_002);
    let first = send_text(&mut sender_session, &mut first_send_ctx, "before-proof")?;
    let mut claimed_receive_ctx = context(21, 1_810_001_003);
    assert!(manager
        .receive(
            &mut claimed_receive_ctx,
            claimed_owner.owner_pubkey,
            &first.incoming,
        )?
        .is_none());

    let mut provisional_receive_ctx = context(22, 1_810_001_004);
    let provisional_received = manager
        .receive(
            &mut provisional_receive_ctx,
            provisional_owner,
            &first.incoming,
        )?
        .expect("device-owned session remains usable without owner attribution");
    assert_eq!(provisional_received.payload, b"before-proof");

    manager.observe_peer_roster(claimed_owner.owner_pubkey, roster_for(&[&attacker], 100));
    let still_parked = manager.snapshot();
    let still_parked_record = manager_device_snapshot(
        manager_user_snapshot(&still_parked, provisional_owner),
        attacker.device_pubkey,
    );
    assert_eq!(
        still_parked_record.claimed_owner_pubkey,
        Some(claimed_owner.owner_pubkey)
    );
    assert!(still_parked_record.active_session.is_some());

    manager.observe_peer_app_keys_event(
        signed_app_keys_for(&claimed_owner, &[&attacker], 100),
        UnixSeconds(100),
    )?;
    let promoted_snapshot = manager.snapshot();
    assert!(promoted_snapshot
        .users
        .iter()
        .all(|user| user.owner_pubkey != provisional_owner));
    let promoted_record = manager_device_snapshot(
        manager_user_snapshot(&promoted_snapshot, claimed_owner.owner_pubkey),
        attacker.device_pubkey,
    );
    assert!(promoted_record.authorized);
    assert_eq!(promoted_record.claimed_owner_pubkey, None);

    let mut second_send_ctx = context(23, 1_810_001_005);
    let second = send_text(&mut sender_session, &mut second_send_ctx, "after-proof")?;
    let mut verified_receive_ctx = context(24, 1_810_001_006);
    let verified_received = manager
        .receive(
            &mut verified_receive_ctx,
            claimed_owner.owner_pubkey,
            &second.incoming,
        )?
        .expect("verified roster should promote the parked session");
    assert_eq!(verified_received.payload, b"after-proof");
    Ok(())
}

#[test]
fn generic_session_import_uses_claimed_owner_verification() -> Result<()> {
    let local = manager_device(46, 146);
    let claimed_owner = manager_device(47, 147);
    let attacker = manager_device(48, 148);
    let (_, _, _, receiver_session) = direct_session_pair(148, 149, 1_810_001_100)?;
    let mut manager = session_manager(&local);

    manager.import_session_state(
        claimed_owner.owner_pubkey,
        attacker.device_pubkey,
        receiver_session.state,
        UnixSeconds(1_810_001_101),
    );

    let snapshot = manager.snapshot();
    assert!(snapshot
        .users
        .iter()
        .all(|user| user.owner_pubkey != claimed_owner.owner_pubkey));
    let parked = manager_device_snapshot(
        manager_user_snapshot(&snapshot, provisional_owner_pubkey(attacker.device_pubkey)),
        attacker.device_pubkey,
    );
    assert_eq!(
        parked.claimed_owner_pubkey,
        Some(claimed_owner.owner_pubkey)
    );
    Ok(())
}

#[test]
fn peer_roster_api_cannot_modify_local_owner_authority() {
    let local = manager_device(61, 161);
    let attacker = manager_device(62, 162);
    let mut manager = session_manager(&local);

    assert_eq!(
        manager.observe_peer_roster(local.owner_pubkey, roster_for(&[&attacker], 150)),
        RosterSnapshotDecision::Stale
    );
    assert!(manager
        .snapshot()
        .users
        .iter()
        .all(|user| user.owner_pubkey != local.owner_pubkey));
}

#[test]
fn restore_ignores_cached_authorization_without_owner_binding() -> Result<()> {
    let local = manager_device(49, 149);
    let claimed_owner = manager_device(50, 150);
    let attacker = manager_device(51, 151);
    let (_, _, mut sender_session, receiver_session) =
        direct_session_pair(151, 152, 1_810_001_200)?;
    let mut manager = session_manager(&local);

    manager.observe_peer_roster(claimed_owner.owner_pubkey, roster_for(&[&attacker], 110));
    manager.import_session_state(
        claimed_owner.owner_pubkey,
        attacker.device_pubkey,
        receiver_session.state,
        UnixSeconds(1_810_001_201),
    );

    let mut forged_snapshot = manager.snapshot();
    let forged_user = forged_snapshot
        .users
        .iter_mut()
        .find(|user| user.owner_pubkey == claimed_owner.owner_pubkey)
        .expect("claimed owner record");
    forged_user.roster = None;
    let forged_record = forged_user
        .devices
        .iter_mut()
        .find(|record| record.device_pubkey == attacker.device_pubkey)
        .expect("attacker device record");
    forged_record.authorized = true;
    forged_record.is_stale = false;

    let mut restored = restore_manager(&forged_snapshot, local.secret_key)?;
    let restored_snapshot = restored.snapshot();
    let restored_record = manager_device_snapshot(
        manager_user_snapshot(&restored_snapshot, claimed_owner.owner_pubkey),
        attacker.device_pubkey,
    );
    assert!(!restored_record.authorized);

    let mut send_ctx = context(25, 1_810_001_202);
    let message = send_text(&mut sender_session, &mut send_ctx, "cached-flag")?;
    let mut receive_ctx = context(26, 1_810_001_203);
    assert!(restored
        .receive(
            &mut receive_ctx,
            claimed_owner.owner_pubkey,
            &message.incoming,
        )?
        .is_none());
    Ok(())
}

#[test]
fn restore_does_not_reconcile_parked_claim_from_unproven_roster() -> Result<()> {
    let local = manager_device(52, 152);
    let claimed_owner = manager_device(53, 153);
    let attacker = manager_device(54, 154);
    let (_, _, _, receiver_session) = direct_session_pair(154, 155, 1_810_001_300)?;
    let mut manager = session_manager(&local);
    manager.import_claimed_session_state(
        claimed_owner.owner_pubkey,
        attacker.device_pubkey,
        receiver_session.state,
        UnixSeconds(1_810_001_301),
    );

    let mut snapshot = manager.snapshot();
    snapshot.users.push(UserRecordSnapshot {
        owner_pubkey: claimed_owner.owner_pubkey,
        roster: Some(roster_for(&[&attacker], 120)),
        devices: Vec::new(),
    });

    let restored = restore_manager(&snapshot, local.secret_key)?;
    let restored_snapshot = restored.snapshot();
    let restored_record = manager_device_snapshot(
        manager_user_snapshot(
            &restored_snapshot,
            provisional_owner_pubkey(attacker.device_pubkey),
        ),
        attacker.device_pubkey,
    );
    assert_eq!(
        restored_record.claimed_owner_pubkey,
        Some(claimed_owner.owner_pubkey)
    );
    assert!(restored_record.active_session.is_some());
    Ok(())
}

#[test]
fn signed_app_keys_provenance_survives_restore_and_promotes_parked_claim() -> Result<()> {
    let local = manager_device(55, 155);
    let claimed_owner = manager_device(56, 156);
    let device = manager_device(57, 157);
    let (_, _, _, receiver_session) = direct_session_pair(157, 158, 1_810_001_400)?;
    let mut manager = session_manager(&local);
    manager.import_claimed_session_state(
        claimed_owner.owner_pubkey,
        device.device_pubkey,
        receiver_session.state,
        UnixSeconds(1_810_001_401),
    );
    manager.observe_peer_app_keys_event(
        signed_app_keys_for(&claimed_owner, &[&device], 130),
        UnixSeconds(130),
    )?;

    let restored = restore_manager(&manager.snapshot(), local.secret_key)?;
    let restored_snapshot = restored.snapshot();
    assert!(restored_snapshot
        .users
        .iter()
        .all(|user| user.owner_pubkey != provisional_owner_pubkey(device.device_pubkey)));
    let restored_record = manager_device_snapshot(
        manager_user_snapshot(&restored_snapshot, claimed_owner.owner_pubkey),
        device.device_pubkey,
    );
    assert!(restored_record.authorized);
    assert_eq!(restored_record.claimed_owner_pubkey, None);
    assert!(restored_record.active_session.is_some());
    Ok(())
}

#[test]
fn equal_time_signed_conflict_suspends_owner_attribution_across_restore() -> Result<()> {
    let local = manager_device(58, 158);
    let claimed_owner = manager_device(59, 159);
    let device = manager_device(60, 160);
    let (_, _, mut sender_session, receiver_session) =
        direct_session_pair(160, 161, 1_810_001_500)?;
    let mut manager = session_manager(&local);
    manager.import_claimed_session_state(
        claimed_owner.owner_pubkey,
        device.device_pubkey,
        receiver_session.state,
        UnixSeconds(1_810_001_501),
    );

    manager.observe_peer_app_keys_event(
        signed_app_keys_for(&claimed_owner, &[&device], 140),
        UnixSeconds(140),
    )?;
    assert!(
        manager_device_snapshot(
            manager_user_snapshot(&manager.snapshot(), claimed_owner.owner_pubkey),
            device.device_pubkey,
        )
        .authorized
    );

    manager.observe_peer_app_keys_event(
        signed_app_keys_for(&claimed_owner, &[], 140),
        UnixSeconds(140),
    )?;
    let conflicted = manager.snapshot();
    assert_eq!(conflicted.verified_peer_app_keys_events.len(), 2);
    assert!(
        !manager_device_snapshot(
            manager_user_snapshot(&conflicted, claimed_owner.owner_pubkey),
            device.device_pubkey,
        )
        .authorized
    );

    let mut restored = restore_manager(&conflicted, local.secret_key)?;
    let message = send_text(
        &mut sender_session,
        &mut context(27, 1_810_001_502),
        "ambiguous-owner",
    )?;
    assert!(restored
        .receive(
            &mut context(28, 1_810_001_503),
            claimed_owner.owner_pubkey,
            &message.incoming,
        )?
        .is_none());
    Ok(())
}

#[test]
fn tampered_delivery_does_not_corrupt_receiver_state() -> Result<()> {
    let alice = manager_device(15, 151);
    let bob = manager_device(16, 161);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&bob, &[&bob], 80), UnixSeconds(80))?;
    bob_manager
        .observe_peer_app_keys_event(signed_app_keys_for(&alice, &[&alice], 80), UnixSeconds(80))?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 80, 1_810_000_600)?,
    )?;

    let mut send_ctx = context(18, 1_810_000_601);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"hello".to_vec())?;
    let mut observe_ctx = context(19, 1_810_000_602);
    manager_observe_invite_response(
        &mut bob_manager,
        &mut observe_ctx,
        &prepared.invite_responses[0],
    )?;

    let before = snapshot(&bob_manager.snapshot());
    let mut tampered = prepared.deliveries[0].clone();
    tampered.envelope.ciphertext = mutate_text(&tampered.envelope.ciphertext);

    let mut receive_ctx = context(20, 1_810_000_603);
    let result = manager_receive_delivery(
        &mut bob_manager,
        &mut receive_ctx,
        alice.owner_pubkey,
        &tampered,
    );
    assert!(result.is_err());
    assert_eq!(snapshot(&bob_manager.snapshot()), before);
    Ok(())
}
