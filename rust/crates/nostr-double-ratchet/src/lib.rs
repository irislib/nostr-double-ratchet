pub mod app_keys;
pub mod device_link;
pub mod direct_message_subscriptions;
pub mod error;
pub mod group;
pub mod group_manager;
pub mod group_wire;
pub mod ids;
pub mod invite;
pub mod message_builders;
pub mod message_origin;
pub mod multi_device;
pub mod one_to_many;
pub mod owner_roster_proof;
pub mod protocol_types;
pub mod roster;
pub mod roster_editor;
pub mod sender_key;
pub mod session;
pub mod session_manager;
pub mod shared_channel;
pub mod utils;
pub mod wire;

pub use app_keys::{
    build_app_keys_device_authorization_filter,
    encrypted_device_label_payloads_from_app_keys_event, is_app_keys_event,
    owner_roster_proof_from_app_keys_event, parse_owner_roster_proof,
    resolve_app_keys_owner_for_device, AppKeys, DeviceEntry, DeviceLabels,
    APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT, APP_KEYS_ENCRYPTED_DEVICE_LABELS_SCHEMA,
    APP_KEYS_FACT_TYPE, APP_KEYS_OWNER_PUBKEY_FACT, APP_KEYS_SCHEMA, APP_KEYS_SNAPSHOT_KIND,
};
pub use device_link::{
    deterministic_link_invite_for_device, deterministic_link_invite_for_device_link_request,
    encode_compact_device_link_request, parse_compact_device_link_request, DeviceLinkRequest,
};
pub use direct_message_subscriptions::{
    app_keys_subscription_authors, build_app_keys_backfill_filter,
    build_direct_message_backfill_filter, build_invite_backfill_filter,
    build_invite_response_backfill_filter, build_protocol_discovery_filters,
    build_runtime_backfill_filters, direct_message_subscription_authors,
    invite_response_subscription_recipients, DirectMessageSubscriptionTracker,
    RuntimeSubscriptionRegistration, RuntimeSubscriptionTracker,
};
pub use error::{DomainError, Error, Result};
pub use group::*;
pub use group_manager::*;
pub use group_wire::{
    build_group_roster_fact_filter, group_roster_unsigned_event, is_group_roster_fact_event,
    parse_group_roster_fact_event, project_group_roster_fact_events, GroupEventManager,
    GroupRosterFact, JsonGroupPayloadCodecV1, GROUP_ROSTER_FACT_KIND, GROUP_ROSTER_FACT_SCHEMA,
    GROUP_ROSTER_FACT_TYPE,
};
pub use ids::{DevicePubkey, OwnerPubkey, UnixSeconds};
pub use invite::{Invite, InviteResponse, InviteResponseEnvelope};
pub use message_builders::*;
pub use message_origin::{classify_message_origin, MessageOrigin};
pub use multi_device::{
    apply_app_keys_snapshot, apply_app_keys_snapshot_with_required_device,
    evaluate_device_registration_state, resolve_conversation_candidate_pubkeys,
    resolve_rumor_peer_pubkey, select_latest_app_keys_from_events,
    should_require_relay_registration_confirmation, AppKeysSnapshot, AppKeysSnapshotDecision,
    DeviceRegistrationState,
};
pub use one_to_many::*;
pub use owner_roster_proof::OwnerRosterProof;
pub use protocol_types::{ProtocolContext, MAX_SKIP};
pub use roster::{AuthorizedDevice, DeviceRoster, RosterSnapshotDecision};
pub use roster_editor::RosterEditor;
pub use sender_key::*;
pub use session::{
    Header, MessageEnvelope, ReceiveOutcome, ReceivePlan, SendOutcome, SendPlan,
    SerializableKeyPair, Session, SessionState, SkippedKeysEntry,
};
pub use session_manager::{
    Delivery, DeviceRecordSnapshot, PreparedSend, ProcessedInviteResponse, PruneReport,
    ReceivedMessage, RelayGap, SessionManager, SessionManagerSnapshot, UserRecordSnapshot,
};
pub use shared_channel::SharedChannel;
pub use wire::{
    group_sender_key_message_event, invite_response_event, invite_unsigned_event, invite_url,
    message_event, parse_group_sender_key_message_event,
    parse_group_sender_key_message_event_unchecked, parse_invite_event,
    parse_invite_response_event, parse_invite_url, parse_message_event, parse_roster_event,
    roster_unsigned_event, DecodedRosterEvent, GROUP_SENDER_KEY_MESSAGE_KIND, INVITE_EVENT_KIND,
    INVITE_LIST_LABEL, INVITE_RESPONSE_KIND, MESSAGE_EVENT_KIND, ROSTER_EVENT_KIND,
};

pub(crate) use utils::{
    device_pubkey_from_secret_bytes, kdf, random_secret_key_bytes, secret_key_from_bytes,
};

