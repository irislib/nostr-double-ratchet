#![allow(dead_code)]

use base64::Engine;
use nostr::nips::nip44::{self, Version};
use nostr::{
    Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp, UnsignedEvent,
};
use nostr_double_ratchet::wire as codec;
use nostr_double_ratchet::{
    owner_roster_proof_from_app_keys_event, parse_owner_roster_proof, AppKeys, AuthorizedDevice,
    Delivery, DeviceEntry, DevicePubkey, DeviceRecordSnapshot, DeviceRoster, Invite,
    InviteResponse, InviteResponseEnvelope, MessageEnvelope, OwnerPubkey, PreparedSend,
    ProcessedInviteResponse, ProtocolContext, ReceivedMessage, Result, RosterSnapshotDecision,
    Session, SessionManager, SessionManagerSnapshot, SessionState, UnixSeconds, UserRecordSnapshot,
};
use rand::{rngs::StdRng, CryptoRng, RngCore, SeedableRng};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

pub const ROOT_URL: &str = "https://chat.iris.to";

pub struct Actor {
    pub secret_key: [u8; 32],
    pub keys: Keys,
    pub device_pubkey: DevicePubkey,
    pub owner_pubkey: OwnerPubkey,
}

pub struct ManagerDevice {
    pub owner_secret_key: [u8; 32],
    pub owner_keys: Keys,
    pub owner_pubkey: OwnerPubkey,
    pub secret_key: [u8; 32],
    pub keys: Keys,
    pub device_pubkey: DevicePubkey,
}

pub struct InviteBootstrap {
    pub alice: Actor,
    pub bob: Actor,
    pub owned_invite: Invite,
    pub invite_response: InviteResponse,
    pub response_envelope: InviteResponseEnvelope,
    pub alice_session: Session,
    pub bob_session: Session,
}

