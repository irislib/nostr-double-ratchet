use crate::{
    AuthorizedDevice, DeviceMembership, DevicePubkey, DeviceRoster, DomainError, Error, Invite,
    InviteResponse, InviteResponseEnvelope, MessageEnvelope, OwnerPubkey, ProtocolContext, Result,
    RosterSnapshotDecision, Session, SessionState, UnixSeconds, VerifiedAppKeysIndex,
};
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_INACTIVE_SESSIONS: usize = 10;
#[derive(Debug, Clone)]
pub struct SessionManager {
    local_owner_pubkey: OwnerPubkey,
    local_device_pubkey: DevicePubkey,
    local_device_secret_key: [u8; 32],
    local_invite: Option<Invite>,
    verified_peer_app_keys: VerifiedAppKeysIndex,
    users: BTreeMap<OwnerPubkey, UserRecord>,
}

#[derive(Debug, Clone)]
struct UserRecord {
    owner_pubkey: OwnerPubkey,
    roster: Option<DeviceRoster>,
    devices: BTreeMap<DevicePubkey, DeviceRecord>,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    device_pubkey: DevicePubkey,
    authorized: bool,
    is_stale: bool,
    stale_since: Option<UnixSeconds>,
    claimed_owner_pubkey: Option<OwnerPubkey>,
    public_invite: Option<Invite>,
    invite_response_generated: bool,
    active_session: Option<Session>,
    inactive_sessions: Vec<Session>,
    last_activity: Option<UnixSeconds>,
    created_at: UnixSeconds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionManagerSnapshot {
    pub local_owner_pubkey: OwnerPubkey,
    pub local_device_pubkey: DevicePubkey,
    pub local_invite: Option<Invite>,
    #[serde(default)]
    pub verified_peer_app_keys_events: Vec<nostr::Event>,
    pub users: Vec<UserRecordSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserRecordSnapshot {
    pub owner_pubkey: OwnerPubkey,
    pub roster: Option<DeviceRoster>,
    pub devices: Vec<DeviceRecordSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceRecordSnapshot {
    pub device_pubkey: DevicePubkey,
    pub authorized: bool,
    pub is_stale: bool,
    pub stale_since: Option<UnixSeconds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claimed_owner_pubkey: Option<OwnerPubkey>,
    pub public_invite: Option<Invite>,
    #[serde(default)]
    pub invite_response_generated: bool,
    pub active_session: Option<SessionState>,
    pub inactive_sessions: Vec<SessionState>,
    pub last_activity: Option<UnixSeconds>,
    pub created_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSend {
    pub recipient_owner: OwnerPubkey,
    pub payload: Vec<u8>,
    pub deliveries: Vec<Delivery>,
    pub invite_responses: Vec<InviteResponseEnvelope>,
    pub relay_gaps: Vec<RelayGap>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub owner_pubkey: OwnerPubkey,
    pub device_pubkey: DevicePubkey,
    pub envelope: MessageEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedInviteResponse {
    pub owner_pubkey: OwnerPubkey,
    pub device_pubkey: DevicePubkey,
    pub claimed_owner_pubkey: Option<OwnerPubkey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedMessage {
    pub owner_pubkey: OwnerPubkey,
    pub device_pubkey: DevicePubkey,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum RelayGap {
    MissingRoster {
        owner_pubkey: OwnerPubkey,
    },
    MissingDeviceInvite {
        owner_pubkey: OwnerPubkey,
        device_pubkey: DevicePubkey,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PruneReport {
    pub removed_devices: Vec<(OwnerPubkey, DevicePubkey)>,
    pub removed_users: Vec<OwnerPubkey>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct TargetDevice {
    owner_pubkey: OwnerPubkey,
    device_pubkey: DevicePubkey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendSessionSource {
    Active,
    Inactive(usize),
}

mod lifecycle;
mod records;
mod rosters;
mod sending;

fn apply_roster_snapshot(
    current_roster: Option<&DeviceRoster>,
    incoming_roster: &DeviceRoster,
) -> (RosterSnapshotDecision, DeviceRoster) {
    let Some(current_roster) = current_roster else {
        return (RosterSnapshotDecision::Advanced, incoming_roster.clone());
    };

    if incoming_roster.created_at > current_roster.created_at {
        return (RosterSnapshotDecision::Advanced, incoming_roster.clone());
    }

    if incoming_roster.created_at < current_roster.created_at {
        return (RosterSnapshotDecision::Stale, current_roster.clone());
    }

    (
        RosterSnapshotDecision::MergedEqualTimestamp,
        current_roster.merge(incoming_roster),
    )
}

fn session_priority(session: &Session) -> (u8, u32, u32) {
    let can_send = session.can_send();
    let can_receive = session.state.receiving_chain_key.is_some()
        || session.state.their_current_nostr_public_key.is_some()
        || session.state.receiving_chain_message_number > 0;

    let directionality = match (can_send, can_receive) {
        (true, true) => 3,
        (true, false) => 2,
        (false, true) => 1,
        (false, false) => 0,
    };

    (
        directionality,
        session.state.receiving_chain_message_number,
        session.state.sending_chain_message_number,
    )
}

fn is_one_way_bootstrap_session(session: &Session) -> bool {
    session.state.receiving_chain_key.is_none()
        && session.state.their_current_nostr_public_key.is_none()
}

fn merge_created_at(current: UnixSeconds, observed: UnixSeconds) -> UnixSeconds {
    match (current.get(), observed.get()) {
        (0, _) => observed,
        (_, 0) => current,
        _ => current.min(observed),
    }
}
