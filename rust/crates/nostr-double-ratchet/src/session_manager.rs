use crate::{
    DevicePubkey, DeviceRoster, DomainError, Error, Invite, InviteResponse, InviteResponseEnvelope,
    MessageEnvelope, OwnerPubkey, OwnerRosterProof, ProtocolContext, Result,
    RosterSnapshotDecision, Session, SessionState, UnixSeconds,
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
    local_owner_roster_proof: Option<OwnerRosterProof>,
    users: BTreeMap<OwnerPubkey, UserRecord>,
}

#[derive(Debug, Clone)]
struct UserRecord {
    owner_pubkey: OwnerPubkey,
    roster: Option<DeviceRoster>,
    roster_verified: bool,
    devices: BTreeMap<DevicePubkey, DeviceRecord>,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    device_pubkey: DevicePubkey,
    authorized: bool,
    is_stale: bool,
    stale_since: Option<UnixSeconds>,
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
    pub users: Vec<UserRecordSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserRecordSnapshot {
    pub owner_pubkey: OwnerPubkey,
    pub roster: Option<DeviceRoster>,
    #[serde(default)]
    pub roster_verified: bool,
    pub devices: Vec<DeviceRecordSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceRecordSnapshot {
    pub device_pubkey: DevicePubkey,
    pub authorized: bool,
    pub is_stale: bool,
    pub stale_since: Option<UnixSeconds>,
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
    pub roster_decision: RosterSnapshotDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedDeviceInvite {
    pub owner_pubkey: OwnerPubkey,
    pub device_pubkey: DevicePubkey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedDeviceIdentity {
    pub owner_pubkey: OwnerPubkey,
    pub device_pubkey: DevicePubkey,
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

impl SessionManager {
    pub fn new(local_owner_pubkey: OwnerPubkey, local_device_secret_key: [u8; 32]) -> Self {
        let local_device_pubkey = crate::device_pubkey_from_secret_bytes(&local_device_secret_key)
            .expect("local device secret key must derive a valid device public key");

        Self {
            local_owner_pubkey,
            local_device_pubkey,
            local_device_secret_key,
            local_invite: None,
            local_owner_roster_proof: None,
            users: BTreeMap::new(),
        }
    }

    pub fn from_snapshot(
        snapshot: SessionManagerSnapshot,
        local_device_secret_key: [u8; 32],
    ) -> Result<Self> {
        let derived_local_device_pubkey =
            crate::device_pubkey_from_secret_bytes(&local_device_secret_key)?;
        if derived_local_device_pubkey != snapshot.local_device_pubkey {
            return Err(DomainError::InvalidState(
                "snapshot local device pubkey does not match provided secret key".to_string(),
            )
            .into());
        }

        let users = snapshot
            .users
            .into_iter()
            .map(UserRecord::from_snapshot)
            .map(|record| (record.owner_pubkey, record))
            .collect();

        Ok(Self {
            local_owner_pubkey: snapshot.local_owner_pubkey,
            local_device_pubkey: snapshot.local_device_pubkey,
            local_device_secret_key,
            local_invite: snapshot.local_invite,
            local_owner_roster_proof: None,
            users,
        })
    }

    pub fn snapshot(&self) -> SessionManagerSnapshot {
        SessionManagerSnapshot {
            local_owner_pubkey: self.local_owner_pubkey,
            local_device_pubkey: self.local_device_pubkey,
            local_invite: self.local_invite.clone(),
            users: self.users.values().map(UserRecord::snapshot).collect(),
        }
    }

    pub fn local_device_pubkey(&self) -> DevicePubkey {
        self.local_device_pubkey
    }

    pub fn replace_local_invite(&mut self, invite: Invite) {
        self.local_invite = Some(invite);
    }

    pub fn observe_owner_roster_proof(
        &mut self,
        proof: OwnerRosterProof,
    ) -> Result<RosterSnapshotDecision> {
        let existing_is_verified = self
            .users
            .get(&proof.owner_pubkey())
            .is_some_and(|user| user.roster_verified);
        let current_created_at = existing_is_verified
            .then(|| {
                self.users
                    .get(&proof.owner_pubkey())
                    .and_then(|user| user.roster.as_ref())
                    .map(|roster| roster.created_at)
            })
            .flatten();
        if current_created_at.is_some_and(|current| proof.roster().created_at < current) {
            return Ok(RosterSnapshotDecision::Stale);
        }

        let owner_pubkey = proof.owner_pubkey();
        let decision = self.apply_roster_for_owner_inner(
            owner_pubkey,
            proof.roster().clone(),
            !existing_is_verified,
        );
        self.user_record_mut(owner_pubkey).roster_verified = true;

        if owner_pubkey == self.local_owner_pubkey {
            if proof
                .roster()
                .get_device(&self.local_device_pubkey)
                .is_some()
            {
                self.local_owner_roster_proof = Some(proof);
            } else {
                self.local_owner_roster_proof = None;
            }
        }

        Ok(decision)
    }

    pub fn set_local_owner_roster_proof(
        &mut self,
        proof: OwnerRosterProof,
    ) -> Result<RosterSnapshotDecision> {
        if proof.owner_pubkey() != self.local_owner_pubkey {
            return Err(DomainError::InvalidState(
                "local owner roster proof belongs to a different owner".to_string(),
            )
            .into());
        }
        proof.ensure_authorizes_device(self.local_device_pubkey)?;
        self.observe_owner_roster_proof(proof)
    }

    pub fn local_owner_roster_proof(&self) -> Option<&OwnerRosterProof> {
        self.local_owner_roster_proof.as_ref()
    }

    pub fn ensure_local_invite<R>(&mut self, ctx: &mut ProtocolContext<'_, R>) -> Result<&Invite>
    where
        R: RngCore + CryptoRng,
    {
        if self.local_invite.is_none() {
            let invite = Invite::create_new_with_context(
                ctx,
                self.local_device_pubkey,
                Some(self.local_owner_pubkey),
                None,
            )?;
            self.observe_public_invite(self.local_owner_pubkey, invite.clone())?;
            self.local_invite = Some(invite);
        }

        Ok(self.local_invite.as_ref().expect("local invite must exist"))
    }

    pub fn observe_verified_device_invite(
        &mut self,
        proof: OwnerRosterProof,
        invite: Invite,
    ) -> Result<ObservedDeviceInvite> {
        let owner_pubkey = proof.owner_pubkey();
        let device_pubkey = invite.inviter_device_pubkey;
        proof.ensure_authorizes_device(device_pubkey)?;
        if invite
            .inviter_owner_pubkey
            .is_some_and(|hint| hint != owner_pubkey)
        {
            return Err(DomainError::InvalidState(
                "invite owner hint does not match roster proof signer".to_string(),
            )
            .into());
        }
        self.observe_owner_roster_proof(proof)?;
        self.observe_device_invite(invite)
    }

    pub fn observe_device_invite(&mut self, invite: Invite) -> Result<ObservedDeviceInvite> {
        let device_pubkey = invite.inviter_device_pubkey;
        let mut owners = self.users.values().filter_map(|user| {
            (user.roster_verified
                && user
                    .roster
                    .as_ref()
                    .and_then(|roster| roster.get_device(&device_pubkey))
                    .is_some())
            .then_some(user.owner_pubkey)
        });
        let owner_pubkey = owners.next().ok_or(DomainError::CannotSendYet)?;
        if owners.next().is_some() {
            return Err(DomainError::InvalidState(
                "device is authorized by more than one owner roster".to_string(),
            )
            .into());
        }
        if invite
            .inviter_owner_pubkey
            .is_some_and(|hint| hint != owner_pubkey)
        {
            return Err(DomainError::InvalidState(
                "invite owner hint does not match verified roster".to_string(),
            )
            .into());
        }
        self.observe_public_invite(owner_pubkey, invite)?;
        Ok(ObservedDeviceInvite {
            owner_pubkey,
            device_pubkey,
        })
    }

    pub fn observe_invite_response<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        envelope: &InviteResponseEnvelope,
    ) -> Result<Option<ProcessedInviteResponse>>
    where
        R: RngCore + CryptoRng,
    {
        self.observe_invite_response_with_roster_proof_verifier(ctx, envelope, |_, _| {
            Err(
                DomainError::InvalidState("owner roster proof verifier required".to_string())
                    .into(),
            )
        })
    }

    pub fn observe_invite_response_with_roster_proof_verifier<R, F>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        envelope: &InviteResponseEnvelope,
        verify_owner_roster_proof: F,
    ) -> Result<Option<ProcessedInviteResponse>>
    where
        R: RngCore + CryptoRng,
        F: FnOnce(&str, DevicePubkey) -> Result<OwnerRosterProof>,
    {
        let Some(invite) = self.local_invite.clone() else {
            return Ok(None);
        };

        let mut owned_invite = invite;
        let InviteResponse {
            session,
            invitee_device_pubkey,
            invitee_owner_pubkey,
            owner_roster_proof,
            ..
        } = owned_invite.process_response(ctx, envelope, self.local_device_secret_key)?;

        let raw_proof = owner_roster_proof.ok_or_else(|| {
            DomainError::InvalidState("invite response missing owner roster proof".to_string())
        })?;
        let proof = verify_owner_roster_proof(&raw_proof, invitee_device_pubkey)?;
        proof.ensure_authorizes_device(invitee_device_pubkey)?;
        if invitee_owner_pubkey.is_some_and(|owner| owner != proof.owner_pubkey()) {
            return Err(DomainError::InvalidState(
                "invite response owner hint does not match roster proof signer".to_string(),
            )
            .into());
        }
        let owner_pubkey = proof.owner_pubkey();
        let roster_decision = self.observe_owner_roster_proof(proof)?;
        let effective_roster_authorizes = self
            .users
            .get(&owner_pubkey)
            .filter(|user| user.roster_verified)
            .and_then(|user| user.roster.as_ref())
            .and_then(|roster| roster.get_device(&invitee_device_pubkey))
            .is_some();
        if !effective_roster_authorizes {
            return Err(DomainError::InvalidState(
                "effective owner roster does not authorize invite responder".to_string(),
            )
            .into());
        }

        self.local_invite = Some(owned_invite);
        let user = self.user_record_mut(owner_pubkey);
        let record = user.device_record_mut(invitee_device_pubkey, ctx.now);
        record.invite_response_generated = true;
        record.upsert_session(session, ctx.now);

        Ok(Some(ProcessedInviteResponse {
            owner_pubkey,
            device_pubkey: invitee_device_pubkey,
            roster_decision,
        }))
    }

    pub fn prepare_send<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.commit_prepared_send(|staged| {
            staged.prepare_send_inner(ctx, recipient_owner, payload, true)
        })
    }

    /// Prepare a send to the recipient owner's authorized devices without also
    /// preparing local sibling sender-copy deliveries.
    ///
    /// `prepare_send` is the higher-level app default. This lower-level variant
    /// is useful for runtimes that need a different payload for local sibling
    /// sync than for peer delivery.
    pub fn prepare_remote_send<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.commit_prepared_send(|staged| {
            staged.prepare_send_inner(ctx, recipient_owner, payload, false)
        })
    }

    pub fn prepare_remote_send_to_devices<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        device_pubkeys: impl IntoIterator<Item = DevicePubkey>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let targets = device_pubkeys
            .into_iter()
            .map(|device_pubkey| TargetDevice {
                owner_pubkey: recipient_owner,
                device_pubkey,
            })
            .collect();
        self.commit_prepared_send(|staged| {
            staged.prepare_explicit_send(ctx, recipient_owner, targets, payload, false)
        })
    }

    pub fn prepare_local_sibling_send<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.commit_prepared_send(|staged| {
            staged.prepare_local_sibling_send_inner(ctx, payload, false)
        })
    }