pub struct InviteResponseFixture {
    pub alice: Actor,
    pub bob: Actor,
    pub owned_invite: Invite,
    pub public_invite: Invite,
    pub response_envelope: InviteResponseEnvelope,
    pub bob_session: Session,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteResponseCorruption {
    OuterEnvelope,
    InnerBase64,
    InnerJson,
    PayloadJson,
    InvalidSessionKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMessage {
    pub payload: Vec<u8>,
    pub event: Event,
    pub incoming: MessageEnvelope,
}

pub fn context(seed: u64, now_secs: u64) -> ProtocolContext<'static, StdRng> {
    let mixed_seed = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(17)
        ^ now_secs.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let rng = Box::new(StdRng::seed_from_u64(mixed_seed));
    let rng = Box::leak(rng);
    ProtocolContext::new(UnixSeconds(now_secs), rng)
}

pub fn snapshot<T>(value: &T) -> String
where
    T: Serialize,
{
    serde_json::to_string(value).unwrap()
}

pub fn payload_text(payload: &[u8]) -> String {
    String::from_utf8(payload.to_vec()).expect("payload must be valid utf-8 in this test")
}

pub fn assert_payload_eq(actual: &[u8], expected: &[u8]) {
    assert_eq!(actual, expected);
}

pub fn actor(secret_fill: u8) -> Actor {
    let secret_key = [secret_fill; 32];
    let keys = Keys::new(SecretKey::from_slice(&secret_key).unwrap());
    let device_pubkey = DevicePubkey::from_bytes(keys.public_key().to_bytes());
    Actor {
        secret_key,
        keys,
        device_pubkey,
        owner_pubkey: OwnerPubkey::from_bytes(device_pubkey.to_bytes()),
    }
}

pub fn manager_device(owner_fill: u8, device_fill: u8) -> ManagerDevice {
    let owner_secret_key = [owner_fill; 32];
    let owner_keys = Keys::new(SecretKey::from_slice(&owner_secret_key).unwrap());
    let owner_pubkey = OwnerPubkey::from_bytes(owner_keys.public_key().to_bytes());
    let secret_key = [device_fill; 32];
    let keys = Keys::new(SecretKey::from_slice(&secret_key).unwrap());
    let device_pubkey = DevicePubkey::from_bytes(keys.public_key().to_bytes());
    owner_secret_keys()
        .lock()
        .unwrap()
        .insert(owner_pubkey, owner_secret_key);
    ManagerDevice {
        owner_secret_key,
        owner_keys,
        owner_pubkey,
        secret_key,
        keys,
        device_pubkey,
    }
}

pub fn session_manager(device: &ManagerDevice) -> SessionManager {
    let mut manager = SessionManager::new(device.owner_pubkey, device.secret_key);
    manager
        .set_local_owner_roster_proof(proof_for_roster(
            device.owner_pubkey,
            &roster_for(&[device], 0),
        ))
        .unwrap();
    manager
}

pub fn roster_for(devices: &[&ManagerDevice], created_at: u64) -> DeviceRoster {
    DeviceRoster::new(
        UnixSeconds(created_at),
        devices
            .iter()
            .map(|device| AuthorizedDevice::new(device.device_pubkey, UnixSeconds(created_at)))
            .collect(),
    )
}

pub fn public_invite_via_url(invite: &Invite) -> Result<Invite> {
    codec::parse_invite_url(&codec::invite_url(invite, ROOT_URL)?).map_err(Into::into)
}

pub fn public_invite_via_event(invite: &Invite, signer_secret: [u8; 32]) -> Result<Invite> {
    let keys = Keys::new(SecretKey::from_slice(&signer_secret).unwrap());
    let event = codec::invite_unsigned_event(invite)?
        .sign_with_keys(&keys)
        .map_err(codec_error)?;
    codec::parse_invite_event(&event).map_err(Into::into)
}

pub fn manager_public_device_invite(
    manager: &mut SessionManager,
    device: &ManagerDevice,
    seed: u64,
    now_secs: u64,
) -> Result<Invite> {
    let mut ctx = context(seed, now_secs);
    let invite = manager.ensure_local_invite(&mut ctx)?.clone();
    let _ = device;
    public_invite_via_url(&invite)
}

pub fn custom_public_device_invite(
    device: &ManagerDevice,
    seed: u64,
    now_secs: u64,
) -> Result<Invite> {
    let mut ctx = context(seed, now_secs);
    let invite = Invite::create_new_with_context(
        &mut ctx,
        device.device_pubkey,
        Some(device.owner_pubkey),
        None,
    )?;
    public_invite_via_url(&invite)
}

pub fn manager_receive_delivery<R>(
    manager: &mut SessionManager,
    ctx: &mut ProtocolContext<'_, R>,
    sender_owner: OwnerPubkey,
    delivery: &Delivery,
) -> Result<Option<ReceivedMessage>>
where
    R: RngCore + CryptoRng,
{
    let event = codec::message_event(&delivery.envelope)?;
    let incoming = codec::parse_message_event(&event)?;
    manager.receive(ctx, sender_owner, &incoming)
}

pub fn manager_observe_invite_response<R>(
    manager: &mut SessionManager,
    ctx: &mut ProtocolContext<'_, R>,
    envelope: &InviteResponseEnvelope,
) -> Result<Option<ProcessedInviteResponse>>
where
    R: RngCore + CryptoRng,
{
    let event = codec::invite_response_event(envelope)?;
    let incoming = codec::parse_invite_response_event(&event)?;
    manager.observe_invite_response_with_roster_proof_verifier(
        ctx,
        &incoming,
        |raw, required_device| {
            let proof = parse_owner_roster_proof(raw)?;
            proof.ensure_authorizes_device(required_device)?;
            Ok(proof)
        },
    )
}

pub fn observe_device_invites(
    manager: &mut SessionManager,
    _owner_pubkey: OwnerPubkey,
    invites: &[Invite],
) -> Result<()> {
    for invite in invites {
        manager.observe_device_invite(invite.clone())?;
    }
    Ok(())
}

pub fn restore_manager(
    snapshot: &SessionManagerSnapshot,
    local_device_secret_key: [u8; 32],
) -> Result<SessionManager> {
    let restored: SessionManagerSnapshot =
        serde_json::from_str(&serde_json::to_string(snapshot).unwrap()).unwrap();
    SessionManager::from_snapshot(restored, local_device_secret_key)
}

pub fn manager_user_snapshot(
    snapshot: &SessionManagerSnapshot,
    owner_pubkey: OwnerPubkey,
) -> &UserRecordSnapshot {
    snapshot
        .users
        .iter()
        .find(|user| user.owner_pubkey == owner_pubkey)
        .expect("owner snapshot must exist")
}

pub fn manager_device_snapshot(
    user: &UserRecordSnapshot,
    device_pubkey: DevicePubkey,
) -> &DeviceRecordSnapshot {
    user.devices
        .iter()
        .find(|device| device.device_pubkey == device_pubkey)
        .expect("device snapshot must exist")
}

pub fn prepared_targets(prepared: &PreparedSend) -> Vec<(OwnerPubkey, DevicePubkey)> {
    prepared
        .deliveries
        .iter()
        .map(|delivery| (delivery.owner_pubkey, delivery.device_pubkey))
        .collect()
}

pub fn delivery_by_target(
    prepared: &PreparedSend,
    owner_pubkey: OwnerPubkey,
    device_pubkey: DevicePubkey,
) -> Delivery {
    prepared
        .deliveries
        .iter()
        .find(|delivery| {
            delivery.owner_pubkey == owner_pubkey && delivery.device_pubkey == device_pubkey
        })
        .cloned()
        .expect("target delivery must exist")
}

pub fn received_payloads(received: &[ReceivedMessage]) -> Vec<String> {
    received
        .iter()
        .map(|message| payload_text(&message.payload))
        .collect()
}

pub fn direct_session_pair(
    alice_fill: u8,
    bob_fill: u8,
    base_secs: u64,
) -> Result<(Actor, Actor, Session, Session)> {
    let alice = actor(alice_fill);
    let bob = actor(bob_fill);
    let shared_secret = [77u8; 32];

    let mut alice_init = context(10 + alice_fill as u64, base_secs);
    let alice_session = Session::new_initiator(
        &mut alice_init,
        bob.device_pubkey,
        alice.secret_key,
        shared_secret,
    )?;

    let mut bob_init = context(20 + bob_fill as u64, base_secs);
    let bob_session = Session::new_responder(
        &mut bob_init,
        alice.device_pubkey,
        bob.secret_key,
        shared_secret,
    )?;

    Ok((alice, bob, alice_session, bob_session))
}

pub fn bootstrap_via_invite_url(base_secs: u64) -> Result<InviteBootstrap> {
    bootstrap_via_invite(base_secs, true)
}

pub fn bootstrap_via_invite_event(base_secs: u64) -> Result<InviteBootstrap> {
    bootstrap_via_invite(base_secs, false)
}

fn bootstrap_via_invite(base_secs: u64, via_url: bool) -> Result<InviteBootstrap> {
    let alice = actor(11);
    let bob = actor(12);

    let mut invite_ctx = context(100, base_secs);
    let mut owned_invite =
        Invite::create_new_with_context(&mut invite_ctx, alice.device_pubkey, None, None)?;

    let public_invite = if via_url {
        public_invite_via_url(&owned_invite)?
    } else {
        public_invite_via_event(&owned_invite, alice.secret_key)?
    };

    let mut accept_ctx = context(101, base_secs + 1);
    let (bob_session, response_envelope) =
        public_invite.accept_with_context(&mut accept_ctx, bob.device_pubkey, bob.secret_key)?;

    let event = codec::invite_response_event(&response_envelope)?;
    let incoming = codec::parse_invite_response_event(&event)?;

    let mut process_ctx = context(102, base_secs + 2);
    let invite_response =
        owned_invite.process_response(&mut process_ctx, &incoming, alice.secret_key)?;
    let alice_session = invite_response.session.clone();

    Ok(InviteBootstrap {
        alice,
        bob,
        owned_invite,
        invite_response,
        response_envelope,
        alice_session,
        bob_session,
    })
}

pub fn invite_response_fixture(
    base_secs: u64,
    max_uses: Option<usize>,
) -> Result<InviteResponseFixture> {
    let alice = actor(51);
    let bob = actor(52);

    let mut invite_ctx = context(300, base_secs);
    let owned_invite =
        Invite::create_new_with_context(&mut invite_ctx, alice.device_pubkey, None, max_uses)?;
    let public_invite = public_invite_via_url(&owned_invite)?;

    let mut accept_ctx = context(301, base_secs + 1);
    let (bob_session, response_envelope) =
        public_invite.accept_with_context(&mut accept_ctx, bob.device_pubkey, bob.secret_key)?;

    Ok(InviteResponseFixture {
        alice,
        bob,
        owned_invite,
        public_invite,
        response_envelope,
        bob_session,
    })
}

pub fn send_bytes<R>(
    session: &mut Session,
    ctx: &mut ProtocolContext<'_, R>,
    payload: Vec<u8>,
) -> Result<SentMessage>
where
    R: RngCore + CryptoRng,
{
    let send_plan = session.plan_send(&payload, ctx.now)?;
    let sent = session.apply_send(send_plan);
    let event = codec::message_event(&sent.envelope)?;
    let incoming = codec::parse_message_event(&event)?;
    Ok(SentMessage {
        payload: sent.payload,
        event,
        incoming,
    })
}

pub fn send_text<R>(
    session: &mut Session,
    ctx: &mut ProtocolContext<'_, R>,
    text: impl AsRef<str>,
) -> Result<SentMessage>
where
    R: RngCore + CryptoRng,
{
    send_bytes(session, ctx, text.as_ref().as_bytes().to_vec())
}

pub fn receive_message<R>(
    session: &mut Session,
    ctx: &mut ProtocolContext<'_, R>,
    incoming: &MessageEnvelope,
) -> Result<Vec<u8>>
where
    R: RngCore + CryptoRng,
{
    let plan = session.plan_receive(ctx, incoming)?;
    Ok(session.apply_receive(plan).payload)
}

pub fn receive_event<R>(
    session: &mut Session,
    ctx: &mut ProtocolContext<'_, R>,
    event: &Event,
) -> Result<Vec<u8>>
where
    R: RngCore + CryptoRng,
{
    let incoming = codec::parse_message_event(event)?;
    receive_message(session, ctx, &incoming)
}

pub fn restore_session(state: &SessionState) -> Session {
    let restored: SessionState =
        serde_json::from_str(&serde_json::to_string(state).unwrap()).unwrap();
    Session::from_state(restored)
}

pub fn checkpoint_session(session: &Session) -> SessionState {
    session.state.clone()
}

pub fn mutate_text(value: &str) -> String {
    let mut chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return "A".to_string();
    }
    let index = chars
        .iter()
        .rposition(|c| *c != '=')
        .unwrap_or(chars.len().saturating_sub(1));
    chars[index] = match chars[index] {
        'A' => 'B',
        'B' => 'C',
        _ => 'A',
    };
    chars.into_iter().collect()
}

