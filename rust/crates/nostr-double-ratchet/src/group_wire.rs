use crate::{
    DevicePubkey, Error, GroupPairwiseCommand, GroupPayloadCodec, GroupPayloadEncodeContext,
    GroupProtocol, GroupSenderKeyPlaintext, GroupSenderKeyPlaintextDecodeContext, GroupSnapshot,
    OwnerPubkey, Result, SenderKeyDistribution, SenderKeyRepairRequest, UnixSeconds,
};
use nostr::{
    Alphabet, Event, EventBuilder, EventId, Filter, Kind, PublicKey, SingleLetterTag, Tag, Tags,
    Timestamp, UnsignedEvent,
};
use serde::{Deserialize, Serialize};

pub const GROUP_ROSTER_FACT_KIND: u32 = 37368;
pub const GROUP_ROSTER_FACT_TYPE: &str = "group_roster";
pub const GROUP_ROSTER_FACT_SCHEMA: u64 = 1;
pub const GROUP_SENDER_KEY_DISTRIBUTION_KIND: u32 = 10446;
pub const GROUP_SENDER_KEY_REPAIR_REQUEST_KIND: u32 = 10447;

const GROUP_WIRE_FORMAT_VERSION_V1: u8 = 1;
const CHAT_MESSAGE_KIND: u32 = 14;
const GROUP_LABEL_TAG: &str = "l";
const KEY_TAG: &str = "key";
const SENDER_TAG: &str = "sender";
const MESSAGE_TAG: &str = "message";
const MS_TAG: &str = "ms";
const REVISION_TAG: &str = "revision";

#[derive(Debug, Clone, Copy, Default)]
pub struct JsonGroupPayloadCodecV1;

