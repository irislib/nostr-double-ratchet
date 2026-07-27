use super::*;

impl SessionManager {
    pub(super) fn prepare_device_delivery<R>(
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
        let claimed_owner = Some(self.local_owner_pubkey);
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
            match public_invite.accept_with_owner_context(
                ctx,
                local_device_pubkey,
                local_device_secret_key,
                claimed_owner,
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

        let (mut session, invite_response) = match public_invite.accept_with_owner_context(
            ctx,
            local_device_pubkey,
            local_device_secret_key,
            claimed_owner,
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

    pub(super) fn prepare_device_deliveries_for_all_send_sessions<R>(
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

    pub(super) fn prepare_send_inner<R>(
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

        self.prepare_explicit_send(ctx, recipient_owner, targets, payload, relay_gaps, false)
    }

    pub(super) fn prepare_explicit_send<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        recipient_owner: OwnerPubkey,
        targets: BTreeSet<TargetDevice>,
        payload: Vec<u8>,
        mut relay_gaps: Vec<RelayGap>,
        refresh_one_way_bootstrap: bool,
    ) -> Result<PreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let mut deliveries = Vec::new();
        let mut invite_responses = Vec::new();
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

    pub(super) fn collect_recipient_targets(
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

        if user
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

    pub(super) fn collect_local_sibling_targets(&self, targets: &mut BTreeSet<TargetDevice>) {
        let Some(user) = self.users.get(&self.local_owner_pubkey) else {
            return;
        };

        if user.roster.is_none() {
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
}