pub fn signed_event(
    signer_secret: [u8; 32],
    kind: u32,
    content: &str,
    tags: Vec<Tag>,
    created_at: UnixSeconds,
) -> Event {
    let keys = Keys::new(SecretKey::from_slice(&signer_secret).unwrap());
    EventBuilder::new(Kind::from(kind as u16), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at.get()))
        .build(keys.public_key())
        .sign_with_keys(&keys)
        .unwrap()
}

pub fn header_tag(header: &str) -> Tag {
    Tag::parse(["header".to_string(), header.to_string()]).unwrap()
}

pub fn corrupt_invite_response_layer(
    invite: &Invite,
    response: &InviteResponseEnvelope,
    invitee: &Actor,
    corruption: InviteResponseCorruption,
) -> Result<InviteResponseEnvelope> {
    match corruption {
        InviteResponseCorruption::OuterEnvelope => {
            let mut tampered = response.clone();
            tampered.content = mutate_text(&tampered.content);
            Ok(tampered)
        }
        InviteResponseCorruption::InnerJson => {
            reencrypt_outer_response(response, "\"not-json\"".to_string())
        }
        InviteResponseCorruption::InnerBase64 => {
            let mut inner = decrypt_outer_response(invite, response)?;
            inner.content = "***not-base64***".to_string();
            inner.id = None;
            inner.ensure_id();
            reencrypt_outer_response(response, inner.try_as_json()?)
        }
        InviteResponseCorruption::PayloadJson => {
            let mut inner = decrypt_outer_response(invite, response)?;
            inner.content = build_invite_payload_ciphertext(invite, invitee, "{")?;
            inner.id = None;
            inner.ensure_id();
            reencrypt_outer_response(response, inner.try_as_json()?)
        }
        InviteResponseCorruption::InvalidSessionKey => {
            let mut inner = decrypt_outer_response(invite, response)?;
            inner.content = build_invite_payload_ciphertext(
                invite,
                invitee,
                r#"{"sessionKey":"deadbeef","deviceId":"broken-device"}"#,
            )?;
            inner.id = None;
            inner.ensure_id();
            reencrypt_outer_response(response, inner.try_as_json()?)
        }
    }
}