pub type GroupEventManager = crate::GroupManager<JsonGroupPayloadCodecV1>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GroupWireEnvelopeV1 {
    wire_format_version: u8,
    payload: GroupPairwisePayloadV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum GroupPairwisePayloadV1 {
    MetadataSnapshot {
        snapshot: GroupSnapshot,
    },
    CreateGroup {
        group_id: String,
        protocol: GroupProtocol,
        base_revision: u64,
        new_revision: u64,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        picture: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        about: Option<String>,
        created_by: OwnerPubkey,
        members: Vec<OwnerPubkey>,
        admins: Vec<OwnerPubkey>,
        created_at: UnixSeconds,
        updated_at: UnixSeconds,
    },
    SyncGroup {
        group_id: String,
        protocol: GroupProtocol,
        revision: u64,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        picture: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        about: Option<String>,
        created_by: OwnerPubkey,
        members: Vec<OwnerPubkey>,
        admins: Vec<OwnerPubkey>,
        created_at: UnixSeconds,
        updated_at: UnixSeconds,
    },
    GroupMessage {
        group_id: String,
        revision: u64,
        body: Vec<u8>,
    },
    SenderKeyDistribution {
        distribution: SenderKeyDistribution,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SenderKeyDistributionContent {
    group_id: String,
    key_id: u32,
    chain_key: String,
    iteration: u32,
    created_at: UnixSeconds,
    sender_event_pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SenderKeyRepairRequestContent {
    group_id: String,
    sender_event_pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    required_revision: Option<u64>,
    created_at: UnixSeconds,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRosterFact {
    pub event_id: EventId,
    pub signer_pubkey: PublicKey,
    pub group_id: String,
    pub revision: u64,
    pub snapshot: GroupSnapshot,
}

pub fn build_group_roster_fact_filter<I, S, A>(group_ids: I, authors: A) -> Filter
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
    A: IntoIterator<Item = PublicKey>,
{
    let group_ids: Vec<String> = group_ids
        .into_iter()
        .map(|value| value.as_ref().trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    let authors: Vec<PublicKey> = authors.into_iter().collect();
    let mut filter = Filter::new().kind(Kind::from(GROUP_ROSTER_FACT_KIND as u16));
    if !group_ids.is_empty() {
        filter = filter.custom_tags(SingleLetterTag::lowercase(Alphabet::D), group_ids);
    }
    if !authors.is_empty() {
        filter = filter.authors(authors);
    }
    filter
}

fn group_roster_fact_tags(snapshot: &GroupSnapshot) -> Result<Vec<Tag>> {
    let group_id = require_non_empty(&snapshot.group_id, "group id")?;
    let name = require_non_empty(&snapshot.name, "name")?;
    let members = canonical_owner_pubkeys(&snapshot.members);
    let admins = canonical_owner_pubkeys(&snapshot.admins);
    require_admins_are_members(&admins, &members)?;

    let revision = snapshot.revision.to_string();
    let created_at = snapshot.created_at.get().to_string();
    let updated_at = snapshot.updated_at.get().to_string();
    let created_by = snapshot.created_by.to_hex();
    let mut tags = vec![
        vec!["d".to_string(), group_id.to_string()],
        vec!["i".to_string(), group_id.to_string(), "subject".to_string()],
        vec!["type".to_string(), GROUP_ROSTER_FACT_TYPE.to_string()],
        vec!["schema".to_string(), GROUP_ROSTER_FACT_SCHEMA.to_string()],
        vec!["group_id".to_string(), group_id.to_string()],
        vec!["revision".to_string(), revision],
        vec!["name".to_string(), name.to_string()],
        vec!["created_at".to_string(), created_at],
        vec!["updated_at".to_string(), updated_at],
        vec!["created_by".to_string(), created_by],
        vec![
            "protocol".to_string(),
            group_protocol_to_tag(snapshot.protocol)?.to_string(),
        ],
    ];
    if let Some(about) = snapshot.about.as_ref().filter(|value| !value.is_empty()) {
        tags.push(vec!["about".to_string(), about.to_string()]);
    }
    if let Some(picture) = snapshot.picture.as_ref().filter(|value| !value.is_empty()) {
        tags.push(vec!["picture".to_string(), picture.to_string()]);
    }
    tags.extend(
        members
            .iter()
            .map(|member| vec!["member".to_string(), member.to_hex()]),
    );
    tags.extend(
        admins
            .iter()
            .map(|admin| vec!["admin".to_string(), admin.to_hex()]),
    );
    canonicalize_raw_tags(&mut tags);
    tags.into_iter()
        .map(|parts| Tag::parse(parts).map_err(|error| Error::Parse(error.to_string())))
        .collect()
}

pub fn group_roster_unsigned_event(
    signer_pubkey: PublicKey,
    snapshot: &GroupSnapshot,
) -> Result<UnsignedEvent> {
    let signer_owner = OwnerPubkey::from_bytes(signer_pubkey.to_bytes());
    let admins = canonical_owner_pubkeys(&snapshot.admins);
    if !admins.contains(&signer_owner) {
        return Err(Error::InvalidEvent(
            "GroupRoster signer must be an admin".to_string(),
        ));
    }

    let tags = group_roster_fact_tags(snapshot)?;

    Ok(
        EventBuilder::new(Kind::from(GROUP_ROSTER_FACT_KIND as u16), "")
            .tags(tags)
            .custom_created_at(Timestamp::from(snapshot.updated_at.get()))
            .build(signer_pubkey),
    )
}

pub fn is_group_roster_fact_event(event: &Event) -> bool {
    event.kind.as_u16() as u32 == GROUP_ROSTER_FACT_KIND
        && event_tag_values(event, "type")
            .iter()
            .any(|value| value == GROUP_ROSTER_FACT_TYPE)
}

fn unsigned_is_group_roster_fact_event(event: &UnsignedEvent) -> bool {
    event.kind.as_u16() as u32 == GROUP_ROSTER_FACT_KIND
        && unsigned_event_tag_values(event, "type")
            .iter()
            .any(|value| value == GROUP_ROSTER_FACT_TYPE)
}

pub fn parse_group_roster_fact_event(event: &Event) -> Result<GroupRosterFact> {
    if event.verify().is_err() {
        return Err(Error::InvalidEvent(
            "GroupRoster fact signature is invalid".to_string(),
        ));
    }
    if !is_group_roster_fact_event(event) {
        return Err(Error::InvalidEvent(
            "Event is not a GroupRoster fact".to_string(),
        ));
    }
    if !event.content.is_empty() {
        return Err(Error::InvalidEvent(
            "GroupRoster fact event content must be empty".to_string(),
        ));
    }
    let schema = event_required_u64(event, "schema")?;
    if schema != GROUP_ROSTER_FACT_SCHEMA {
        return Err(Error::InvalidEvent(format!(
            "Unsupported GroupRoster fact schema {schema}"
        )));
    }
    let group_id = group_id_from_event(event)?;
    if let Some(tagged_group_id) = event_first_tag_value(event, "group_id") {
        if tagged_group_id != group_id {
            return Err(Error::InvalidEvent(
                "GroupRoster group_id/subject tag mismatch".to_string(),
            ));
        }
    }
    let members = canonical_owner_pubkeys(&event_owner_pubkeys(event, "member")?);
    let admins = canonical_owner_pubkeys(&event_owner_pubkeys(event, "admin")?);
    require_admins_are_members(&admins, &members)?;
    let signer_owner = OwnerPubkey::from_bytes(event.pubkey.to_bytes());
    if !admins.contains(&signer_owner) {
        return Err(Error::InvalidEvent(
            "GroupRoster signer must be an admin".to_string(),
        ));
    }
    let protocol = event_first_tag_value(event, "protocol")
        .map(|value| group_protocol_from_tag(&value))
        .transpose()?
        .unwrap_or_else(GroupProtocol::sender_key_v1);
    let revision = event_required_u64(event, "revision")?;
    let snapshot = GroupSnapshot {
        group_id: group_id.clone(),
        protocol,
        name: event_required_value(event, "name")?,
        picture: event_first_tag_value(event, "picture"),
        about: event_first_tag_value(event, "about")
            .or_else(|| event_first_tag_value(event, "description")),
        created_by: event_owner_pubkey(event, "created_by")?,
        members,
        admins,
        revision,
        created_at: UnixSeconds(event_required_u64(event, "created_at")?),
        updated_at: UnixSeconds(event_required_u64(event, "updated_at")?),
    };

    Ok(GroupRosterFact {
        event_id: event.id,
        signer_pubkey: event.pubkey,
        group_id,
        revision,
        snapshot,
    })
}

pub fn project_group_roster_fact_events<'a, I>(events: I) -> Vec<GroupSnapshot>
where
    I: IntoIterator<Item = &'a Event>,
{
    let mut by_group: std::collections::BTreeMap<String, GroupRosterFact> =
        std::collections::BTreeMap::new();
    for event in events {
        let Ok(fact) = parse_group_roster_fact_event(event) else {
            continue;
        };
        let should_replace = by_group
            .get(&fact.group_id)
            .map(|existing| compare_group_roster_facts(&fact, existing).is_gt())
            .unwrap_or(true);
        if should_replace {
            by_group.insert(fact.group_id.clone(), fact);
        }
    }
    by_group.into_values().map(|fact| fact.snapshot).collect()
}

fn group_roster_snapshot_from_unsigned_event(event: &UnsignedEvent) -> Result<GroupSnapshot> {
    if !unsigned_is_group_roster_fact_event(event) {
        return Err(Error::InvalidEvent(
            "Event is not a GroupRoster fact".to_string(),
        ));
    }
    if !event.content.is_empty() {
        return Err(Error::InvalidEvent(
            "GroupRoster fact event content must be empty".to_string(),
        ));
    }
    let schema = unsigned_event_required_u64(event, "schema")?;
    if schema != GROUP_ROSTER_FACT_SCHEMA {
        return Err(Error::InvalidEvent(format!(
            "Unsupported GroupRoster fact schema {schema}"
        )));
    }
    let group_id = group_id_from_unsigned_event(event)?;
    if let Some(tagged_group_id) = unsigned_event_first_tag_value(event, "group_id") {
        if tagged_group_id != group_id {
            return Err(Error::InvalidEvent(
                "GroupRoster group_id/subject tag mismatch".to_string(),
            ));
        }
    }
    let members = canonical_owner_pubkeys(&unsigned_event_owner_pubkeys(event, "member")?);
    let admins = canonical_owner_pubkeys(&unsigned_event_owner_pubkeys(event, "admin")?);
    require_admins_are_members(&admins, &members)?;
    let protocol = unsigned_event_first_tag_value(event, "protocol")
        .map(|value| group_protocol_from_tag(&value))
        .transpose()?
        .unwrap_or_else(GroupProtocol::sender_key_v1);
    Ok(GroupSnapshot {
        group_id,
        protocol,
        name: unsigned_event_required_value(event, "name")?,
        picture: unsigned_event_first_tag_value(event, "picture"),
        about: unsigned_event_first_tag_value(event, "about")
            .or_else(|| unsigned_event_first_tag_value(event, "description")),
        created_by: unsigned_event_owner_pubkey(event, "created_by")?,
        members,
        admins,
        revision: unsigned_event_required_u64(event, "revision")?,
        created_at: UnixSeconds(unsigned_event_required_u64(event, "created_at")?),
        updated_at: UnixSeconds(unsigned_event_required_u64(event, "updated_at")?),
    })
}

mod codec;

fn encode_envelope(payload: GroupPairwisePayloadV1) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&GroupWireEnvelopeV1 {
        wire_format_version: GROUP_WIRE_FORMAT_VERSION_V1,
        payload,
    })?)
}

fn compare_group_roster_facts(
    left: &GroupRosterFact,
    right: &GroupRosterFact,
) -> std::cmp::Ordering {
    left.revision
        .cmp(&right.revision)
        .then_with(|| left.snapshot.updated_at.cmp(&right.snapshot.updated_at))
        .then_with(|| left.event_id.to_hex().cmp(&right.event_id.to_hex()))
}

fn group_protocol_to_tag(protocol: GroupProtocol) -> Result<&'static str> {
    if protocol.is_pairwise_fanout_v1() {
        Ok("pairwise_fanout_v1")
    } else if protocol.is_sender_key_v1() {
        Ok("sender_key_v1")
    } else {
        Err(Error::InvalidEvent(
            "Unsupported GroupRoster protocol".to_string(),
        ))
    }
}

fn group_protocol_from_tag(value: &str) -> Result<GroupProtocol> {
    match value {
        "pairwise_fanout_v1" => Ok(GroupProtocol::pairwise_fanout_v1()),
        "sender_key_v1" => Ok(GroupProtocol::sender_key_v1()),
        other => Err(Error::InvalidEvent(format!(
            "Unsupported GroupRoster protocol {other}"
        ))),
    }
}

fn canonical_owner_pubkeys(pubkeys: &[OwnerPubkey]) -> Vec<OwnerPubkey> {
    let mut pubkeys = pubkeys.to_vec();
    pubkeys.sort();
    pubkeys.dedup();
    pubkeys
}

fn require_admins_are_members(admins: &[OwnerPubkey], members: &[OwnerPubkey]) -> Result<()> {
    if admins.is_empty() {
        return Err(Error::InvalidEvent(
            "GroupRoster admins must not be empty".to_string(),
        ));
    }
    if admins.iter().any(|admin| !members.contains(admin)) {
        return Err(Error::InvalidEvent(
            "GroupRoster admins must also be members".to_string(),
        ));
    }
    Ok(())
}

fn require_non_empty<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::InvalidEvent(format!(
            "GroupRoster {label} must not be empty"
        )));
    }
    Ok(value)
}

