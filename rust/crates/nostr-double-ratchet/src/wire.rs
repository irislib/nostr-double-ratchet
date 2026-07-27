#[cfg(feature = "full")]
use crate::{AuthorizedDevice, DeviceRoster, GroupSenderKeyMessageEnvelope};
use crate::{
    DevicePubkey, Error as CoreError, Invite, InviteResponseEnvelope, MessageEnvelope, OwnerPubkey,
    UnixSeconds,
};
#[cfg(feature = "full")]
use base64::Engine;
#[cfg(feature = "full")]
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp, UnsignedEvent};
use thiserror::Error;

pub const MESSAGE_EVENT_KIND: u32 = 1060;
#[cfg(feature = "full")]
pub const GROUP_SENDER_KEY_MESSAGE_KIND: u32 = MESSAGE_EVENT_KIND;
pub const INVITE_EVENT_KIND: u32 = 30078;
pub const INVITE_RESPONSE_KIND: u32 = 1059;
#[cfg(feature = "full")]
pub const ROSTER_EVENT_KIND: u32 = 30078;

#[cfg(feature = "full")]
const ROSTER_D_TAG: &str = "double-ratchet/app-keys";
#[cfg(feature = "full")]
const ROSTER_VERSION: &str = "1";
pub const INVITE_LIST_LABEL: &str = "double-ratchet/invites";
#[cfg(feature = "full")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedRosterEvent {
    pub owner_pubkey: OwnerPubkey,
    pub roster: DeviceRoster,
}

#[cfg(feature = "full")]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ParsedGroupSenderKeyMessageEvent {
    pub sender_event_pubkey: DevicePubkey,
    pub key_id: u32,
    pub message_number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_header: Option<String>,
    pub created_at: UnixSeconds,
    pub ciphertext: Vec<u8>,
}