    pub fn prepare_local_sibling_send_to_devices<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        device_pubkeys: impl IntoIterator<Item = DevicePubkey>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let targets = device_pubkeys
            .into_iter()
            .map(|device_pubkey| TargetDevice {
                owner_pubkey: self.local_owner_pubkey,
                device_pubkey,
            })
            .collect();
        let local_owner_pubkey = self.local_owner_pubkey;
        self.commit_prepared_send(|staged| {
            staged.prepare_explicit_send(ctx, local_owner_pubkey, targets, payload, false)
        })
    }

    pub fn prepare_local_sibling_send_reusing_sessions<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.commit_prepared_send(|staged| {
            staged.prepare_local_sibling_send_inner(ctx, payload, false)
        })
    }

    pub fn prepare_local_sibling_send_refreshing_one_way_sessions<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.commit_prepared_send(|staged| {
            staged.prepare_local_sibling_send_inner(ctx, payload, true)
        })
    }

    pub fn prepare_local_sibling_send_reusing_all_sessions<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.commit_prepared_send(|staged| {
            staged.prepare_local_sibling_send_reusing_all_sessions_inner(ctx, payload)
        })
    }

    fn prepare_local_sibling_send_reusing_all_sessions_inner<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let mut targets = BTreeSet::new();
        self.collect_local_sibling_targets(&mut targets);

        let mut deliveries = Vec::new();
        let mut invite_responses = Vec::new();
        let mut relay_gaps = Vec::new();

        for target in targets {
            let mut target_deliveries = self.prepare_device_deliveries_for_all_send_sessions(
                ctx,
                target.owner_pubkey,
                target.device_pubkey,
                &payload,
            )?;
            if target_deliveries.is_empty() {
                match self.prepare_device_delivery(
                    ctx,
                    target.owner_pubkey,
                    target.device_pubkey,
                    &payload,
                    false,
                )? {
                    Some((delivery, maybe_response)) => {
                        target_deliveries.push(delivery);
                        if let Some(response) = maybe_response {
                            invite_responses.push(response);
                        }
                    }
                    None => {
                        relay_gaps.push(RelayGap::MissingDeviceInvite {
                            owner_pubkey: target.owner_pubkey,
                            device_pubkey: target.device_pubkey,
                        });
                    }
                }
            }
            deliveries.extend(target_deliveries);
        }

        relay_gaps.sort();

        Ok(PreparedSend {
            recipient_owner: self.local_owner_pubkey,
            payload,
            deliveries,
            invite_responses,
            relay_gaps,
        })
    }

    fn commit_prepared_send(
        &mut self,
        prepare: impl FnOnce(&mut Self) -> Result<PreparedSend>,
    ) -> Result<PreparedSend> {
        let mut staged = self.clone();
        let prepared = prepare(&mut staged)?;
        *self = staged;
        Ok(prepared)
    }

    fn prepare_local_sibling_send_inner<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
        refresh_one_way_bootstrap: bool,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let mut targets = BTreeSet::new();
        self.collect_local_sibling_targets(&mut targets);

        let mut deliveries = Vec::new();
        let mut invite_responses = Vec::new();
        let mut relay_gaps = Vec::new();

        for target in targets {
            match self.prepare_device_delivery(
                ctx,
                target.owner_pubkey,
                target.device_pubkey,
                &payload,
                refresh_one_way_bootstrap,
            )? {
                Some((delivery, maybe_response)) => {
                    deliveries.push(delivery);
                    if let Some(response) = maybe_response {
                        invite_responses.push(response);
                    }
                }
                None => {
                    relay_gaps.push(RelayGap::MissingDeviceInvite {
                        owner_pubkey: target.owner_pubkey,
                        device_pubkey: target.device_pubkey,
                    });
                }
            }
        }

        relay_gaps.sort();

        Ok(PreparedSend {
            recipient_owner: self.local_owner_pubkey,
            payload,
            deliveries,
            invite_responses,
            relay_gaps,
        })
    }

    pub(crate) fn has_authorized_local_siblings(&self) -> bool {
        let Some(user) = self.users.get(&self.local_owner_pubkey) else {
            return false;
        };
        if !user.roster_verified || user.roster.is_none() {
            return false;
        }
        user.authorized_non_stale_devices()
            .into_iter()
            .any(|device_pubkey| device_pubkey != self.local_device_pubkey)
    }

    pub fn resolve_sender(&self, sender: DevicePubkey) -> Option<VerifiedDeviceIdentity> {
        self.users.values().find_map(|user| {
            if !user.roster_verified {
                return None;
            }
            user.devices.values().find_map(|record| {
                if !record.authorized || record.is_stale {
                    return None;
                }
                let matches = record
                    .active_session
                    .as_ref()
                    .is_some_and(|session| session.matches_sender(sender))
                    || record
                        .inactive_sessions
                        .iter()
                        .any(|session| session.matches_sender(sender));
                matches.then_some(VerifiedDeviceIdentity {
                    owner_pubkey: user.owner_pubkey,
                    device_pubkey: record.device_pubkey,
                })
            })
        })
    }

    pub fn verified_identity_for_device(
        &self,
        device_pubkey: DevicePubkey,
    ) -> Option<VerifiedDeviceIdentity> {
        self.users.values().find_map(|user| {
            let is_authorized = user.roster_verified
                && user
                    .roster
                    .as_ref()
                    .and_then(|roster| roster.get_device(&device_pubkey))
                    .is_some()
                && user
                    .devices
                    .get(&device_pubkey)
                    .is_some_and(|record| record.authorized && !record.is_stale);
            is_authorized.then_some(VerifiedDeviceIdentity {
                owner_pubkey: user.owner_pubkey,
                device_pubkey,
            })
        })
    }

    pub fn receive_from_verified_sender<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        envelope: &MessageEnvelope,
    ) -> Result<Option<ReceivedMessage>>
    where
        R: RngCore + CryptoRng,
    {
        let Some(identity) = self.resolve_sender(envelope.sender) else {
            return Ok(None);
        };
        self.receive(ctx, identity.owner_pubkey, envelope)
    }

    pub fn receive<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        sender_owner: OwnerPubkey,
        envelope: &MessageEnvelope,
    ) -> Result<Option<ReceivedMessage>>
    where
        R: RngCore + CryptoRng,
    {
        let Some(user) = self.users.get_mut(&sender_owner) else {
            return Ok(None);
        };
        if !user.roster_verified {
            return Ok(None);
        }

        let device_pubkeys: Vec<DevicePubkey> = user.devices.keys().copied().collect();
        for device_pubkey in device_pubkeys {
            let record = user
                .devices
                .get_mut(&device_pubkey)
                .expect("device key collected from map");
            if !record.authorized || record.is_stale {
                continue;
            }

            if let Some(active_session) = record.active_session.as_ref() {
                if active_session.matches_sender(envelope.sender) {
                    let plan = active_session.plan_receive(ctx, envelope)?;
                    let outcome = record
                        .active_session
                        .as_mut()
                        .expect("active session must still exist")
                        .apply_receive(plan);
                    record.last_activity = Some(ctx.now);
                    return Ok(Some(ReceivedMessage {
                        owner_pubkey: sender_owner,
                        device_pubkey,
                        payload: outcome.payload,
                    }));
                }
            }

            let mut matched_inactive = None;
            for (index, session) in record.inactive_sessions.iter().enumerate() {
                if !session.matches_sender(envelope.sender) {
                    continue;
                }
                let plan = session.plan_receive(ctx, envelope)?;
                matched_inactive = Some((index, plan));
                break;
            }

            if let Some((index, plan)) = matched_inactive {
                let mut session = record.inactive_sessions.remove(index);
                let outcome = session.apply_receive(plan);
                record.promote_inactive_session(session);
                record.last_activity = Some(ctx.now);
                return Ok(Some(ReceivedMessage {
                    owner_pubkey: sender_owner,
                    device_pubkey,
                    payload: outcome.payload,
                }));
            }
        }

        Ok(None)
    }

    pub fn prune_stale(&mut self, _now: UnixSeconds) -> PruneReport {
        let mut removed_devices = Vec::new();
        let mut removed_users = Vec::new();

        self.users.retain(|owner_pubkey, user| {
            user.devices.retain(|device_pubkey, record| {
                let keep = !record.is_stale;
                if !keep {
                    removed_devices.push((*owner_pubkey, *device_pubkey));
                }
                keep
            });

            let keep_user = !user.devices.is_empty() || user.roster.is_some();
            if !keep_user {
                removed_users.push(*owner_pubkey);
            }
            keep_user
        });

        removed_devices.sort();
        removed_users.sort();

        PruneReport {
            removed_devices,
            removed_users,
        }
    }

    pub fn delete_user(&mut self, owner_pubkey: OwnerPubkey) {
        if owner_pubkey != self.local_owner_pubkey {
            self.users.remove(&owner_pubkey);
        }
    }

    pub fn import_session_state(
        &mut self,
        owner_pubkey: OwnerPubkey,
        device_pubkey: DevicePubkey,
        state: SessionState,
        now: UnixSeconds,
    ) -> Result<()> {
        let is_authorized = self.users.get(&owner_pubkey).is_some_and(|user| {
            user.roster_verified
                && user
                    .roster
                    .as_ref()
                    .and_then(|roster| roster.get_device(&device_pubkey))
                    .is_some()
        });
        if !is_authorized {
            return Err(DomainError::InvalidState(
                "cannot import a session for an unverified owner/device binding".to_string(),
            )
            .into());
        }
        let user = self.user_record_mut(owner_pubkey);
        let record = user.device_record_mut(device_pubkey, now);
        record.authorized = true;
        record.is_stale = false;
        record.invite_response_generated = true;
        record.upsert_session(Session::from_state(state), now);
        Ok(())
    }

    fn prepare_device_delivery<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        owner_pubkey: OwnerPubkey,
        device_pubkey: DevicePubkey,
        payload: &[u8],
        refresh_one_way_bootstrap: bool,
    ) -> Result<Option<(Delivery, Option<InviteResponseEnvelope>)>>
    where
        R: RngCore + CryptoRng,
    {
        let local_owner_roster_proof = self.local_owner_roster_proof.clone();
        let local_owner_pubkey = self.local_owner_pubkey;
        let local_device_pubkey = self.local_device_pubkey;
        let local_device_secret_key = self.local_device_secret_key;
        let user = self.user_record_mut(owner_pubkey);
        let record = user.device_record_mut(device_pubkey, ctx.now);

        if !record.authorized || record.is_stale {
            return Ok(None);
        }

        let source = record.best_send_session_source();
        let should_refresh_local_sibling_bootstrap = refresh_one_way_bootstrap
            && owner_pubkey == local_owner_pubkey
            && device_pubkey != local_device_pubkey
            && record.public_invite.is_some()
            && source
                .as_ref()
                .and_then(|source| record.session_for_send_source(source))
                .is_some_and(is_one_way_bootstrap_session);

        if should_refresh_local_sibling_bootstrap {
            let public_invite = record
                .public_invite
                .clone()
                .expect("checked public invite presence");
            let proof = local_owner_roster_proof
                .as_ref()
                .ok_or(DomainError::CannotSendYet)?;
            match public_invite.accept_with_owner_roster_proof_context(
                ctx,
                local_device_pubkey,
                local_device_secret_key,
                proof,
            ) {
                Ok((mut session, invite_response)) => {
                    let mut envelope = session
                        .apply_send(session.plan_send(payload, ctx.now)?)
                        .envelope;
                    envelope.recipient = Some(device_pubkey);
                    record.invite_response_generated = true;
                    record.upsert_session(session, ctx.now);

                    return Ok(Some((
                        Delivery {
                            owner_pubkey,
                            device_pubkey,
                            envelope,
                        },
                        Some(invite_response),
                    )));
                }
                Err(Error::Domain(
                    DomainError::InviteAlreadyUsed | DomainError::InviteExhausted,
                )) => {}
                Err(error) => return Err(error),
            }
        }

        if let Some(source) = source {
            let plan = match source {
                SendSessionSource::Active => record
                    .active_session
                    .as_ref()
                    .expect("active session must exist")
                    .plan_send(payload, ctx.now)?,
                SendSessionSource::Inactive(index) => {
                    record.inactive_sessions[index].plan_send(payload, ctx.now)?
                }
            };

            let mut envelope = match source {
                SendSessionSource::Active => {
                    record
                        .active_session
                        .as_mut()
                        .expect("active session must exist")
                        .apply_send(plan)
                        .envelope
                }
                SendSessionSource::Inactive(index) => {
                    let mut session = record.inactive_sessions.remove(index);
                    let outcome = session.apply_send(plan);
                    record.upsert_session(session, ctx.now);
                    outcome.envelope
                }
            };
            envelope.recipient = Some(device_pubkey);

            record.last_activity = Some(ctx.now);
            return Ok(Some((
                Delivery {
                    owner_pubkey,
                    device_pubkey,
                    envelope,
                },
                None,
            )));
        }

        let Some(public_invite) = record.public_invite.clone() else {
            return Ok(None);
        };

        let proof = local_owner_roster_proof
            .as_ref()
            .ok_or(DomainError::CannotSendYet)?;
        let (mut session, invite_response) = match public_invite
            .accept_with_owner_roster_proof_context(
                ctx,
                local_device_pubkey,
                local_device_secret_key,
                proof,
            ) {
            Ok(result) => result,
            Err(Error::Domain(DomainError::InviteAlreadyUsed | DomainError::InviteExhausted)) => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        let mut envelope = session
            .apply_send(session.plan_send(payload, ctx.now)?)
            .envelope;
        envelope.recipient = Some(device_pubkey);
        record.invite_response_generated = true;
        record.upsert_session(session, ctx.now);

        Ok(Some((
            Delivery {
                owner_pubkey,
                device_pubkey,
                envelope,
            },
            Some(invite_response),
        )))
    }

    fn prepare_device_deliveries_for_all_send_sessions<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        owner_pubkey: OwnerPubkey,
        device_pubkey: DevicePubkey,
        payload: &[u8],
    ) -> Result<Vec<Delivery>>
    where
        R: RngCore + CryptoRng,
    {
        let user = self.user_record_mut(owner_pubkey);
        let record = user.device_record_mut(device_pubkey, ctx.now);

        if !record.authorized || record.is_stale {
            return Ok(Vec::new());
        }

        let mut deliveries = Vec::new();

        if let Some(active_session) = record.active_session.as_mut() {
            if active_session.can_send() {
                let plan = active_session.plan_send(payload, ctx.now)?;
                let mut envelope = active_session.apply_send(plan).envelope;
                envelope.recipient = Some(device_pubkey);
                deliveries.push(Delivery {
                    owner_pubkey,
                    device_pubkey,
                    envelope,
                });
            }
        }

        let inactive_sessions = std::mem::take(&mut record.inactive_sessions);
        for mut session in inactive_sessions {
            if session.can_send() {
                let plan = session.plan_send(payload, ctx.now)?;
                let mut envelope = session.apply_send(plan).envelope;
                envelope.recipient = Some(device_pubkey);
                deliveries.push(Delivery {
                    owner_pubkey,
                    device_pubkey,
                    envelope,
                });
            }
            record.upsert_session(session, ctx.now);
        }

        if !deliveries.is_empty() {
            record.last_activity = Some(ctx.now);
        }

        Ok(deliveries)
    }

    fn prepare_send_inner<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        payload: Vec<u8>,
        include_local_siblings: bool,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let mut relay_gaps = Vec::new();
        let mut targets = BTreeSet::new();

        self.collect_recipient_targets(recipient_owner, &mut targets, &mut relay_gaps);
        if include_local_siblings {
            self.collect_local_sibling_targets(&mut targets);
        }

        let mut deliveries = Vec::new();
        let mut invite_responses = Vec::new();

        for target in targets {
            match self.prepare_device_delivery(
                ctx,
                target.owner_pubkey,
                target.device_pubkey,
                &payload,
                false,
            )? {
                Some((delivery, maybe_response)) => {
                    deliveries.push(delivery);
                    if let Some(response) = maybe_response {
                        invite_responses.push(response);
                    }
                }
                None => {
                    relay_gaps.push(RelayGap::MissingDeviceInvite {
                        owner_pubkey: target.owner_pubkey,
                        device_pubkey: target.device_pubkey,
                    });
                }
            }
        }

        relay_gaps.sort();

        Ok(PreparedSend {
            recipient_owner,
            payload,
            deliveries,
            invite_responses,
            relay_gaps,
        })
    }

    fn prepare_explicit_send<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        targets: BTreeSet<TargetDevice>,
        payload: Vec<u8>,
        refresh_one_way_bootstrap: bool,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let mut deliveries = Vec::new();
        let mut invite_responses = Vec::new();
        let mut relay_gaps = Vec::new();

        for target in targets {
            match self.prepare_device_delivery(
                ctx,
                target.owner_pubkey,
                target.device_pubkey,
                &payload,
                refresh_one_way_bootstrap,
            )? {
                Some((delivery, maybe_response)) => {
                    deliveries.push(delivery);
                    if let Some(response) = maybe_response {
                        invite_responses.push(response);
                    }
                }
                None => {
                    relay_gaps.push(RelayGap::MissingDeviceInvite {
                        owner_pubkey: target.owner_pubkey,
                        device_pubkey: target.device_pubkey,
                    });
                }
            }
        }

        relay_gaps.sort();

        Ok(PreparedSend {
            recipient_owner,
            payload,
            deliveries,
            invite_responses,
            relay_gaps,
        })
    }

    fn collect_recipient_targets(
        &self,
        recipient_owner: OwnerPubkey,
        targets: &mut BTreeSet<TargetDevice>,
        relay_gaps: &mut Vec<RelayGap>,
    ) {
        let Some(user) = self.users.get(&recipient_owner) else {
            relay_gaps.push(RelayGap::MissingRoster {
                owner_pubkey: recipient_owner,
            });
            return;
        };

        if !user.roster_verified
            || user
                .roster
                .as_ref()
                .is_none_or(|roster| roster.devices().is_empty())
        {
            relay_gaps.push(RelayGap::MissingRoster {
                owner_pubkey: recipient_owner,
            });
            return;
        }

        for device_pubkey in user.authorized_non_stale_devices() {
            targets.insert(TargetDevice {
                owner_pubkey: recipient_owner,
                device_pubkey,
            });
        }
    }

    fn collect_local_sibling_targets(&self, targets: &mut BTreeSet<TargetDevice>) {
        let Some(user) = self.users.get(&self.local_owner_pubkey) else {
            return;
        };

        if !user.roster_verified || user.roster.is_none() {
            return;
        }

        for device_pubkey in user.authorized_non_stale_devices() {
            if device_pubkey == self.local_device_pubkey {
                continue;
            }
            targets.insert(TargetDevice {
                owner_pubkey: self.local_owner_pubkey,
                device_pubkey,
            });
        }
    }

    fn observe_public_invite(&mut self, owner_pubkey: OwnerPubkey, invite: Invite) -> Result<()> {
        if let Some(inviter_owner_pubkey) = invite.inviter_owner_pubkey {
            if inviter_owner_pubkey != owner_pubkey {
                return Err(DomainError::InvalidState(format!(
                    "invite owner mismatch: expected {owner_pubkey}, got {inviter_owner_pubkey}"
                ))
                .into());
            }
        }

        let device_pubkey = invite.inviter_device_pubkey;
        let mut public_invite = invite;
        public_invite.inviter_ephemeral_private_key = None;

        let user = self.user_record_mut(owner_pubkey);
        let record = user.device_record_mut(device_pubkey, public_invite.created_at);

        let should_replace_invite = record
            .public_invite
            .as_ref()
            .is_none_or(|existing| public_invite.created_at >= existing.created_at);

        record.created_at = merge_created_at(record.created_at, public_invite.created_at);
        if should_replace_invite {
            record.public_invite = Some(public_invite);
        }
        Ok(())
    }

    fn apply_roster_for_owner_inner(
        &mut self,
        owner_pubkey: OwnerPubkey,
        incoming_roster: DeviceRoster,
        replace_existing: bool,
    ) -> RosterSnapshotDecision {
        let user = self.user_record_mut(owner_pubkey);
        let current_roster = user.roster.as_ref();
        let (decision, next_roster) = if replace_existing {
            (RosterSnapshotDecision::Advanced, incoming_roster)
        } else {
            apply_roster_snapshot(current_roster, &incoming_roster)
        };

        let previous_authorized = current_roster
            .map(authorized_device_set)
            .unwrap_or_default();
        let next_authorized = authorized_device_set(&next_roster);

        user.roster = Some(next_roster.clone());

        for device in next_roster.devices() {
            let record = user.device_record_mut(device.device_pubkey, device.created_at);
            record.authorized = true;
            record.is_stale = false;
            record.stale_since = None;
            record.created_at = merge_created_at(record.created_at, device.created_at);
        }

        for removed in previous_authorized.difference(&next_authorized) {
            let record = user.device_record_mut(*removed, next_roster.created_at);
            record.authorized = false;
            record.is_stale = true;
            if record.stale_since.is_none() {
                record.stale_since = Some(next_roster.created_at);
            }
        }

        decision
    }

    fn user_record_mut(&mut self, owner_pubkey: OwnerPubkey) -> &mut UserRecord {
        self.users
            .entry(owner_pubkey)
            .or_insert_with(|| UserRecord::new(owner_pubkey))
    }
}

