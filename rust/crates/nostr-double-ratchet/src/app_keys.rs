use crate::{Error, Result};
use base64::Engine;
use nostr::nips::nip44;
use nostr::{
    Alphabet, Event, EventBuilder, Filter, Keys, Kind, PublicKey, SingleLetterTag, Tag, Timestamp,
    UnsignedEvent,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use uuid::Uuid;

pub const APP_KEYS_SNAPSHOT_KIND: u32 = 37368;
pub const APP_KEYS_SCHEMA: u64 = 1;
pub const APP_KEYS_FACT_TYPE: &str = "app_keys_roster_snapshot";
pub const APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT: &str = "encrypted_device_labels";
pub const APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA: u64 = 1;
pub const APP_KEYS_OWNER_PUBKEY_FACT: &str = "owner_pubkey";
const APP_KEYS_AUTHORIZATION_MAX_EVENT_BYTES: usize = 64 * 1024;
const APP_KEYS_AUTHORIZATION_MAX_DEVICES: usize = 64;
const APP_KEYS_AUTHORIZATION_MAX_FUTURE_SKEW_SECS: u64 = 5 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceMembership {
    Authorized,
    Excluded,
    Missing,
    Ambiguous,
}

#[derive(Debug, Clone)]
struct AppKeysAuthorizationCandidate {
    event: Event,
    app_keys: AppKeys,
}

#[derive(Debug, Clone)]
struct VerifiedAppKeysHead {
    created_at_secs: u64,
    candidates: BTreeMap<nostr::EventId, AppKeysAuthorizationCandidate>,
}

/// Canonical owner-signed AppKeys heads observed through normal event ingestion.
///
/// Newer snapshots replace older ones. Conflicting snapshots at the same second
/// remain visible so security-sensitive membership checks can fail closed.
#[derive(Debug, Clone, Default)]
pub struct VerifiedAppKeysIndex {
    heads: BTreeMap<PublicKey, VerifiedAppKeysHead>,
}

impl VerifiedAppKeysIndex {
    pub fn ingest(&mut self, event: Event, now_secs: u64) -> Result<bool> {
        let owner = event.pubkey;
        let app_keys = app_keys_authorization_candidate(owner, &event, now_secs)?;
        let created_at_secs = event.created_at.as_secs();
        let Some(current) = self.heads.get_mut(&owner) else {
            self.heads.insert(
                owner,
                VerifiedAppKeysHead {
                    created_at_secs,
                    candidates: BTreeMap::from([(
                        event.id,
                        AppKeysAuthorizationCandidate { event, app_keys },
                    )]),
                },
            );
            return Ok(true);
        };

        if created_at_secs < current.created_at_secs {
            return Ok(false);
        }
        if created_at_secs > current.created_at_secs {
            current.created_at_secs = created_at_secs;
            current.candidates.clear();
        }
        Ok(current
            .candidates
            .insert(event.id, AppKeysAuthorizationCandidate { event, app_keys })
            .is_none())
    }

    pub fn membership(&self, owner: PublicKey, device: PublicKey) -> DeviceMembership {
        let Some(head) = self.heads.get(&owner) else {
            return DeviceMembership::Missing;
        };
        let membership = head
            .candidates
            .values()
            .map(|candidate| candidate.app_keys.get_device(&device).is_some())
            .collect::<BTreeSet<_>>();
        if membership.len() != 1 {
            DeviceMembership::Ambiguous
        } else if membership.contains(&true) {
            DeviceMembership::Authorized
        } else {
            DeviceMembership::Excluded
        }
    }

    pub fn events_for_owner(&self, owner: PublicKey) -> Vec<Event> {
        self.heads
            .get(&owner)
            .map(|head| {
                head.candidates
                    .values()
                    .map(|candidate| candidate.event.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn events(&self) -> Vec<Event> {
        self.heads
            .values()
            .flat_map(|head| {
                head.candidates
                    .values()
                    .map(|candidate| candidate.event.clone())
            })
            .collect()
    }

    pub(crate) fn owners(&self) -> Vec<PublicKey> {
        self.heads.keys().copied().collect()
    }

    pub(crate) fn head_created_at(&self, owner: PublicKey) -> Option<u64> {
        self.heads.get(&owner).map(|head| head.created_at_secs)
    }

    pub(crate) fn app_keys_for_event(
        &self,
        owner: PublicKey,
        event_id: nostr::EventId,
    ) -> Option<AppKeys> {
        self.heads
            .get(&owner)
            .and_then(|head| head.candidates.get(&event_id))
            .map(|candidate| candidate.app_keys.clone())
    }
}

#[derive(Debug, Clone)]
pub struct DeviceEntry {
    pub identity_pubkey: PublicKey,
    pub created_at: u64,
}

impl DeviceEntry {
    pub fn new(identity_pubkey: PublicKey, created_at: u64) -> Self {
        Self {
            identity_pubkey,
            created_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceLabels {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_label: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDeviceLabels {
    #[serde(rename = "identityPubkey", alias = "identity_pubkey")]
    identity_pubkey: String,
    #[serde(
        rename = "deviceLabel",
        alias = "device_label",
        skip_serializing_if = "Option::is_none"
    )]
    device_label: Option<String>,
    #[serde(
        rename = "clientLabel",
        alias = "client_label",
        skip_serializing_if = "Option::is_none"
    )]
    client_label: Option<String>,
    #[serde(rename = "updatedAt", alias = "updated_at")]
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedAppKeysContent {
    #[serde(rename = "type")]
    payload_type: String,
    v: u8,
    #[serde(rename = "deviceLabels", alias = "device_labels")]
    device_labels: Vec<StoredDeviceLabels>,
}

#[derive(Debug, Clone)]
pub struct AppKeys {
    devices: HashMap<PublicKey, DeviceEntry>,
    device_labels: HashMap<PublicKey, DeviceLabels>,
}

impl AppKeys {
    pub fn new(devices: Vec<DeviceEntry>) -> Self {
        let mut map = HashMap::new();
        for device in devices {
            map.insert(device.identity_pubkey, device);
        }
        Self {
            devices: map,
            device_labels: HashMap::new(),
        }
    }

    pub fn add_device(&mut self, device: DeviceEntry) {
        self.devices.entry(device.identity_pubkey).or_insert(device);
    }

    pub fn remove_device(&mut self, identity_pubkey: &PublicKey) {
        self.devices.remove(identity_pubkey);
        self.device_labels.remove(identity_pubkey);
    }

    pub fn get_device(&self, identity_pubkey: &PublicKey) -> Option<&DeviceEntry> {
        self.devices.get(identity_pubkey)
    }

    pub fn get_all_devices(&self) -> Vec<DeviceEntry> {
        self.devices.values().cloned().collect()
    }

    pub fn set_device_labels(
        &mut self,
        identity_pubkey: PublicKey,
        device_label: Option<String>,
        client_label: Option<String>,
        updated_at: Option<u64>,
    ) {
        self.device_labels.insert(
            identity_pubkey,
            DeviceLabels {
                device_label,
                client_label,
                updated_at: updated_at.unwrap_or_else(current_unix_timestamp),
            },
        );
    }

    pub fn get_device_labels(&self, identity_pubkey: &PublicKey) -> Option<&DeviceLabels> {
        self.device_labels.get(identity_pubkey)
    }

    pub fn get_all_device_labels(&self) -> Vec<(PublicKey, DeviceLabels)> {
        self.device_labels
            .iter()
            .map(|(identity_pubkey, labels)| (*identity_pubkey, labels.clone()))
            .collect()
    }

    fn build_unsigned_event_at(
        &self,
        owner_pubkey: PublicKey,
        encrypted_labels: String,
        created_at_secs: u64,
    ) -> UnsignedEvent {
        let profile_id = Uuid::new_v4().to_string();
        let mut fact_tags = vec![
            vec!["type".to_string(), APP_KEYS_FACT_TYPE.to_string()],
            vec!["schema".to_string(), APP_KEYS_SCHEMA.to_string()],
            vec![
                APP_KEYS_OWNER_PUBKEY_FACT.to_string(),
                owner_pubkey.to_hex(),
            ],
        ];
        let mut devices = self.get_all_devices();
        devices.sort_by(|left, right| {
            left.created_at.cmp(&right.created_at).then_with(|| {
                left.identity_pubkey
                    .to_hex()
                    .cmp(&right.identity_pubkey.to_hex())
            })
        });
        for device in devices {
            fact_tags.push(vec![
                "device".to_string(),
                device.identity_pubkey.to_hex(),
                device.created_at.to_string(),
            ]);
        }
        if !encrypted_labels.is_empty() {
            fact_tags.push(vec![
                APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT.to_string(),
                encrypted_labels,
            ]);
        }

        let mut indexed_pubkeys = BTreeSet::new();
        for fact in &fact_tags {
            for value in fact.iter().skip(1) {
                if crate::utils::pubkey_from_hex(value).is_ok() {
                    indexed_pubkeys.insert(value.clone());
                }
            }
        }

        let mut raw_tags = vec![
            vec!["d".to_string(), profile_id.clone()],
            vec!["i".to_string(), profile_id, "subject".to_string()],
        ];
        raw_tags.extend(
            indexed_pubkeys
                .into_iter()
                .map(|pubkey| vec!["p".to_string(), pubkey]),
        );
        raw_tags.extend(fact_tags);
        raw_tags.sort();
        raw_tags.dedup();
        let tags = raw_tags
            .into_iter()
            .map(|parts| Tag::parse(parts).expect("valid app-keys fact tag"))
            .collect::<Vec<_>>();

        EventBuilder::new(Kind::from(APP_KEYS_SNAPSHOT_KIND as u16), "")
            .tags(tags)
            .custom_created_at(Timestamp::from(created_at_secs))
            .build(owner_pubkey)
    }

    fn build_unsigned_event(&self, owner_pubkey: PublicKey, content: String) -> UnsignedEvent {
        self.build_unsigned_event_at(owner_pubkey, content, current_unix_timestamp())
    }

    pub fn get_event(&self, owner_pubkey: PublicKey) -> UnsignedEvent {
        self.build_unsigned_event(owner_pubkey, String::new())
    }

    pub fn get_event_at(&self, owner_pubkey: PublicKey, created_at_secs: u64) -> UnsignedEvent {
        self.build_unsigned_event_at(owner_pubkey, String::new(), created_at_secs)
    }

    pub fn get_encrypted_event(&self, owner_keys: &Keys) -> Result<UnsignedEvent> {
        self.get_encrypted_event_at(owner_keys, current_unix_timestamp())
    }

    pub fn get_encrypted_event_at(
        &self,
        owner_keys: &Keys,
        created_at_secs: u64,
    ) -> Result<UnsignedEvent> {
        if self.device_labels.is_empty() {
            return Ok(self.get_event_at(owner_keys.public_key(), created_at_secs));
        }

        let conversation_key =
            nip44::v2::ConversationKey::derive(owner_keys.secret_key(), &owner_keys.public_key())?;
        let payload = EncryptedAppKeysContent {
            payload_type: "app-keys-labels".to_string(),
            v: 1,
            device_labels: self
                .get_all_device_labels()
                .into_iter()
                .filter(|(identity_pubkey, _)| self.devices.contains_key(identity_pubkey))
                .map(|(identity_pubkey, labels)| StoredDeviceLabels {
                    identity_pubkey: hex::encode(identity_pubkey.to_bytes()),
                    device_label: labels.device_label,
                    client_label: labels.client_label,
                    updated_at: labels.updated_at,
                })
                .collect(),
        };

        let payload_json = serde_json::to_string(&payload)?;
        let encrypted_bytes =
            nip44::v2::encrypt_to_bytes(&conversation_key, payload_json.as_bytes())?;
        let content = base64::engine::general_purpose::STANDARD.encode(&encrypted_bytes);

        Ok(self.build_unsigned_event_at(owner_keys.public_key(), content, created_at_secs))
    }

    pub fn from_event(event: &Event) -> Result<Self> {
        if event.verify().is_err() {
            return Err(Error::InvalidEvent("Invalid signature".to_string()));
        }

        if !is_app_keys_event(event) {
            return Err(Error::InvalidEvent(
                "Event is not an AppKeys roster snapshot".to_string(),
            ));
        }
        if !event.content.is_empty() {
            return Err(Error::InvalidEvent(
                "AppKeys roster snapshot content must be empty".to_string(),
            ));
        }
        let schema = required_integer(event, "schema")?;
        if schema != APP_KEYS_SCHEMA {
            return Err(Error::InvalidEvent(format!(
                "Unsupported AppKeys roster schema {schema}"
            )));
        }
        let owner_pubkey = pubkey_from_required_tag(event, APP_KEYS_OWNER_PUBKEY_FACT)?;
        if owner_pubkey != event.pubkey {
            return Err(Error::InvalidEvent(
                "AppKeys roster owner signer mismatch".to_string(),
            ));
        }
        let _profile_id = app_keys_profile_id_from_event(event)?;

        let mut devices = Vec::new();
        for tag in event.tags.iter() {
            let vals = tag.clone().to_vec();
            if vals.first().map(|s| s.as_str()) != Some("device") {
                continue;
            }
            if vals.len() < 3 {
                continue;
            }

            let pk_hex = vals[1].clone();
            let created_at_str = vals[2].clone();
            let created_at = created_at_str
                .parse::<u64>()
                .unwrap_or_else(|_| event.created_at.as_secs());

            let pk = crate::utils::pubkey_from_hex(&pk_hex)?;
            devices.push(DeviceEntry::new(pk, created_at));
        }

        Ok(AppKeys::new(devices))
    }

    pub fn from_event_with_labels(event: &Event, owner_keys: &Keys) -> Result<Self> {
        let mut app_keys = Self::from_event(event)?;
        app_keys.load_encrypted_labels(event, owner_keys)?;
        Ok(app_keys)
    }

    pub fn serialize(&self) -> Result<String> {
        #[derive(Serialize)]
        struct StoredDevice {
            identity_pubkey: String,
            created_at: u64,
        }
        #[derive(Serialize)]
        struct StoredAppKeys {
            devices: Vec<StoredDevice>,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            device_labels: Vec<StoredDeviceLabels>,
        }

        let devices = self
            .get_all_devices()
            .into_iter()
            .map(|d| StoredDevice {
                identity_pubkey: hex::encode(d.identity_pubkey.to_bytes()),
                created_at: d.created_at,
            })
            .collect();

        let device_labels = self
            .get_all_device_labels()
            .into_iter()
            .map(|(identity_pubkey, labels)| StoredDeviceLabels {
                identity_pubkey: hex::encode(identity_pubkey.to_bytes()),
                device_label: labels.device_label,
                client_label: labels.client_label,
                updated_at: labels.updated_at,
            })
            .collect();

        Ok(serde_json::to_string(&StoredAppKeys {
            devices,
            device_labels,
        })?)
    }

    pub fn deserialize(json: &str) -> Result<Self> {
        #[derive(Deserialize)]
        struct StoredDevice {
            identity_pubkey: String,
            created_at: u64,
        }
        #[derive(Deserialize)]
        struct StoredAppKeys {
            devices: Vec<StoredDevice>,
            #[serde(default)]
            device_labels: Vec<StoredDeviceLabels>,
        }

        let data: StoredAppKeys = serde_json::from_str(json)?;
        let devices = data
            .devices
            .into_iter()
            .filter_map(|d| {
                crate::utils::pubkey_from_hex(&d.identity_pubkey)
                    .ok()
                    .map(|pk| DeviceEntry::new(pk, d.created_at))
            })
            .collect();

        let mut app_keys = AppKeys::new(devices);
        for labels in data.device_labels {
            if let Ok(pubkey) = crate::utils::pubkey_from_hex(&labels.identity_pubkey) {
                app_keys.device_labels.insert(
                    pubkey,
                    DeviceLabels {
                        device_label: labels.device_label,
                        client_label: labels.client_label,
                        updated_at: labels.updated_at,
                    },
                );
            }
        }

        Ok(app_keys)
    }

    pub fn merge(&self, other: &AppKeys) -> AppKeys {
        let mut merged = HashMap::new();

        for device in self
            .get_all_devices()
            .into_iter()
            .chain(other.get_all_devices())
        {
            merged
                .entry(device.identity_pubkey)
                .and_modify(|existing: &mut DeviceEntry| {
                    if device.created_at < existing.created_at {
                        *existing = device.clone();
                    }
                })
                .or_insert(device);
        }

        let mut merged_labels = HashMap::new();
        for (identity_pubkey, labels) in self.device_labels.iter().chain(other.device_labels.iter())
        {
            merged_labels
                .entry(*identity_pubkey)
                .and_modify(|existing: &mut DeviceLabels| {
                    if labels.updated_at > existing.updated_at {
                        *existing = labels.clone();
                    }
                })
                .or_insert_with(|| labels.clone());
        }

        merged_labels.retain(|identity_pubkey, _| merged.contains_key(identity_pubkey));

        AppKeys {
            devices: merged,
            device_labels: merged_labels,
        }
    }

    fn load_encrypted_labels(&mut self, event: &Event, owner_keys: &Keys) -> Result<()> {
        let Some(encrypted_labels) = tag_values(event, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT)
            .into_iter()
            .next()
        else {
            return Ok(());
        };

        let conversation_key =
            nip44::v2::ConversationKey::derive(owner_keys.secret_key(), &owner_keys.public_key())?;
        let ciphertext_bytes = base64::engine::general_purpose::STANDARD
            .decode(encrypted_labels.as_bytes())
            .map_err(|e| Error::Decryption(format!("Base64 decode error: {}", e)))?;
        let plaintext_bytes = nip44::v2::decrypt_to_bytes(&conversation_key, &ciphertext_bytes)?;
        let payload = serde_json::from_slice::<EncryptedAppKeysContent>(&plaintext_bytes)?;

        if payload.payload_type != "app-keys-labels" || payload.v != 1 {
            return Err(Error::InvalidEvent(
                "Unsupported AppKeys label payload".to_string(),
            ));
        }

        self.device_labels.clear();
        for labels in payload.device_labels {
            let pubkey = crate::utils::pubkey_from_hex(&labels.identity_pubkey)?;
            if self.devices.contains_key(&pubkey) {
                self.device_labels.insert(
                    pubkey,
                    DeviceLabels {
                        device_label: labels.device_label,
                        client_label: labels.client_label,
                        updated_at: labels.updated_at,
                    },
                );
            }
        }

        Ok(())
    }
}

pub fn encrypted_device_label_payloads_from_app_keys_event(event: &Event) -> Vec<String> {
    tag_values(event, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT)
}

pub fn build_app_keys_device_authorization_filter(device_pubkey: PublicKey) -> Filter {
    Filter::new()
        .kind(Kind::from(APP_KEYS_SNAPSHOT_KIND as u16))
        .custom_tags(SingleLetterTag::lowercase(Alphabet::P), [device_pubkey])
}

pub fn resolve_app_keys_owner_for_device(
    event: &Event,
    device_pubkey: PublicKey,
) -> Result<Option<PublicKey>> {
    let app_keys = AppKeys::from_event(event)?;
    Ok(app_keys.get_device(&device_pubkey).map(|_| event.pubkey))
}

fn app_keys_authorization_candidate(
    owner: PublicKey,
    event: &Event,
    now_secs: u64,
) -> Result<AppKeys> {
    if event.pubkey != owner {
        return Err(Error::InvalidEvent(
            "AppKeys authorization owner mismatch".to_string(),
        ));
    }
    if event.created_at.as_secs()
        > now_secs.saturating_add(APP_KEYS_AUTHORIZATION_MAX_FUTURE_SKEW_SECS)
    {
        return Err(Error::InvalidEvent(
            "AppKeys authorization event is too far in the future".to_string(),
        ));
    }
    if serde_json::to_vec(event)?.len() > APP_KEYS_AUTHORIZATION_MAX_EVENT_BYTES {
        return Err(Error::InvalidEvent(
            "AppKeys authorization event is too large".to_string(),
        ));
    }
    let device_tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(|value| value.as_str()) == Some("device"))
        .collect::<Vec<_>>();
    if device_tags.len() > APP_KEYS_AUTHORIZATION_MAX_DEVICES {
        return Err(Error::InvalidEvent(
            "AppKeys authorization roster has too many devices".to_string(),
        ));
    }
    if device_tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.len() < 3 || values[2].parse::<u64>().is_err()
    }) {
        return Err(Error::InvalidEvent(
            "AppKeys authorization device tag is malformed".to_string(),
        ));
    }
    AppKeys::from_event(event)
}

fn tag_values(event: &Event, name: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let vals = tag.clone().to_vec();
            (vals.first().map(|value| value.as_str()) == Some(name))
                .then(|| vals.get(1).map(|value| value.trim().to_string()))
                .flatten()
        })
        .filter(|value| !value.is_empty())
        .collect()
}

fn required_tag_value(event: &Event, name: &str) -> Result<String> {
    tag_values(event, name)
        .into_iter()
        .next()
        .ok_or_else(|| Error::InvalidEvent(format!("AppKeys roster missing {name}")))
}

fn required_integer(event: &Event, name: &str) -> Result<u64> {
    required_tag_value(event, name)?
        .parse::<u64>()
        .map_err(|_| Error::InvalidEvent(format!("AppKeys {name} must be an integer")))
}

fn pubkey_from_required_tag(event: &Event, name: &str) -> Result<PublicKey> {
    crate::utils::pubkey_from_hex(&required_tag_value(event, name)?)
}

fn app_keys_profile_id_from_event(event: &Event) -> Result<String> {
    let profile_id = event
        .tags
        .iter()
        .filter_map(|tag| {
            let vals = tag.clone().to_vec();
            (vals.first().map(|value| value.as_str()) == Some("i")
                && vals.get(2).map(|value| value.as_str()) == Some("subject"))
            .then(|| vals.get(1).map(|value| value.trim().to_lowercase()))
            .flatten()
        })
        .next()
        .ok_or_else(|| Error::InvalidEvent("AppKeys roster missing profile subject".to_string()))?;
    canonical_profile_id(&profile_id)
}

fn canonical_profile_id(profile_id: &str) -> Result<String> {
    let normalized = profile_id.trim().to_lowercase();
    if !is_uuid_like(&normalized) {
        return Err(Error::InvalidEvent(
            "AppKeys profile id must be a UUID".to_string(),
        ));
    }
    Ok(normalized)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    [8, 13, 18, 23]
        .into_iter()
        .all(|index| bytes[index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn current_unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

pub fn is_app_keys_event(event: &Event) -> bool {
    if event.kind.as_u16() != APP_KEYS_SNAPSHOT_KIND as u16 {
        return false;
    }

    tag_values(event, "type")
        .iter()
        .any(|value| value == APP_KEYS_FACT_TYPE)
}