pub const APP_KEYS_EVENT_KIND: u32 = APP_KEYS_SNAPSHOT_KIND;
pub const CHAT_MESSAGE_KIND: u32 = 14;
pub const CHAT_SETTINGS_KIND: u32 = 10448;
pub const REACTION_KIND: u32 = 7;
pub const RECEIPT_KIND: u32 = 15;
pub const TYPING_KIND: u32 = 25;
pub const SHARED_CHANNEL_KIND: u32 = 4;
pub const EXPIRATION_TAG: &str = "expiration";

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOptions {
    pub expires_at: Option<u64>,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsPayloadV1 {
    #[serde(rename = "type")]
    pub typ: String,
    pub v: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_ttl_seconds: Option<u64>,
}

pub fn process_invite_response_event(
    invite: &Invite,
    event: &nostr::Event,
    inviter_private_key: [u8; 32],
) -> Result<Option<InviteResponse>> {
    let envelope = parse_invite_response_event(event)
        .map_err(|error| Error::InvalidEvent(error.to_string()))?;
    let mut rng = rand::rngs::OsRng;
    let mut ctx = ProtocolContext::new(UnixSeconds(event.created_at.as_secs()), &mut rng);
    let mut invite = invite.clone();
    invite
        .process_response(&mut ctx, &envelope, inviter_private_key)
        .map(Some)
}

pub trait SessionNostrExt {
    fn send_event(&mut self, event: nostr::UnsignedEvent) -> Result<nostr::Event>;
    fn receive(&mut self, event: &nostr::Event) -> Result<Option<String>>;
}

impl SessionNostrExt for Session {
    fn send_event(&mut self, mut event: nostr::UnsignedEvent) -> Result<nostr::Event> {
        event.ensure_id();
        let payload = serde_json::to_vec(&event)?;
        let now = UnixSeconds(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );
        let plan = self.plan_send(&payload, now)?;
        let envelope = self.apply_send(plan).envelope;
        message_event(&envelope).map_err(|error| Error::InvalidEvent(error.to_string()))
    }

    fn receive(&mut self, event: &nostr::Event) -> Result<Option<String>> {
        let envelope =
            parse_message_event(event).map_err(|error| Error::InvalidEvent(error.to_string()))?;
        if !self.matches_sender(envelope.sender) {
            return Ok(None);
        }
        let mut rng = rand::rngs::OsRng;
        let mut ctx = ProtocolContext::new(UnixSeconds(event.created_at.as_secs()), &mut rng);
        let plan = self.plan_receive(&mut ctx, &envelope)?;
        let outcome = self.apply_receive(plan);
        let plaintext = String::from_utf8(outcome.payload)
            .map_err(|error| Error::Decryption(error.to_string()))?;
        Ok(Some(plaintext))
    }
}

pub trait InviteNostrExt {
    fn get_url(&self, root: &str) -> Result<String>;
    fn get_event(&self) -> Result<nostr::UnsignedEvent>;
    fn from_url(url: &str) -> Result<Invite>;
    fn from_event(event: &nostr::Event) -> Result<Invite>;
    fn process_invite_response(
        &self,
        event: &nostr::Event,
        inviter_private_key: [u8; 32],
    ) -> Result<Option<InviteResponse>>;
}

impl InviteNostrExt for Invite {
    fn get_url(&self, root: &str) -> Result<String> {
        invite_url(self, root).map_err(|error| Error::InvalidEvent(error.to_string()))
    }

    fn get_event(&self) -> Result<nostr::UnsignedEvent> {
        if self.device_id.is_none() {
            return Err(Error::DeviceIdRequired);
        }
        invite_unsigned_event(self).map_err(|error| Error::InvalidEvent(error.to_string()))
    }

    fn from_url(url: &str) -> Result<Invite> {
        parse_invite_url(url).map_err(|error| Error::InvalidEvent(error.to_string()))
    }

    fn from_event(event: &nostr::Event) -> Result<Invite> {
        parse_invite_event(event).map_err(|error| Error::InvalidEvent(error.to_string()))
    }

    fn process_invite_response(
        &self,
        event: &nostr::Event,
        inviter_private_key: [u8; 32],
    ) -> Result<Option<InviteResponse>> {
        process_invite_response_event(self, event, inviter_private_key)
    }
}

#[cfg(test)]
mod architecture_tests {
    #[test]
    fn core_modules_do_not_manage_runtime_or_wire() {
        let sources = [
            include_str!("group.rs"),
            include_str!("group_manager.rs"),
            include_str!("invite.rs"),
            include_str!("roster.rs"),
            include_str!("roster_editor.rs"),
            include_str!("sender_key.rs"),
            include_str!("session.rs"),
            include_str!("session_manager.rs"),
        ];
        for banned in [
            "NdrRuntime",
            "SessionManagerEvent",
            "StorageAdapter",
            "crossbeam",
            "tokio",
            "EventBuilder",
            "Filter",
            "crate::wire",
            "wire::",
            "pairwise_codec",
            "GroupWireEnvelopeV1",
            "GroupPairwisePayloadV1",
            "GroupSenderKeyPlaintextV1",
            "wire_format_version",
        ] {
            for source in sources {
                assert!(
                    !source.contains(banned),
                    "core should stay deterministic and wire/runtime-free; found `{banned}`"
                );
            }
        }
    }
}