impl UserRecord {
    fn new(owner_pubkey: OwnerPubkey) -> Self {
        Self {
            owner_pubkey,
            roster: None,
            roster_verified: false,
            devices: BTreeMap::new(),
        }
    }

    fn from_snapshot(snapshot: UserRecordSnapshot) -> Self {
        let roster_is_verified = snapshot.roster_verified;
        Self {
            owner_pubkey: snapshot.owner_pubkey,
            roster: snapshot.roster,
            roster_verified: snapshot.roster_verified,
            devices: snapshot
                .devices
                .into_iter()
                .map(|snapshot| DeviceRecord::from_snapshot(snapshot, roster_is_verified))
                .map(|record| (record.device_pubkey, record))
                .collect(),
        }
    }

    fn snapshot(&self) -> UserRecordSnapshot {
        UserRecordSnapshot {
            owner_pubkey: self.owner_pubkey,
            roster: self.roster.clone(),
            roster_verified: self.roster_verified,
            devices: self.devices.values().map(DeviceRecord::snapshot).collect(),
        }
    }

    fn device_record_mut(
        &mut self,
        device_pubkey: DevicePubkey,
        created_at: UnixSeconds,
    ) -> &mut DeviceRecord {
        self.devices
            .entry(device_pubkey)
            .or_insert_with(|| DeviceRecord::new(device_pubkey, created_at))
    }

