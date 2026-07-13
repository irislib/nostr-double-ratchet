use nostr::{Keys, SecretKey};
use nostr_double_ratchet::{
    invite_url, owner_roster_proof_from_app_keys_event, parse_invite_url, parse_owner_roster_proof,
    AppKeys, DeviceEntry, DevicePubkey, DomainError, Error, OwnerPubkey, OwnerRosterProof,
    ProtocolContext, Result, RosterSnapshotDecision, SessionManager, UnixSeconds,
};
use rand::{rngs::StdRng, SeedableRng};

fn keys(fill: u8) -> Keys {
    Keys::new(SecretKey::from_slice(&[fill; 32]).unwrap())
}

fn context(seed: u64, now: u64) -> ProtocolContext<'static, StdRng> {
    ProtocolContext::new(
        UnixSeconds(now),
        Box::leak(Box::new(StdRng::seed_from_u64(seed))),
    )
}

fn proof(owner: &Keys, devices: &[(&Keys, u64)], created_at: u64) -> Result<OwnerRosterProof> {
    let app_keys = AppKeys::new(
        devices
            .iter()
            .map(|(device, registered_at)| DeviceEntry::new(device.public_key(), *registered_at))
            .collect(),
    );
    let event = app_keys
        .get_event_at(owner.public_key(), created_at)
        .sign_with_keys(owner)?;
    owner_roster_proof_from_app_keys_event(&event)
}

fn new_manager(owner: &Keys, device: &Keys) -> SessionManager {
    SessionManager::new(
        OwnerPubkey::from_bytes(owner.public_key().to_bytes()),
        device.secret_key().to_secret_bytes(),
    )
}

fn public_invite(
    manager: &mut SessionManager,
    seed: u64,
    now: u64,
) -> Result<nostr_double_ratchet::Invite> {
    let mut ctx = context(seed, now);
    let invite = manager.ensure_local_invite(&mut ctx)?.clone();
    parse_invite_url(&invite_url(&invite, "https://chat.iris.to")?).map_err(Into::into)
}

#[test]
fn signed_app_keys_proof_binds_owner_and_device() -> Result<()> {
    let owner = keys(1);
    let device = keys(2);
    let proof = proof(&owner, &[(&device, 100)], 200)?;
    let mut manager = new_manager(&keys(31), &keys(32));

    assert_eq!(
        proof.owner_pubkey(),
        OwnerPubkey::from_bytes(owner.public_key().to_bytes())
    );
    proof.ensure_authorizes_device(DevicePubkey::from_bytes(device.public_key().to_bytes()))?;
    manager.observe_owner_roster_proof(proof)?;
    let identity = manager
        .verified_identity_for_device(DevicePubkey::from_bytes(device.public_key().to_bytes()))
        .expect("signed roster must make the owner/device binding queryable");
    assert_eq!(
        identity.owner_pubkey,
        OwnerPubkey::from_bytes(owner.public_key().to_bytes())
    );
    Ok(())
}

#[test]
fn tampered_app_keys_event_cannot_cross_proof_boundary() -> Result<()> {
    let owner = keys(33);
    let device = keys(34);
    let signed = proof(&owner, &[(&device, 100)], 200)?;
    let mut tampered: serde_json::Value = serde_json::from_str(signed.raw_event()).unwrap();
    tampered["created_at"] = serde_json::json!(201);

    let result = parse_owner_roster_proof(&serde_json::to_string(&tampered).unwrap());
    assert!(matches!(result, Err(Error::InvalidEvent(_))));
    Ok(())
}

#[test]
fn stale_proof_cannot_resurrect_device_removed_by_newer_roster() -> Result<()> {
    let local_owner = keys(3);
    let local_device = keys(4);
    let remote_owner = keys(5);
    let remote_device = keys(6);
    let mut manager = new_manager(&local_owner, &local_device);

    manager.observe_owner_roster_proof(proof(&remote_owner, &[], 300)?)?;
    let before = manager.snapshot();
    let stale = proof(&remote_owner, &[(&remote_device, 100)], 200)?;
    assert_eq!(
        manager.observe_owner_roster_proof(stale.clone())?,
        RosterSnapshotDecision::Stale
    );
    assert_eq!(manager.snapshot(), before);

    let mut remote_manager = new_manager(&remote_owner, &remote_device);
    let invite = public_invite(&mut remote_manager, 1, 301)?;
    let result = manager.observe_verified_device_invite(stale, invite);
    assert!(matches!(
        result,
        Err(Error::Domain(DomainError::CannotSendYet))
    ));
    assert_eq!(manager.snapshot(), before);
    Ok(())
}

