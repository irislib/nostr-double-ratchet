use super::records::prefer_new_duplicate_sender_key;
use super::*;

impl<C> GroupManager<C>
where
    C: GroupPayloadCodec,
{
    pub(super) fn send_sender_key_message<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        record: &GroupRecord,
        body: Vec<u8>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let mut remote = GroupPreparedPublish::empty();
        let local_device = session_manager.local_device_pubkey();
        let id = SenderKeyRecordId::new(
            record.group_id.clone(),
            self.local_owner_pubkey,
            local_device,
        );
        let devices = Self::group_recipient_devices(record, session_manager);
        let previous = self
            .sender_keys
            .get(&id)
            .and_then(|s| s.delivery_state.as_ref());
        let force_rotate = self.local_sender_key_has_removed_recipients(record, local_device)
            || self.device_removal_requires_rotation(&id, &devices);
        let digest = Self::group_roster_digest(record)?;
        let siblings_changed = previous.is_none_or(|state| {
            state.roster_digest != digest
                || state.device_rosters.get(&self.local_owner_pubkey)
                    != devices.get(&self.local_owner_pubkey)
        });
        let changed_owners: BTreeSet<_> = record
            .remote_members(self.local_owner_pubkey)
            .into_iter()
            .filter(|owner| {
                previous.is_none_or(|p| p.device_rosters.get(owner) != devices.get(owner))
            })
            .collect();
        let (distribution, rotated) =
            self.ensure_local_sender_key_record(ctx, record, local_device, force_rotate)?;
        let mut recipients: BTreeSet<_> = self
            .sender_key_distribution_recipients(
                record,
                local_device,
                distribution.key_id,
                record.remote_members(self.local_owner_pubkey),
            )
            .into_iter()
            .collect();
        recipients.extend(changed_owners);
        if !recipients.is_empty() {
            remote = self.fanout_sender_key_distribution(
                session_manager,
                ctx,
                recipients.into_iter().collect(),
                &distribution,
            )?;
        }
        let mut local_sibling = GroupPreparedPublish::empty();
        if rotated || siblings_changed {
            local_sibling = self.local_sibling_sync(session_manager, ctx, record)?;
            let key =
                self.local_sibling_sender_key_distribution(session_manager, ctx, &distribution)?;
            merge_group_prepared_publish(&mut local_sibling, key);
        }
        let sender_record = self
            .sender_keys
            .get_mut(&id)
            .ok_or_else(|| group_error("missing local sender-key record"))?;
        sender_record.delivery_state = Some(crate::GroupSenderDeliveryState {
            key_id: distribution.key_id,
            roster_digest: digest,
            device_rosters: devices,
        });
        let key_id = sender_record
            .latest_key_id
            .ok_or_else(|| group_error("missing local sender-key id"))?;
        let state = sender_record
            .states
            .get_mut(&key_id)
            .ok_or_else(|| group_error("missing local sender-key state"))?;
        let plaintext = self.payload_codec.encode_sender_key_plaintext(
            encode_context(session_manager, ctx),
            &GroupSenderKeyPlaintext {
                group_id: record.group_id.clone(),
                revision: record.revision,
                body,
            },
        )?;
        let plan = state.plan_encrypt(&plaintext)?;
        let message_number = plan.message_number;
        let ciphertext = plan.ciphertext.clone();
        state.apply_encrypt(plan);
        let signer_secret_key = sender_record
            .sender_event_secret_key
            .ok_or_else(|| group_error("missing local sender-event secret key"))?;

        let sender_key_message = GroupSenderKeyMessageEnvelope {
            group_id: record.group_id.clone(),
            sender_event_pubkey: sender_record.sender_event_pubkey,
            signer_secret_key,
            key_id,
            message_number,
            encrypted_header: None,
            created_at: ctx.now,
            ciphertext,
        };
        remote.sender_key_messages.push(sender_key_message);

        Ok(GroupPreparedSend {
            group_id: record.group_id.clone(),
            remote,
            local_sibling,
        })
    }

    fn group_roster_digest(group: &GroupRecord) -> Result<[u8; 32]> {
        use sha2::{Digest, Sha256};
        Ok(Sha256::digest(serde_json::to_vec(&group.snapshot())?).into())
    }

    fn group_recipient_devices(
        group: &GroupRecord,
        sessions: &SessionManager,
    ) -> BTreeMap<OwnerPubkey, BTreeSet<DevicePubkey>> {
        group
            .members
            .iter()
            .filter_map(|owner| {
                let roster = sessions.roster(*owner)?;
                Some((
                    *owner,
                    roster
                        .devices()
                        .iter()
                        .map(|entry| entry.device_pubkey)
                        .collect(),
                ))
            })
            .collect()
    }

    fn device_removal_requires_rotation(
        &self,
        id: &SenderKeyRecordId,
        current: &BTreeMap<OwnerPubkey, BTreeSet<DevicePubkey>>,
    ) -> bool {
        let Some(sender) = self.sender_keys.get(id) else {
            return false;
        };
        sender.delivery_state.as_ref().is_none_or(|old| {
            Some(old.key_id) != sender.latest_key_id
                || old.device_rosters.iter().any(|(owner, devices)| {
                    current.get(owner).is_none_or(|now| !devices.is_subset(now))
                })
        })
    }

    fn remember_bootstrap(
        &mut self,
        group: &GroupRecord,
        sessions: &SessionManager,
        key_id: u32,
    ) -> Result<()> {
        let id = SenderKeyRecordId::new(
            group.group_id.clone(),
            self.local_owner_pubkey,
            sessions.local_device_pubkey(),
        );
        let sender = self
            .sender_keys
            .get_mut(&id)
            .ok_or_else(|| group_error("missing sender-key record"))?;
        sender.delivery_state = Some(crate::GroupSenderDeliveryState {
            key_id,
            roster_digest: Self::group_roster_digest(group)?,
            device_rosters: Self::group_recipient_devices(group, sessions),
        });
        Ok(())
    }

    pub(super) fn prepare_sender_key_bootstrap<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        record: &GroupRecord,
        mut prepared: GroupPreparedSend,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let local_device = session_manager.local_device_pubkey();
        let id = SenderKeyRecordId::new(
            record.group_id.clone(),
            self.local_owner_pubkey,
            local_device,
        );
        let rotate = self.device_removal_requires_rotation(
            &id,
            &Self::group_recipient_devices(record, session_manager),
        );
        let (distribution, _) =
            self.ensure_local_sender_key_record(ctx, record, local_device, rotate)?;
        let remote = self.fanout_sender_key_distribution(
            session_manager,
            ctx,
            record.remote_members(self.local_owner_pubkey),
            &distribution,
        )?;
        merge_group_prepared_publish(&mut prepared.remote, remote);
        let local =
            self.local_sibling_sender_key_distribution(session_manager, ctx, &distribution)?;
        merge_group_prepared_publish(&mut prepared.local_sibling, local);
        self.remember_bootstrap(record, session_manager, distribution.key_id)?;
        Ok(prepared)
    }

    pub(super) fn prepare_sender_key_rotation<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        record: &GroupRecord,
        mut prepared: GroupPreparedSend,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let local_device = session_manager.local_device_pubkey();
        let (distribution, _) =
            self.ensure_local_sender_key_record(ctx, record, local_device, true)?;
        let remote = self.fanout_sender_key_distribution(
            session_manager,
            ctx,
            record.remote_members(self.local_owner_pubkey),
            &distribution,
        )?;
        merge_group_prepared_publish(&mut prepared.remote, remote);
        let local =
            self.local_sibling_sender_key_distribution(session_manager, ctx, &distribution)?;
        merge_group_prepared_publish(&mut prepared.local_sibling, local);
        self.remember_bootstrap(record, session_manager, distribution.key_id)?;
        Ok(prepared)
    }

    pub(super) fn ensure_local_sender_key_record<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        record: &GroupRecord,
        local_device: DevicePubkey,
        force_rotate: bool,
    ) -> Result<(SenderKeyDistribution, bool)>
    where
        R: RngCore + CryptoRng,
    {
        let id = SenderKeyRecordId::new(
            record.group_id.clone(),
            self.local_owner_pubkey,
            local_device,
        );
        let mut created_or_rotated = force_rotate;
        if !self.sender_keys.contains_key(&id) {
            let sender_event_secret_key = random_secret_key_bytes(ctx.rng)?;
            let sender_event_pubkey = device_pubkey_from_secret_bytes(&sender_event_secret_key)?;
            let sender_record = SenderKeyRecord {
                group_id: record.group_id.clone(),
                sender_owner: self.local_owner_pubkey,
                sender_device: local_device,
                sender_event_pubkey,
                sender_event_secret_key: Some(sender_event_secret_key),
                latest_key_id: None,
                states: BTreeMap::new(),
                distribution_history: BTreeMap::new(),
                distributed_to: BTreeMap::new(),
                repair_snapshots: Vec::new(),
                delivery_state: None,
            };
            self.sender_event_index
                .insert(sender_event_pubkey, sender_record.id());
            self.sender_keys.insert(id.clone(), sender_record);
            created_or_rotated = true;
        }

        let sender_record = self
            .sender_keys
            .get_mut(&id)
            .ok_or_else(|| group_error("missing local sender-key record"))?;
        let mut new_distribution = None;
        if force_rotate || sender_record.latest_key_id.is_none() {
            let key_id = random_key_id(ctx);
            let mut chain_key = [0u8; 32];
            ctx.rng.fill_bytes(&mut chain_key);
            sender_record
                .states
                .insert(key_id, SenderKeyState::new(key_id, chain_key, 0));
            sender_record.latest_key_id = Some(key_id);
            new_distribution = Some(SenderKeyDistribution {
                group_id: record.group_id.clone(),
                key_id,
                sender_event_pubkey: sender_record.sender_event_pubkey,
                chain_key,
                iteration: 0,
                created_at: ctx.now,
            });
            created_or_rotated = true;
        }

        let key_id = sender_record
            .latest_key_id
            .ok_or_else(|| group_error("missing local sender-key id"))?;
        let state = sender_record
            .states
            .get(&key_id)
            .ok_or_else(|| group_error("missing local sender-key state"))?;
        let distribution = new_distribution.unwrap_or_else(|| SenderKeyDistribution {
            group_id: record.group_id.clone(),
            key_id,
            sender_event_pubkey: sender_record.sender_event_pubkey,
            chain_key: state.chain_key(),
            iteration: state.iteration(),
            created_at: ctx.now,
        });
        if created_or_rotated {
            sender_record
                .distribution_history
                .insert(distribution.key_id, distribution.clone());
        }
        Ok((distribution, created_or_rotated))
    }

    pub(super) fn fanout_sender_key_distribution<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        recipients: Vec<OwnerPubkey>,
        distribution: &SenderKeyDistribution,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        let prepared = self.fanout_payload(
            session_manager,
            ctx,
            &distribution.group_id,
            recipients.clone(),
            &GroupPairwiseCommand::SenderKeyDistribution {
                distribution: distribution.clone(),
            },
        )?;
        self.record_sender_key_repair_snapshot(
            &distribution.group_id,
            session_manager.local_device_pubkey(),
            distribution,
            &recipients,
        );
        self.mark_sender_key_distribution_recipients(
            &distribution.group_id,
            session_manager.local_device_pubkey(),
            distribution.key_id,
            recipients,
        );
        Ok(prepared)
    }

    pub(super) fn local_sibling_sender_key_distribution<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        distribution: &SenderKeyDistribution,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        let prepared = self.local_sibling_payload(
            session_manager,
            ctx,
            &distribution.group_id,
            &GroupPairwiseCommand::SenderKeyDistribution {
                distribution: distribution.clone(),
            },
        )?;
        let intended_for_local_sibling = !prepared.deliveries.is_empty()
            || !prepared.invite_responses.is_empty()
            || !prepared.relay_gaps.is_empty()
            || !prepared.pending_fanouts.is_empty();
        if intended_for_local_sibling {
            self.record_sender_key_repair_snapshot(
                &distribution.group_id,
                session_manager.local_device_pubkey(),
                distribution,
                &[self.local_owner_pubkey],
            );
        }
        Ok(prepared)
    }

    pub(super) fn observe_sender_key_distribution(
        &mut self,
        sender_owner: OwnerPubkey,
        sender_device: DevicePubkey,
        distribution: SenderKeyDistribution,
    ) -> Result<()> {
        let group = self.group_record(&distribution.group_id)?.clone();
        if !group.protocol.is_sender_key_v1() {
            return Ok(());
        }
        group.ensure_member(sender_owner)?;

        let id = SenderKeyRecordId::new(distribution.group_id.clone(), sender_owner, sender_device);
        if let Some(existing_id) = self
            .sender_event_index
            .get(&distribution.sender_event_pubkey)
            .cloned()
            .filter(|existing_id| *existing_id != id)
        {
            let prefer_new = self
                .sender_keys
                .get(&existing_id)
                .map(|existing| {
                    let incoming = SenderKeyRecord {
                        group_id: distribution.group_id.clone(),
                        sender_owner,
                        sender_device,
                        sender_event_pubkey: distribution.sender_event_pubkey,
                        sender_event_secret_key: None,
                        latest_key_id: Some(distribution.key_id),
                        states: BTreeMap::new(),
                        distribution_history: BTreeMap::new(),
                        distributed_to: BTreeMap::new(),
                        repair_snapshots: Vec::new(),
                        delivery_state: None,
                    };
                    prefer_new_duplicate_sender_key(self.local_owner_pubkey, existing, &incoming)
                })
                .unwrap_or(true);
            if prefer_new {
                self.sender_keys.remove(&existing_id);
            } else {
                return Ok(());
            }
        }
        let record = self
            .sender_keys
            .entry(id.clone())
            .or_insert_with(|| SenderKeyRecord {
                group_id: distribution.group_id.clone(),
                sender_owner,
                sender_device,
                sender_event_pubkey: distribution.sender_event_pubkey,
                sender_event_secret_key: None,
                latest_key_id: None,
                states: BTreeMap::new(),
                distribution_history: BTreeMap::new(),
                distributed_to: BTreeMap::new(),
                repair_snapshots: Vec::new(),
                delivery_state: None,
            });
        if record.sender_event_pubkey != distribution.sender_event_pubkey {
            self.sender_event_index.remove(&record.sender_event_pubkey);
            record.sender_event_pubkey = distribution.sender_event_pubkey;
        }
        self.sender_event_index
            .insert(distribution.sender_event_pubkey, id);
        record.latest_key_id = Some(distribution.key_id);
        let known = record.distribution_history.get(&distribution.key_id);
        match (known, record.states.get_mut(&distribution.key_id)) {
            (Some(known), Some(state)) => {
                // Copies of one distribution are made at different chain
                // positions and arrive in any order. An earlier copy opens the
                // messages before the first position this device learned.
                if state.extend_backwards(
                    known.iteration,
                    &known.chain_key,
                    distribution.iteration,
                    &distribution.chain_key,
                ) {
                    record
                        .distribution_history
                        .insert(distribution.key_id, distribution);
                }
            }
            _ => {
                record
                    .distribution_history
                    .entry(distribution.key_id)
                    .or_insert_with(|| distribution.clone());
                record.states.entry(distribution.key_id).or_insert_with(|| {
                    SenderKeyState::new(
                        distribution.key_id,
                        distribution.chain_key,
                        distribution.iteration,
                    )
                });
            }
        }
        Ok(())
    }

    pub(super) fn sender_key_distribution_recipients(
        &self,
        group: &GroupRecord,
        local_device: DevicePubkey,
        key_id: u32,
        candidates: Vec<OwnerPubkey>,
    ) -> Vec<OwnerPubkey> {
        let id = SenderKeyRecordId::new(
            group.group_id.clone(),
            self.local_owner_pubkey,
            local_device,
        );
        let Some(record) = self.sender_keys.get(&id) else {
            return candidates;
        };
        let distributed = record.distributed_to.get(&key_id);
        candidates
            .into_iter()
            .filter(|recipient| {
                group.members.contains(recipient)
                    && distributed.is_none_or(|owners| !owners.contains(recipient))
            })
            .collect()
    }

    pub(super) fn local_sender_key_has_removed_recipients(
        &self,
        group: &GroupRecord,
        local_device: DevicePubkey,
    ) -> bool {
        let id = SenderKeyRecordId::new(
            group.group_id.clone(),
            self.local_owner_pubkey,
            local_device,
        );
        let Some(record) = self.sender_keys.get(&id) else {
            return false;
        };
        let Some(key_id) = record.latest_key_id else {
            return false;
        };
        record
            .distributed_to
            .get(&key_id)
            .is_some_and(|recipients| {
                recipients
                    .iter()
                    .any(|owner| !group.members.contains(owner))
            })
    }

    pub(super) fn mark_sender_key_distribution_recipients(
        &mut self,
        group_id: &str,
        local_device: DevicePubkey,
        key_id: u32,
        recipients: Vec<OwnerPubkey>,
    ) {
        if recipients.is_empty() {
            return;
        }
        let id =
            SenderKeyRecordId::new(group_id.to_string(), self.local_owner_pubkey, local_device);
        if let Some(record) = self.sender_keys.get_mut(&id) {
            record
                .distributed_to
                .entry(key_id)
                .or_default()
                .extend(recipients);
        }
    }

    pub(super) fn record_sender_key_repair_snapshot(
        &mut self,
        group_id: &str,
        local_device: DevicePubkey,
        distribution: &SenderKeyDistribution,
        recipients: &[OwnerPubkey],
    ) {
        if recipients.is_empty() {
            return;
        }
        let id =
            SenderKeyRecordId::new(group_id.to_string(), self.local_owner_pubkey, local_device);
        let Some(record) = self.sender_keys.get_mut(&id) else {
            return;
        };

        let mut recipients = recipients.to_vec();
        recipients.sort_unstable();
        recipients.dedup();
        if record.repair_snapshots.iter().any(|snapshot| {
            snapshot.key_id == distribution.key_id
                && snapshot.distribution.iteration == distribution.iteration
                && snapshot.recipients == recipients
        }) {
            return;
        }
        record.repair_snapshots.push(GroupSenderKeyRepairSnapshot {
            key_id: distribution.key_id,
            distribution: distribution.clone(),
            recipients,
        });
    }

    pub(super) fn group_record(&self, group_id: &str) -> Result<&GroupRecord> {
        self.groups
            .get(group_id)
            .ok_or_else(|| group_error(format!("unknown group `{group_id}`")))
    }
}
