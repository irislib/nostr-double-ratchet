use super::*;

impl<C> GroupManager<C>
where
    C: GroupPayloadCodec + Default,
{
    pub fn new(local_owner_pubkey: OwnerPubkey) -> Self {
        Self::new_with_payload_codec(local_owner_pubkey, C::default())
    }

    pub fn from_snapshot(snapshot: GroupManagerSnapshot) -> Result<Self> {
        Self::from_snapshot_with_payload_codec(snapshot, C::default())
    }
}

impl GroupRecord {
    pub(super) fn from_snapshot(snapshot: GroupSnapshot) -> Result<Self> {
        let members = validate_unique_owners(&snapshot.members, "members")?;
        let admins = validate_unique_owners(&snapshot.admins, "admins")?;
        validate_supported_protocol(snapshot.protocol)?;
        validate_group_invariants(&members, &admins)?;

        Ok(Self {
            group_id: snapshot.group_id,
            protocol: snapshot.protocol,
            name: snapshot.name,
            picture: snapshot.picture,
            about: snapshot.about,
            created_by: snapshot.created_by,
            members,
            admins,
            revision: snapshot.revision,
            created_at: snapshot.created_at,
            updated_at: snapshot.updated_at,
        })
    }

    pub(super) fn from_metadata_snapshot(snapshot: GroupSnapshot) -> Result<Self> {
        let record = Self::from_snapshot(snapshot)?;
        validate_supported_protocol(record.protocol)?;
        if record.revision == 0 {
            return Err(group_error("metadata snapshot revision must be at least 1"));
        }
        Ok(record)
    }

