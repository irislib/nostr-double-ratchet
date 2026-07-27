use thiserror::Error;

#[derive(Debug, Error)]
pub enum PairwiseError {
    #[error("invalid key: {0}")]
    InvalidKey(String),

    #[error("invalid event: {0}")]
    InvalidEvent(String),

    #[error("authenticated peer mismatch: expected {expected}, got {actual}")]
    PeerMismatch { expected: String, actual: String },

    #[error("pairwise owner claim must equal device identity")]
    OwnerDeviceMismatch,

    #[error("session with {0} is not ready")]
    SessionNotReady(String),

    #[error("durable {queue} queue is full")]
    QueueFull { queue: &'static str },

    #[error("{input} exceeds the {limit}-byte limit")]
    InputTooLarge { input: &'static str, limit: usize },

    #[error("state belongs to {actual}, not {expected}")]
    IdentityMismatch { expected: String, actual: String },

    #[error("unsupported state format version {0}")]
    UnsupportedFormat(u32),

    #[error("unsupported state schema version {0}")]
    UnsupportedSchema(u32),

    #[error("corrupt pairwise state: {0}")]
    CorruptState(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("cryptographic operation failed: {0}")]
    Crypto(String),

    #[error("serialization failed: {0}")]
    Serialization(String),
}

pub type Result<T> = std::result::Result<T, PairwiseError>;

impl From<serde_json::Error> for PairwiseError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error.to_string())
    }
}

impl From<nostr_double_ratchet::Error> for PairwiseError {
    fn from(error: nostr_double_ratchet::Error) -> Self {
        match error {
            nostr_double_ratchet::Error::Domain(
                nostr_double_ratchet::DomainError::CannotSendYet
                | nostr_double_ratchet::DomainError::SessionNotReady,
            )
            | nostr_double_ratchet::Error::SessionNotReady => {
                Self::SessionNotReady("peer".to_string())
            }
            other => Self::Crypto(other.to_string()),
        }
    }
}

impl From<nostr_double_ratchet::wire::Error> for PairwiseError {
    fn from(error: nostr_double_ratchet::wire::Error) -> Self {
        Self::InvalidEvent(error.to_string())
    }
}

impl From<nostr_double_ratchet_pairwise_codec::Error> for PairwiseError {
    fn from(error: nostr_double_ratchet_pairwise_codec::Error) -> Self {
        Self::InvalidEvent(error.to_string())
    }
}

impl From<nostr::key::Error> for PairwiseError {
    fn from(error: nostr::key::Error) -> Self {
        Self::InvalidKey(error.to_string())
    }
}

impl From<nostr::event::Error> for PairwiseError {
    fn from(error: nostr::event::Error) -> Self {
        Self::InvalidEvent(error.to_string())
    }
}