    fn authorized_non_stale_devices(&self) -> Vec<DevicePubkey> {
        self.devices
            .values()
            .filter(|record| record.authorized && !record.is_stale)
            .map(|record| record.device_pubkey)
            .collect()
    }
}

impl DeviceRecord {
    fn new(device_pubkey: DevicePubkey, created_at: UnixSeconds) -> Self {
        Self {
            device_pubkey,
            authorized: false,
            is_stale: false,
            stale_since: None,
            public_invite: None,
            invite_response_generated: false,
            active_session: None,
            inactive_sessions: Vec::new(),
            last_activity: None,
            created_at,
        }
    }

    fn from_snapshot(snapshot: DeviceRecordSnapshot, roster_is_verified: bool) -> Self {
        Self {
            device_pubkey: snapshot.device_pubkey,
            authorized: roster_is_verified && snapshot.authorized,
            is_stale: snapshot.is_stale,
            stale_since: snapshot.stale_since,
            public_invite: snapshot.public_invite,
            invite_response_generated: snapshot.invite_response_generated,
            active_session: snapshot.active_session.map(Session::from_state),
            inactive_sessions: snapshot
                .inactive_sessions
                .into_iter()
                .map(Session::from_state)
                .collect(),
            last_activity: snapshot.last_activity,
            created_at: snapshot.created_at,
        }
    }