fn tag_values(tags: &Tags, key: &str) -> Vec<String> {
    tags.iter()
        .filter_map(|tag| {
            let values = tag.as_slice();
            if values.first().map(|value| value.as_str()) != Some(key) {
                return None;
            }
            values.get(1).map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .collect()
}

fn event_tag_values(event: &Event, key: &str) -> Vec<String> {
    tag_values(&event.tags, key)
}

fn unsigned_event_tag_values(event: &UnsignedEvent, key: &str) -> Vec<String> {
    tag_values(&event.tags, key)
}

fn event_first_tag_value(event: &Event, key: &str) -> Option<String> {
    event_tag_values(event, key).into_iter().next()
}

fn unsigned_event_first_tag_value(event: &UnsignedEvent, key: &str) -> Option<String> {
    unsigned_event_tag_values(event, key).into_iter().next()
}

fn event_required_value(event: &Event, key: &str) -> Result<String> {
    event_first_tag_value(event, key)
        .ok_or_else(|| Error::InvalidEvent(format!("GroupRoster fact missing {key}")))
}

fn unsigned_event_required_value(event: &UnsignedEvent, key: &str) -> Result<String> {
    unsigned_event_first_tag_value(event, key)
        .ok_or_else(|| Error::InvalidEvent(format!("GroupRoster fact missing {key}")))
}

fn event_required_u64(event: &Event, key: &str) -> Result<u64> {
    event_required_value(event, key)?
        .parse::<u64>()
        .map_err(|_| Error::InvalidEvent(format!("GroupRoster {key} must be an integer")))
}

fn unsigned_event_required_u64(event: &UnsignedEvent, key: &str) -> Result<u64> {
    unsigned_event_required_value(event, key)?
        .parse::<u64>()
        .map_err(|_| Error::InvalidEvent(format!("GroupRoster {key} must be an integer")))
}

fn event_owner_pubkey(event: &Event, key: &str) -> Result<OwnerPubkey> {
    parse_owner_pubkey_hex(&event_required_value(event, key)?)
}

fn unsigned_event_owner_pubkey(event: &UnsignedEvent, key: &str) -> Result<OwnerPubkey> {
    parse_owner_pubkey_hex(&unsigned_event_required_value(event, key)?)
}

fn event_owner_pubkeys(event: &Event, key: &str) -> Result<Vec<OwnerPubkey>> {
    event_tag_values(event, key)
        .iter()
        .map(|value| parse_owner_pubkey_hex(value))
        .collect()
}

fn unsigned_event_owner_pubkeys(event: &UnsignedEvent, key: &str) -> Result<Vec<OwnerPubkey>> {
    unsigned_event_tag_values(event, key)
        .iter()
        .map(|value| parse_owner_pubkey_hex(value))
        .collect()
}

fn group_id_from_event(event: &Event) -> Result<String> {
    group_id_from_tags(&event.tags)
}

fn group_id_from_unsigned_event(event: &UnsignedEvent) -> Result<String> {
    group_id_from_tags(&event.tags)
}

fn group_id_from_tags(tags: &Tags) -> Result<String> {
    let subjects: Vec<String> = tags
        .iter()
        .filter_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(|value| value.as_str()) == Some("i")
                && values.get(2).map(|value| value.as_str()) == Some("subject"))
            .then(|| values.get(1).map(|value| value.trim().to_string()))
            .flatten()
        })
        .filter(|value| !value.is_empty())
        .collect();
    if subjects.len() != 1 {
        return Err(Error::InvalidEvent(
            "GroupRoster fact must have exactly one subject i tag".to_string(),
        ));
    }
    let group_id = subjects[0].clone();
    let d = tag_values(tags, "d")
        .into_iter()
        .next()
        .ok_or_else(|| Error::InvalidEvent("GroupRoster fact missing d tag".to_string()))?;
    if d != group_id {
        return Err(Error::InvalidEvent(
            "GroupRoster d/subject tag mismatch".to_string(),
        ));
    }
    Ok(group_id)
}