#[derive(Error, Debug)]
pub enum Error {
    #[error(transparent)]
    Core(#[from] CoreError),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error("invalid event: {0}")]
    InvalidEvent(String),

    #[error(transparent)]
    NostrEvent(#[from] nostr::event::Error),

    #[error(transparent)]
    NostrKey(#[from] nostr::key::Error),

    #[error(transparent)]
    Nip44(#[from] nostr::nips::nip44::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<Error> for CoreError {
    fn from(error: Error) -> Self {
        CoreError::Parse(error.to_string())
    }
}

pub fn message_event(envelope: &MessageEnvelope) -> Result<Event> {
    let author_secret_key = secret_key_from_bytes(&envelope.signer_secret_key)?;
    let author_keys = Keys::new(author_secret_key);
    let derived_sender = DevicePubkey::from_bytes(author_keys.public_key().to_bytes());
    if derived_sender != envelope.sender {
        return Err(Error::InvalidEvent(
            "sender does not match signer secret".to_string(),
        ));
    }

    let mut builder = EventBuilder::new(
        Kind::from(MESSAGE_EVENT_KIND as u16),
        envelope.ciphertext.clone(),
    )
    .tag(tag(["header", envelope.encrypted_header.as_str()])?)
    .custom_created_at(Timestamp::from(envelope.created_at.get()));
    if let Some(recipient) = envelope.recipient {
        builder = builder.tag(tag(["p", &recipient.to_string()])?);
    }
    let unsigned = builder.build(public_key(envelope.sender)?);

    Ok(unsigned.sign_with_keys(&author_keys)?)
}

pub fn parse_message_event(event: &Event) -> Result<MessageEnvelope> {
    verify_event_kind(event, MESSAGE_EVENT_KIND)?;
    event.verify()?;
    let encrypted_header = required_tag_value(event, "header")?;
    if encrypted_header.is_empty() {
        return Err(Error::InvalidEvent("empty `header` tag".to_string()));
    }

    Ok(MessageEnvelope {
        sender: DevicePubkey::from_bytes(event.pubkey.to_bytes()),
        recipient: optional_tag_value(event, "p")
            .as_deref()
            .map(parse_device_pubkey)
            .transpose()?,
        signer_secret_key: [0u8; 32],
        created_at: UnixSeconds(event.created_at.as_secs()),
        encrypted_header,
        ciphertext: event.content.clone(),
    })
}

#[cfg(feature = "full")]
pub fn group_sender_key_message_event(envelope: &GroupSenderKeyMessageEnvelope) -> Result<Event> {
    let author_secret_key = secret_key_from_bytes(&envelope.signer_secret_key)?;
    let author_keys = Keys::new(author_secret_key);
    let derived_sender = DevicePubkey::from_bytes(author_keys.public_key().to_bytes());
    if derived_sender != envelope.sender_event_pubkey {
        return Err(Error::InvalidEvent(
            "sender-event pubkey does not match signer secret".to_string(),
        ));
    }

    let content = build_group_sender_key_hidden_content(&envelope.ciphertext);
    let encrypted_header = match envelope.encrypted_header.clone() {
        Some(encrypted_header) => encrypted_header,
        None => encrypted_cover_header(&author_keys)?,
    };
    let unsigned = EventBuilder::new(Kind::from(GROUP_SENDER_KEY_MESSAGE_KIND as u16), content)
        .tag(tag(["header", encrypted_header.as_str()])?)
        .custom_created_at(Timestamp::from(envelope.created_at.get()))
        .build(public_key(envelope.sender_event_pubkey)?);

    Ok(unsigned.sign_with_keys(&author_keys)?)
}

#[cfg(feature = "full")]
pub fn parse_group_sender_key_message_event(
    event: &Event,
) -> Result<ParsedGroupSenderKeyMessageEvent> {
    verify_event_kind(event, GROUP_SENDER_KEY_MESSAGE_KIND)?;
    event.verify()?;
    if optional_tag_value(event, "header").is_some() {
        return Err(Error::InvalidEvent(
            "camouflaged group sender-key event requires caller-side sender match".to_string(),
        ));
    }

    parsed_group_sender_key_message_event_from_content(event)
}

#[cfg(feature = "full")]
pub fn parse_group_sender_key_message_event_unchecked(
    event: &Event,
) -> Result<ParsedGroupSenderKeyMessageEvent> {
    verify_event_kind(event, GROUP_SENDER_KEY_MESSAGE_KIND)?;
    event.verify()?;
    parsed_group_sender_key_message_event_from_content(event)
}

#[cfg(feature = "full")]
fn parsed_group_sender_key_message_event_from_content(
    event: &Event,
) -> Result<ParsedGroupSenderKeyMessageEvent> {
    let encrypted_header = optional_tag_value(event, "header");
    let parsed = if encrypted_header.is_some() {
        (0, 0, parse_group_sender_key_hidden_content(&event.content)?)
    } else {
        parse_group_sender_key_legacy_content(&event.content)?
    };

    Ok(ParsedGroupSenderKeyMessageEvent {
        sender_event_pubkey: DevicePubkey::from_bytes(event.pubkey.to_bytes()),
        key_id: parsed.0,
        message_number: parsed.1,
        encrypted_header,
        created_at: UnixSeconds(event.created_at.as_secs()),
        ciphertext: parsed.2,
    })
}

#[cfg(feature = "full")]
pub(crate) fn encrypted_cover_header_tag(keys: &Keys) -> Result<Tag> {
    let encrypted = encrypted_cover_header(keys)?;
    tag(["header", encrypted.as_str()])
}

#[cfg(feature = "full")]
fn encrypted_cover_header(keys: &Keys) -> Result<String> {
    let cover = serde_json::json!({
        "v": 1,
        "type": "sender-key-cover",
    });
    Ok(nip44::encrypt(
        keys.secret_key(),
        &keys.public_key(),
        serde_json::to_string(&cover)?,
        nip44::Version::V2,
    )?)
}

#[cfg(feature = "full")]
fn build_group_sender_key_hidden_content(ciphertext: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(ciphertext)
}

#[cfg(feature = "full")]
fn parse_group_sender_key_hidden_content(content: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|e| Error::InvalidEvent(e.to_string()))
}

#[cfg(all(test, feature = "full"))]
fn build_group_sender_key_legacy_content(
    key_id: u32,
    message_number: u32,
    ciphertext: &[u8],
) -> String {
    let mut payload = Vec::with_capacity(8 + ciphertext.len());
    payload.extend_from_slice(&key_id.to_be_bytes());
    payload.extend_from_slice(&message_number.to_be_bytes());
    payload.extend_from_slice(ciphertext);
    base64::engine::general_purpose::STANDARD.encode(payload)
}

#[cfg(feature = "full")]
fn parse_group_sender_key_legacy_content(content: &str) -> Result<(u32, u32, Vec<u8>)> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|e| Error::InvalidEvent(e.to_string()))?;
    if bytes.len() < 8 {
        return Err(Error::InvalidEvent(
            "group sender-key payload too short".to_string(),
        ));
    }
    let key_id = u32::from_be_bytes(
        bytes[0..4]
            .try_into()
            .map_err(|_| Error::InvalidEvent("invalid key_id bytes".to_string()))?,
    );
    let message_number = u32::from_be_bytes(
        bytes[4..8]
            .try_into()
            .map_err(|_| Error::InvalidEvent("invalid message number bytes".to_string()))?,
    );
    Ok((key_id, message_number, bytes[8..].to_vec()))
}

pub fn invite_url(invite: &Invite, root: &str) -> Result<String> {
    let mut data = serde_json::Map::new();
    data.insert(
        "inviter".to_string(),
        serde_json::Value::String(invite.inviter_device_pubkey.to_string()),
    );
    data.insert(
        "ephemeralKey".to_string(),
        serde_json::Value::String(invite.inviter_ephemeral_public_key.to_string()),
    );
    data.insert(
        "sharedSecret".to_string(),
        serde_json::Value::String(hex::encode(invite.shared_secret)),
    );
    data.insert(
        "createdAt".to_string(),
        serde_json::Value::Number(serde_json::Number::from(invite.created_at.get())),
    );
    if let Some(device_id) = invite.device_id.as_ref() {
        data.insert(
            "deviceId".to_string(),
            serde_json::Value::String(device_id.clone()),
        );
    }
    let owner = invite
        .owner_public_key
        .map(|pk| OwnerPubkey::from_bytes(pk.to_bytes()))
        .or(invite.inviter_owner_pubkey);
    if let Some(owner) = owner {
        data.insert(
            "owner".to_string(),
            serde_json::Value::String(owner.to_string()),
        );
    }
    if let Some(purpose) = invite.purpose.as_ref() {
        data.insert(
            "purpose".to_string(),
            serde_json::Value::String(purpose.clone()),
        );
    }
    if let Some(max_uses) = invite.max_uses {
        data.insert(
            "maxUses".to_string(),
            serde_json::Value::Number(serde_json::Number::from(max_uses)),
        );
    }

    Ok(format!(
        "{root}#{}",
        urlencoding::encode(&serde_json::Value::Object(data).to_string())
    ))
}

pub fn parse_invite_url(url: &str) -> Result<Invite> {
    let hash = url
        .split('#')
        .nth(1)
        .ok_or_else(|| Error::InvalidEvent("no hash in invite URL".to_string()))?;
    let decoded = urlencoding::decode(hash).map_err(|e| Error::InvalidEvent(e.to_string()))?;
    let data: serde_json::Value = serde_json::from_str(&decoded)?;

    let inviter_device_pubkey = parse_device_pubkey(
        data.get("inviter")
            .and_then(|value| value.as_str())
            .ok_or_else(|| Error::InvalidEvent("missing inviter".to_string()))?,
    )?;
    let inviter_ephemeral_public_key = parse_device_pubkey(
        data["ephemeralKey"]
            .as_str()
            .or_else(|| data["inviterEphemeralPublicKey"].as_str())
            .ok_or_else(|| Error::InvalidEvent("missing ephemeralKey".to_string()))?,
    )?;
    let shared_secret = parse_hex_32(
        data["sharedSecret"]
            .as_str()
            .ok_or_else(|| Error::InvalidEvent("missing sharedSecret".to_string()))?,
    )?;
    let inviter_owner_pubkey = data["owner"]
        .as_str()
        .or_else(|| data["ownerPubkey"].as_str())
        .or_else(|| data["ownerPublicKey"].as_str())
        .map(parse_owner_pubkey)
        .transpose()?;

    Ok(Invite {
        inviter_device_pubkey,
        inviter_ephemeral_public_key,
        shared_secret,
        inviter_ephemeral_private_key: None,
        max_uses: data["maxUses"].as_u64().map(|value| value as usize),
        used_by: Vec::new(),
        used_response_contents: Vec::new(),
        created_at: UnixSeconds(data["createdAt"].as_u64().unwrap_or(0)),
        inviter_owner_pubkey,
        purpose: data["purpose"].as_str().map(ToString::to_string),
        inviter: public_key(inviter_device_pubkey)?,
        device_id: data["deviceId"].as_str().map(ToString::to_string),
        owner_public_key: inviter_owner_pubkey
            .map(|owner| public_key(DevicePubkey::from_bytes(owner.to_bytes())))
            .transpose()?,
    })
}

pub fn invite_unsigned_event(invite: &Invite) -> Result<UnsignedEvent> {
    let inviter_device_pubkey = invite.inviter_device_pubkey;
    let d_suffix = invite
        .device_id
        .clone()
        .unwrap_or_else(|| inviter_device_pubkey.to_string());
    let mut builder = EventBuilder::new(Kind::from(INVITE_EVENT_KIND as u16), "")
        .tag(tag([
            "ephemeralKey",
            &invite.inviter_ephemeral_public_key.to_string(),
        ])?)
        .tag(tag(["sharedSecret", &hex::encode(invite.shared_secret)])?)
        .tag(tag(["d", &format!("double-ratchet/invites/{d_suffix}")])?)
        .tag(tag(["l", INVITE_LIST_LABEL])?)
        .custom_created_at(Timestamp::from(invite.created_at.get()));

    let owner = invite
        .owner_public_key
        .map(|pk| OwnerPubkey::from_bytes(pk.to_bytes()))
        .or(invite.inviter_owner_pubkey);
    if let Some(inviter_owner_pubkey) = owner {
        builder = builder.tag(tag(["ownerPublicKey", &inviter_owner_pubkey.to_string()])?);
    }

    Ok(builder.build(public_key(inviter_device_pubkey)?))
}

pub fn parse_invite_event(event: &Event) -> Result<Invite> {
    verify_event_kind(event, INVITE_EVENT_KIND)?;
    event.verify()?;

    let device_id = parse_invite_d_tag(&required_tag_value(event, "d")?)?;
    let inviter_device_pubkey = parse_device_pubkey(&device_id)
        .unwrap_or_else(|_| DevicePubkey::from_bytes(event.pubkey.to_bytes()));
    let inviter_owner_pubkey = optional_tag_value(event, "ownerPublicKey")
        .map(|value| parse_owner_pubkey(&value))
        .transpose()?;
    if event.pubkey.to_bytes() != inviter_device_pubkey.to_bytes() {
        return Err(Error::InvalidEvent(
            "invite event author does not match inviter device".to_string(),
        ));
    }

    Ok(Invite {
        inviter_device_pubkey,
        inviter_ephemeral_public_key: parse_device_pubkey(&required_tag_value(
            event,
            "ephemeralKey",
        )?)?,
        shared_secret: parse_hex_32(&required_tag_value(event, "sharedSecret")?)?,
        inviter_ephemeral_private_key: None,
        max_uses: None,
        used_by: Vec::new(),
        used_response_contents: Vec::new(),
        created_at: UnixSeconds(event.created_at.as_secs()),
        inviter_owner_pubkey,
        purpose: None,
        inviter: event.pubkey,
        device_id: (device_id != inviter_device_pubkey.to_string()).then_some(device_id),
        owner_public_key: inviter_owner_pubkey
            .map(|owner| public_key(DevicePubkey::from_bytes(owner.to_bytes())))
            .transpose()?,
    })
}

pub fn invite_response_event(envelope: &InviteResponseEnvelope) -> Result<Event> {
    let author_secret_key = secret_key_from_bytes(&envelope.signer_secret_key)?;
    let author_keys = Keys::new(author_secret_key);
    let derived_sender = DevicePubkey::from_bytes(author_keys.public_key().to_bytes());
    if derived_sender != envelope.sender {
        return Err(Error::InvalidEvent(
            "sender does not match signer secret".to_string(),
        ));
    }

    let unsigned = EventBuilder::new(
        Kind::from(INVITE_RESPONSE_KIND as u16),
        envelope.content.clone(),
    )
    .tag(tag(["p", &envelope.recipient.to_string()])?)
    .custom_created_at(Timestamp::from(envelope.created_at.get()))
    .build(public_key(envelope.sender)?);

    Ok(unsigned.sign_with_keys(&author_keys)?)
}

pub fn parse_invite_response_event(event: &Event) -> Result<InviteResponseEnvelope> {
    verify_event_kind(event, INVITE_RESPONSE_KIND)?;
    event.verify()?;
    let recipient = parse_device_pubkey(&required_tag_value(event, "p")?)?;

    Ok(InviteResponseEnvelope {
        sender: DevicePubkey::from_bytes(event.pubkey.to_bytes()),
        signer_secret_key: [0u8; 32],
        recipient,
        created_at: UnixSeconds(event.created_at.as_secs()),
        content: event.content.clone(),
    })
}

#[cfg(feature = "full")]
pub fn roster_unsigned_event(
    owner_pubkey: OwnerPubkey,
    roster: &DeviceRoster,
) -> Result<UnsignedEvent> {
    let mut builder = EventBuilder::new(Kind::from(ROSTER_EVENT_KIND as u16), "")
        .tag(tag(["d", ROSTER_D_TAG])?)
        .tag(tag(["version", ROSTER_VERSION])?)
        .custom_created_at(Timestamp::from(roster.created_at.get()));

    for device in roster.devices() {
        builder = builder.tag(tag([
            "device",
            &device.device_pubkey.to_string(),
            &device.created_at.get().to_string(),
        ])?);
    }

    Ok(builder.build(owner_public_key(owner_pubkey)?))
}

#[cfg(feature = "full")]
pub fn parse_roster_event(event: &Event) -> Result<DecodedRosterEvent> {
    verify_event_kind(event, ROSTER_EVENT_KIND)?;
    event.verify()?;
    if optional_tag_value(event, "d").as_deref() != Some(ROSTER_D_TAG) {
        return Err(Error::InvalidEvent("missing roster d tag".to_string()));
    }

    let mut devices = Vec::new();
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.first().map(|value| value.as_str()) != Some("device") {
            continue;
        }
        let device_pubkey = parse_device_pubkey(
            values
                .get(1)
                .ok_or_else(|| Error::InvalidEvent("device tag missing pubkey".to_string()))?,
        )?;
        let created_at = values
            .get(2)
            .ok_or_else(|| Error::InvalidEvent("device tag missing created_at".to_string()))?
            .parse::<u64>()
            .map_err(|e| Error::InvalidEvent(e.to_string()))?;
        devices.push(AuthorizedDevice {
            device_pubkey,
            created_at: UnixSeconds(created_at),
        });
    }

