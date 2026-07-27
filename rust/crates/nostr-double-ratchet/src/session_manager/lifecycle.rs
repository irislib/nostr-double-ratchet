use super::*;

impl SessionManager {
    pub fn new(local_owner_pubkey: OwnerPubkey, local_device_secret_key: [u8; 32]) -> Self {
        let local_device_pubkey = crate::device_pubkey_from_secret_bytes(&local_device_secret_key)
            .expect("local device secret key must derive a valid device public key");

        Self {
            local_owner_pubkey,
            local_device_pubkey,
            local_device_secret_key,
            local_invite: None,
            verified_peer_app_keys: VerifiedAppKeysIndex::default(),
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

        let mut verified_peer_app_keys = VerifiedAppKeysIndex::default();
        for event in snapshot.verified_peer_app_keys_events {
            let observed_at = event.created_at.as_secs();
            // Invalid or corrupt persisted evidence fails closed. A stored event
            // was already accepted at observation time, so restore validates it
            // against its own timestamp rather than the current wall clock.
            let _ = verified_peer_app_keys.ingest(event, observed_at);
        }

        let users = snapshot
            .users
            .into_iter()
            .map(UserRecord::from_snapshot)
            .map(|record| (record.owner_pubkey, record))
            .collect();

        let mut manager = Self {
            local_owner_pubkey: snapshot.local_owner_pubkey,
            local_device_pubkey: snapshot.local_device_pubkey,
            local_device_secret_key,
            local_invite: snapshot.local_invite,
            verified_peer_app_keys,
            users,
        };

        // Cached roster projections and authorization flags are not owner proof.
        // Rebuild authorization from exact signed AppKeys evidence first, then
        // promote only provisional claims covered by that evidence.
        let restored_owners = manager.users.keys().copied().collect::<Vec<_>>();
        for owner_pubkey in restored_owners.iter().copied() {
            manager.recompute_authorization_for_owner(owner_pubkey);
        }
        let verified_owners = manager
            .verified_peer_app_keys
            .owners()
            .into_iter()
            .map(|owner| OwnerPubkey::from_bytes(owner.to_bytes()))
            .collect::<Vec<_>>();
        for owner_pubkey in verified_owners {
            let now = owner_pubkey
                .to_nostr()
                .ok()
                .and_then(|owner| manager.verified_peer_app_keys.head_created_at(owner))
                .map(UnixSeconds)
                .unwrap_or(UnixSeconds(0));
            manager.reconcile_verified_claimed_devices(owner_pubkey, now);
            manager.recompute_authorization_for_owner(owner_pubkey);
        }

        Ok(manager)
    }

    pub fn snapshot(&self) -> SessionManagerSnapshot {
        SessionManagerSnapshot {
            local_owner_pubkey: self.local_owner_pubkey,
            local_device_pubkey: self.local_device_pubkey,
            local_invite: self.local_invite.clone(),
            verified_peer_app_keys_events: self.verified_peer_app_keys.events(),
            users: self.users.values().map(UserRecord::snapshot).collect(),
        }
    }

    pub fn local_device_pubkey(&self) -> DevicePubkey {
        self.local_device_pubkey
    }

    pub fn replace_local_invite(&mut self, invite: Invite) {
        self.local_invite = Some(invite);
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

    pub fn apply_local_roster(&mut self, roster: DeviceRoster) -> RosterSnapshotDecision {
        self.apply_roster_for_owner(self.local_owner_pubkey, roster)
    }

    pub fn replace_local_roster(&mut self, roster: DeviceRoster) -> RosterSnapshotDecision {
        self.apply_roster_for_owner_inner(self.local_owner_pubkey, roster, true)
    }

    /// Observe a peer roster as an operational projection only.
    ///
    /// This method never grants a distinct device (`O != D`) authority to act
    /// for the owner. Feed the exact signed event to
    /// [`SessionManager::observe_peer_app_keys_event`] to establish that proof.
    /// Observations naming the local owner are ignored; local roster changes
    /// must use [`SessionManager::apply_local_roster`] or
    /// [`SessionManager::replace_local_roster`].
    pub fn observe_peer_roster(
        &mut self,
        owner_pubkey: OwnerPubkey,
        roster: DeviceRoster,
    ) -> RosterSnapshotDecision {
        if owner_pubkey == self.local_owner_pubkey {
            return RosterSnapshotDecision::Stale;
        }
        self.apply_roster_for_owner(owner_pubkey, roster)
    }

    /// Observe exact AppKeys evidence signed by a peer owner.
    ///
    /// A plain `DeviceRoster` is only an operational projection. Distinct
    /// owner/device authorization (`O != D`) is granted only through this path.
    pub fn observe_peer_app_keys_event(
        &mut self,
        event: nostr::Event,
        observed_at: UnixSeconds,
    ) -> Result<bool> {
        let owner_nostr = event.pubkey;
        let event_id = event.id;
        let owner = OwnerPubkey::from_bytes(owner_nostr.to_bytes());
        let created_at = UnixSeconds(event.created_at.as_secs());
        if !self
            .verified_peer_app_keys
            .ingest(event, observed_at.get())?
        {
            return Ok(false);
        }
        let app_keys = self
            .verified_peer_app_keys
            .app_keys_for_event(owner_nostr, event_id)
            .expect("successfully ingested AppKeys candidate must remain indexed");

        let roster = DeviceRoster::new(
            created_at,
            app_keys
                .get_all_devices()
                .into_iter()
                .map(|device| {
                    AuthorizedDevice::new(
                        DevicePubkey::from_bytes(device.identity_pubkey.to_bytes()),
                        UnixSeconds(device.created_at),
                    )
                })
                .collect(),
        );
        self.apply_roster_for_owner(owner, roster);
        Ok(true)
    }

    pub fn observe_device_invite(
        &mut self,
        owner_pubkey: OwnerPubkey,
        invite: Invite,
    ) -> Result<()> {
        self.observe_public_invite(owner_pubkey, invite)
    }

    pub fn observe_invite_response<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        envelope: &InviteResponseEnvelope,
    ) -> Result<Option<ProcessedInviteResponse>>
    where
        R: RngCore + CryptoRng,
    {
        let Some(invite) = self.local_invite.clone() else {
            return Ok(None);
        };

        let mut owned_invite = invite;
        let InviteResponse {
            session,
            invitee_device_pubkey,
            invitee_owner_pubkey,
            ..
        } = owned_invite.process_response(ctx, envelope, self.local_device_secret_key)?;

        self.local_invite = Some(owned_invite);

        let invitee_owner_pubkey = invitee_owner_pubkey.ok_or_else(|| {
            DomainError::InvalidState("invite response missing owner claim".to_string())
        })?;

        Ok(Some(self.store_claimed_session(
            invitee_owner_pubkey,
            invitee_device_pubkey,
            session,
            ctx.now,
        )))
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
        self.prepare_send_inner(ctx, recipient_owner, payload, true)
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
        self.prepare_send_inner(ctx, recipient_owner, payload, false)
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
        self.prepare_explicit_send(ctx, recipient_owner, targets, payload, Vec::new(), false)
    }

    pub fn prepare_local_sibling_send<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.prepare_local_sibling_send_inner(ctx, payload, false)
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
        self.prepare_explicit_send(
            ctx,
            self.local_owner_pubkey,
            targets,
            payload,
            Vec::new(),
            false,
        )
    }

