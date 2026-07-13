use crate::{DevicePubkey, UnixSeconds};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RosterSnapshotDecision {
    Advanced,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct AuthorizedDevice {
    pub device_pubkey: DevicePubkey,
    pub created_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRoster {
    pub created_at: UnixSeconds,
    pub devices: Vec<AuthorizedDevice>,
}

impl AuthorizedDevice {
    pub fn new(device_pubkey: DevicePubkey, created_at: UnixSeconds) -> Self {
        Self {
            device_pubkey,
            created_at,
        }
    }
}

impl DeviceRoster {
    pub fn new(created_at: UnixSeconds, devices: Vec<AuthorizedDevice>) -> Self {
        Self {
            created_at,
            devices: normalize_devices(devices),
        }
    }

    pub fn get_device(&self, device_pubkey: &DevicePubkey) -> Option<&AuthorizedDevice> {
        self.devices
            .iter()
            .find(|device| device.device_pubkey == *device_pubkey)
    }

    pub fn devices(&self) -> &[AuthorizedDevice] {
        &self.devices
    }
}

fn normalize_devices(devices: Vec<AuthorizedDevice>) -> Vec<AuthorizedDevice> {
    let mut by_pubkey = BTreeMap::new();

    for device in devices {
        by_pubkey
            .entry(device.device_pubkey)
            .and_modify(|existing: &mut AuthorizedDevice| {
                if device.created_at < existing.created_at {
                    *existing = device;
                }
            })
            .or_insert(device);
    }

    by_pubkey.into_values().collect()
}