    Ok(DecodedRosterEvent {
        owner_pubkey: OwnerPubkey::from_bytes(event.pubkey.to_bytes()),
        roster: DeviceRoster::new(UnixSeconds(event.created_at.as_secs()), devices),
    })
}

fn verify_event_kind(event: &Event, expected_kind: u32) -> Result<()> {
    if event.kind != Kind::from(expected_kind as u16) {
        return Err(Error::InvalidEvent(format!(
            "unexpected kind {}, expected {}",
            event.kind, expected_kind
        )));
    }
    Ok(())
}

fn tag<const N: usize>(parts: [&str; N]) -> Result<Tag> {
    Tag::parse(parts.map(str::to_owned)).map_err(|e| Error::InvalidEvent(e.to_string()))
}

fn required_tag_value(event: &Event, key: &str) -> Result<String> {
    optional_tag_value(event, key)
        .ok_or_else(|| Error::InvalidEvent(format!("missing `{key}` tag")))
}

fn optional_tag_value(event: &Event, key: &str) -> Option<String> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(|value| value.as_str()) == Some(key))
        .and_then(|tag| tag.as_slice().get(1).map(ToOwned::to_owned))
}

fn parse_owner_pubkey(value: &str) -> Result<OwnerPubkey> {
    let pubkey = nostr::PublicKey::parse(value)?;
    Ok(OwnerPubkey::from_bytes(pubkey.to_bytes()))
}

