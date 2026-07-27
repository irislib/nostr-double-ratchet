use super::*;

impl UserRecord {
    pub(super) fn new(owner_pubkey: OwnerPubkey) -> Self {
        Self {
            owner_pubkey,
            roster: None,
            devices: BTreeMap::new(),
        }
    }

    pub(super) fn from_snapshot(snapshot: UserRecordSnapshot) -> Self {
        Self {
            owner_pubkey: snapshot.owner_pubkey,
            roster: snapshot.roster,
            devices: snapshot
                .devices
                .into_iter()
                .map(DeviceRecord::from_snapshot)
                .map(|record| (record.device_pubkey, record))
                .collect(),
        }
    }

    pub(super) fn snapshot(&self) -> UserRecordSnapshot {
        UserRecordSnapshot {
            owner_pubkey: self.owner_pubkey,
            roster: self.roster.clone(),
            devices: self.devices.values().map(DeviceRecord::snapshot).collect(),
        }
    }

    pub(super) fn device_record_mut(
        &mut self,
        device_pubkey: DevicePubkey,
        created_at: UnixSeconds,
    ) -> &mut DeviceRecord {
        self.devices
            .entry(device_pubkey)
            .or_insert_with(|| DeviceRecord::new(device_pubkey, created_at))
    }

    pub(super) fn recompute_authorization(&mut self, authorized_devices: &BTreeSet<DevicePubkey>) {
        let owner_pubkey = self.owner_pubkey;
        let roster_created_at = self.roster.as_ref().map(|roster| roster.created_at);
        let roster_devices = self
            .roster
            .as_ref()
            .map(|roster| {
                roster
                    .devices()
                    .iter()
                    .map(|device| (device.device_pubkey, device.created_at))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for record in self.devices.values_mut() {
            let self_owned =
                crate::owner_pubkey_from_device_pubkey(record.device_pubkey) == self.owner_pubkey;
            record.authorized = self_owned || authorized_devices.contains(&record.device_pubkey);
            if record.authorized {
                record.is_stale = false;
                record.stale_since = None;
            } else if let Some(roster_created_at) = roster_created_at {
                record.is_stale = true;
                if record.stale_since.is_none() {
                    record.stale_since = Some(roster_created_at);
                }
            } else {
                record.is_stale = false;
                record.stale_since = None;
            }
        }

        for (device_pubkey, created_at) in roster_devices {
            let record = self.device_record_mut(device_pubkey, created_at);
            record.authorized = authorized_devices.contains(&device_pubkey)
                || crate::owner_pubkey_from_device_pubkey(device_pubkey) == owner_pubkey;
            if record.authorized {
                record.is_stale = false;
                record.stale_since = None;
            }
            record.created_at = merge_created_at(record.created_at, created_at);
        }
    }

    pub(super) fn authorized_non_stale_devices(&self) -> Vec<DevicePubkey> {
        self.devices
            .values()
            .filter(|record| record.authorized && !record.is_stale)
            .map(|record| record.device_pubkey)
            .collect()
    }
}

impl DeviceRecord {
    pub(super) fn new(device_pubkey: DevicePubkey, created_at: UnixSeconds) -> Self {
        Self {
            device_pubkey,
            authorized: false,
            is_stale: false,
            stale_since: None,
            claimed_owner_pubkey: None,
            public_invite: None,
            invite_response_generated: false,
            active_session: None,
            inactive_sessions: Vec::new(),
            last_activity: None,
            created_at,
        }
    }

    pub(super) fn from_snapshot(snapshot: DeviceRecordSnapshot) -> Self {
        Self {
            device_pubkey: snapshot.device_pubkey,
            authorized: snapshot.authorized,
            is_stale: snapshot.is_stale,
            stale_since: snapshot.stale_since,
            claimed_owner_pubkey: snapshot.claimed_owner_pubkey,
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

    pub(super) fn snapshot(&self) -> DeviceRecordSnapshot {
        DeviceRecordSnapshot {
            device_pubkey: self.device_pubkey,
            authorized: self.authorized,
            is_stale: self.is_stale,
            stale_since: self.stale_since,
            claimed_owner_pubkey: self.claimed_owner_pubkey,
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

    pub(super) fn best_send_session_source(&self) -> Option<SendSessionSource> {
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

    pub(super) fn session_for_send_source(&self, source: &SendSessionSource) -> Option<&Session> {
        match source {
            SendSessionSource::Active => self.active_session.as_ref(),
            SendSessionSource::Inactive(index) => self.inactive_sessions.get(*index),
        }
    }

    pub(super) fn upsert_session(&mut self, session: Session, now: UnixSeconds) {
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

    pub(super) fn absorb(&mut self, mut other: DeviceRecord, now: UnixSeconds) {
        self.authorized |= other.authorized;
        self.is_stale &= other.is_stale;
        self.stale_since = match (self.stale_since, other.stale_since) {
            (Some(existing), Some(incoming)) => Some(existing.min(incoming)),
            (None, incoming) => incoming,
            (existing, None) => existing,
        };
        self.claimed_owner_pubkey = self
            .claimed_owner_pubkey
            .or(other.claimed_owner_pubkey.take());
        self.created_at = merge_created_at(self.created_at, other.created_at);

        if let Some(public_invite) = other.public_invite.take() {
            let should_replace_invite = self
                .public_invite
                .as_ref()
                .is_none_or(|existing| public_invite.created_at >= existing.created_at);
            if should_replace_invite {
                self.public_invite = Some(public_invite);
            }
        }
        self.invite_response_generated |= other.invite_response_generated;

        if let Some(session) = other.active_session.take() {
            self.upsert_session(session, now);
        }

        for session in other.inactive_sessions.drain(..) {
            self.upsert_session(session, now);
        }

        self.last_activity = match (self.last_activity, other.last_activity) {
            (Some(existing), Some(incoming)) => Some(existing.max(incoming)),
            (None, incoming) => incoming,
            (existing, None) => existing,
        };
    }

    pub(super) fn promote_inactive_session(&mut self, session: Session) {
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

    pub(super) fn contains_state(&self, state: &SessionState) -> bool {
        self.active_session
            .as_ref()
            .is_some_and(|session| session.state == *state)
            || self
                .inactive_sessions
                .iter()
                .any(|session| session.state == *state)
    }

    pub(super) fn compact_duplicate_sessions(&mut self) {
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