fn decrypt_outer_response(
    invite: &Invite,
    response: &InviteResponseEnvelope,
) -> Result<UnsignedEvent> {
    let inviter_ephemeral_private_key = invite
        .inviter_ephemeral_private_key
        .expect("owned invite must have ephemeral private key");
    let decrypted = nip44::decrypt(
        &SecretKey::from_slice(&inviter_ephemeral_private_key).unwrap(),
        &nostr_pubkey(response.sender),
        &response.content,
    )?;
    Ok(UnsignedEvent::from_json(&decrypted)?)
}

fn reencrypt_outer_response(
    response: &InviteResponseEnvelope,
    plaintext: String,
) -> Result<InviteResponseEnvelope> {
    let content = nip44::encrypt(
        &SecretKey::from_slice(&response.signer_secret_key).unwrap(),
        &nostr_pubkey(response.recipient),
        plaintext,
        Version::V2,
    )?;
    Ok(InviteResponseEnvelope {
        sender: response.sender,
        signer_secret_key: response.signer_secret_key,
        recipient: response.recipient,
        created_at: response.created_at,
        content,
    })
}

fn build_invite_payload_ciphertext(
    invite: &Invite,
    invitee: &Actor,
    payload_json: &str,
) -> Result<String> {
    let dh_encrypted = nip44::encrypt(
        &SecretKey::from_slice(&invitee.secret_key).unwrap(),
        &nostr_pubkey(invite.inviter_device_pubkey),
        payload_json,
        Version::V2,
    )?;
    let conversation_key = nip44::v2::ConversationKey::new(invite.shared_secret);
    let encrypted_bytes = nip44::v2::encrypt_to_bytes(&conversation_key, dh_encrypted.as_bytes())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted_bytes))
}

