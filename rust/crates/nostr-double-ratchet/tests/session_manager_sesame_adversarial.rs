mod support;

use nostr_double_ratchet::{DomainError, Error, RelayGap, Result, Session, UnixSeconds};
use support::{
    context, manager_device, manager_device_snapshot, manager_observe_invite_response,
    manager_public_device_invite, manager_receive_delivery, manager_user_snapshot, mutate_text,
    provisional_owner_pubkey, restore_manager, roster_for, session_manager, snapshot,
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

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 10));

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

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 20));
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

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 30));
    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 30));
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

    manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 50));
    manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[], 51));
    let decision = manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 50));
    assert_eq!(
        decision,
        nostr_double_ratchet::RosterSnapshotDecision::Stale
    );

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

    manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 60));
    let old_invite = manager_public_device_invite(&mut bob_manager, &bob, 60, 1_810_000_400)?;
    manager.observe_device_invite(bob.owner_pubkey, old_invite.clone())?;
    manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[], 61));
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

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 70));
    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 70));
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

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[], 72));
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

    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 90));
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
fn tampered_delivery_does_not_corrupt_receiver_state() -> Result<()> {
    let alice = manager_device(15, 151);
    let bob = manager_device(16, 161);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 80));
    bob_manager.observe_peer_roster(alice.owner_pubkey, roster_for(&[&alice], 80));
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

#[test]
fn aggregate_remote_send_failure_does_not_advance_an_earlier_target() -> Result<()> {
    let alice = manager_device(51, 151);
    let bob1 = manager_device(52, 152);
    let bob2 = manager_device(52, 153);
    let mut manager = session_manager(&alice);
    manager.observe_peer_roster(bob1.owner_pubkey, roster_for(&[&bob1, &bob2], 100));

    for (index, bob) in [&bob1, &bob2].into_iter().enumerate() {
        let mut session_ctx = context(30 + index as u64, 1_810_001_000);
        let session = Session::new_initiator(
            &mut session_ctx,
            bob.device_pubkey,
            [201 + index as u8; 32],
            [77 + index as u8; 32],
        )?;
        manager.import_session_state(
            bob.owner_pubkey,
            bob.device_pubkey,
            session.state,
            UnixSeconds(1_810_001_000),
        );
    }

    let mut corrupted = manager.snapshot();
    let bob_user = corrupted
        .users
        .iter_mut()
        .find(|user| user.owner_pubkey == bob1.owner_pubkey)
        .expect("bob owner must exist");
    let later_device = bob_user
        .devices
        .iter_mut()
        .max_by_key(|device| device.device_pubkey)
        .expect("bob device must exist");
    later_device
        .active_session
        .as_mut()
        .expect("active session must exist")
        .our_current_nostr_key
        .as_mut()
        .expect("initiator send key must exist")
        .private_key = [0; 32];

    let mut manager = restore_manager(&corrupted, alice.secret_key)?;
    let before = manager.snapshot();
    let mut send_ctx = context(32, 1_810_001_001);
    assert!(manager
        .prepare_remote_send(&mut send_ctx, bob1.owner_pubkey, b"atomic".to_vec())
        .is_err());
    assert_eq!(manager.snapshot(), before);
    Ok(())
}

#[test]
fn aggregate_all_session_send_failure_does_not_advance_an_earlier_sibling() -> Result<()> {
    let alice1 = manager_device(53, 154);
    let alice2 = manager_device(53, 155);
    let alice3 = manager_device(53, 156);
    let mut manager = session_manager(&alice1);
    manager.apply_local_roster(roster_for(&[&alice1, &alice2, &alice3], 101));

    for (index, sibling) in [&alice2, &alice3].into_iter().enumerate() {
        let mut session_ctx = context(33 + index as u64, 1_810_001_010);
        let session = Session::new_initiator(
            &mut session_ctx,
            sibling.device_pubkey,
            [203 + index as u8; 32],
            [79 + index as u8; 32],
        )?;
        manager.import_session_state(
            alice1.owner_pubkey,
            sibling.device_pubkey,
            session.state,
            UnixSeconds(1_810_001_010),
        );
    }

    let mut corrupted = manager.snapshot();
    let local_user = corrupted
        .users
        .iter_mut()
        .find(|user| user.owner_pubkey == alice1.owner_pubkey)
        .expect("local owner must exist");
    let later_sibling = local_user
        .devices
        .iter_mut()
        .filter(|device| device.device_pubkey != alice1.device_pubkey)
        .max_by_key(|device| device.device_pubkey)
        .expect("local sibling must exist");
    later_sibling
        .active_session
        .as_mut()
        .expect("active session must exist")
        .our_current_nostr_key
        .as_mut()
        .expect("initiator send key must exist")
        .private_key = [0; 32];

    let mut manager = restore_manager(&corrupted, alice1.secret_key)?;
    let before = manager.snapshot();
    let mut send_ctx = context(35, 1_810_001_011);
    assert!(manager
        .prepare_local_sibling_send_reusing_all_sessions(&mut send_ctx, b"atomic-sibling".to_vec(),)
        .is_err());
    assert_eq!(manager.snapshot(), before);
    Ok(())
}
