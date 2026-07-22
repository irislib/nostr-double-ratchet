use crate::{Delivery, DevicePubkey, InviteResponseEnvelope, OwnerPubkey, RelayGap, UnixSeconds};
use serde::{Deserialize, Deserializer, Serialize};

pub type SenderEventPubkey = DevicePubkey;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupStrategy {
    PairwiseFanout,
    SenderKey,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct GroupProtocol {
    pub strategy: GroupStrategy,
    pub version: u16,
}

impl GroupProtocol {
    #[allow(non_upper_case_globals)]
    pub const PairwiseFanoutV1: Self = Self::pairwise_fanout_v1();
    #[allow(non_upper_case_globals)]
    pub const SenderKeyV1: Self = Self::sender_key_v1();

    pub const fn pairwise_fanout_v1() -> Self {
        Self {
            strategy: GroupStrategy::PairwiseFanout,
            version: 1,
        }
    }

    pub const fn sender_key_v1() -> Self {
        Self {
            strategy: GroupStrategy::SenderKey,
            version: 1,
        }
    }

    pub fn is_pairwise_fanout_v1(self) -> bool {
        self == Self::pairwise_fanout_v1()
    }

    pub fn is_sender_key_v1(self) -> bool {
        self == Self::sender_key_v1()
    }
}

impl<'de> Deserialize<'de> for GroupProtocol {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Legacy(String),
            Descriptor {
                strategy: GroupStrategy,
                version: u16,
            },
        }

        match Wire::deserialize(deserializer)? {
            Wire::Legacy(value) if value == "pairwise_fanout_v1" => {
                Ok(GroupProtocol::pairwise_fanout_v1())
            }
            Wire::Legacy(value) if value == "sender_key_v1" => Ok(GroupProtocol::sender_key_v1()),
            Wire::Legacy(value) => Err(serde::de::Error::custom(format!(
                "unsupported group protocol `{value}`"
            ))),
            Wire::Descriptor { strategy, version } => Ok(GroupProtocol { strategy, version }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupSnapshot {
    pub group_id: String,
    pub protocol: GroupProtocol,
    pub name: String,
    /// Optional URL of the group's picture/avatar. Travels alongside `name`
    /// in the same revisioned metadata snapshot so new joiners receive it
    /// automatically on their first sync, and there is no separate side
    /// channel for picture updates that could be reordered against
    /// membership changes. `None` means the group has no picture set.
    /// Skipped on the wire when absent so pre-0.0.144 peers keep round-tripping
    /// snapshots unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    /// Optional free-text description of the group (Signal calls this the
    /// group description). Same wire-compat treatment as `picture`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    pub created_by: OwnerPubkey,
    pub members: Vec<OwnerPubkey>,
    pub admins: Vec<OwnerPubkey>,
    pub revision: u64,
    pub created_at: UnixSeconds,
    pub updated_at: UnixSeconds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupManagerSnapshot {
    pub local_owner_pubkey: OwnerPubkey,
    pub groups: Vec<GroupSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sender_keys: Vec<GroupSenderKeyRecordSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupPreparedPublish {
    pub deliveries: Vec<Delivery>,
    pub invite_responses: Vec<InviteResponseEnvelope>,
    pub sender_key_messages: Vec<GroupSenderKeyMessageEnvelope>,
    pub relay_gaps: Vec<RelayGap>,
    pub pending_fanouts: Vec<GroupPendingFanout>,
}

impl GroupPreparedPublish {
    pub fn empty() -> Self {
        Self {
            deliveries: Vec::new(),
            invite_responses: Vec::new(),
            sender_key_messages: Vec::new(),
            relay_gaps: Vec::new(),
            pending_fanouts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GroupPendingFanout {
    Remote {
        recipient_owner: OwnerPubkey,
        payload: Vec<u8>,
    },
    LocalSiblings {
        payload: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupPreparedSend {
    pub group_id: String,
    pub remote: GroupPreparedPublish,
    pub local_sibling: GroupPreparedPublish,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCreateResult {
    pub group: GroupSnapshot,
    pub prepared: GroupPreparedSend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupPayloadEncodeContext {
    pub local_device_pubkey: DevicePubkey,
    pub created_at: UnixSeconds,
}

pub trait GroupPayloadCodec: Clone {
    fn is_pairwise_payload(&self, payload: &[u8]) -> bool;

    fn encode_pairwise_command(
        &self,
        ctx: GroupPayloadEncodeContext,
        command: &GroupPairwiseCommand,
    ) -> crate::Result<Vec<u8>>;

    fn decode_pairwise_command(
        &self,
        payload: &[u8],
    ) -> crate::Result<Option<GroupPairwiseCommand>>;

    fn encode_sender_key_plaintext(
        &self,
        ctx: GroupPayloadEncodeContext,
        plaintext: &GroupSenderKeyPlaintext,
    ) -> crate::Result<Vec<u8>>;

    fn decode_sender_key_plaintext(
        &self,
        ctx: GroupSenderKeyPlaintextDecodeContext<'_>,
        payload: &[u8],
    ) -> crate::Result<Option<GroupSenderKeyPlaintext>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupPairwiseCommand {
    MetadataSnapshot {
        snapshot: GroupSnapshot,
    },
    GroupMessage {
        group_id: String,
        revision: u64,
        body: Vec<u8>,
    },
    SenderKeyDistribution {
        distribution: SenderKeyDistribution,
    },
    SenderKeyRepairRequest {
        request: SenderKeyRepairRequest,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupSenderKeyPlaintext {
    pub group_id: String,
    pub revision: u64,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupSenderKeyPlaintextDecodeContext<'a> {
    pub group_id: &'a str,
    pub current_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupReceivedMessage {
    pub group_id: String,
    pub sender_owner: OwnerPubkey,
    pub sender_device: Option<DevicePubkey>,
    pub body: Vec<u8>,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupIncomingEvent {
    MetadataUpdated(GroupSnapshot),
    Message(GroupReceivedMessage),
    SenderKeyRepairRequested(GroupSenderKeyRepairRequestEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupSenderKeyRecordSnapshot {
    pub group_id: String,
    pub sender_owner: OwnerPubkey,
    pub sender_device: DevicePubkey,
    pub sender_event_pubkey: SenderEventPubkey,
    #[serde(default, with = "crate::serde_hex::option")]
    pub sender_event_secret_key: Option<[u8; 32]>,
    pub latest_key_id: Option<u32>,
    pub states: Vec<crate::SenderKeyState>,
    #[serde(default)]
    pub distribution_history: Vec<SenderKeyDistribution>,
    #[serde(default)]
    pub distributed_to: Vec<GroupSenderKeyDistributionRecipientsSnapshot>,
    #[serde(default)]
    pub repair_snapshots: Vec<GroupSenderKeyRepairSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupSenderKeyDistributionRecipientsSnapshot {
    pub key_id: u32,
    pub recipients: Vec<OwnerPubkey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupSenderKeyRepairSnapshot {
    pub key_id: u32,
    pub distribution: SenderKeyDistribution,
    pub recipients: Vec<OwnerPubkey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SenderKeyDistribution {
    pub group_id: String,
    pub key_id: u32,
    pub sender_event_pubkey: SenderEventPubkey,
    #[serde(with = "hex::serde")]
    pub chain_key: [u8; 32],
    pub iteration: u32,
    pub created_at: UnixSeconds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SenderKeyRepairRequest {
    pub group_id: String,
    pub sender_event_pubkey: SenderEventPubkey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_revision: Option<u64>,
    pub created_at: UnixSeconds,
}

impl SenderKeyRepairRequest {
    pub fn from_pending_sender_key_message(
        message: &GroupSenderKeyMessage,
        result: &GroupSenderKeyHandleResult,
        created_at: UnixSeconds,
    ) -> Option<Self> {
        match result {
            GroupSenderKeyHandleResult::PendingDistribution {
                group_id,
                sender_event_pubkey,
                key_id,
                message_number,
            } => Some(Self {
                group_id: group_id.clone(),
                sender_event_pubkey: *sender_event_pubkey,
                key_id: *key_id,
                message_number: *message_number,
                required_revision: None,
                created_at,
            }),
            GroupSenderKeyHandleResult::PendingRevision {
                group_id,
                required_revision,
                key_id,
                message_number,
                ..
            } => Some(Self {
                group_id: group_id.clone(),
                sender_event_pubkey: message.sender_event_pubkey,
                key_id: Some(*key_id),
                message_number: Some(*message_number),
                required_revision: Some(*required_revision),
                created_at,
            }),
            _ => None,
        }
    }
}

pub const SENDER_KEY_REPAIR_DEFAULT_RETRY_DELAYS_SECS: [u64; 5] = [30, 120, 600, 3_600, 21_600];

pub fn sender_key_repair_default_retry_delay_secs(sent_request_count: u32) -> u64 {
    let index = sent_request_count
        .saturating_sub(1)
        .min((SENDER_KEY_REPAIR_DEFAULT_RETRY_DELAYS_SECS.len() - 1) as u32)
        as usize;
    SENDER_KEY_REPAIR_DEFAULT_RETRY_DELAYS_SECS[index]
}

pub fn sender_key_repair_default_next_retry_at(
    now: UnixSeconds,
    sent_request_count: u32,
) -> UnixSeconds {
    UnixSeconds(
        now.get()
            .saturating_add(sender_key_repair_default_retry_delay_secs(
                sent_request_count,
            )),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupSenderKeyRepairRequestEvent {
    pub requester_owner: OwnerPubkey,
    pub requester_device: Option<DevicePubkey>,
    pub request: SenderKeyRepairRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupSenderKeyMessageEnvelope {
    pub group_id: String,
    pub sender_event_pubkey: SenderEventPubkey,
    #[serde(with = "hex::serde")]
    pub signer_secret_key: [u8; 32],
    pub key_id: u32,
    pub message_number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_header: Option<String>,
    pub created_at: UnixSeconds,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GroupSenderKeyMessage {
    pub group_id: String,
    pub sender_event_pubkey: SenderEventPubkey,
    pub key_id: u32,
    pub message_number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_header: Option<String>,
    pub created_at: UnixSeconds,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupSenderKeyHandleResult {
    Event(GroupIncomingEvent),
    PendingDistribution {
        group_id: String,
        sender_event_pubkey: SenderEventPubkey,
        key_id: Option<u32>,
        message_number: Option<u32>,
    },
    PendingRevision {
        group_id: String,
        current_revision: u64,
        required_revision: u64,
        key_id: u32,
        message_number: u32,
    },
    Ignored,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_key_repair_default_retry_policy_starts_fast_then_backs_off() {
        assert_eq!(sender_key_repair_default_retry_delay_secs(0), 30);
        assert_eq!(sender_key_repair_default_retry_delay_secs(1), 30);
        assert_eq!(sender_key_repair_default_retry_delay_secs(2), 120);
        assert_eq!(sender_key_repair_default_retry_delay_secs(3), 600);
        assert_eq!(sender_key_repair_default_retry_delay_secs(4), 3_600);
        assert_eq!(sender_key_repair_default_retry_delay_secs(5), 21_600);
        assert_eq!(sender_key_repair_default_retry_delay_secs(u32::MAX), 21_600);
    }

    #[test]
    fn sender_key_repair_default_next_retry_saturates() {
        assert_eq!(
            sender_key_repair_default_next_retry_at(UnixSeconds(100), 2),
            UnixSeconds(220)
        );
        assert_eq!(
            sender_key_repair_default_next_retry_at(UnixSeconds(u64::MAX - 10), 1),
            UnixSeconds(u64::MAX)
        );
    }

    #[test]
    fn sender_key_repair_request_from_pending_distribution_uses_blocked_message_number() {
        let sender_event_pubkey = DevicePubkey::from_bytes([7; 32]);
        let request = SenderKeyRepairRequest::from_pending_sender_key_message(
            &GroupSenderKeyMessage {
                group_id: "ignored-message-group".to_string(),
                sender_event_pubkey: DevicePubkey::from_bytes([8; 32]),
                key_id: 99,
                message_number: 42,
                encrypted_header: None,
                created_at: UnixSeconds(100),
                ciphertext: vec![1, 2, 3],
            },
            &GroupSenderKeyHandleResult::PendingDistribution {
                group_id: "group-1".to_string(),
                sender_event_pubkey,
                key_id: Some(7),
                message_number: Some(42),
            },
            UnixSeconds(200),
        )
        .expect("pending distribution should request repair");

        assert_eq!(request.group_id, "group-1");
        assert_eq!(request.sender_event_pubkey, sender_event_pubkey);
        assert_eq!(request.key_id, Some(7));
        assert_eq!(request.message_number, Some(42));
        assert_eq!(request.required_revision, None);
        assert_eq!(request.created_at, UnixSeconds(200));
    }

    #[test]
    fn sender_key_repair_request_from_pending_revision_requests_metadata_too() {
        let sender_event_pubkey = DevicePubkey::from_bytes([9; 32]);
        let request = SenderKeyRepairRequest::from_pending_sender_key_message(
            &GroupSenderKeyMessage {
                group_id: "group-1".to_string(),
                sender_event_pubkey,
                key_id: 11,
                message_number: 12,
                encrypted_header: None,
                created_at: UnixSeconds(100),
                ciphertext: vec![1, 2, 3],
            },
            &GroupSenderKeyHandleResult::PendingRevision {
                group_id: "group-1".to_string(),
                current_revision: 3,
                required_revision: 4,
                key_id: 11,
                message_number: 12,
            },
            UnixSeconds(200),
        )
        .expect("pending revision should request repair");

        assert_eq!(request.group_id, "group-1");
        assert_eq!(request.sender_event_pubkey, sender_event_pubkey);
        assert_eq!(request.key_id, Some(11));
        assert_eq!(request.message_number, Some(12));
        assert_eq!(request.required_revision, Some(4));
        assert_eq!(request.created_at, UnixSeconds(200));
    }

    #[test]
    fn sender_key_repair_request_from_consumed_result_returns_none() {
        let message = GroupSenderKeyMessage {
            group_id: "group-1".to_string(),
            sender_event_pubkey: DevicePubkey::from_bytes([9; 32]),
            key_id: 11,
            message_number: 12,
            encrypted_header: None,
            created_at: UnixSeconds(100),
            ciphertext: vec![1, 2, 3],
        };

        assert_eq!(
            SenderKeyRepairRequest::from_pending_sender_key_message(
                &message,
                &GroupSenderKeyHandleResult::Ignored,
                UnixSeconds(200)
            ),
            None
        );
    }
}
