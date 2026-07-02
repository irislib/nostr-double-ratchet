//! Invite response interop vectors between Rust and TypeScript.

use nostr::{Event, JsonUtil, Keys, PublicKey, SecretKey};
use nostr_double_ratchet::{
    invite_response_event, parse_invite_response_event, DevicePubkey, Invite, OwnerPubkey, Result,
    UnixSeconds,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

mod support;
use support::context;

#[derive(Debug, Deserialize, Serialize)]
struct InviteResponseVector {
    description: String,
    invite_created_at: u64,
    inviter_device_sk: String,
    inviter_device_pubkey: String,
    inviter_ephemeral_sk: String,
    inviter_ephemeral_pubkey: String,
    shared_secret: String,
    invitee_device_sk: String,
    invitee_device_pubkey: String,
    invitee_owner_pubkey: Option<String>,
    invitee_session_pubkey: String,
    invite_response_event: serde_json::Value,
    expected: ExpectedInviteResponse,
}

#[derive(Debug, Deserialize, Serialize)]
struct ExpectedInviteResponse {
    invitee_identity: String,
    invitee_session_pubkey: String,
    owner_public_key: Option<String>,
}

fn test_vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("test-vectors")
}

fn hex_to_bytes32(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value).expect("invalid hex");
    bytes.as_slice().try_into().expect("expected 32 bytes")
}

fn public_key_from_hex(value: &str) -> PublicKey {
    PublicKey::from_slice(&hex_to_bytes32(value)).expect("invalid pubkey")
}

fn device_pubkey_from_hex(value: &str) -> DevicePubkey {
    DevicePubkey::from_bytes(hex_to_bytes32(value))
}

fn optional_public_key_hex(value: Option<PublicKey>) -> Option<String> {
    value.map(|pubkey| hex::encode(pubkey.to_bytes()))
}

fn owned_invite_from_vector(vector: &InviteResponseVector) -> Invite {
    Invite {
        inviter_device_pubkey: device_pubkey_from_hex(&vector.inviter_device_pubkey),
        inviter_ephemeral_public_key: device_pubkey_from_hex(&vector.inviter_ephemeral_pubkey),
        shared_secret: hex_to_bytes32(&vector.shared_secret),
        inviter_ephemeral_private_key: Some(hex_to_bytes32(&vector.inviter_ephemeral_sk)),
        max_uses: None,
        used_by: Vec::new(),
        used_response_contents: Vec::new(),
        created_at: UnixSeconds(vector.invite_created_at),
        inviter_owner_pubkey: None,
        purpose: None,
        inviter: public_key_from_hex(&vector.inviter_device_pubkey),
        device_id: None,
        owner_public_key: None,
    }
}

fn assert_rust_processes_vector(vector: &InviteResponseVector) -> Result<()> {
    let event = Event::from_json(serde_json::to_string(&vector.invite_response_event)?)?;
    let envelope = parse_invite_response_event(&event)?;
    let mut invite = owned_invite_from_vector(vector);
    let mut process_ctx = context(912, 1_700_300_050);
    let response = invite.process_response(
        &mut process_ctx,
        &envelope,
        hex_to_bytes32(&vector.inviter_device_sk),
    )?;

    assert_eq!(
        hex::encode(response.invitee_identity.to_bytes()),
        vector.expected.invitee_identity
    );
    assert_eq!(
        response.invitee_device_pubkey.to_hex(),
        vector.expected.invitee_identity
    );
    assert_eq!(
        optional_public_key_hex(response.owner_public_key),
        vector.expected.owner_public_key
    );
    assert_eq!(
        response
            .session
            .state
            .their_next_nostr_public_key
            .expect("responder session should point at invitee session pubkey")
            .to_hex(),
        vector.expected.invitee_session_pubkey
    );

    Ok(())
}