#[test]
fn invite_response_uses_embedded_signed_roster_proof() -> Result<()> {
    let alice_owner = keys(7);
    let alice_device = keys(8);
    let bob_owner = keys(9);
    let bob_device = keys(10);
    let alice_proof = proof(&alice_owner, &[(&alice_device, 400)], 400)?;
    let bob_proof = proof(&bob_owner, &[(&bob_device, 400)], 400)?;
    let mut alice = new_manager(&alice_owner, &alice_device);
    let mut bob = new_manager(&bob_owner, &bob_device);
    alice.set_local_owner_roster_proof(alice_proof.clone())?;
    bob.set_local_owner_roster_proof(bob_proof.clone())?;

    let bob_invite = public_invite(&mut bob, 2, 401)?;
    alice.observe_verified_device_invite(bob_proof, bob_invite)?;
    let mut send_ctx = context(3, 402);
    let prepared = alice.prepare_remote_send(
        &mut send_ctx,
        OwnerPubkey::from_bytes(bob_owner.public_key().to_bytes()),
        b"hello".to_vec(),
    )?;

    let mut observe_ctx = context(4, 403);
    let processed = bob
        .observe_invite_response_with_roster_proof_verifier(
            &mut observe_ctx,
            &prepared.invite_responses[0],
            |raw, required_device| {
                let proof = nostr_double_ratchet::parse_owner_roster_proof(raw)?;
                proof.ensure_authorizes_device(required_device)?;
                Ok(proof)
            },
        )?
        .expect("response must be processed");
    assert_eq!(
        processed.owner_pubkey,
        OwnerPubkey::from_bytes(alice_owner.public_key().to_bytes())
    );
    Ok(())
}

#[test]
fn restore_reparses_persisted_signed_proofs() -> Result<()> {
    let owner = keys(11);
    let device = keys(12);
    let remote_owner = keys(13);
    let remote_device = keys(14);
    let local_proof = proof(&owner, &[(&device, 500)], 500)?;
    let remote_proof = proof(&remote_owner, &[(&remote_device, 500)], 500)?;
    let mut original = new_manager(&owner, &device);
    original.set_local_owner_roster_proof(local_proof.clone())?;
    let mut remote = new_manager(&remote_owner, &remote_device);
    let remote_invite = public_invite(&mut remote, 5, 501)?;
    original.observe_verified_device_invite(remote_proof, remote_invite)?;

    let persisted = serde_json::to_string(&original.snapshot()).unwrap();
    let snapshot = serde_json::from_str(&persisted).unwrap();
    let mut restored =
        SessionManager::from_snapshot(snapshot, device.secret_key().to_secret_bytes())?;
    assert_eq!(
        restored
            .local_owner_roster_proof()
            .expect("local signed proof must survive restore")
            .event_id(),
        local_proof.event_id()
    );
    assert!(restored
        .verified_identity_for_device(DevicePubkey::from_bytes(
            remote_device.public_key().to_bytes()
        ))
        .is_some());

    let mut ready_ctx = context(7, 503);
    let prepared = restored.prepare_remote_send(
        &mut ready_ctx,
        OwnerPubkey::from_bytes(remote_owner.public_key().to_bytes()),
        b"ready".to_vec(),
    )?;
    assert_eq!(prepared.deliveries.len(), 1);
    assert_eq!(prepared.invite_responses.len(), 1);
    Ok(())
}