    pub fn prepare_local_sibling_send_reusing_sessions<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.prepare_local_sibling_send_inner(ctx, payload, false)
    }

    pub fn prepare_local_sibling_send_refreshing_one_way_sessions<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.prepare_local_sibling_send_inner(ctx, payload, true)
    }

    pub fn prepare_local_sibling_send_reusing_all_sessions<R>(
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

    pub(super) fn prepare_local_sibling_send_inner<R>(
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
        self.prepare_explicit_send(
            ctx,
            self.local_owner_pubkey,
            targets,
            payload,
            Vec::new(),
            refresh_one_way_bootstrap,
        )
    }

    pub(crate) fn has_authorized_local_siblings(&self) -> bool {
        let Some(user) = self.users.get(&self.local_owner_pubkey) else {
            return false;
        };
        if user.roster.is_none() {
            return false;
        }
        user.authorized_non_stale_devices()
            .into_iter()
            .any(|device_pubkey| device_pubkey != self.local_device_pubkey)
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
        let owner_authorized_devices = self.authorized_devices_for_owner(sender_owner);
        let Some(user) = self.users.get_mut(&sender_owner) else {
            return Ok(None);
        };

        let device_pubkeys: Vec<DevicePubkey> = user.devices.keys().copied().collect();
        for device_pubkey in device_pubkeys {
            let record = user
                .devices
                .get_mut(&device_pubkey)
                .expect("device key collected from map");

            let has_owner_binding = crate::owner_pubkey_from_device_pubkey(device_pubkey)
                == sender_owner
                || owner_authorized_devices.contains(&device_pubkey);
            if !has_owner_binding || !record.authorized || record.is_stale {
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
    ) {
        self.import_claimed_session_state(owner_pubkey, device_pubkey, state, now);
    }

    /// Import a session whose peer device is authenticated by the ratchet but
    /// whose claimed owner still requires roster verification.
    ///
    /// If the owner/device binding is not verified, the session is retained
    /// under the device's own identity and the claimed owner remains
    /// provisional. A later roster containing the device promotes the session
    /// to the claimed owner.
    pub fn import_claimed_session_state(
        &mut self,
        claimed_owner_pubkey: OwnerPubkey,
        authenticated_device_pubkey: DevicePubkey,
        state: SessionState,
        now: UnixSeconds,
    ) -> ProcessedInviteResponse {
        self.store_claimed_session(
            claimed_owner_pubkey,
            authenticated_device_pubkey,
            Session::from_state(state),
            now,
        )
    }

    pub(super) fn store_claimed_session(
        &mut self,
        claimed_owner_pubkey: OwnerPubkey,
        authenticated_device_pubkey: DevicePubkey,
        session: Session,
        now: UnixSeconds,
    ) -> ProcessedInviteResponse {
        let device_owner_pubkey =
            crate::owner_pubkey_from_device_pubkey(authenticated_device_pubkey);
        let claim_is_verified =
            self.owner_device_is_authorized(claimed_owner_pubkey, authenticated_device_pubkey);
        let owner_pubkey = if claim_is_verified {
            claimed_owner_pubkey
        } else {
            device_owner_pubkey
        };
        let provisional_claim =
            (claimed_owner_pubkey != owner_pubkey).then_some(claimed_owner_pubkey);
        let should_seed_single_device_roster = owner_pubkey == device_owner_pubkey
            && self
                .users
                .get(&owner_pubkey)
                .and_then(|user| user.roster.as_ref())
                .is_none();

        let user = self.user_record_mut(owner_pubkey);
        if should_seed_single_device_roster {
            user.roster = Some(DeviceRoster::new(
                now,
                vec![AuthorizedDevice::new(authenticated_device_pubkey, now)],
            ));
        }
        let record = user.device_record_mut(authenticated_device_pubkey, now);
        record.claimed_owner_pubkey = provisional_claim;
        record.invite_response_generated = true;
        record.upsert_session(session, now);
        self.recompute_authorization_for_owner(owner_pubkey);

        ProcessedInviteResponse {
            owner_pubkey,
            device_pubkey: authenticated_device_pubkey,
            claimed_owner_pubkey: provisional_claim,
        }
    }
}