    fn snapshot(&self) -> DeviceRecordSnapshot {
        DeviceRecordSnapshot {
            device_pubkey: self.device_pubkey,
            authorized: self.authorized,
            is_stale: self.is_stale,
            stale_since: self.stale_since,
            public_invite: self.public_invite.clone(),
            invite_response_generated: self.invite_response_generated,
            active_session: self
                .active_session
                .as_ref()
                .map(|session| session.state.clone()),
            inactive_sessions: self
                .inactive_sessions
                .iter()
                .map(|session| session.state.clone())
                .collect(),
            last_activity: self.last_activity,
            created_at: self.created_at,
        }
    }

    fn best_send_session_source(&self) -> Option<SendSessionSource> {
        let mut best: Option<(SendSessionSource, (u8, u32, u32))> = None;

        if let Some(active_session) = self.active_session.as_ref() {
            if active_session.can_send() {
                best = Some((SendSessionSource::Active, session_priority(active_session)));
            }
        }

        for (index, session) in self.inactive_sessions.iter().enumerate() {
            if !session.can_send() {
                continue;
            }
            let priority = session_priority(session);
            if best
                .as_ref()
                .is_none_or(|(_, current_priority)| priority > *current_priority)
            {
                best = Some((SendSessionSource::Inactive(index), priority));
            }
        }

        best.map(|(source, _)| source)
    }