#[test]
fn newer_local_proof_can_revoke_current_device_without_preserving_stale_authority() -> Result<()> {
    let owner = keys(60);
    let device = keys(61);
    let device_pubkey = DevicePubkey::from_bytes(device.public_key().to_bytes());
    let authorizing = proof(&owner, &[(&device, 800)], 800)?;
    let revoking = proof(&owner, &[], 801)?;
    let revoking_raw = revoking.raw_event().to_string();
    let mut manager = new_manager(&owner, &device);

    assert_eq!(
        manager.set_local_owner_roster_proof(authorizing.clone())?,
        RosterSnapshotDecision::Advanced
    );
    assert!(manager.local_owner_roster_proof().is_some());

    assert_eq!(
        manager.set_local_owner_roster_proof(revoking.clone())?,
        RosterSnapshotDecision::Advanced
    );
    assert!(manager.local_owner_roster_proof().is_none());
    assert!(manager
        .verified_identity_for_device(device_pubkey)
        .is_none());
    let snapshot = manager.snapshot();
    let local_user = snapshot
        .users
        .iter()
        .find(|user| user.owner_pubkey == OwnerPubkey::from_bytes(owner.public_key().to_bytes()))
        .expect("local owner record must be persisted");
    assert_eq!(
        local_user.owner_roster_proof.as_deref(),
        Some(&*revoking_raw)
    );

    assert_eq!(
        manager.set_local_owner_roster_proof(authorizing)?,
        RosterSnapshotDecision::Stale
    );
    assert!(manager.local_owner_roster_proof().is_none());
    assert_eq!(manager.snapshot(), snapshot);

    let restored = SessionManager::from_snapshot(snapshot, device.secret_key().to_secret_bytes())?;
    assert!(restored.local_owner_roster_proof().is_none());
    assert!(restored
        .verified_identity_for_device(device_pubkey)
        .is_none());
    let restored_proof = restored
        .snapshot()
        .users
        .into_iter()
        .find(|user| user.owner_pubkey == OwnerPubkey::from_bytes(owner.public_key().to_bytes()))
        .and_then(|user| user.owner_roster_proof)
        .expect("revoking exact proof must survive restore");
    assert_eq!(restored_proof, revoking_raw);
    Ok(())
}

#[test]
fn legacy_snapshot_without_proof_provenance_quarantines_authorization() -> Result<()> {
    let owner = keys(15);
    let device = keys(16);
    let remote_owner = keys(17);
    let remote_device = keys(18);
    let mut original = new_manager(&owner, &device);
    original.observe_owner_roster_proof(proof(&remote_owner, &[(&remote_device, 600)], 600)?)?;

    let mut legacy = original.snapshot();
    let remote_user = legacy
        .users
        .iter_mut()
        .find(|user| {
            user.owner_pubkey == OwnerPubkey::from_bytes(remote_owner.public_key().to_bytes())
        })
        .expect("remote roster must be persisted");
    remote_user.owner_roster_proof = None;
    remote_user.roster_verified = true;
    for device in &mut remote_user.devices {
        device.authorized = true;
    }

    let restored = SessionManager::from_snapshot(legacy, device.secret_key().to_secret_bytes())?;
    assert!(restored
        .verified_identity_for_device(DevicePubkey::from_bytes(
            remote_device.public_key().to_bytes()
        ))
        .is_none());
    Ok(())
}

#[test]
fn duplicate_owner_authorization_is_ambiguous() -> Result<()> {
    let local_owner = keys(40);
    let local_device = keys(41);
    let owner_a = keys(42);
    let owner_b = keys(43);
    let shared_device = keys(44);
    let shared_device_pubkey = DevicePubkey::from_bytes(shared_device.public_key().to_bytes());
    let mut manager = new_manager(&local_owner, &local_device);

    manager.observe_owner_roster_proof(proof(&owner_a, &[(&shared_device, 700)], 700)?)?;
    manager.observe_owner_roster_proof(proof(&owner_b, &[(&shared_device, 700)], 700)?)?;

    assert!(manager
        .verified_identity_for_device(shared_device_pubkey)
        .is_none());
    Ok(())
}

#[test]
fn ambiguous_verified_invite_does_not_mutate_manager() -> Result<()> {
    let local_owner = keys(45);
    let local_device = keys(46);
    let owner_a = keys(47);
    let owner_b = keys(48);
    let shared_device = keys(49);
    let mut manager = new_manager(&local_owner, &local_device);
    manager.observe_owner_roster_proof(proof(&owner_a, &[(&shared_device, 710)], 710)?)?;

    let mut remote = new_manager(&owner_b, &shared_device);
    let invite = public_invite(&mut remote, 8, 711)?;
    let before = manager.snapshot();
    let result = manager
        .observe_verified_device_invite(proof(&owner_b, &[(&shared_device, 710)], 710)?, invite);

    assert!(matches!(
        result,
        Err(Error::Domain(DomainError::InvalidState(_)))
    ));
    assert_eq!(manager.snapshot(), before);
    Ok(())
}

