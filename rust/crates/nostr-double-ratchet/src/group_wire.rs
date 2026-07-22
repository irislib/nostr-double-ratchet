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

impl GroupPayloadCodec for JsonGroupPayloadCodecV1 {
    fn is_pairwise_payload(&self, payload: &[u8]) -> bool {
        self.decode_pairwise_command(payload)
            .map(|command| command.is_some())
            .unwrap_or(false)
    }

    fn encode_pairwise_command(
        &self,
        ctx: GroupPayloadEncodeContext,
        command: &GroupPairwiseCommand,
    ) -> Result<Vec<u8>> {
        match command {
            GroupPairwiseCommand::MetadataSnapshot { snapshot } => {
                encode_master_metadata_snapshot(ctx, snapshot)
            }
            GroupPairwiseCommand::GroupMessage {
                group_id,
                revision,
                body,
            } => encode_envelope(GroupPairwisePayloadV1::GroupMessage {
                group_id: group_id.clone(),
                revision: *revision,
                body: body.clone(),
            }),
            GroupPairwiseCommand::SenderKeyDistribution { distribution } => {
                encode_sender_key_distribution(ctx, distribution)
            }
            GroupPairwiseCommand::SenderKeyRepairRequest { request } => {
                encode_sender_key_repair_request(ctx, request)
            }
        }
    }

    fn decode_pairwise_command(&self, payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
        if let Some(command) = decode_master_metadata_snapshot(payload)? {
            return Ok(Some(command));
        }
        if let Some(command) = decode_sender_key_distribution(payload)? {
            return Ok(Some(command));
        }
        if let Some(command) = decode_sender_key_repair_request(payload)? {
            return Ok(Some(command));
        }

        let Ok(envelope) = serde_json::from_slice::<GroupWireEnvelopeV1>(payload) else {
            return Ok(None);
        };
        if envelope.wire_format_version != GROUP_WIRE_FORMAT_VERSION_V1 {
            return Ok(None);
        }
        command_from_v1_payload(envelope.payload)
    }

    fn encode_sender_key_plaintext(
        &self,
        ctx: GroupPayloadEncodeContext,
        plaintext: &GroupSenderKeyPlaintext,
    ) -> Result<Vec<u8>> {
        let content = String::from_utf8(plaintext.body.clone())
            .map_err(|error| Error::Parse(error.to_string()))?;
        let millis = ctx.created_at.get().saturating_mul(1000).to_string();
        let revision = plaintext.revision.to_string();
        let event = EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), content)
            .tags(vec![
                tag([GROUP_LABEL_TAG, plaintext.group_id.as_str()])?,
                tag([MS_TAG, millis.as_str()])?,
                tag([REVISION_TAG, revision.as_str()])?,
            ])
            .custom_created_at(Timestamp::from(ctx.created_at.get()))
            .build(ctx.local_device_pubkey.to_nostr()?);
        Ok(serde_json::to_vec(&event)?)
    }

    fn decode_sender_key_plaintext(
        &self,
        ctx: GroupSenderKeyPlaintextDecodeContext<'_>,
        payload: &[u8],
    ) -> Result<Option<GroupSenderKeyPlaintext>> {
        let Some(event) = decode_verified_unsigned_event(payload)? else {
            return Ok(None);
        };
        if event.kind.as_u16() as u32 != CHAT_MESSAGE_KIND {
            return Ok(None);
        }
        let Some(group_id) = first_tag_value(&event, GROUP_LABEL_TAG) else {
            return Ok(None);
        };
        if group_id != ctx.group_id {
            return Ok(None);
        }
        let revision = first_tag_value(&event, REVISION_TAG)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(ctx.current_revision);
        Ok(Some(GroupSenderKeyPlaintext {
            group_id,
            revision,
            body: event.content.into_bytes(),
        }))
    }
}

fn encode_master_metadata_snapshot(
    ctx: GroupPayloadEncodeContext,
    snapshot: &GroupSnapshot,
) -> Result<Vec<u8>> {
    let event = EventBuilder::new(Kind::from(GROUP_ROSTER_FACT_KIND as u16), "")
        .tags(group_roster_fact_tags(snapshot)?)
        .custom_created_at(Timestamp::from(ctx.created_at.get()))
        .build(ctx.local_device_pubkey.to_nostr()?);
    Ok(serde_json::to_vec(&event)?)
}

fn decode_master_metadata_snapshot(payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
    let Some(event) = decode_verified_unsigned_event(payload)? else {
        return Ok(None);
    };
    if event.kind.as_u16() as u32 != GROUP_ROSTER_FACT_KIND
        || !unsigned_is_group_roster_fact_event(&event)
    {
        return Ok(None);
    }

    let snapshot = group_roster_snapshot_from_unsigned_event(&event)?;
    Ok(Some(GroupPairwiseCommand::MetadataSnapshot { snapshot }))
}

fn encode_sender_key_distribution(
    ctx: GroupPayloadEncodeContext,
    distribution: &SenderKeyDistribution,
) -> Result<Vec<u8>> {
    let content = serde_json::to_string(&SenderKeyDistributionContent {
        group_id: distribution.group_id.clone(),
        key_id: distribution.key_id,
        chain_key: hex::encode(distribution.chain_key),
        iteration: distribution.iteration,
        created_at: distribution.created_at,
        sender_event_pubkey: distribution.sender_event_pubkey.to_string(),
    })?;
    let millis = ctx.created_at.get().saturating_mul(1000).to_string();
    let key_id = distribution.key_id.to_string();
    let event = EventBuilder::new(
        Kind::from(GROUP_SENDER_KEY_DISTRIBUTION_KIND as u16),
        content,
    )
    .tags(vec![
        tag([GROUP_LABEL_TAG, distribution.group_id.as_str()])?,
        tag([KEY_TAG, key_id.as_str()])?,
        tag([MS_TAG, millis.as_str()])?,
    ])
    .custom_created_at(Timestamp::from(ctx.created_at.get()))
    .build(ctx.local_device_pubkey.to_nostr()?);
    Ok(serde_json::to_vec(&event)?)
}