fn parse_device_pubkey(value: &str) -> Result<DevicePubkey> {
    let pubkey = nostr::PublicKey::parse(value)?;
    Ok(DevicePubkey::from_bytes(pubkey.to_bytes()))
}

fn parse_invite_d_tag(value: &str) -> Result<String> {
    value
        .strip_prefix("double-ratchet/invites/")
        .map(ToString::to_string)
        .ok_or_else(|| Error::InvalidEvent("invalid invite d tag".to_string()))
}

fn parse_hex_32(value: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(value).map_err(|e| Error::InvalidEvent(e.to_string()))?;
    <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| Error::InvalidEvent("expected 32-byte hex".to_string()))
}

fn secret_key_from_bytes(bytes: &[u8; 32]) -> Result<nostr::SecretKey> {
    Ok(nostr::SecretKey::from_slice(bytes)?)
}

fn public_key(device_pubkey: DevicePubkey) -> Result<nostr::PublicKey> {
    Ok(nostr::PublicKey::from_slice(&device_pubkey.to_bytes())?)
}

#[cfg(feature = "full")]
fn owner_public_key(owner_pubkey: OwnerPubkey) -> Result<nostr::PublicKey> {
    Ok(nostr::PublicKey::from_slice(&owner_pubkey.to_bytes())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_event_roundtrip() {
        let signer_secret = [21u8; 32];
        let sender = DevicePubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&signer_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let event = message_event(&MessageEnvelope {
            sender,
            recipient: Some(DevicePubkey::from_bytes([7u8; 32])),
            signer_secret_key: signer_secret,
            created_at: UnixSeconds(10),
            encrypted_header: "header".to_string(),
            ciphertext: "ciphertext".to_string(),
        })
        .unwrap();

        let parsed = parse_message_event(&event).unwrap();
        assert_eq!(parsed.sender, sender);
        assert_eq!(parsed.recipient, Some(DevicePubkey::from_bytes([7u8; 32])));
        assert_eq!(parsed.encrypted_header, "header");
        assert_eq!(parsed.ciphertext, "ciphertext");
    }

    #[cfg(feature = "full")]
    #[test]
    fn group_sender_key_message_event_roundtrip_is_camouflaged_as_message_event() {
        let signer_secret = [22u8; 32];
        let sender_event_pubkey = DevicePubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&signer_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let event = group_sender_key_message_event(&GroupSenderKeyMessageEnvelope {
            group_id: "group-1".to_string(),
            sender_event_pubkey,
            signer_secret_key: signer_secret,
            key_id: 7,
            message_number: 11,
            encrypted_header: None,
            created_at: UnixSeconds(12),
            ciphertext: b"ciphertext".to_vec(),
        })
        .unwrap();

        assert_eq!(event.kind.as_u16() as u32, MESSAGE_EVENT_KIND);
        assert_eq!(GROUP_SENDER_KEY_MESSAGE_KIND, MESSAGE_EVENT_KIND);
        assert!(optional_tag_value(&event, "header").is_some());
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&event.content)
                .unwrap(),
            b"ciphertext"
        );
        assert!(parse_group_sender_key_message_event(&event).is_err());
        let parsed = parse_group_sender_key_message_event_unchecked(&event).unwrap();
        assert_eq!(parsed.sender_event_pubkey, sender_event_pubkey);
        assert_eq!(parsed.key_id, 0);
        assert_eq!(parsed.message_number, 0);
        assert!(parsed.encrypted_header.is_some());
        assert_eq!(parsed.ciphertext, b"ciphertext");
    }

    #[cfg(feature = "full")]
    #[test]
    fn legacy_group_sender_key_message_without_header_still_parses() {
        let signer_secret = [23u8; 32];
        let signer_keys = Keys::new(secret_key_from_bytes(&signer_secret).unwrap());
        let sender_event_pubkey = DevicePubkey::from_bytes(signer_keys.public_key().to_bytes());
        let content = build_group_sender_key_legacy_content(8, 12, b"legacy ciphertext");
        let event = EventBuilder::new(Kind::from(GROUP_SENDER_KEY_MESSAGE_KIND as u16), content)
            .custom_created_at(Timestamp::from(13))
            .build(signer_keys.public_key())
            .sign_with_keys(&signer_keys)
            .unwrap();

        assert!(optional_tag_value(&event, "header").is_none());
        let parsed = parse_group_sender_key_message_event(&event).unwrap();
        assert_eq!(parsed.sender_event_pubkey, sender_event_pubkey);
        assert_eq!(parsed.key_id, 8);
        assert_eq!(parsed.message_number, 12);
        assert!(parsed.encrypted_header.is_none());
        assert_eq!(parsed.ciphertext, b"legacy ciphertext");
    }

    #[test]
    fn invite_url_and_event_roundtrip() {
        let owner_secret = [31u8; 32];
        let owner_pubkey = OwnerPubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&owner_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let signer_secret = [32u8; 32];
        let inviter_device_pubkey = DevicePubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&signer_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let invite = Invite {
            inviter_device_pubkey,
            inviter_ephemeral_public_key: DevicePubkey::from_bytes([9u8; 32]),
            shared_secret: [7u8; 32],
            inviter_ephemeral_private_key: Some([8u8; 32]),
            max_uses: None,
            used_by: Vec::new(),
            used_response_contents: Vec::new(),
            created_at: UnixSeconds(22),
            inviter_owner_pubkey: Some(owner_pubkey),
            purpose: None,
            inviter: inviter_device_pubkey.to_nostr().unwrap(),
            device_id: None,
            owner_public_key: Some(owner_pubkey.to_nostr().unwrap()),
        };

        let url = invite_url(&invite, "https://chat.iris.to").unwrap();
        let encoded = url.split('#').nth(1).unwrap();
        let decoded = urlencoding::decode(encoded).unwrap();
        let data: serde_json::Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(
            data["inviter"].as_str().unwrap(),
            invite.inviter_device_pubkey.to_string()
        );
        assert!(data.get("inviterDevice").is_none());

        let parsed_from_url = parse_invite_url(&url).unwrap();
        assert_eq!(
            parsed_from_url.inviter_device_pubkey,
            invite.inviter_device_pubkey
        );
        assert_eq!(
            parsed_from_url.inviter_owner_pubkey,
            invite.inviter_owner_pubkey
        );
        assert_eq!(parsed_from_url.created_at, invite.created_at);

        let unsigned = invite_unsigned_event(&invite).unwrap();
        let keys = Keys::new(secret_key_from_bytes(&signer_secret).unwrap());
        assert_eq!(
            keys.public_key().to_bytes(),
            inviter_device_pubkey.to_bytes()
        );
        let signed = unsigned.sign_with_keys(&keys).unwrap();
        let parsed_from_event = parse_invite_event(&signed).unwrap();
        assert_eq!(
            parsed_from_event.inviter_device_pubkey,
            invite.inviter_device_pubkey
        );
        assert_eq!(
            parsed_from_event.inviter_owner_pubkey,
            invite.inviter_owner_pubkey
        );
    }

    #[test]
    fn invite_url_preserves_private_one_use_metadata() {
        let device = Keys::generate().public_key();
        let owner = Keys::generate().public_key();
        let mut invite =
            Invite::create_new(device, Some(device.to_hex()), Some(1)).expect("invite");
        invite.owner_public_key = Some(owner);
        invite.inviter_owner_pubkey = Some(OwnerPubkey::from_bytes(owner.to_bytes()));
        invite.purpose = Some("private".to_string());

        let url = invite_url(&invite, "https://chat.iris.to").unwrap();
        let parsed = parse_invite_url(&url).unwrap();

        assert_eq!(parsed.device_id, Some(device.to_hex()));
        assert_eq!(parsed.max_uses, Some(1));
        assert_eq!(parsed.created_at, invite.created_at);
        assert_eq!(parsed.owner_public_key, Some(owner));
        assert_eq!(parsed.purpose.as_deref(), Some("private"));
    }

    #[test]
    fn invite_url_accepts_owner_public_key_alias() {
        let device = Keys::generate().public_key();
        let owner = Keys::generate().public_key();
        let payload = serde_json::json!({
            "inviter": device.to_hex(),
            "ephemeralKey": device.to_hex(),
            "sharedSecret": "01".repeat(32),
            "ownerPublicKey": owner.to_hex(),
        })
        .to_string();
        let encoded = urlencoding::encode(&payload);
        let parsed = parse_invite_url(&format!("https://chat.iris.to/#{encoded}")).unwrap();

        assert_eq!(parsed.owner_public_key, Some(owner));
        assert_eq!(
            parsed.inviter_owner_pubkey,
            Some(OwnerPubkey::from_bytes(owner.to_bytes()))
        );
    }

    #[test]
    fn invite_url_rejects_inviter_device_wire_name() {
        let data = serde_json::json!({
            "inviterDevice": DevicePubkey::from_bytes([3u8; 32]).to_string(),
            "ephemeralKey": DevicePubkey::from_bytes([9u8; 32]).to_string(),
            "sharedSecret": hex::encode([7u8; 32]),
            "createdAt": 22,
        });
        let url = format!(
            "https://chat.iris.to#{}",
            urlencoding::encode(&data.to_string())
        );

        assert!(parse_invite_url(&url).is_err());
    }

    #[test]
    fn invite_response_event_roundtrip() {
        let sender_secret = [22u8; 32];
        let sender = DevicePubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&sender_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let recipient = DevicePubkey::from_bytes([7u8; 32]);

        let event = invite_response_event(&InviteResponseEnvelope {
            sender,
            signer_secret_key: sender_secret,
            recipient,
            created_at: UnixSeconds(25),
            content: "payload".to_string(),
        })
        .unwrap();

        let parsed = parse_invite_response_event(&event).unwrap();
        assert_eq!(parsed.sender, sender);
        assert_eq!(parsed.recipient, recipient);
        assert_eq!(parsed.created_at, UnixSeconds(25));
        assert_eq!(parsed.content, "payload");
    }

    #[test]
    fn invite_event_requires_device_author() {
        let owner_secret = [31u8; 32];
        let owner_pubkey = OwnerPubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&owner_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let device_secret = [32u8; 32];
        let inviter_device_pubkey = DevicePubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&device_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let invite = Invite {
            inviter_device_pubkey,
            inviter_ephemeral_public_key: DevicePubkey::from_bytes([9u8; 32]),
            shared_secret: [7u8; 32],
            inviter_ephemeral_private_key: Some([8u8; 32]),
            max_uses: None,
            used_by: Vec::new(),
            used_response_contents: Vec::new(),
            created_at: UnixSeconds(22),
            inviter_owner_pubkey: Some(owner_pubkey),
            purpose: None,
            inviter: inviter_device_pubkey.to_nostr().unwrap(),
            device_id: None,
            owner_public_key: Some(owner_pubkey.to_nostr().unwrap()),
        };

        let unsigned = invite_unsigned_event(&invite).unwrap();
        let owner_keys = Keys::new(secret_key_from_bytes(&owner_secret).unwrap());
        let signed = unsigned.sign_with_keys(&owner_keys).unwrap();
        assert!(parse_invite_event(&signed).is_err());
    }

    #[cfg(feature = "full")]
    #[test]
    fn roster_event_roundtrip() {
        let owner_secret = [41u8; 32];
        let owner = OwnerPubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&owner_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let device_secret = [42u8; 32];
        let device_pubkey = DevicePubkey::from_bytes(
            Keys::new(secret_key_from_bytes(&device_secret).unwrap())
                .public_key()
                .to_bytes(),
        );
        let roster = DeviceRoster::new(
            UnixSeconds(300),
            vec![AuthorizedDevice::new(device_pubkey, UnixSeconds(100))],
        );

        let unsigned = roster_unsigned_event(owner, &roster).unwrap();
        assert!(unsigned.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.first().map(|value| value.as_str()) == Some("d")
                && values.get(1).map(|value| value.as_str()) == Some("double-ratchet/app-keys")
        }));
        let keys = Keys::new(secret_key_from_bytes(&owner_secret).unwrap());
        let signed = unsigned.sign_with_keys(&keys).unwrap();

        let decoded = parse_roster_event(&signed).unwrap();
        assert_eq!(decoded.owner_pubkey, owner);
        assert_eq!(decoded.roster, roster);

        let legacy_roster_unsigned = EventBuilder::new(Kind::from(ROSTER_EVENT_KIND as u16), "")
            .tag(tag(["d", "double-ratchet/roster"]).unwrap())
            .tag(tag(["version", ROSTER_VERSION]).unwrap())
            .tag(tag(["device", &device_pubkey.to_string(), "100"]).unwrap())
            .custom_created_at(Timestamp::from(roster.created_at.get()))
            .build(owner_public_key(owner).unwrap());
        let legacy_roster_signed = legacy_roster_unsigned.sign_with_keys(&keys).unwrap();
        assert!(parse_roster_event(&legacy_roster_signed).is_err());
    }
}