fn canonicalize_raw_tags(tags: &mut Vec<Vec<String>>) {
    tags.sort();
    tags.dedup();
}

fn first_tag_value(event: &UnsignedEvent, key: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let values = tag.as_slice();
        if values.first().map(|value| value.as_str()) != Some(key) {
            return None;
        }
        values.get(1).cloned()
    })
}

fn require_tag_string(event: &UnsignedEvent, key: &str, expected: &str) -> Result<()> {
    let Some(value) = first_tag_value(event, key) else {
        return Err(Error::Parse(format!("missing {key} tag")));
    };
    if value != expected {
        return Err(Error::Parse(format!("{key} tag mismatch")));
    }
    Ok(())
}

fn require_tag_u32(event: &UnsignedEvent, key: &str, expected: u32) -> Result<()> {
    let Some(value) = first_tag_value(event, key) else {
        return Err(Error::Parse(format!("missing {key} tag")));
    };
    let value = value
        .parse::<u32>()
        .map_err(|error| Error::Parse(error.to_string()))?;
    if value != expected {
        return Err(Error::Parse(format!("{key} tag mismatch")));
    }
    Ok(())
}

fn require_tag_u64(event: &UnsignedEvent, key: &str, expected: u64) -> Result<()> {
    let Some(value) = first_tag_value(event, key) else {
        return Err(Error::Parse(format!("missing {key} tag")));
    };
    let value = value
        .parse::<u64>()
        .map_err(|error| Error::Parse(error.to_string()))?;
    if value != expected {
        return Err(Error::Parse(format!("{key} tag mismatch")));
    }
    Ok(())
}

fn tag<const N: usize>(parts: [&str; N]) -> Result<Tag> {
    Tag::parse(parts.map(str::to_owned)).map_err(|error| Error::Parse(error.to_string()))
}

fn parse_device_pubkey_hex(value: &str) -> Result<DevicePubkey> {
    let bytes = hex::decode(value).map_err(|error| Error::Parse(error.to_string()))?;
    let bytes = <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| Error::Parse("expected 32-byte public key".to_string()))?;
    Ok(DevicePubkey::from_bytes(bytes))
}

fn parse_owner_pubkey_hex(value: &str) -> Result<OwnerPubkey> {
    let bytes = hex::decode(value).map_err(|error| Error::Parse(error.to_string()))?;
    let bytes = <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| Error::Parse("expected 32-byte public key".to_string()))?;
    Ok(OwnerPubkey::from_bytes(bytes))
}

#[cfg(test)]
mod tests;