fn nostr_pubkey(pubkey: DevicePubkey) -> PublicKey {
    PublicKey::from_slice(&pubkey.to_bytes()).unwrap()
}

fn codec_error(error: nostr::event::Error) -> nostr_double_ratchet::Error {
    nostr_double_ratchet::Error::Parse(error.to_string())
}

pub fn provisional_owner_pubkey(device_pubkey: DevicePubkey) -> OwnerPubkey {
    OwnerPubkey::from_bytes(device_pubkey.to_bytes())
}

pub trait SessionManagerCompatExt {
    fn apply_local_roster(&mut self, roster: DeviceRoster) -> RosterSnapshotDecision;

    fn replace_local_roster(&mut self, roster: DeviceRoster) -> RosterSnapshotDecision;

    fn observe_peer_roster(
        &mut self,
        owner_pubkey: OwnerPubkey,
        roster: DeviceRoster,
    ) -> RosterSnapshotDecision;

    fn prepare_send_text<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        text: String,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng;

    fn receive_direct_message<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        sender_owner: OwnerPubkey,
        envelope: &MessageEnvelope,
    ) -> Result<Option<ReceivedMessage>>
    where
        R: RngCore + CryptoRng;

    fn prune_stale_records(&mut self, now: UnixSeconds) -> nostr_double_ratchet::PruneReport;
}

impl SessionManagerCompatExt for SessionManager {
    fn apply_local_roster(&mut self, roster: DeviceRoster) -> RosterSnapshotDecision {
        self.set_local_owner_roster_proof(proof_for_roster(
            self.snapshot().local_owner_pubkey,
            &roster,
        ))
        .unwrap()
    }

    fn replace_local_roster(&mut self, roster: DeviceRoster) -> RosterSnapshotDecision {
        self.apply_local_roster(roster)
    }

    fn observe_peer_roster(
        &mut self,
        owner_pubkey: OwnerPubkey,
        roster: DeviceRoster,
    ) -> RosterSnapshotDecision {
        self.observe_owner_roster_proof(proof_for_roster(owner_pubkey, &roster))
            .unwrap()
    }

    fn prepare_send_text<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        text: String,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.prepare_send(ctx, recipient_owner, text.into_bytes())
    }

    fn receive_direct_message<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        sender_owner: OwnerPubkey,
        envelope: &MessageEnvelope,
    ) -> Result<Option<ReceivedMessage>>
    where
        R: RngCore + CryptoRng,
    {
        self.receive(ctx, sender_owner, envelope)
    }

    fn prune_stale_records(&mut self, now: UnixSeconds) -> nostr_double_ratchet::PruneReport {
        self.prune_stale(now)
    }
}

fn owner_secret_keys() -> &'static Mutex<BTreeMap<OwnerPubkey, [u8; 32]>> {
    static OWNER_SECRET_KEYS: OnceLock<Mutex<BTreeMap<OwnerPubkey, [u8; 32]>>> = OnceLock::new();
    OWNER_SECRET_KEYS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn proof_for_roster(
    owner_pubkey: OwnerPubkey,
    roster: &DeviceRoster,
) -> nostr_double_ratchet::OwnerRosterProof {
    let secret_key = owner_secret_keys()
        .lock()
        .unwrap()
        .get(&owner_pubkey)
        .copied()
        .expect("test owner secret must be registered");
    let owner_keys = Keys::new(SecretKey::from_slice(&secret_key).unwrap());
    let app_keys = AppKeys::new(
        roster
            .devices()
            .iter()
            .map(|device| {
                DeviceEntry::new(
                    device.device_pubkey.to_nostr().unwrap(),
                    device.created_at.get(),
                )
            })
            .collect(),
    );
    let event = app_keys
        .get_event_at(owner_keys.public_key(), roster.created_at.get())
        .sign_with_keys(&owner_keys)
        .unwrap();
    owner_roster_proof_from_app_keys_event(&event).unwrap()
}