fn decode_sender_key_distribution(payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
    let Some(event) = decode_verified_unsigned_event(payload)? else {
        return Ok(None);
    };
    if event.kind.as_u16() as u32 != GROUP_SENDER_KEY_DISTRIBUTION_KIND {
        return Ok(None);
    }

    let content = serde_json::from_str::<SenderKeyDistributionContent>(&event.content)?;
    if content.group_id.is_empty() {
        return Ok(None);
    }
    if let Some(tagged_group_id) = first_tag_value(&event, GROUP_LABEL_TAG) {
        if tagged_group_id != content.group_id {
            return Err(Error::Parse(
                "sender-key distribution group id/tag mismatch".to_string(),
            ));
        }
    }
    if let Some(tagged_key_id) = first_tag_value(&event, KEY_TAG) {
        let tagged_key_id = tagged_key_id
            .parse::<u32>()
            .map_err(|error| Error::Parse(error.to_string()))?;
        if tagged_key_id != content.key_id {
            return Err(Error::Parse(
                "sender-key distribution key id/tag mismatch".to_string(),
            ));
        }
    }
    let chain_key =
        hex::decode(&content.chain_key).map_err(|error| Error::Parse(error.to_string()))?;
    let chain_key = <[u8; 32]>::try_from(chain_key.as_slice()).map_err(|_| {
        Error::Parse("sender-key distribution chain key must be 32 bytes".to_string())
    })?;
    let sender_event_pubkey = parse_device_pubkey_hex(&content.sender_event_pubkey)?;

    Ok(Some(GroupPairwiseCommand::SenderKeyDistribution {
        distribution: SenderKeyDistribution {
            group_id: content.group_id,
            key_id: content.key_id,
            sender_event_pubkey,
            chain_key,
            iteration: content.iteration,
            created_at: content.created_at,
        },
    }))
}

fn encode_sender_key_repair_request(
    ctx: GroupPayloadEncodeContext,
    request: &SenderKeyRepairRequest,
) -> Result<Vec<u8>> {
    let content = serde_json::to_string(&SenderKeyRepairRequestContent {
        group_id: request.group_id.clone(),
        sender_event_pubkey: request.sender_event_pubkey.to_string(),
        key_id: request.key_id,
        message_number: request.message_number,
        required_revision: request.required_revision,
        created_at: request.created_at,
    })?;
    let millis = ctx.created_at.get().saturating_mul(1000).to_string();
    let sender_event_pubkey = request.sender_event_pubkey.to_string();
    let mut tags = vec![
        tag([GROUP_LABEL_TAG, request.group_id.as_str()])?,
        tag([SENDER_TAG, sender_event_pubkey.as_str()])?,
        tag([MS_TAG, millis.as_str()])?,
    ];
    let key_id;
    if let Some(request_key_id) = request.key_id {
        key_id = request_key_id.to_string();
        tags.push(tag([KEY_TAG, key_id.as_str()])?);
    }
    let message_number;
    if let Some(request_message_number) = request.message_number {
        message_number = request_message_number.to_string();
        tags.push(tag([MESSAGE_TAG, message_number.as_str()])?);
    }
    let revision;
    if let Some(required_revision) = request.required_revision {
        revision = required_revision.to_string();
        tags.push(tag([REVISION_TAG, revision.as_str()])?);
    }

    let event = EventBuilder::new(
        Kind::from(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND as u16),
        content,
    )
    .tags(tags)
    .custom_created_at(Timestamp::from(ctx.created_at.get()))
    .build(ctx.local_device_pubkey.to_nostr()?);
    Ok(serde_json::to_vec(&event)?)
}

fn decode_sender_key_repair_request(payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
    let Some(event) = decode_verified_unsigned_event(payload)? else {
        return Ok(None);
    };
    if event.kind.as_u16() as u32 != GROUP_SENDER_KEY_REPAIR_REQUEST_KIND {
        return Ok(None);
    }

    let content = serde_json::from_str::<SenderKeyRepairRequestContent>(&event.content)?;
    if content.group_id.is_empty() {
        return Ok(None);
    }
    require_tag_string(&event, GROUP_LABEL_TAG, &content.group_id)?;
    require_tag_string(&event, SENDER_TAG, &content.sender_event_pubkey)?;
    match content.key_id {
        Some(key_id) => require_tag_u32(&event, KEY_TAG, key_id)?,
        None => {
            if first_tag_value(&event, KEY_TAG).is_some() {
                return Err(Error::Parse("key tag mismatch".to_string()));
            }
        }
    }
    match content.message_number {
        Some(message_number) => require_tag_u32(&event, MESSAGE_TAG, message_number)?,
        None => {
            if first_tag_value(&event, MESSAGE_TAG).is_some() {
                return Err(Error::Parse("message tag mismatch".to_string()));
            }
        }
    }
    match content.required_revision {
        Some(required_revision) => require_tag_u64(&event, REVISION_TAG, required_revision)?,
        None => {
            if first_tag_value(&event, REVISION_TAG).is_some() {
                return Err(Error::Parse("revision tag mismatch".to_string()));
            }
        }
    }

    Ok(Some(GroupPairwiseCommand::SenderKeyRepairRequest {
        request: SenderKeyRepairRequest {
            group_id: content.group_id,
            sender_event_pubkey: parse_device_pubkey_hex(&content.sender_event_pubkey)?,
            key_id: content.key_id,
            message_number: content.message_number,
            required_revision: content.required_revision,
            created_at: content.created_at,
        },
    }))
}

