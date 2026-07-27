use super::*;

impl SessionManager {
    pub(super) fn observe_public_invite(
        &mut self,
        owner_pubkey: OwnerPubkey,
        invite: Invite,
    ) -> Result<()> {
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

    pub(super) fn apply_roster_for_owner(
        &mut self,
        owner_pubkey: OwnerPubkey,
        incoming_roster: DeviceRoster,
    ) -> RosterSnapshotDecision {
        self.apply_roster_for_owner_inner(owner_pubkey, incoming_roster, false)
    }

    pub(super) fn apply_roster_for_owner_inner(
        &mut self,
        owner_pubkey: OwnerPubkey,
        incoming_roster: DeviceRoster,
        replace_existing: bool,
    ) -> RosterSnapshotDecision {
        let (decision, next_roster) = {
            let user = self.user_record_mut(owner_pubkey);
            let current_roster = user.roster.as_ref();
            if replace_existing {
                (RosterSnapshotDecision::Advanced, incoming_roster)
            } else {
                apply_roster_snapshot(current_roster, &incoming_roster)
            }
        };

        let next_created_at = next_roster.created_at;
        self.user_record_mut(owner_pubkey).roster = Some(next_roster);
        self.recompute_authorization_for_owner(owner_pubkey);
        self.reconcile_verified_claimed_devices(owner_pubkey, next_created_at);
        self.recompute_authorization_for_owner(owner_pubkey);

        decision
    }

    pub(super) fn reconcile_verified_claimed_devices(
        &mut self,
        owner_pubkey: OwnerPubkey,
        now: UnixSeconds,
    ) {
        let source_owners: Vec<OwnerPubkey> = self
            .users
            .keys()
            .copied()
            .filter(|candidate_owner_pubkey| *candidate_owner_pubkey != owner_pubkey)
            .collect();

        let mut migrated = Vec::new();
        let mut empty_sources = Vec::new();

        for source_owner_pubkey in source_owners {
            let matching_devices = self
                .users
                .get(&source_owner_pubkey)
                .map(|user| {
                    user.devices
                        .values()
                        .filter(|record| {
                            if !self.owner_device_is_authorized(owner_pubkey, record.device_pubkey)
                            {
                                return false;
                            }
                            if record.claimed_owner_pubkey == Some(owner_pubkey) {
                                return true;
                            }
                            user.roster
                                .as_ref()
                                .and_then(|roster| roster.get_device(&record.device_pubkey))
                                .is_none()
                        })
                        .map(|record| record.device_pubkey)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            if matching_devices.is_empty() {
                continue;
            }

            if let Some(user) = self.users.get_mut(&source_owner_pubkey) {
                let source_roster_is_provisional = user.roster.as_ref().is_some_and(|roster| {
                    roster.devices().iter().all(|device| {
                        matching_devices.contains(&device.device_pubkey)
                            && crate::owner_pubkey_from_device_pubkey(device.device_pubkey)
                                == source_owner_pubkey
                    })
                });

                for device_pubkey in matching_devices {
                    if let Some(mut record) = user.devices.remove(&device_pubkey) {
                        record.claimed_owner_pubkey = None;
                        migrated.push(record);
                    }
                }

                if user.devices.is_empty()
                    && (user.roster.is_none() || source_roster_is_provisional)
                {
                    empty_sources.push(source_owner_pubkey);
                }
            }
        }

        for source_owner_pubkey in empty_sources {
            self.users.remove(&source_owner_pubkey);
        }

        if migrated.is_empty() {
            return;
        }

        let user = self.user_record_mut(owner_pubkey);
        for record in migrated {
            let device_pubkey = record.device_pubkey;
            user.device_record_mut(device_pubkey, record.created_at)
                .absorb(record, now);
        }
    }

    pub(super) fn owner_device_is_authorized(
        &self,
        owner_pubkey: OwnerPubkey,
        device_pubkey: DevicePubkey,
    ) -> bool {
        if crate::owner_pubkey_from_device_pubkey(device_pubkey) == owner_pubkey {
            return true;
        }
        if owner_pubkey == self.local_owner_pubkey {
            return self
                .users
                .get(&owner_pubkey)
                .and_then(|user| user.roster.as_ref())
                .and_then(|roster| roster.get_device(&device_pubkey))
                .is_some();
        }
        let Ok(owner) = owner_pubkey.to_nostr() else {
            return false;
        };
        let Ok(device) = device_pubkey.to_nostr() else {
            return false;
        };
        self.verified_peer_app_keys.membership(owner, device) == DeviceMembership::Authorized
    }

    pub(super) fn authorized_devices_for_owner(
        &self,
        owner_pubkey: OwnerPubkey,
    ) -> BTreeSet<DevicePubkey> {
        self.users
            .get(&owner_pubkey)
            .map(|user| {
                user.roster
                    .as_ref()
                    .map(|roster| {
                        roster
                            .devices()
                            .iter()
                            .filter(|device| {
                                self.owner_device_is_authorized(owner_pubkey, device.device_pubkey)
                            })
                            .map(|device| device.device_pubkey)
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    pub(super) fn recompute_authorization_for_owner(&mut self, owner_pubkey: OwnerPubkey) {
        let authorized_devices = self.authorized_devices_for_owner(owner_pubkey);
        if let Some(user) = self.users.get_mut(&owner_pubkey) {
            user.recompute_authorization(&authorized_devices);
        }
    }

    pub(super) fn user_record_mut(&mut self, owner_pubkey: OwnerPubkey) -> &mut UserRecord {
        self.users
            .entry(owner_pubkey)
            .or_insert_with(|| UserRecord::new(owner_pubkey))
    }
}