    fn session_for_send_source(&self, source: &SendSessionSource) -> Option<&Session> {
        match source {
            SendSessionSource::Active => self.active_session.as_ref(),
            SendSessionSource::Inactive(index) => self.inactive_sessions.get(*index),
        }
    }

    fn upsert_session(&mut self, session: Session, now: UnixSeconds) {
        if self.contains_state(&session.state) {
            self.compact_duplicate_sessions();
            self.last_activity = Some(now);
            return;
        }

        let new_priority = session_priority(&session);
        let old_priority = self
            .active_session
            .as_ref()
            .map(session_priority)
            .unwrap_or((0, 0, 0));

        if let Some(old_active) = self.active_session.take() {
            if old_priority >= new_priority {
                self.inactive_sessions.push(session);
                self.active_session = Some(old_active);
            } else {
                self.inactive_sessions.push(old_active);
                self.active_session = Some(session);
            }
        } else {
            self.active_session = Some(session);
        }

        self.compact_duplicate_sessions();
        if self.inactive_sessions.len() > MAX_INACTIVE_SESSIONS {
            self.inactive_sessions.truncate(MAX_INACTIVE_SESSIONS);
        }
        self.last_activity = Some(now);
    }

    fn promote_inactive_session(&mut self, session: Session) {
        let new_priority = session_priority(&session);
        if let Some(old_active) = self.active_session.take() {
            let old_priority = session_priority(&old_active);
            if new_priority > old_priority {
                if old_active.state != session.state {
                    self.inactive_sessions.push(old_active);
                }
                self.active_session = Some(session);
            } else {
                self.inactive_sessions.push(session);
                self.active_session = Some(old_active);
            }
        } else {
            self.active_session = Some(session);
        }
        self.compact_duplicate_sessions();
        if self.inactive_sessions.len() > MAX_INACTIVE_SESSIONS {
            self.inactive_sessions.truncate(MAX_INACTIVE_SESSIONS);
        }
    }

    fn contains_state(&self, state: &SessionState) -> bool {
        self.active_session
            .as_ref()
            .is_some_and(|session| session.state == *state)
            || self
                .inactive_sessions
                .iter()
                .any(|session| session.state == *state)
    }

    fn compact_duplicate_sessions(&mut self) {
        let active_state = self
            .active_session
            .as_ref()
            .map(|session| session.state.clone());
        let mut unique_states = Vec::new();
        let mut inactive_sessions = Vec::with_capacity(self.inactive_sessions.len());

        for session in self.inactive_sessions.drain(..) {
            let is_duplicate = active_state
                .as_ref()
                .is_some_and(|state| *state == session.state)
                || unique_states.contains(&session.state);
            if is_duplicate {
                continue;
            }
            unique_states.push(session.state.clone());
            inactive_sessions.push(session);
        }

        self.inactive_sessions = inactive_sessions;
    }
}

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

fn authorized_device_set(roster: &DeviceRoster) -> BTreeSet<DevicePubkey> {
    roster
        .devices()
        .iter()
        .map(|device| device.device_pubkey)
        .collect()
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
