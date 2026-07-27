use super::records::prefer_new_duplicate_sender_key;
use super::*;

impl<C> GroupManager<C>
where
    C: GroupPayloadCodec,
{
    pub fn new_with_payload_codec(local_owner_pubkey: OwnerPubkey, payload_codec: C) -> Self {
        Self {
            payload_codec,
            local_owner_pubkey,
            groups: BTreeMap::new(),
            sender_keys: BTreeMap::new(),
            sender_event_index: BTreeMap::new(),
        }
    }

    pub fn is_pairwise_payload(&self, payload: &[u8]) -> bool {
        self.payload_codec.is_pairwise_payload(payload)
    }

    pub fn from_snapshot_with_payload_codec(
        snapshot: GroupManagerSnapshot,
        payload_codec: C,
    ) -> Result<Self> {
        let local_owner_pubkey = snapshot.local_owner_pubkey;
        let mut groups = BTreeMap::new();
        for group in snapshot.groups {
            let record = GroupRecord::from_snapshot(group)?;
            if groups.insert(record.group_id.clone(), record).is_some() {
                return Err(group_error("duplicate group id in snapshot"));
            }
        }
        let mut sender_keys = BTreeMap::new();
        let mut sender_event_index = BTreeMap::new();
        for snapshot in snapshot.sender_keys {
            let record = SenderKeyRecord::from_snapshot(snapshot)?;
            let id = record.id();
            if sender_keys.contains_key(&id) {
                return Err(group_error("duplicate sender-key record in snapshot"));
            }
            if let Some(existing_id) = sender_event_index.get(&record.sender_event_pubkey).cloned()
            {
                let existing = sender_keys
                    .get(&existing_id)
                    .ok_or_else(|| group_error("sender-event index points to missing state"))?;
                if prefer_new_duplicate_sender_key(local_owner_pubkey, existing, &record) {
                    sender_keys.remove(&existing_id);
                    sender_event_index.insert(record.sender_event_pubkey, id.clone());
                    sender_keys.insert(id, record);
                }
                continue;
            }
            sender_event_index.insert(record.sender_event_pubkey, id.clone());
            sender_keys.insert(id, record);
        }
        Ok(Self {
            payload_codec,
            local_owner_pubkey,
            groups,
            sender_keys,
            sender_event_index,
        })
    }

    pub fn snapshot(&self) -> GroupManagerSnapshot {
        GroupManagerSnapshot {
            local_owner_pubkey: self.local_owner_pubkey,
            groups: self.groups.values().map(GroupRecord::snapshot).collect(),
            sender_keys: self
                .sender_keys
                .values()
                .map(SenderKeyRecord::snapshot)
                .collect(),
        }
    }

    pub fn group(&self, group_id: &str) -> Option<GroupSnapshot> {
        self.groups.get(group_id).map(GroupRecord::snapshot)
    }

    pub fn groups(&self) -> Vec<GroupSnapshot> {
        self.groups.values().map(GroupRecord::snapshot).collect()
    }

    pub fn sync_group_to_local_siblings<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        let record = self.group_record(group_id)?.clone();
        self.local_sibling_sync(session_manager, ctx, &record)
    }

    pub fn known_sender_event_pubkeys(&self) -> Vec<SenderEventPubkey> {
        self.sender_event_index.keys().copied().collect()
    }

    pub fn group_id_for_sender_event_pubkey(
        &self,
        sender_event_pubkey: SenderEventPubkey,
    ) -> Option<String> {
        self.sender_event_index
            .get(&sender_event_pubkey)
            .map(|id| id.group_id.clone())
    }

    pub fn create_group<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        name: String,
        initial_members: Vec<OwnerPubkey>,
    ) -> Result<GroupCreateResult>
    where
        R: RngCore + CryptoRng,
    {
        self.create_group_with_protocol(
            session_manager,
            ctx,
            name,
            initial_members,
            GroupProtocol::pairwise_fanout_v1(),
        )
    }

    pub fn create_group_with_protocol<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        name: String,
        initial_members: Vec<OwnerPubkey>,
        protocol: GroupProtocol,
    ) -> Result<GroupCreateResult>
    where
        R: RngCore + CryptoRng,
    {
        let member_set = validate_unique_owners(&initial_members, "initial members")?;
        if member_set.contains(&self.local_owner_pubkey) {
            return Err(group_error("local owner is added automatically"));
        }
        validate_supported_protocol(protocol)?;

        let group_id = random_group_id(ctx);
        let mut members = member_set;
        members.insert(self.local_owner_pubkey);

        let mut admins = BTreeSet::new();
        admins.insert(self.local_owner_pubkey);

        let record = GroupRecord {
            group_id: group_id.clone(),
            protocol,
            name,
            picture: None,
            about: None,
            created_by: self.local_owner_pubkey,
            members,
            admins,
            revision: 1,
            created_at: ctx.now,
            updated_at: ctx.now,
        };
        let payload = record.metadata_payload();
        let recipients = record.remote_members(self.local_owner_pubkey);
        let prepared = GroupPreparedSend {
            group_id: group_id.clone(),
            remote: self.fanout_payload(session_manager, ctx, &group_id, recipients, &payload)?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &record)?,
        };
        let prepared = if protocol.is_sender_key_v1() {
            self.prepare_sender_key_bootstrap(session_manager, ctx, &record, prepared)?
        } else {
            prepared
        };
        let snapshot = record.snapshot();

        self.groups.insert(group_id, record);

        Ok(GroupCreateResult {
            group: snapshot,
            prepared,
        })
    }

    pub fn retry_create_group<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        recipients: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let record = self.group_record(group_id)?.clone();
        record.ensure_admin(self.local_owner_pubkey)?;

        let recipients = validate_unique_owners(&recipients, "recipients")?
            .into_iter()
            .filter(|owner| *owner != self.local_owner_pubkey)
            .collect::<Vec<_>>();
        for recipient in &recipients {
            record.ensure_member(*recipient)?;
        }

        let prepared = GroupPreparedSend {
            group_id: record.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &record.group_id,
                recipients,
                &record.metadata_payload(),
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &record)?,
        };
        if record.protocol.is_sender_key_v1() {
            self.prepare_sender_key_bootstrap(session_manager, ctx, &record, prepared)
        } else {
            Ok(prepared)
        }
    }

    pub fn send_message<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        body: Vec<u8>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let record = self.group_record(group_id)?.clone();
        record.ensure_member(self.local_owner_pubkey)?;
        if record.protocol.is_sender_key_v1() {
            return self.send_sender_key_message(session_manager, ctx, &record, body);
        }
        let payload = GroupPairwiseCommand::GroupMessage {
            group_id: record.group_id.clone(),
            revision: record.revision,
            body,
        };

        let mut local_sibling = self.local_sibling_sync(session_manager, ctx, &record)?;
        let sibling_message =
            self.local_sibling_payload(session_manager, ctx, &record.group_id, &payload)?;
        merge_group_prepared_publish(&mut local_sibling, sibling_message);

        Ok(GroupPreparedSend {
            group_id: record.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &record.group_id,
                record.remote_members(self.local_owner_pubkey),
                &payload,
            )?,
            local_sibling,
        })
    }

    pub fn request_sender_key_repair<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        request: &SenderKeyRepairRequest,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let record = self.group_record(&request.group_id)?.clone();
        if !record.protocol.is_sender_key_v1() || !record.members.contains(&self.local_owner_pubkey)
        {
            return Ok(empty_group_prepared_send(request.group_id.clone()));
        }

        let command = GroupPairwiseCommand::SenderKeyRepairRequest {
            request: request.clone(),
        };
        Ok(GroupPreparedSend {
            group_id: request.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &request.group_id,
                record.remote_members(self.local_owner_pubkey),
                &command,
            )?,
            local_sibling: self.local_sibling_payload(
                session_manager,
                ctx,
                &request.group_id,
                &command,
            )?,
        })
    }

    pub fn respond_to_sender_key_repair_request<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        requester_owner: OwnerPubkey,
        request: &SenderKeyRepairRequest,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let Some(record) = self.groups.get(&request.group_id).cloned() else {
            return Ok(empty_group_prepared_send(request.group_id.clone()));
        };
        if !record.protocol.is_sender_key_v1() || !record.members.contains(&requester_owner) {
            return Ok(empty_group_prepared_send(request.group_id.clone()));
        }

        let mut prepared = empty_group_prepared_send(request.group_id.clone());
        let include_required_revision_metadata = request
            .required_revision
            .is_some_and(|required| record.revision >= required);
        let mut include_context_metadata = false;
        let mut distributions = Vec::new();

        if let Some(id) = self
            .sender_event_index
            .get(&request.sender_event_pubkey)
            .cloned()
            .filter(|id| {
                id.group_id == request.group_id && id.sender_owner == self.local_owner_pubkey
            })
        {
            if let Some(sender_record) = self
                .sender_keys
                .get(&id)
                .filter(|record| record.sender_event_secret_key.is_some())
            {
                distributions = match (request.key_id, request.message_number) {
                    (Some(key_id), Some(message_number)) => sender_record
                        .repair_distribution_for(requester_owner, key_id, message_number)
                        .into_iter()
                        .collect::<Vec<_>>(),
                    _ => sender_record.repair_distributions_for_requester(requester_owner),
                };
                include_context_metadata = request.required_revision.is_none()
                    && requester_owner != self.local_owner_pubkey
                    && distributions.iter().any(|distribution| {
                        sender_record.requester_received_initial_repair_snapshot(
                            requester_owner,
                            distribution,
                        )
                    });
            }
        }

        for distribution in distributions {
            let distribution = self.repair_payload_to_owner(
                session_manager,
                ctx,
                requester_owner,
                &GroupPairwiseCommand::SenderKeyDistribution { distribution },
            )?;
            merge_group_prepared_publish(&mut prepared.remote, distribution.remote);
            merge_group_prepared_publish(&mut prepared.local_sibling, distribution.local_sibling);
        }
        if include_required_revision_metadata || include_context_metadata {
            let metadata = self.repair_payload_to_owner(
                session_manager,
                ctx,
                requester_owner,
                &record.metadata_payload(),
            )?;
            merge_group_prepared_publish(&mut prepared.remote, metadata.remote);
            merge_group_prepared_publish(&mut prepared.local_sibling, metadata.local_sibling);
        }
        Ok(prepared)
    }

    pub fn update_name<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        name: String,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.update_metadata_with(
            session_manager,
            ctx,
            group_id,
            |next, actor, base, new_rev, now| next.apply_rename(actor, name, base, new_rev, now),
        )
    }

    /// Set or clear the group's picture URL. `Some(url)` updates, `None`
    /// clears. Travels in the same metadata snapshot as name/membership so
    /// new joiners and out-of-sync admins converge automatically — no
    /// separate side channel.
    pub fn update_picture<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        picture: Option<String>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.update_metadata_with(
            session_manager,
            ctx,
            group_id,
            |next, actor, base, new_rev, now| {
                next.apply_picture_change(actor, picture, base, new_rev, now)
            },
        )
    }

    /// Set or clear the group's free-text description. `Some(text)` updates,
    /// `None` clears.
    pub fn update_about<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        about: Option<String>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        self.update_metadata_with(
            session_manager,
            ctx,
            group_id,
            |next, actor, base, new_rev, now| {
                next.apply_about_change(actor, about, base, new_rev, now)
            },
        )
    }

    /// Common implementation for `update_name` / `update_picture` /
    /// `update_about`: clone the current record, ask the caller to mutate
    /// the new copy via one of the `apply_*` admin-checked helpers, then
    /// fan the resulting metadata snapshot out to remote members and our
    /// local siblings.
    pub(super) fn update_metadata_with<R, F>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        apply: F,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
        F: FnOnce(&mut GroupRecord, OwnerPubkey, u64, u64, UnixSeconds) -> Result<()>,
    {
        let current = self.group_record(group_id)?.clone();
        let mut next = current.clone();
        let base_revision = current.revision;
        let new_revision = base_revision + 1;
        apply(
            &mut next,
            self.local_owner_pubkey,
            base_revision,
            new_revision,
            ctx.now,
        )?;

        let payload = next.metadata_payload();

        let prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &current.group_id,
                next.remote_members(self.local_owner_pubkey),
                &payload,
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &next)?,
        };
        self.groups.insert(current.group_id.clone(), next);
        Ok(prepared)
    }

    pub fn retry_update_name<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let current = self.group_record(group_id)?.clone();
        current.ensure_admin(self.local_owner_pubkey)?;
        let payload = current.metadata_payload();

        Ok(GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &current.group_id,
                current.remote_members(self.local_owner_pubkey),
                &payload,
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &current)?,
        })
    }

    pub fn add_members<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        members: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let additions = validate_unique_owners(&members, "members")?;
        let current = self.group_record(group_id)?.clone();
        let mut next = current.clone();
        next.apply_add_members(
            self.local_owner_pubkey,
            &additions,
            current.revision,
            current.revision + 1,
            ctx.now,
        )?;

        let payload = next.metadata_payload();
        let remote = self.fanout_payload(
            session_manager,
            ctx,
            &current.group_id,
            next.remote_members(self.local_owner_pubkey),
            &payload,
        )?;

        let mut prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &next)?,
        };
        if next.protocol.is_sender_key_v1() {
            prepared = self.prepare_sender_key_bootstrap(session_manager, ctx, &next, prepared)?;
        }
        self.groups.insert(current.group_id.clone(), next);
        Ok(prepared)
    }

    pub fn retry_add_members<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        members: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let additions = validate_unique_owners(&members, "members")?;
        let current = self.group_record(group_id)?.clone();
        current.ensure_admin(self.local_owner_pubkey)?;
        for owner in &additions {
            current.ensure_member(*owner)?;
        }

        let payload = current.metadata_payload();
        let remote = self.fanout_payload(
            session_manager,
            ctx,
            &current.group_id,
            current.remote_members(self.local_owner_pubkey),
            &payload,
        )?;
        let prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &current)?,
        };
        if current.protocol.is_sender_key_v1() {
            self.prepare_sender_key_bootstrap(session_manager, ctx, &current, prepared)
        } else {
            Ok(prepared)
        }
    }

    pub fn remove_members<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        members: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let removals = validate_unique_owners(&members, "members")?;
        let current = self.group_record(group_id)?.clone();
        let mut next = current.clone();
        next.apply_remove_members(
            self.local_owner_pubkey,
            &removals,
            current.revision,
            current.revision + 1,
            ctx.now,
        )?;

        let payload = next.metadata_payload();

        let mut prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &current.group_id,
                current.remote_members(self.local_owner_pubkey),
                &payload,
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &next)?,
        };
        if next.protocol.is_sender_key_v1() {
            prepared = self.prepare_sender_key_rotation(session_manager, ctx, &next, prepared)?;
        }
        self.groups.insert(current.group_id.clone(), next);
        Ok(prepared)
    }

    pub fn retry_remove_members<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        members: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let removals = validate_unique_owners(&members, "members")?;
        let current = self.group_record(group_id)?.clone();
        current.ensure_admin(self.local_owner_pubkey)?;
        for owner in &removals {
            if current.members.contains(owner) {
                return Err(group_error(format!(
                    "owner {owner} should already be removed before retrying removal"
                )));
            }
        }

        let payload = current.metadata_payload();

        let mut recipients = current
            .remote_members(self.local_owner_pubkey)
            .into_iter()
            .collect::<BTreeSet<_>>();
        recipients.extend(
            removals
                .iter()
                .copied()
                .filter(|owner| *owner != self.local_owner_pubkey),
        );

        let prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &current.group_id,
                recipients.into_iter().collect(),
                &payload,
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &current)?,
        };
        if current.protocol.is_sender_key_v1() {
            self.prepare_sender_key_bootstrap(session_manager, ctx, &current, prepared)
        } else {
            Ok(prepared)
        }
    }

    pub fn add_admins<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        admins: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let additions = validate_unique_owners(&admins, "admins")?;
        let current = self.group_record(group_id)?.clone();
        let mut next = current.clone();
        next.apply_add_admins(
            self.local_owner_pubkey,
            &additions,
            current.revision,
            current.revision + 1,
            ctx.now,
        )?;

        let payload = next.metadata_payload();

        let prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &current.group_id,
                next.remote_members(self.local_owner_pubkey),
                &payload,
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &next)?,
        };
        self.groups.insert(current.group_id.clone(), next);
        Ok(prepared)
    }

    pub fn remove_admins<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        group_id: &str,
        admins: Vec<OwnerPubkey>,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let removals = validate_unique_owners(&admins, "admins")?;
        let current = self.group_record(group_id)?.clone();
        let mut next = current.clone();
        next.apply_remove_admins(
            self.local_owner_pubkey,
            &removals,
            current.revision,
            current.revision + 1,
            ctx.now,
        )?;

        let payload = next.metadata_payload();

        let prepared = GroupPreparedSend {
            group_id: current.group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &current.group_id,
                next.remote_members(self.local_owner_pubkey),
                &payload,
            )?,
            local_sibling: self.local_sibling_sync(session_manager, ctx, &next)?,
        };
        self.groups.insert(current.group_id.clone(), next);
        Ok(prepared)
    }
}
