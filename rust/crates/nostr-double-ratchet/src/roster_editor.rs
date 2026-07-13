use crate::{AuthorizedDevice, DevicePubkey, DeviceRoster, UnixSeconds};
use std::collections::BTreeMap;

/// Snapshot editor for the authoritative device roster.
///
/// This stays separate from `SessionManager` on purpose:
/// - `SessionManager` consumes roster snapshots and manages sessions
/// - `RosterEditor` helps product code build the next full roster snapshot
///
/// The resulting `DeviceRoster` can then be:
/// - signed and published as the next AppKeys fact snapshot
/// - verified into an `OwnerRosterProof` before `SessionManager` observes it
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RosterEditor {
    devices: BTreeMap<DevicePubkey, AuthorizedDevice>,
}

impl RosterEditor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_roster(roster: Option<&DeviceRoster>) -> Self {
        let mut editor = Self::new();
        if let Some(roster) = roster {
            for device in roster.devices() {
                editor.authorize_device(device.device_pubkey, device.created_at);
            }
        }
        editor
    }

    pub fn authorize_device(
        &mut self,
        device_pubkey: DevicePubkey,
        created_at: UnixSeconds,
    ) -> bool {
        match self.devices.get_mut(&device_pubkey) {
            Some(existing) => {
                if created_at < existing.created_at {
                    existing.created_at = created_at;
                    true
                } else {
                    false
                }
            }
            None => {
                self.devices.insert(
                    device_pubkey,
                    AuthorizedDevice::new(device_pubkey, created_at),
                );
                true
            }
        }
    }

    pub fn revoke_device(&mut self, device_pubkey: DevicePubkey) -> bool {
        self.devices.remove(&device_pubkey).is_some()
    }

    pub fn contains_device(&self, device_pubkey: DevicePubkey) -> bool {
        self.devices.contains_key(&device_pubkey)
    }

    pub fn devices(&self) -> Vec<AuthorizedDevice> {
        self.devices.values().copied().collect()
    }

    pub fn build(&self, created_at: UnixSeconds) -> DeviceRoster {
        DeviceRoster::new(created_at, self.devices())
    }
}
