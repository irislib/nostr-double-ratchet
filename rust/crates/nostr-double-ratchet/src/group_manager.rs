use crate::{
    device_pubkey_from_secret_bytes, random_secret_key_bytes, DevicePubkey, DomainError,
    GroupCreateResult, GroupIncomingEvent, GroupManagerSnapshot, GroupPairwiseCommand,
    GroupPayloadCodec, GroupPayloadEncodeContext, GroupPendingFanout, GroupPreparedPublish,
    GroupPreparedSend, GroupProtocol, GroupReceivedMessage, GroupSenderKeyHandleResult,
    GroupSenderKeyMessage, GroupSenderKeyMessageEnvelope, GroupSenderKeyPlaintext,
    GroupSenderKeyPlaintextDecodeContext, GroupSenderKeyRecordSnapshot,
    GroupSenderKeyRepairRequestEvent, GroupSenderKeyRepairSnapshot, GroupSnapshot, OwnerPubkey,
    ProtocolContext, Result, SenderEventPubkey, SenderKeyDistribution, SenderKeyMessageContent,
    SenderKeyRepairRequest, SenderKeyState, SessionManager, UnixSeconds,
};
use rand::{CryptoRng, RngCore};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct GroupManager<C> {
    payload_codec: C,
    local_owner_pubkey: OwnerPubkey,
    groups: BTreeMap<String, GroupRecord>,
    sender_keys: BTreeMap<SenderKeyRecordId, SenderKeyRecord>,
    sender_event_index: BTreeMap<SenderEventPubkey, SenderKeyRecordId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GroupRecord {
    group_id: String,
    protocol: GroupProtocol,
    name: String,
    picture: Option<String>,
    about: Option<String>,
    created_by: OwnerPubkey,
    members: BTreeSet<OwnerPubkey>,
    admins: BTreeSet<OwnerPubkey>,
    revision: u64,
    created_at: UnixSeconds,
    updated_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SenderKeyRecordId {
    group_id: String,
    sender_owner: OwnerPubkey,
    sender_device: DevicePubkey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SenderKeyRecord {
    group_id: String,
    sender_owner: OwnerPubkey,
    sender_device: DevicePubkey,
    sender_event_pubkey: SenderEventPubkey,
    sender_event_secret_key: Option<[u8; 32]>,
    latest_key_id: Option<u32>,
    states: BTreeMap<u32, SenderKeyState>,
    distribution_history: BTreeMap<u32, SenderKeyDistribution>,
    distributed_to: BTreeMap<u32, BTreeSet<OwnerPubkey>>,
    repair_snapshots: Vec<GroupSenderKeyRepairSnapshot>,
}

mod incoming;
mod management;
mod records;
mod sender_keys;

fn random_group_id<R>(ctx: &mut ProtocolContext<'_, R>) -> String
where
    R: RngCore + CryptoRng,
{
    let mut bytes = [0u8; 16];
    ctx.rng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn encode_context<R>(
    session_manager: &SessionManager,
    ctx: &ProtocolContext<'_, R>,
) -> GroupPayloadEncodeContext
where
    R: RngCore + CryptoRng,
{
    GroupPayloadEncodeContext {
        local_device_pubkey: session_manager.local_device_pubkey(),
        created_at: ctx.now,
    }
}

fn random_key_id<R>(ctx: &mut ProtocolContext<'_, R>) -> u32
where
    R: RngCore + CryptoRng,
{
    loop {
        let id = ctx.rng.next_u32();
        if id != 0 {
            return id;
        }
    }
}

fn validate_supported_protocol(protocol: GroupProtocol) -> Result<()> {
    if protocol.is_pairwise_fanout_v1() || protocol.is_sender_key_v1() {
        Ok(())
    } else {
        Err(group_error(format!(
            "unsupported group protocol {:?}/{}",
            protocol.strategy, protocol.version
        )))
    }
}

fn validate_unique_owners(values: &[OwnerPubkey], label: &str) -> Result<BTreeSet<OwnerPubkey>> {
    let set: BTreeSet<_> = values.iter().copied().collect();
    if set.len() != values.len() {
        return Err(group_error(format!("duplicate {label} are not allowed")));
    }
    Ok(set)
}

fn validate_group_invariants(
    members: &BTreeSet<OwnerPubkey>,
    admins: &BTreeSet<OwnerPubkey>,
) -> Result<()> {
    if members.is_empty() {
        return Err(group_error("group must have at least one member"));
    }
    if admins.is_empty() {
        return Err(group_error("group must have at least one admin"));
    }
    if !admins.is_subset(members) {
        return Err(group_error("all admins must also be members"));
    }
    Ok(())
}

fn merge_group_prepared_publish(into: &mut GroupPreparedPublish, next: GroupPreparedPublish) {
    into.deliveries.extend(next.deliveries);
    into.invite_responses.extend(next.invite_responses);
    into.sender_key_messages.extend(next.sender_key_messages);
    into.relay_gaps.extend(next.relay_gaps);
    into.relay_gaps.sort();
    into.relay_gaps.dedup();
    for fanout in next.pending_fanouts {
        if !into.pending_fanouts.contains(&fanout) {
            into.pending_fanouts.push(fanout);
        }
    }
}

fn empty_group_prepared_send(group_id: String) -> GroupPreparedSend {
    GroupPreparedSend {
        group_id,
        remote: GroupPreparedPublish::empty(),
        local_sibling: GroupPreparedPublish::empty(),
    }
}

fn group_error(message: impl Into<String>) -> crate::Error {
    DomainError::InvalidGroupOperation(message.into()).into()
}

fn pending_group_revision_error(
    group_id: impl Into<String>,
    current_revision: u64,
    required_revision: u64,
) -> crate::Error {
    DomainError::PendingGroupRevision {
        group_id: group_id.into(),
        current_revision,
        required_revision,
    }
    .into()
}
