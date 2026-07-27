use nostr::{EventBuilder, Kind, PublicKey, Tag, Timestamp, UnsignedEvent};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL_TAG: &str = "ndr-protocol";
pub const PROTOCOL_VALUE: &str = "pairwise-rumor";
pub const VERSION_TAG: &str = "ndr-version";
pub const VERSION_VALUE: &str = "1";
pub const MS_TAG: &str = "ms";
pub const EXPIRATION_TAG: &str = "expiration";

pub const CHAT_MESSAGE_KIND: u32 = 14;
pub const REACTION_KIND: u32 = 7;
pub const RECEIPT_KIND: u32 = 15;
pub const TYPING_KIND: u32 = 25;
pub const CHAT_SETTINGS_KIND: u32 = 10448;

#[derive(Debug, Error)]
pub enum Error {
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    NostrEvent(#[from] nostr::event::Error),
    #[error(transparent)]
    NostrTag(#[from] nostr::event::tag::Error),
    #[error("unknown protocol `{0}`")]
    UnknownProtocol(String),
    #[error("missing `{PROTOCOL_TAG}` tag")]
    MissingProtocol,
    #[error("missing `{VERSION_TAG}` tag")]
    MissingVersion,
    #[error("unsupported `{VERSION_TAG}` `{0}`")]
    UnsupportedVersion(String),
    #[error("invalid receipt type `{0}`")]
    InvalidReceiptType(String),
    #[error("invalid chat settings payload")]
    InvalidChatSettings,
    #[error("duplicate `{0}` tag")]
    DuplicateControlTag(String),
    #[error("missing `{0}` tag")]
    MissingControlTag(String),
    #[error("invalid `{0}` tag value")]
    InvalidControlTag(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeMode {
    Strict,
    AllowLegacyUnmarked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolMarker {
    CurrentV1,
    LegacyUnmarked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncodeOptions {
    pub created_at_secs: u64,
    pub millis: u64,
    pub expiration: Option<u64>,
}

impl EncodeOptions {
    pub fn new(created_at_secs: u64, millis: u64) -> Self {
        Self {
            created_at_secs,
            millis,
            expiration: None,
        }
    }

    pub fn with_expiration(mut self, expiration: u64) -> Self {
        self.expiration = Some(expiration);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptType {
    Delivered,
    Seen,
}

impl ReceiptType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Seen => "seen",
        }
    }
}

impl TryFrom<&str> for ReceiptType {
    type Error = Error;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "delivered" => Ok(Self::Delivered),
            "seen" => Ok(Self::Seen),
            other => Err(Error::InvalidReceiptType(other.to_string())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatSettingsTtl {
    ClearPeerOverride,
    DisablePeerExpiration,
    Seconds(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairwiseRumorKind {
    Message {
        body: String,
        event_ids: Vec<String>,
        expiration: Option<u64>,
    },
    Typing {
        expiration: Option<u64>,
    },
    Receipt {
        receipt_type: ReceiptType,
        event_ids: Vec<String>,
        expiration: Option<u64>,
    },
    Reaction {
        emoji: String,
        event_id: Option<String>,
        expiration: Option<u64>,
    },
    ChatSettings {
        message_ttl: ChatSettingsTtl,
    },
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedPairwiseRumor {
    pub marker: ProtocolMarker,
    pub event: UnsignedEvent,
    pub kind: PairwiseRumorKind,
    pub millis: Option<u64>,
    pub expiration: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSettingsPayloadV1 {
    #[serde(rename = "type")]
    typ: String,
    v: u32,
    #[serde(default)]
    message_ttl_seconds: Option<serde_json::Value>,
}

pub fn message_event(
    author: PublicKey,
    body: impl Into<String>,
    options: EncodeOptions,
) -> Result<UnsignedEvent> {
    build_event(author, CHAT_MESSAGE_KIND, body.into(), options, Vec::new())
}

pub fn encode_message(
    author: PublicKey,
    body: impl Into<String>,
    options: EncodeOptions,
) -> Result<Vec<u8>> {
    encode_event(&message_event(author, body, options)?)
}

pub fn typing_event(author: PublicKey, options: EncodeOptions) -> Result<UnsignedEvent> {
    build_event(
        author,
        TYPING_KIND,
        "typing".to_string(),
        options,
        Vec::new(),
    )
}

pub fn encode_typing(author: PublicKey, options: EncodeOptions) -> Result<Vec<u8>> {
    encode_event(&typing_event(author, options)?)
}

pub fn receipt_event<I, S>(
    author: PublicKey,
    receipt_type: ReceiptType,
    event_ids: I,
    options: EncodeOptions,
) -> Result<UnsignedEvent>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let tags = event_ids
        .into_iter()
        .map(|event_id| tag(["e", event_id.into().as_str()]))
        .collect::<Result<Vec<_>>>()?;
    build_event(
        author,
        RECEIPT_KIND,
        receipt_type.as_str().to_string(),
        options,
        tags,
    )
}

pub fn encode_receipt<I, S>(
    author: PublicKey,
    receipt_type: ReceiptType,
    event_ids: I,
    options: EncodeOptions,
) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    encode_event(&receipt_event(author, receipt_type, event_ids, options)?)
}

pub fn reaction_event(
    author: PublicKey,
    target_event_id: impl Into<String>,
    emoji: impl Into<String>,
    options: EncodeOptions,
) -> Result<UnsignedEvent> {
    let target_event_id = target_event_id.into();
    build_event(
        author,
        REACTION_KIND,
        emoji.into(),
        options,
        vec![tag(["e", target_event_id.as_str()])?],
    )
}

pub fn encode_reaction(
    author: PublicKey,
    target_event_id: impl Into<String>,
    emoji: impl Into<String>,
    options: EncodeOptions,
) -> Result<Vec<u8>> {
    encode_event(&reaction_event(author, target_event_id, emoji, options)?)
}

pub fn chat_settings_event(
    author: PublicKey,
    message_ttl: ChatSettingsTtl,
    created_at_secs: u64,
    millis: u64,
) -> Result<UnsignedEvent> {
    let message_ttl_seconds = match message_ttl {
        ChatSettingsTtl::ClearPeerOverride => None,
        ChatSettingsTtl::DisablePeerExpiration => Some(serde_json::Value::Null),
        ChatSettingsTtl::Seconds(seconds) => Some(serde_json::Value::Number(seconds.into())),
    };
    let payload = ChatSettingsPayloadV1 {
        typ: "chat-settings".to_string(),
        v: 1,
        message_ttl_seconds,
    };
    build_event(
        author,
        CHAT_SETTINGS_KIND,
        serde_json::to_string(&payload)?,
        EncodeOptions::new(created_at_secs, millis),
        Vec::new(),
    )
}

pub fn encode_chat_settings(
    author: PublicKey,
    message_ttl: ChatSettingsTtl,
    created_at_secs: u64,
    millis: u64,
) -> Result<Vec<u8>> {
    encode_event(&chat_settings_event(
        author,
        message_ttl,
        created_at_secs,
        millis,
    )?)
}

pub fn encode_event(event: &UnsignedEvent) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(event)?)
}

pub fn decode(payload: &[u8]) -> Result<DecodedPairwiseRumor> {
    decode_with_mode(payload, DecodeMode::AllowLegacyUnmarked)
}

pub fn decode_strict(payload: &[u8]) -> Result<DecodedPairwiseRumor> {
    decode_with_mode(payload, DecodeMode::Strict)
}

pub fn decode_with_mode(payload: &[u8], mode: DecodeMode) -> Result<DecodedPairwiseRumor> {
    let mut event = serde_json::from_slice::<UnsignedEvent>(payload)?;
    event.ensure_id();
    event.verify_id()?;
    let marker = protocol_marker(&event, mode)?;
    let (millis, expiration) = control_tags(&event, marker)?;
    let kind = match event.kind.as_u16() as u32 {
        CHAT_MESSAGE_KIND => PairwiseRumorKind::Message {
            body: event.content.clone(),
            event_ids: tag_values(&event, "e"),
            expiration,
        },
        TYPING_KIND => PairwiseRumorKind::Typing { expiration },
        RECEIPT_KIND => PairwiseRumorKind::Receipt {
            receipt_type: ReceiptType::try_from(event.content.as_str())?,
            event_ids: tag_values(&event, "e"),
            expiration,
        },
        REACTION_KIND => PairwiseRumorKind::Reaction {
            emoji: event.content.clone(),
            event_id: tag_values(&event, "e").into_iter().next(),
            expiration,
        },
        CHAT_SETTINGS_KIND => PairwiseRumorKind::ChatSettings {
            message_ttl: parse_chat_settings(&event.content)?,
        },
        _ => PairwiseRumorKind::Custom,
    };

    Ok(DecodedPairwiseRumor {
        marker,
        event,
        kind,
        millis,
        expiration,
    })
}

fn control_tags(
    event: &UnsignedEvent,
    marker: ProtocolMarker,
) -> Result<(Option<u64>, Option<u64>)> {
    let millis = if marker == ProtocolMarker::CurrentV1 {
        let millis = single_tag_value(event, MS_TAG)?
            .ok_or_else(|| Error::MissingControlTag(MS_TAG.to_string()))?;
        Some(
            millis
                .parse::<u64>()
                .map_err(|_| Error::InvalidControlTag(MS_TAG.to_string()))?,
        )
    } else {
        None
    };
    Ok((millis, expiration(event)?))
}

fn build_event(
    author: PublicKey,
    kind: u32,
    content: String,
    options: EncodeOptions,
    mut extra_tags: Vec<Tag>,
) -> Result<UnsignedEvent> {
    let mut tags = vec![
        tag([PROTOCOL_TAG, PROTOCOL_VALUE])?,
        tag([VERSION_TAG, VERSION_VALUE])?,
    ];
    tags.append(&mut extra_tags);
    tags.push(tag([MS_TAG, options.millis.to_string().as_str()])?);
    if let Some(expiration) = options.expiration {
        tags.push(tag([EXPIRATION_TAG, expiration.to_string().as_str()])?);
    }

    let event = EventBuilder::new(Kind::from(kind as u16), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(options.created_at_secs))
        .build(author);
    Ok(event)
}

fn protocol_marker(event: &UnsignedEvent, mode: DecodeMode) -> Result<ProtocolMarker> {
    let protocol = single_tag_value(event, PROTOCOL_TAG)?;
    match protocol.as_deref() {
        Some(PROTOCOL_VALUE) => {}
        Some(other) => return Err(Error::UnknownProtocol(other.to_string())),
        None if mode == DecodeMode::AllowLegacyUnmarked => {
            return Ok(ProtocolMarker::LegacyUnmarked)
        }
        None => return Err(Error::MissingProtocol),
    }

    match single_tag_value(event, VERSION_TAG)?.as_deref() {
        Some(VERSION_VALUE) => Ok(ProtocolMarker::CurrentV1),
        Some(other) => Err(Error::UnsupportedVersion(other.to_string())),
        None => Err(Error::MissingVersion),
    }
}

fn parse_chat_settings(content: &str) -> Result<ChatSettingsTtl> {
    let value = serde_json::from_str::<serde_json::Value>(content)?;
    if value.get("type").and_then(|value| value.as_str()) != Some("chat-settings")
        || value.get("v").and_then(|value| value.as_u64()) != Some(1)
    {
        return Err(Error::InvalidChatSettings);
    }

    match value.get("messageTtlSeconds") {
        None => Ok(ChatSettingsTtl::ClearPeerOverride),
        Some(serde_json::Value::Null) => Ok(ChatSettingsTtl::DisablePeerExpiration),
        Some(serde_json::Value::Number(number)) => match number.as_u64() {
            Some(0) => Ok(ChatSettingsTtl::DisablePeerExpiration),
            Some(seconds) => Ok(ChatSettingsTtl::Seconds(seconds)),
            None => Err(Error::InvalidChatSettings),
        },
        _ => Err(Error::InvalidChatSettings),
    }
}

fn expiration(event: &UnsignedEvent) -> Result<Option<u64>> {
    single_tag_value(event, EXPIRATION_TAG)?
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| Error::InvalidControlTag(EXPIRATION_TAG.to_string()))
        })
        .transpose()
}

fn single_tag_value(event: &UnsignedEvent, key: &str) -> Result<Option<String>> {
    let mut matching = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(key));
    let Some(first) = matching.next() else {
        return Ok(None);
    };
    let value = first
        .as_slice()
        .get(1)
        .cloned()
        .ok_or_else(|| Error::InvalidControlTag(key.to_string()))?;
    if matching.next().is_some() {
        return Err(Error::DuplicateControlTag(key.to_string()));
    }
    Ok(Some(value))
}

fn tag_values(event: &UnsignedEvent, key: &str) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let values = tag.as_slice();
            if values.first().map(|value| value.as_str()) != Some(key) {
                return None;
            }
            values.get(1).cloned()
        })
        .collect()
}