#[test]
fn equal_timestamp_proofs_select_one_exact_event_without_union() -> Result<()> {
    let local_owner = keys(50);
    let local_device = keys(51);
    let remote_owner = keys(52);
    let device_a = keys(53);
    let device_b = keys(54);
    let proof_a = proof(&remote_owner, &[(&device_a, 720)], 720)?;
    let proof_b = proof(&remote_owner, &[(&device_b, 720)], 720)?;
    assert_ne!(proof_a.event_id(), proof_b.event_id());

    let (winner, loser, winner_device, loser_device) = if proof_a.event_id() < proof_b.event_id() {
        (proof_a, proof_b, &device_a, &device_b)
    } else {
        (proof_b, proof_a, &device_b, &device_a)
    };
    let mut loser_then_winner = new_manager(&local_owner, &local_device);
    let mut winner_then_loser = new_manager(&local_owner, &local_device);

    loser_then_winner.observe_owner_roster_proof(loser.clone())?;
    assert_eq!(
        loser_then_winner.observe_owner_roster_proof(winner.clone())?,
        RosterSnapshotDecision::Advanced
    );
    winner_then_loser.observe_owner_roster_proof(winner.clone())?;
    assert_eq!(
        winner_then_loser.observe_owner_roster_proof(loser)?,
        RosterSnapshotDecision::Stale
    );

    for manager in [&loser_then_winner, &winner_then_loser] {
        assert!(manager
            .verified_identity_for_device(DevicePubkey::from_bytes(
                winner_device.public_key().to_bytes()
            ))
            .is_some());
        assert!(manager
            .verified_identity_for_device(DevicePubkey::from_bytes(
                loser_device.public_key().to_bytes()
            ))
            .is_none());
        let stored = manager
            .snapshot()
            .users
            .into_iter()
            .find(|user| {
                user.owner_pubkey == OwnerPubkey::from_bytes(remote_owner.public_key().to_bytes())
            })
            .and_then(|user| user.owner_roster_proof)
            .expect("winning exact proof must be persisted");
        assert_eq!(stored, winner.raw_event());
    }
    Ok(())
}

#[test]
fn sender_resolution_fails_closed_when_sessions_match_multiple_owners() -> Result<()> {
    let local_owner = keys(55);
    let local_device = keys(56);
    let remote_owner = keys(57);
    let duplicate_owner = keys(58);
    let remote_device = keys(59);
    let local_proof = proof(&local_owner, &[(&local_device, 730)], 730)?;
    let remote_proof = proof(&remote_owner, &[(&remote_device, 730)], 730)?;
    let duplicate_proof = proof(&duplicate_owner, &[(&remote_device, 730)], 730)?;
    let remote_device_pubkey = DevicePubkey::from_bytes(remote_device.public_key().to_bytes());
    let remote_owner_pubkey = OwnerPubkey::from_bytes(remote_owner.public_key().to_bytes());
    let mut local = new_manager(&local_owner, &local_device);
    let mut remote = new_manager(&remote_owner, &remote_device);
    local.set_local_owner_roster_proof(local_proof)?;
    let invite = public_invite(&mut remote, 9, 731)?;
    local.observe_verified_device_invite(remote_proof, invite)?;
    let mut send_ctx = context(10, 732);
    local.prepare_remote_send(&mut send_ctx, remote_owner_pubkey, b"hello".to_vec())?;

    let mut snapshot = local.snapshot();
    let original_user = snapshot
        .users
        .iter()
        .find(|user| user.owner_pubkey == remote_owner_pubkey)
        .expect("remote user must exist")
        .clone();
    let sender = original_user
        .devices
        .iter()
        .find(|device| device.device_pubkey == remote_device_pubkey)
        .and_then(|device| device.active_session.as_ref())
        .and_then(|session| {
            session
                .their_current_nostr_public_key
                .or(session.their_next_nostr_public_key)
        })
        .expect("bootstrap session must identify a remote sender key");
    let mut duplicate_user = original_user;
    duplicate_user.owner_pubkey = duplicate_proof.owner_pubkey();
    duplicate_user.owner_roster_proof = Some(duplicate_proof.raw_event().to_string());
    duplicate_user.roster = Some(duplicate_proof.roster().clone());
    duplicate_user.roster_verified = true;
    snapshot.users.push(duplicate_user);

    let restored =
        SessionManager::from_snapshot(snapshot, local_device.secret_key().to_secret_bytes())?;
    assert!(restored
        .verified_identity_for_device(remote_device_pubkey)
        .is_none());
    assert!(restored.resolve_sender(sender).is_none());
    Ok(())
}
