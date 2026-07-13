use crate::{DevicePubkey, DeviceRoster, DomainError, OwnerPubkey, Result};
/// A signed AppKeys snapshot that has already crossed the Nostr verification
/// boundary. `SessionManager` accepts this type instead of owner hints or raw
/// roster snapshots when binding a remote device to an owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerRosterProof {
    owner_pubkey: OwnerPubkey,
    roster: DeviceRoster,
    event_id: String,
    raw_event: String,
}

impl OwnerRosterProof {
    pub(crate) fn verified(
        owner_pubkey: OwnerPubkey,
        roster: DeviceRoster,
        event_id: String,
        raw_event: String,
    ) -> Self {
        Self {
            owner_pubkey,
            roster,
            event_id,
            raw_event,
        }
    }

    pub fn ensure_authorizes_device(&self, device_pubkey: DevicePubkey) -> Result<()> {
        if self.roster.get_device(&device_pubkey).is_none() {
            return Err(DomainError::InvalidState(
                "owner roster proof does not authorize device".to_string(),
            )
            .into());
        }
        Ok(())
    }

    pub fn owner_pubkey(&self) -> OwnerPubkey {
        self.owner_pubkey
    }

    pub fn roster(&self) -> &DeviceRoster {
        &self.roster
    }

    pub fn event_id(&self) -> &str {
        &self.event_id
    }

    pub fn raw_event(&self) -> &str {
        &self.raw_event
    }
}
