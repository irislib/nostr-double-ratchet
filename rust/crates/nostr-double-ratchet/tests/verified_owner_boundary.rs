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
fn restore_requires_runtime_to_reingest_local_signed_proof() -> Result<()> {
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

    let mut restored =
        SessionManager::from_snapshot(original.snapshot(), device.secret_key().to_secret_bytes())?;
    assert!(restored.local_owner_roster_proof().is_none());

    let mut blocked_ctx = context(6, 502);
    let before = restored.snapshot();
    let blocked = restored.prepare_remote_send(
        &mut blocked_ctx,
        OwnerPubkey::from_bytes(remote_owner.public_key().to_bytes()),
        b"blocked".to_vec(),
    );
    assert!(matches!(
        blocked,
        Err(Error::Domain(DomainError::CannotSendYet))
    ));
    assert_eq!(restored.snapshot(), before);

    restored.set_local_owner_roster_proof(local_proof)?;
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
    remote_user.roster_verified = false;

    let restored = SessionManager::from_snapshot(legacy, device.secret_key().to_secret_bytes())?;
    assert!(restored
        .verified_identity_for_device(DevicePubkey::from_bytes(
            remote_device.public_key().to_bytes()
        ))
        .is_none());
    Ok(())
}