fn decode_verified_unsigned_event(payload: &[u8]) -> Result<Option<UnsignedEvent>> {
    let Ok(mut event) = serde_json::from_slice::<UnsignedEvent>(payload) else {
        return Ok(None);
    };
    event.ensure_id();
    event
        .verify_id()
        .map_err(|error| Error::Parse(error.to_string()))?;
    Ok(Some(event))
}

fn encode_envelope(payload: GroupPairwisePayloadV1) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&GroupWireEnvelopeV1 {
        wire_format_version: GROUP_WIRE_FORMAT_VERSION_V1,
        payload,
    })?)
}

fn command_from_v1_payload(
    payload: GroupPairwisePayloadV1,
) -> Result<Option<GroupPairwiseCommand>> {
    Ok(match payload {
        GroupPairwisePayloadV1::MetadataSnapshot { snapshot } => {
            Some(GroupPairwiseCommand::MetadataSnapshot { snapshot })
        }
        GroupPairwisePayloadV1::CreateGroup {
            group_id,
            protocol,
            base_revision,
            new_revision,
            name,
            picture,
            about,
            created_by,
            members,
            admins,
            created_at,
            updated_at,
        } => {
            if base_revision != 0 {
                return Err(Error::Parse(
                    "create group base revision must be 0".to_string(),
                ));
            }
            Some(GroupPairwiseCommand::MetadataSnapshot {
                snapshot: GroupSnapshot {
                    group_id,
                    protocol,
                    name,
                    picture,
                    about,
                    created_by,
                    members,
                    admins,
                    revision: new_revision,
                    created_at,
                    updated_at,
                },
            })
        }
        GroupPairwisePayloadV1::SyncGroup {
            group_id,
            protocol,
            revision,
            name,
            picture,
            about,
            created_by,
            members,
            admins,
            created_at,
            updated_at,
        } => Some(GroupPairwiseCommand::MetadataSnapshot {
            snapshot: GroupSnapshot {
                group_id,
                protocol,
                name,
                picture,
                about,
                created_by,
                members,
                admins,
                revision,
                created_at,
                updated_at,
            },
        }),
        GroupPairwisePayloadV1::GroupMessage {
            group_id,
            revision,
            body,
        } => Some(GroupPairwiseCommand::GroupMessage {
            group_id,
            revision,
            body,
        }),
        GroupPairwisePayloadV1::SenderKeyDistribution { .. } => None,
    })
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
mod tests {
    use super::*;
    use crate::{DevicePubkey, GroupProtocol};
    use nostr::{EventId, Keys};
    use serde::{Deserialize, Serialize};
    use std::{env, fs, path::PathBuf};

    #[derive(Debug, Clone, Deserialize, Serialize)]
    struct GroupRosterFactVector {
        description: String,
        event: serde_json::Value,
        expected: GroupRosterFactExpected,
    }

    #[derive(Debug, Clone, Deserialize, Serialize)]
    struct GroupRosterFactExpected {
        group_id: String,
        name: String,
        created_by: String,
        members: Vec<String>,
        admins: Vec<String>,
        revision: u64,
        created_at: u64,
        updated_at: u64,
    }

    fn owner(byte: u8) -> OwnerPubkey {
        OwnerPubkey::from_bytes([byte; 32])
    }

    fn device(byte: u8) -> DevicePubkey {
        DevicePubkey::from_bytes([byte; 32])
    }

    fn encode_context() -> GroupPayloadEncodeContext {
        GroupPayloadEncodeContext {
            local_device_pubkey: device(9),
            created_at: UnixSeconds(12),
        }
    }

    fn snapshot() -> GroupSnapshot {
        GroupSnapshot {
            group_id: "group-1".to_string(),
            protocol: GroupProtocol::sender_key_v1(),
            name: "Team".to_string(),
            picture: None,
            about: None,
            created_by: owner(1),
            members: vec![owner(1), owner(2)],
            admins: vec![owner(1)],
            revision: 3,
            created_at: UnixSeconds(10),
            updated_at: UnixSeconds(11),
        }
    }

    fn owner_from_keys(keys: &Keys) -> OwnerPubkey {
        OwnerPubkey::from_bytes(keys.public_key().to_bytes())
    }

    fn test_vectors_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("test-vectors")
    }

    fn expected_from_snapshot(snapshot: &GroupSnapshot) -> GroupRosterFactExpected {
        let mut members: Vec<_> = snapshot
            .members
            .iter()
            .map(|owner| owner.to_hex())
            .collect();
        let mut admins: Vec<_> = snapshot.admins.iter().map(|owner| owner.to_hex()).collect();
        members.sort();
        admins.sort();
        GroupRosterFactExpected {
            group_id: snapshot.group_id.clone(),
            name: snapshot.name.clone(),
            created_by: snapshot.created_by.to_hex(),
            members,
            admins,
            revision: snapshot.revision,
            created_at: snapshot.created_at.get(),
            updated_at: snapshot.updated_at.get(),
        }
    }

    fn assert_vector_decodes(vector: &GroupRosterFactVector) {
        let codec = JsonGroupPayloadCodecV1;
        let payload = serde_json::to_vec(&vector.event).unwrap();
        let decoded = codec.decode_pairwise_command(&payload).unwrap();
        let Some(GroupPairwiseCommand::MetadataSnapshot { snapshot }) = decoded else {
            panic!("expected metadata snapshot");
        };
        assert_eq!(snapshot.group_id, vector.expected.group_id);
        assert_eq!(snapshot.name, vector.expected.name);
        assert_eq!(snapshot.created_by.to_hex(), vector.expected.created_by);
        assert_eq!(
            expected_from_snapshot(&snapshot).members,
            vector.expected.members
        );
        assert_eq!(
            expected_from_snapshot(&snapshot).admins,
            vector.expected.admins
        );
        assert_eq!(snapshot.revision, vector.expected.revision);
        assert_eq!(snapshot.created_at.get(), vector.expected.created_at);
        assert_eq!(snapshot.updated_at.get(), vector.expected.updated_at);
    }

    #[test]
    fn metadata_snapshot_command_encodes_group_roster_fact_rumor() {
        let codec = JsonGroupPayloadCodecV1;
        let command = GroupPairwiseCommand::MetadataSnapshot {
            snapshot: snapshot(),
        };

        let encoded = codec
            .encode_pairwise_command(encode_context(), &command)
            .unwrap();

        assert!(codec.is_pairwise_payload(&encoded));
        let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        assert_eq!(event.kind.as_u16() as u32, GROUP_ROSTER_FACT_KIND);
        assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
        assert_eq!(event.content, "");
        assert_eq!(
            first_tag_value(&event, "type").as_deref(),
            Some(GROUP_ROSTER_FACT_TYPE)
        );
        assert_eq!(first_tag_value(&event, "d").as_deref(), Some("group-1"));
        assert!(event.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.first().map(String::as_str) == Some("i")
                && values.get(1).map(String::as_str) == Some("group-1")
                && values.get(2).map(String::as_str) == Some("subject")
        }));
        assert_eq!(
            first_tag_value(&event, "group_id").as_deref(),
            Some("group-1")
        );
        assert_eq!(first_tag_value(&event, "revision").as_deref(), Some("3"));
        assert_eq!(
            first_tag_value(&event, "created_by"),
            Some(owner(1).to_hex())
        );

        assert_eq!(
            codec.decode_pairwise_command(&encoded).unwrap(),
            Some(command)
        );
    }

    #[test]
    fn metadata_snapshot_decodes_typescript_group_roster_fact_vector() {
        let vectors_path = test_vectors_path().join("ts-group-roster-fact-vectors.json");
        if !vectors_path.exists() {
            println!(
                "TypeScript group roster fact vectors not found at {:?}, skipping...",
                vectors_path
            );
            return;
        }

        let content = fs::read_to_string(&vectors_path).unwrap();
        let vector: GroupRosterFactVector = serde_json::from_str(&content).unwrap();
        assert_vector_decodes(&vector);
    }

    #[test]
    #[ignore = "writes an interop fixture; run the explicit vector-generation lane"]
    fn generate_rust_group_roster_fact_vector() {
        let codec = JsonGroupPayloadCodecV1;
        let snapshot = snapshot();
        let encoded = codec
            .encode_pairwise_command(
                encode_context(),
                &GroupPairwiseCommand::MetadataSnapshot {
                    snapshot: snapshot.clone(),
                },
            )
            .unwrap();
        let event: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        let vector = GroupRosterFactVector {
            description: "Group roster fact vector generated by Rust".to_string(),
            event,
            expected: expected_from_snapshot(&snapshot),
        };
        let vectors_path = test_vectors_path().join("rust-group-roster-fact-vectors.json");
        let should_regenerate = env::var("REGENERATE_VECTORS").ok().as_deref() == Some("true")
            || !vectors_path.exists();
        if should_regenerate {
            fs::create_dir_all(vectors_path.parent().unwrap()).unwrap();
            fs::write(
                &vectors_path,
                serde_json::to_string_pretty(&vector).unwrap(),
            )
            .unwrap();
        }

        let content = fs::read_to_string(&vectors_path).unwrap();
        let written: GroupRosterFactVector = serde_json::from_str(&content).unwrap();
        assert_vector_decodes(&written);
    }

    #[test]
    fn group_roster_fact_filter_builder_and_snapshot_roundtrip() {
        let admin = Keys::generate();
        let bob = Keys::generate();
        let carol = Keys::generate();
        let admin_owner = owner_from_keys(&admin);
        let bob_owner = owner_from_keys(&bob);
        let carol_owner = owner_from_keys(&carol);
        let snapshot = GroupSnapshot {
            group_id: "group-facts".to_string(),
            protocol: GroupProtocol::sender_key_v1(),
            name: "Fact Friends".to_string(),
            picture: Some("https://example.test/group.png".to_string()),
            about: Some("tag-native roster".to_string()),
            created_by: admin_owner,
            members: vec![carol_owner, admin_owner, bob_owner],
            admins: vec![bob_owner, admin_owner],
            revision: 4,
            created_at: UnixSeconds(1_700_000_000),
            updated_at: UnixSeconds(1_700_000_123),
        };

        let filter = build_group_roster_fact_filter(["group-facts"], [admin.public_key()]);
        let filter_json = serde_json::to_value(&filter).unwrap();
        assert_eq!(
            filter_json["kinds"],
            serde_json::json!([GROUP_ROSTER_FACT_KIND])
        );
        assert_eq!(
            filter_json["authors"],
            serde_json::json!([admin.public_key()])
        );
        assert_eq!(filter_json["#d"], serde_json::json!(["group-facts"]));

        let unsigned = group_roster_unsigned_event(admin.public_key(), &snapshot).unwrap();
        assert_eq!(unsigned.kind.as_u16() as u32, GROUP_ROSTER_FACT_KIND);
        assert_eq!(GROUP_ROSTER_FACT_KIND, 37368);
        assert_eq!(unsigned.content, "");
        assert_eq!(
            first_tag_value(&unsigned, "type").as_deref(),
            Some(GROUP_ROSTER_FACT_TYPE)
        );
        assert_eq!(
            first_tag_value(&unsigned, "d").as_deref(),
            Some("group-facts")
        );
        assert!(unsigned.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.first().map(String::as_str) == Some("i")
                && values.get(1).map(String::as_str) == Some("group-facts")
                && values.get(2).map(String::as_str) == Some("subject")
        }));
        assert_eq!(
            first_tag_value(&unsigned, "group_id").as_deref(),
            Some("group-facts")
        );
        assert_eq!(first_tag_value(&unsigned, "revision").as_deref(), Some("4"));
        assert_eq!(
            first_tag_value(&unsigned, "name").as_deref(),
            Some("Fact Friends")
        );
        let unsigned_json = serde_json::to_string(&unsigned).unwrap();
        assert!(!unsigned_json.contains("secret"));

        let signed = unsigned.sign_with_keys(&admin).unwrap();
        let parsed = parse_group_roster_fact_event(&signed).unwrap();
        assert_eq!(parsed.group_id, "group-facts");
        assert_eq!(parsed.revision, 4);
        assert_eq!(parsed.signer_pubkey, admin.public_key());
        assert_eq!(parsed.snapshot.name, "Fact Friends");
        assert_eq!(
            parsed.snapshot.picture.as_deref(),
            Some("https://example.test/group.png")
        );
        assert_eq!(parsed.snapshot.about.as_deref(), Some("tag-native roster"));
        let mut expected_members = vec![admin_owner, bob_owner, carol_owner];
        expected_members.sort();
        let mut expected_admins = vec![admin_owner, bob_owner];
        expected_admins.sort();
        assert_eq!(parsed.snapshot.members, expected_members);
        assert_eq!(parsed.snapshot.admins, expected_admins);
    }

    #[test]
    fn group_roster_fact_projection_keeps_latest_revision_per_group() {
        let admin = Keys::generate();
        let admin_owner = owner_from_keys(&admin);
        let old_snapshot = GroupSnapshot {
            group_id: "group-facts".to_string(),
            protocol: GroupProtocol::sender_key_v1(),
            name: "Old".to_string(),
            picture: None,
            about: None,
            created_by: admin_owner,
            members: vec![admin_owner],
            admins: vec![admin_owner],
            revision: 1,
            created_at: UnixSeconds(10),
            updated_at: UnixSeconds(11),
        };
        let new_snapshot = GroupSnapshot {
            name: "New".to_string(),
            revision: 2,
            updated_at: UnixSeconds(12),
            ..old_snapshot.clone()
        };
        let old_event = group_roster_unsigned_event(admin.public_key(), &old_snapshot)
            .unwrap()
            .sign_with_keys(&admin)
            .unwrap();
        let new_event = group_roster_unsigned_event(admin.public_key(), &new_snapshot)
            .unwrap()
            .sign_with_keys(&admin)
            .unwrap();

        let projected = project_group_roster_fact_events([&new_event, &old_event]);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].revision, 2);
        assert_eq!(projected[0].name, "New");
    }

    #[test]
    fn transitional_create_and_sync_envelopes_decode_as_metadata_snapshots() {
        let codec = JsonGroupPayloadCodecV1;
        let create = serde_json::to_vec(&serde_json::json!({
            "wire_format_version": 1,
            "payload": {
                "kind": "create_group",
                "group_id": "group-1",
                "protocol": "sender_key_v1",
                "base_revision": 0,
                "new_revision": 1,
                "name": "Team",
                "created_by": owner(1),
                "members": [owner(1), owner(2)],
                "admins": [owner(1)],
                "created_at": 10,
                "updated_at": 10
            }
        }))
        .unwrap();

        let decoded = codec.decode_pairwise_command(&create).unwrap();
        assert!(matches!(
            decoded,
            Some(GroupPairwiseCommand::MetadataSnapshot { snapshot })
                if snapshot.revision == 1 && snapshot.name == "Team"
        ));

        let sync = encode_envelope(GroupPairwisePayloadV1::SyncGroup {
            group_id: "group-1".to_string(),
            protocol: GroupProtocol::sender_key_v1(),
            revision: 2,
            name: "Renamed".to_string(),
            picture: None,
            about: None,
            created_by: owner(1),
            members: vec![owner(1), owner(2)],
            admins: vec![owner(1)],
            created_at: UnixSeconds(10),
            updated_at: UnixSeconds(11),
        })
        .unwrap();

        let decoded = codec.decode_pairwise_command(&sync).unwrap();
        assert!(matches!(
            decoded,
            Some(GroupPairwiseCommand::MetadataSnapshot { snapshot })
                if snapshot.revision == 2 && snapshot.name == "Renamed"
        ));
    }

    #[test]
    fn unsupported_pairwise_version_is_not_consumed_as_group_payload() {
        let codec = JsonGroupPayloadCodecV1;
        let encoded = serde_json::to_vec(&serde_json::json!({
            "wire_format_version": 255,
            "payload": {
                "kind": "group_message",
                "group_id": "group-1",
                "revision": 1,
                "body": []
            }
        }))
        .unwrap();

        assert!(!codec.is_pairwise_payload(&encoded));
        assert_eq!(codec.decode_pairwise_command(&encoded).unwrap(), None);
    }

    #[test]
    fn sender_key_plaintext_roundtrips_through_old_inner_rumor() {
        let codec = JsonGroupPayloadCodecV1;
        let plaintext = GroupSenderKeyPlaintext {
            group_id: "group-1".to_string(),
            revision: 3,
            body: b"hello group".to_vec(),
        };

        let encoded = codec
            .encode_sender_key_plaintext(encode_context(), &plaintext)
            .unwrap();
        let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        assert_eq!(event.kind.as_u16() as u32, CHAT_MESSAGE_KIND);
        assert_eq!(event.content, "hello group");
        assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
        assert_eq!(
            first_tag_value(&event, GROUP_LABEL_TAG).as_deref(),
            Some("group-1")
        );
        assert_eq!(first_tag_value(&event, REVISION_TAG).as_deref(), Some("3"));

        assert_eq!(
            codec
                .decode_sender_key_plaintext(
                    GroupSenderKeyPlaintextDecodeContext {
                        group_id: "group-1",
                        current_revision: 3,
                    },
                    &encoded,
                )
                .unwrap(),
            Some(plaintext)
        );
    }

    #[test]
    fn sender_key_plaintext_decodes_old_ts_rumor_without_revision() {
        let codec = JsonGroupPayloadCodecV1;
        let event = EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), "legacy")
            .tags(vec![
                tag([GROUP_LABEL_TAG, "group-1"]).unwrap(),
                tag([MS_TAG, "12000"]).unwrap(),
            ])
            .custom_created_at(Timestamp::from(12))
            .build(device(7).to_nostr().unwrap());
        let encoded = serde_json::to_vec(&event).unwrap();

        assert_eq!(
            codec
                .decode_sender_key_plaintext(
                    GroupSenderKeyPlaintextDecodeContext {
                        group_id: "group-1",
                        current_revision: 8,
                    },
                    &encoded,
                )
                .unwrap(),
            Some(GroupSenderKeyPlaintext {
                group_id: "group-1".to_string(),
                revision: 8,
                body: b"legacy".to_vec(),
            })
        );
    }

    #[test]
    fn sender_key_distribution_command_encodes_old_10446_rumor() {
        let codec = JsonGroupPayloadCodecV1;
        let distribution = SenderKeyDistribution {
            group_id: "group-1".to_string(),
            key_id: 7,
            sender_event_pubkey: device(3),
            chain_key: [4; 32],
            iteration: 9,
            created_at: UnixSeconds(11),
        };
        let command = GroupPairwiseCommand::SenderKeyDistribution {
            distribution: distribution.clone(),
        };

        let encoded = codec
            .encode_pairwise_command(encode_context(), &command)
            .unwrap();
        let mut event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        assert_eq!(
            event.kind.as_u16() as u32,
            GROUP_SENDER_KEY_DISTRIBUTION_KIND
        );
        assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
        assert_eq!(
            first_tag_value(&event, GROUP_LABEL_TAG).as_deref(),
            Some("group-1")
        );
        assert_eq!(first_tag_value(&event, KEY_TAG).as_deref(), Some("7"));
        assert_eq!(first_tag_value(&event, MS_TAG).as_deref(), Some("12000"));
        let content = serde_json::from_str::<serde_json::Value>(&event.content).unwrap();
        assert_eq!(content["groupId"], "group-1");
        assert_eq!(content["keyId"], 7);
        assert_eq!(content["chainKey"], hex::encode([4; 32]));
        assert_eq!(content["iteration"], 9);
        assert_eq!(content["createdAt"], 11);
        assert_eq!(content["senderEventPubkey"], device(3).to_string());

        // The old plaintext pubkey is compatibility-only. Core identity comes from authenticated
        // pairwise session context, so the codec must not depend on this field.
        event.pubkey = device(5).to_nostr().unwrap();
        event.id = None;
        event.ensure_id();
        let encoded = serde_json::to_vec(&event).unwrap();

        assert_eq!(
            codec.decode_pairwise_command(&encoded).unwrap(),
            Some(command)
        );
    }

    #[test]
    fn old_sender_key_distribution_rejects_mismatched_event_id() {
        let codec = JsonGroupPayloadCodecV1;
        let distribution = SenderKeyDistribution {
            group_id: "group-1".to_string(),
            key_id: 7,
            sender_event_pubkey: device(3),
            chain_key: [4; 32],
            iteration: 9,
            created_at: UnixSeconds(11),
        };
        let command = GroupPairwiseCommand::SenderKeyDistribution { distribution };
        let encoded = codec
            .encode_pairwise_command(encode_context(), &command)
            .unwrap();
        let mut event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        event.id = Some(EventId::all_zeros());
        let encoded = serde_json::to_vec(&event).unwrap();

        assert!(matches!(
            codec.decode_pairwise_command(&encoded),
            Err(Error::Parse(_))
        ));
    }

    #[test]
    fn current_sender_key_distribution_envelope_is_not_consumed() {
        let codec = JsonGroupPayloadCodecV1;
        let distribution = SenderKeyDistribution {
            group_id: "group-1".to_string(),
            key_id: 7,
            sender_event_pubkey: device(3),
            chain_key: [4; 32],
            iteration: 9,
            created_at: UnixSeconds(11),
        };
        let encoded =
            encode_envelope(GroupPairwisePayloadV1::SenderKeyDistribution { distribution })
                .unwrap();

        assert_eq!(codec.decode_pairwise_command(&encoded).unwrap(), None);
    }

    #[test]
    fn sender_key_repair_request_command_encodes_10447_rumor() {
        let codec = JsonGroupPayloadCodecV1;
        let request = crate::SenderKeyRepairRequest {
            group_id: "group-1".to_string(),
            sender_event_pubkey: device(3),
            key_id: Some(7),
            message_number: Some(42),
            required_revision: Some(9),
            created_at: UnixSeconds(13),
        };
        let command = GroupPairwiseCommand::SenderKeyRepairRequest {
            request: request.clone(),
        };

        let encoded = codec
            .encode_pairwise_command(encode_context(), &command)
            .unwrap();
        let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        assert_eq!(
            event.kind.as_u16() as u32,
            GROUP_SENDER_KEY_REPAIR_REQUEST_KIND
        );
        assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
        assert_eq!(
            first_tag_value(&event, GROUP_LABEL_TAG).as_deref(),
            Some("group-1")
        );
        assert_eq!(first_tag_value(&event, KEY_TAG).as_deref(), Some("7"));
        assert_eq!(
            first_tag_value(&event, SENDER_TAG).as_deref(),
            Some(device(3).to_string().as_str())
        );
        assert_eq!(first_tag_value(&event, MESSAGE_TAG).as_deref(), Some("42"));
        assert_eq!(first_tag_value(&event, REVISION_TAG).as_deref(), Some("9"));
        assert_eq!(first_tag_value(&event, MS_TAG).as_deref(), Some("12000"));
        let content = serde_json::from_str::<serde_json::Value>(&event.content).unwrap();
        assert_eq!(content["groupId"], "group-1");
        assert_eq!(content["senderEventPubkey"], device(3).to_string());
        assert_eq!(content["keyId"], 7);
        assert_eq!(content["messageNumber"], 42);
        assert_eq!(content["requiredRevision"], 9);
        assert_eq!(content["createdAt"], 13);

        assert_eq!(
            codec.decode_pairwise_command(&encoded).unwrap(),
            Some(command)
        );
    }

    #[derive(Debug, serde::Deserialize, serde::Serialize)]
    struct SenderKeyRepairVectors {
        description: String,
        requester_device_pubkey: String,
        encoded_at_ms: u64,
        request: SenderKeyRepairVectorRequest,
        repair_request_event: serde_json::Value,
    }

    #[derive(Debug, serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SenderKeyRepairVectorRequest {
        group_id: String,
        sender_event_pubkey: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_id: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_number: Option<u32>,
        #[serde(default)]
        required_revision: Option<u64>,
        created_at: u64,
    }

    #[test]
    fn typescript_sender_key_repair_vector_decodes() {
        let vectors_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("test-vectors")
            .join("ts-sender-key-repair-vectors.json");

        if !vectors_path.exists() {
            println!(
                "TypeScript sender-key repair vectors not found at {:?}, skipping...",
                vectors_path
            );
            println!(
                "Run `pnpm vitest run tests/SenderKeyRepair.interop.test.ts` in ts/ to generate them."
            );
            return;
        }

        let content = std::fs::read_to_string(&vectors_path).expect("failed to read vectors");
        let vectors: SenderKeyRepairVectors =
            serde_json::from_str(&content).expect("failed to parse vectors");
        let encoded =
            serde_json::to_vec(&vectors.repair_request_event).expect("failed to encode event");

        let decoded = JsonGroupPayloadCodecV1
            .decode_pairwise_command(&encoded)
            .expect("failed to decode TS repair vector");
        let Some(GroupPairwiseCommand::SenderKeyRepairRequest { request }) = decoded else {
            panic!("expected sender-key repair request");
        };

        assert_eq!(request.group_id, vectors.request.group_id);
        assert_eq!(
            request.sender_event_pubkey.to_string(),
            vectors.request.sender_event_pubkey
        );
        assert_eq!(request.key_id, vectors.request.key_id);
        assert_eq!(request.message_number, vectors.request.message_number);
        assert_eq!(request.required_revision, vectors.request.required_revision);
        assert_eq!(request.created_at.get(), vectors.request.created_at);
    }

    #[test]
    #[ignore = "writes an interop fixture; run the explicit vector-generation lane"]
    fn generate_rust_sender_key_repair_vector() {
        let vectors_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("test-vectors")
            .join("rust-sender-key-repair-vectors.json");
        let should_regenerate = std::env::var("REGENERATE_VECTORS").ok().as_deref() == Some("true")
            || !vectors_path.exists();

        if should_regenerate {
            let ctx = encode_context();
            let request = crate::SenderKeyRepairRequest {
                group_id: "group-1".to_string(),
                sender_event_pubkey: device(3),
                key_id: Some(7),
                message_number: Some(42),
                required_revision: Some(9),
                created_at: UnixSeconds(13),
            };
            let encoded = JsonGroupPayloadCodecV1
                .encode_pairwise_command(
                    ctx,
                    &GroupPairwiseCommand::SenderKeyRepairRequest {
                        request: request.clone(),
                    },
                )
                .unwrap();
            let repair_request_event =
                serde_json::from_slice::<serde_json::Value>(&encoded).unwrap();
            let vectors = SenderKeyRepairVectors {
                description: "SenderKeyRepair 10447 request vector generated by Rust".to_string(),
                requester_device_pubkey: ctx.local_device_pubkey.to_string(),
                encoded_at_ms: ctx.created_at.get() * 1000,
                request: SenderKeyRepairVectorRequest {
                    group_id: request.group_id,
                    sender_event_pubkey: request.sender_event_pubkey.to_string(),
                    key_id: request.key_id,
                    message_number: request.message_number,
                    required_revision: request.required_revision,
                    created_at: request.created_at.get(),
                },
                repair_request_event,
            };

            std::fs::create_dir_all(vectors_path.parent().unwrap()).ok();
            std::fs::write(
                &vectors_path,
                serde_json::to_string_pretty(&vectors).unwrap(),
            )
            .expect("failed to write Rust sender-key repair vectors");
        }

        let content = std::fs::read_to_string(&vectors_path).expect("failed to read vectors");
        let vectors: SenderKeyRepairVectors =
            serde_json::from_str(&content).expect("failed to parse vectors");
        let encoded =
            serde_json::to_vec(&vectors.repair_request_event).expect("failed to encode event");
        let decoded = JsonGroupPayloadCodecV1
            .decode_pairwise_command(&encoded)
            .expect("failed to decode Rust repair vector");
        let Some(GroupPairwiseCommand::SenderKeyRepairRequest { request }) = decoded else {
            panic!("expected sender-key repair request");
        };
        assert_eq!(request.group_id, vectors.request.group_id);
        assert_eq!(
            request.sender_event_pubkey.to_string(),
            vectors.request.sender_event_pubkey
        );
        assert_eq!(request.key_id, vectors.request.key_id);
        assert_eq!(request.message_number, vectors.request.message_number);
        assert_eq!(request.required_revision, vectors.request.required_revision);
        assert_eq!(request.created_at.get(), vectors.request.created_at);
    }

    #[test]
    fn old_sender_key_repair_request_envelope_is_not_consumed() {
        let codec = JsonGroupPayloadCodecV1;
        let encoded = serde_json::to_vec(&serde_json::json!({
            "wire_format_version": 1,
            "payload": {
                "kind": "sender_key_repair_request",
                "request": {
                    "group_id": "group-1",
                    "sender_event_pubkey": device(3),
                    "key_id": 7,
                    "message_number": 42,
                    "required_revision": 9,
                    "created_at": 13
                }
            }
        }))
        .unwrap();

        assert_eq!(codec.decode_pairwise_command(&encoded).unwrap(), None);
    }

    #[test]
    fn sender_key_repair_request_rejects_mismatched_tags() {
        let codec = JsonGroupPayloadCodecV1;
        let request = crate::SenderKeyRepairRequest {
            group_id: "group-1".to_string(),
            sender_event_pubkey: device(3),
            key_id: Some(7),
            message_number: Some(42),
            required_revision: Some(9),
            created_at: UnixSeconds(13),
        };
        let command = GroupPairwiseCommand::SenderKeyRepairRequest { request };
        let encoded = codec
            .encode_pairwise_command(encode_context(), &command)
            .unwrap();
        let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        let sender_hex = device(3).to_string();
        let event = EventBuilder::new(
            Kind::from(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND as u16),
            event.content,
        )
        .tags(vec![
            tag([GROUP_LABEL_TAG, "group-2"]).unwrap(),
            tag([KEY_TAG, "7"]).unwrap(),
            tag([SENDER_TAG, sender_hex.as_str()]).unwrap(),
            tag([MESSAGE_TAG, "42"]).unwrap(),
            tag([REVISION_TAG, "9"]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(12))
        .build(device(9).to_nostr().unwrap());
        let encoded = serde_json::to_vec(&event).unwrap();

        assert!(matches!(
            codec.decode_pairwise_command(&encoded),
            Err(Error::Parse(_))
        ));
    }

    #[test]
    fn sender_key_repair_request_without_revision_omits_revision_tag() {
        let codec = JsonGroupPayloadCodecV1;
        let request = crate::SenderKeyRepairRequest {
            group_id: "group-1".to_string(),
            sender_event_pubkey: device(3),
            key_id: Some(7),
            message_number: Some(42),
            required_revision: None,
            created_at: UnixSeconds(13),
        };
        let command = GroupPairwiseCommand::SenderKeyRepairRequest {
            request: request.clone(),
        };
        let encoded = codec
            .encode_pairwise_command(encode_context(), &command)
            .unwrap();
        let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
        assert_eq!(first_tag_value(&event, REVISION_TAG), None);

        assert_eq!(
            codec.decode_pairwise_command(&encoded).unwrap(),
            Some(GroupPairwiseCommand::SenderKeyRepairRequest { request })
        );
    }

    #[test]
    fn sender_key_repair_request_rejects_missing_required_tags() {
        let codec = JsonGroupPayloadCodecV1;
        let content = serde_json::to_string(&SenderKeyRepairRequestContent {
            group_id: "group-1".to_string(),
            sender_event_pubkey: device(3).to_string(),
            key_id: Some(7),
            message_number: Some(42),
            required_revision: Some(9),
            created_at: UnixSeconds(13),
        })
        .unwrap();
        let event = EventBuilder::new(
            Kind::from(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND as u16),
            content,
        )
        .custom_created_at(Timestamp::from(12))
        .build(device(9).to_nostr().unwrap());
        let encoded = serde_json::to_vec(&event).unwrap();

        assert!(matches!(
            codec.decode_pairwise_command(&encoded),
            Err(Error::Parse(_))
        ));
    }
}