fn tag<const N: usize>(parts: [&str; N]) -> Result<Tag> {
    Ok(Tag::parse(parts.map(str::to_owned))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public_key() -> PublicKey {
        nostr::Keys::generate().public_key()
    }

    #[test]
    fn message_roundtrips_as_unsigned_event_bytes() {
        let payload = encode_message(
            public_key(),
            "hello",
            EncodeOptions::new(1_710_000_000, 1_710_000_000_123),
        )
        .expect("encode");

        let decoded = decode_strict(&payload).expect("decode");
        assert_eq!(decoded.marker, ProtocolMarker::CurrentV1);
        assert!(matches!(
            decoded.kind,
            PairwiseRumorKind::Message { ref body, .. } if body == "hello"
        ));
        assert!(!decoded
            .event
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("p")));
    }

    #[test]
    fn legacy_unmarked_master_message_decodes_leniently() {
        let peer = public_key().to_string();
        let legacy = EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), "legacy hello")
            .tags(vec![
                tag(["p", peer.as_str()]).unwrap(),
                tag([MS_TAG, "1710000000123"]).unwrap(),
            ])
            .custom_created_at(Timestamp::from(1710000000))
            .build(public_key());
        let payload = serde_json::to_vec(&legacy).expect("json");

        let decoded = decode(&payload).expect("decode");
        assert_eq!(decoded.marker, ProtocolMarker::LegacyUnmarked);
        assert!(matches!(
            decoded.kind,
            PairwiseRumorKind::Message { ref body, .. } if body == "legacy hello"
        ));
        assert!(matches!(
            decode_strict(&payload),
            Err(Error::MissingProtocol)
        ));
    }

    #[test]
    fn decode_rejects_mismatched_event_id() {
        let mut event = message_event(
            public_key(),
            "forged id",
            EncodeOptions::new(1_710_000_000, 1_710_000_000_123),
        )
        .expect("event");
        event.id = Some(nostr::EventId::all_zeros());
        let payload = serde_json::to_vec(&event).expect("json");

        assert!(matches!(
            decode_strict(&payload),
            Err(Error::NostrEvent(nostr::event::Error::InvalidId))
        ));
    }

    #[test]
    fn receipt_rejects_unknown_status() {
        let payload = serde_json::json!({
            "pubkey": public_key().to_string(),
            "created_at": 1710000000,
            "kind": 15,
            "tags": [
                [PROTOCOL_TAG, PROTOCOL_VALUE],
                [VERSION_TAG, VERSION_VALUE],
                [MS_TAG, "1710000000000"],
                ["e", "abc"]
            ],
            "content": "read"
        });
        let bytes = serde_json::to_vec(&payload).expect("json");

        assert!(matches!(
            decode_strict(&bytes),
            Err(Error::InvalidReceiptType(status)) if status == "read"
        ));
    }

    #[test]
    fn chat_settings_preserve_master_ttl_meanings() {
        let encoded = encode_chat_settings(
            public_key(),
            ChatSettingsTtl::Seconds(86_400),
            1_710_000_000,
            1_710_000_000_123,
        )
        .expect("encode");

        let decoded = decode_strict(&encoded).expect("decode");
        assert!(matches!(
            decoded.kind,
            PairwiseRumorKind::ChatSettings {
                message_ttl: ChatSettingsTtl::Seconds(86_400)
            }
        ));
    }

    #[test]
    fn strict_decode_rejects_duplicate_control_tags() {
        for duplicate in [PROTOCOL_TAG, VERSION_TAG, MS_TAG, EXPIRATION_TAG] {
            let mut event = message_event(
                public_key(),
                "duplicate",
                EncodeOptions::new(1_710_000_000, 1_710_000_000_123).with_expiration(99),
            )
            .expect("event");
            let value = match duplicate {
                PROTOCOL_TAG => PROTOCOL_VALUE,
                VERSION_TAG => VERSION_VALUE,
                MS_TAG => "1710000000123",
                EXPIRATION_TAG => "99",
                _ => unreachable!(),
            };
            event
                .tags
                .push(tag([duplicate, value]).expect("duplicate tag"));
            event.id = None;
            event.ensure_id();
            let payload = serde_json::to_vec(&event).expect("json");
            assert!(matches!(
                decode_strict(&payload),
                Err(Error::DuplicateControlTag(ref key)) if key == duplicate
            ));
        }
    }

    #[test]
    fn strict_decode_rejects_missing_or_malformed_control_values() {
        let author = public_key();
        let missing_millis = EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), "missing")
            .tags(vec![
                tag([PROTOCOL_TAG, PROTOCOL_VALUE]).unwrap(),
                tag([VERSION_TAG, VERSION_VALUE]).unwrap(),
            ])
            .custom_created_at(Timestamp::from(1_710_000_000))
            .build(author);
        assert!(matches!(
            decode_strict(&serde_json::to_vec(&missing_millis).unwrap()),
            Err(Error::MissingControlTag(ref key)) if key == MS_TAG
        ));

        let malformed_expiration =
            EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), "malformed")
                .tags(vec![
                    tag([PROTOCOL_TAG, PROTOCOL_VALUE]).unwrap(),
                    tag([VERSION_TAG, VERSION_VALUE]).unwrap(),
                    tag([MS_TAG, "1710000000123"]).unwrap(),
                    tag([EXPIRATION_TAG, "not-a-timestamp"]).unwrap(),
                ])
                .custom_created_at(Timestamp::from(1_710_000_000))
                .build(author);
        assert!(matches!(
            decode_strict(&serde_json::to_vec(&malformed_expiration).unwrap()),
            Err(Error::InvalidControlTag(ref key)) if key == EXPIRATION_TAG
        ));

        let missing_expiration_value =
            EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), "missing expiration")
                .tags(vec![
                    tag([PROTOCOL_TAG, PROTOCOL_VALUE]).unwrap(),
                    tag([VERSION_TAG, VERSION_VALUE]).unwrap(),
                    tag([MS_TAG, "1710000000123"]).unwrap(),
                    tag([EXPIRATION_TAG]).unwrap(),
                ])
                .custom_created_at(Timestamp::from(1_710_000_000))
                .build(author);
        assert!(matches!(
            decode_strict(&serde_json::to_vec(&missing_expiration_value).unwrap()),
            Err(Error::InvalidControlTag(ref key)) if key == EXPIRATION_TAG
        ));
    }
}