fn build_rust_vector() -> Result<InviteResponseVector> {
    let inviter_device_sk =
        hex_to_bytes32("1111111111111111111111111111111111111111111111111111111111111111");
    let invitee_device_sk =
        hex_to_bytes32("3333333333333333333333333333333333333333333333333333333333333333");
    let invitee_owner_sk =
        hex_to_bytes32("4444444444444444444444444444444444444444444444444444444444444444");

    let inviter_keys = Keys::new(SecretKey::from_slice(&inviter_device_sk)?);
    let invitee_keys = Keys::new(SecretKey::from_slice(&invitee_device_sk)?);
    let invitee_owner_keys = Keys::new(SecretKey::from_slice(&invitee_owner_sk)?);

    let mut invite_ctx = context(910, 1_700_300_000);
    let invite = Invite::create_new_with_context(
        &mut invite_ctx,
        DevicePubkey::from_bytes(inviter_keys.public_key().to_bytes()),
        None,
        None,
    )?;

    let mut accept_ctx = context(911, 1_700_300_010);
    let (session, envelope) = invite.accept_with_owner_context(
        &mut accept_ctx,
        DevicePubkey::from_bytes(invitee_keys.public_key().to_bytes()),
        invitee_device_sk,
        Some(OwnerPubkey::from_bytes(
            invitee_owner_keys.public_key().to_bytes(),
        )),
    )?;
    let event = invite_response_event(&envelope)?;
    let invitee_session_pubkey = session
        .state
        .our_current_nostr_key
        .expect("invitee initiator session should expose current key")
        .public_key
        .to_hex();
    let invitee_identity = hex::encode(invitee_keys.public_key().to_bytes());
    let owner_public_key = hex::encode(invitee_owner_keys.public_key().to_bytes());

    Ok(InviteResponseVector {
        description: "Invite response vector generated by Rust".to_string(),
        invite_created_at: invite.created_at.get(),
        inviter_device_sk: hex::encode(inviter_device_sk),
        inviter_device_pubkey: hex::encode(inviter_keys.public_key().to_bytes()),
        inviter_ephemeral_sk: hex::encode(
            invite
                .inviter_ephemeral_private_key
                .expect("owned invite has ephemeral private key"),
        ),
        inviter_ephemeral_pubkey: invite.inviter_ephemeral_public_key.to_hex(),
        shared_secret: hex::encode(invite.shared_secret),
        invitee_device_sk: hex::encode(invitee_device_sk),
        invitee_device_pubkey: invitee_identity.clone(),
        invitee_owner_pubkey: Some(owner_public_key.clone()),
        invitee_session_pubkey: invitee_session_pubkey.clone(),
        invite_response_event: serde_json::from_str(&event.as_json())?,
        expected: ExpectedInviteResponse {
            invitee_identity,
            invitee_session_pubkey,
            owner_public_key: Some(owner_public_key),
        },
    })
}

#[test]
fn generate_and_validate_rust_invite_response_vector() -> Result<()> {
    let output_path = test_vectors_path().join("rust-invite-response-vectors.json");
    let should_regenerate =
        std::env::var("REGENERATE_VECTORS").as_deref() == Ok("true") || !output_path.exists();

    let vector = if should_regenerate {
        let vector = build_rust_vector()?;
        fs::create_dir_all(output_path.parent().unwrap())
            .map_err(|e| nostr_double_ratchet::Error::Storage(e.to_string()))?;
        fs::write(&output_path, serde_json::to_string_pretty(&vector)?)
            .map_err(|e| nostr_double_ratchet::Error::Storage(e.to_string()))?;
        vector
    } else {
        serde_json::from_str(
            &fs::read_to_string(&output_path)
                .map_err(|e| nostr_double_ratchet::Error::Storage(e.to_string()))?,
        )?
    };

    assert_rust_processes_vector(&vector)
}

#[test]
fn rust_processes_typescript_invite_response_vector() -> Result<()> {
    let input_path = test_vectors_path().join("ts-invite-response-vectors.json");
    if !input_path.exists() {
        println!("TypeScript invite response vector not found, skipping...");
        return Ok(());
    }

    let vector: InviteResponseVector = serde_json::from_str(
        &fs::read_to_string(&input_path)
            .map_err(|e| nostr_double_ratchet::Error::Storage(e.to_string()))?,
    )?;
    assert_rust_processes_vector(&vector)
}
