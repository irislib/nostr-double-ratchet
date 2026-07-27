use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PairwiseActionKind {
    Publish {
        session_id: String,
        event_json: String,
        inner_event_id: Option<String>,
    },
    OutOfBand {
        peer_pubkey_hex: String,
        session_id: String,
        event_json: String,
    },
    Subscribe {
        subscription_id: String,
        filter_json: String,
    },
    Unsubscribe {
        subscription_id: String,
    },
    Delivery {
        peer_pubkey_hex: String,
        inner_event_json: String,
        inner_event_id: String,
        outer_event_id: String,
        expires_at_seconds: Option<u64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairwiseAction {
    pub id: String,
    pub kind: PairwiseActionKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairwiseAcceptResult {
    pub peer_pubkey_hex: String,
    pub created_new_session: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairwiseSendResult {
    pub inner_event_id: String,
    pub outer_event_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairwiseSessionInfo {
    pub send_ready: bool,
    pub receive_ready: bool,
    pub tracked_sender_pubkeys: Vec<String>,
}