    pub(super) fn snapshot(&self) -> GroupSnapshot {
        GroupSnapshot {
            group_id: self.group_id.clone(),
            protocol: self.protocol,
            name: self.name.clone(),
            picture: self.picture.clone(),
            about: self.about.clone(),
            created_by: self.created_by,
            members: self.members.iter().copied().collect(),
            admins: self.admins.iter().copied().collect(),
            revision: self.revision,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    pub(super) fn metadata_payload(&self) -> GroupPairwiseCommand {
        GroupPairwiseCommand::MetadataSnapshot {
            snapshot: self.snapshot(),
        }
    }

    pub(super) fn remote_members(&self, local_owner_pubkey: OwnerPubkey) -> Vec<OwnerPubkey> {
        self.members
            .iter()
            .copied()
            .filter(|owner| *owner != local_owner_pubkey)
            .collect()
    }

    pub(super) fn ensure_admin(&self, owner: OwnerPubkey) -> Result<()> {
        if !self.admins.contains(&owner) {
            return Err(group_error(format!(
                "owner {owner} is not an admin of group `{}`",
                self.group_id
            )));
        }
        Ok(())
    }

    pub(super) fn ensure_member(&self, owner: OwnerPubkey) -> Result<()> {
        if !self.members.contains(&owner) {
            return Err(group_error(format!(
                "owner {owner} is not a member of group `{}`",
                self.group_id
            )));
        }
        Ok(())
    }

    pub(super) fn ensure_revision(&self, base_revision: u64, new_revision: u64) -> Result<()> {
        if base_revision != self.revision {
            return Err(group_error(format!(
                "stale group revision for `{}`: expected {}, got {}",
                self.group_id, self.revision, base_revision
            )));
        }
        if new_revision != base_revision + 1 {
            return Err(group_error(format!(
                "invalid next revision for `{}`: expected {}, got {}",
                self.group_id,
                base_revision + 1,
                new_revision
            )));
        }
        Ok(())
    }

    pub(super) fn apply_rename(
        &mut self,
        actor: OwnerPubkey,
        name: String,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        self.name = name;
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }

    pub(super) fn apply_picture_change(
        &mut self,
        actor: OwnerPubkey,
        picture: Option<String>,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        self.picture = picture.filter(|value| !value.is_empty());
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }

    pub(super) fn apply_about_change(
        &mut self,
        actor: OwnerPubkey,
        about: Option<String>,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        self.about = about.filter(|value| !value.is_empty());
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }

    pub(super) fn apply_add_members(
        &mut self,
        actor: OwnerPubkey,
        additions: &BTreeSet<OwnerPubkey>,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        if additions.is_empty() {
            return Err(group_error("members list must not be empty"));
        }
        for owner in additions {
            if self.members.contains(owner) {
                return Err(group_error(format!("owner {owner} is already a member")));
            }
        }
        self.members.extend(additions.iter().copied());
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }

    pub(super) fn apply_remove_members(
        &mut self,
        actor: OwnerPubkey,
        removals: &BTreeSet<OwnerPubkey>,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        if removals.is_empty() {
            return Err(group_error("members list must not be empty"));
        }
        if removals.contains(&actor) {
            return Err(group_error("self-removal is not allowed"));
        }
        for owner in removals {
            if !self.members.contains(owner) {
                return Err(group_error(format!("owner {owner} is not a member")));
            }
        }
        for owner in removals {
            self.members.remove(owner);
            self.admins.remove(owner);
        }
        validate_group_invariants(&self.members, &self.admins)?;
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }

    pub(super) fn apply_add_admins(
        &mut self,
        actor: OwnerPubkey,
        additions: &BTreeSet<OwnerPubkey>,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        if additions.is_empty() {
            return Err(group_error("admins list must not be empty"));
        }
        for owner in additions {
            if !self.members.contains(owner) {
                return Err(group_error(format!(
                    "owner {owner} must be a member before promotion"
                )));
            }
            if self.admins.contains(owner) {
                return Err(group_error(format!("owner {owner} is already an admin")));
            }
        }
        self.admins.extend(additions.iter().copied());
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }

    pub(super) fn apply_remove_admins(
        &mut self,
        actor: OwnerPubkey,
        removals: &BTreeSet<OwnerPubkey>,
        base_revision: u64,
        new_revision: u64,
        updated_at: UnixSeconds,
    ) -> Result<()> {
        self.ensure_admin(actor)?;
        self.ensure_revision(base_revision, new_revision)?;
        if removals.is_empty() {
            return Err(group_error("admins list must not be empty"));
        }
        for owner in removals {
            if !self.admins.contains(owner) {
                return Err(group_error(format!("owner {owner} is not an admin")));
            }
        }
        if self.admins.len() == removals.len() {
            return Err(group_error("cannot remove the last admin"));
        }
        for owner in removals {
            self.admins.remove(owner);
        }
        validate_group_invariants(&self.members, &self.admins)?;
        self.revision = new_revision;
        self.updated_at = updated_at;
        Ok(())
    }
}

impl SenderKeyRecordId {
    pub(super) fn new(
        group_id: String,
        sender_owner: OwnerPubkey,
        sender_device: DevicePubkey,
    ) -> Self {
        Self {
            group_id,
            sender_owner,
            sender_device,
        }
    }
}

// Older clients briefly forwarded remote sender-key distributions through
// local sibling channels. Heal that persisted shape by keeping a real local
// sender key with its secret, or the remote record over a secretless local copy.
pub(super) fn prefer_new_duplicate_sender_key(
    local_owner_pubkey: OwnerPubkey,
    existing: &SenderKeyRecord,
    incoming: &SenderKeyRecord,
) -> bool {
    let existing_is_local = existing.sender_owner == local_owner_pubkey;
    let incoming_is_local = incoming.sender_owner == local_owner_pubkey;
    let existing_has_secret = existing.sender_event_secret_key.is_some();
    let incoming_has_secret = incoming.sender_event_secret_key.is_some();

    match (
        existing_is_local,
        existing_has_secret,
        incoming_is_local,
        incoming_has_secret,
    ) {
        (true, true, _, _) => false,
        (_, _, true, true) => true,
        (true, false, false, _) => true,
        (false, _, true, false) => false,
        _ => false,
    }
}

impl SenderKeyRecord {
    pub(super) fn id(&self) -> SenderKeyRecordId {
        SenderKeyRecordId::new(self.group_id.clone(), self.sender_owner, self.sender_device)
    }

    pub(super) fn from_snapshot(snapshot: GroupSenderKeyRecordSnapshot) -> Result<Self> {
        let mut states = BTreeMap::new();
        for state in snapshot.states {
            if states.insert(state.key_id(), state).is_some() {
                return Err(group_error("duplicate sender-key state in snapshot"));
            }
        }
        if let Some(latest_key_id) = snapshot.latest_key_id {
            if !states.contains_key(&latest_key_id) {
                return Err(group_error("sender-key latest key id missing from states"));
            }
        }
        Ok(Self {
            group_id: snapshot.group_id,
            sender_owner: snapshot.sender_owner,
            sender_device: snapshot.sender_device,
            sender_event_pubkey: snapshot.sender_event_pubkey,
            sender_event_secret_key: snapshot.sender_event_secret_key,
            latest_key_id: snapshot.latest_key_id,
            states,
            distribution_history: snapshot
                .distribution_history
                .into_iter()
                .map(|distribution| (distribution.key_id, distribution))
                .collect(),
            distributed_to: snapshot
                .distributed_to
                .into_iter()
                .map(|entry| (entry.key_id, entry.recipients.into_iter().collect()))
                .collect(),
            repair_snapshots: snapshot.repair_snapshots,
        })
    }

    pub(super) fn repair_distribution_for(
        &self,
        requester_owner: OwnerPubkey,
        key_id: u32,
        message_number: u32,
    ) -> Option<SenderKeyDistribution> {
        self.repair_snapshots
            .iter()
            .filter(|snapshot| snapshot.key_id == key_id)
            .filter(|snapshot| snapshot.distribution.iteration <= message_number)
            .filter(|snapshot| snapshot.recipients.contains(&requester_owner))
            .max_by_key(|snapshot| snapshot.distribution.iteration)
            .map(|snapshot| snapshot.distribution.clone())
    }

    pub(super) fn repair_distributions_for_requester(
        &self,
        requester_owner: OwnerPubkey,
    ) -> Vec<SenderKeyDistribution> {
        self.repair_snapshots
            .iter()
            .filter(|snapshot| snapshot.recipients.contains(&requester_owner))
            .map(|snapshot| snapshot.distribution.clone())
            .collect()
    }

    pub(super) fn requester_received_initial_repair_snapshot(
        &self,
        requester_owner: OwnerPubkey,
        distribution: &SenderKeyDistribution,
    ) -> bool {
        let Some(first_iteration) = self
            .repair_snapshots
            .iter()
            .filter(|snapshot| snapshot.key_id == distribution.key_id)
            .map(|snapshot| snapshot.distribution.iteration)
            .min()
        else {
            return false;
        };
        first_iteration == distribution.iteration
            && self.repair_snapshots.iter().any(|snapshot| {
                snapshot.key_id == distribution.key_id
                    && snapshot.distribution.iteration == first_iteration
                    && snapshot.recipients.contains(&requester_owner)
            })
    }

    pub(super) fn snapshot(&self) -> GroupSenderKeyRecordSnapshot {
        GroupSenderKeyRecordSnapshot {
            group_id: self.group_id.clone(),
            sender_owner: self.sender_owner,
            sender_device: self.sender_device,
            sender_event_pubkey: self.sender_event_pubkey,
            sender_event_secret_key: self.sender_event_secret_key,
            latest_key_id: self.latest_key_id,
            states: self.states.values().cloned().collect(),
            distribution_history: self.distribution_history.values().cloned().collect(),
            distributed_to: self
                .distributed_to
                .iter()
                .map(
                    |(key_id, recipients)| crate::GroupSenderKeyDistributionRecipientsSnapshot {
                        key_id: *key_id,
                        recipients: recipients.iter().copied().collect(),
                    },
                )
                .collect(),
            repair_snapshots: self.repair_snapshots.clone(),
        }
    }
}
