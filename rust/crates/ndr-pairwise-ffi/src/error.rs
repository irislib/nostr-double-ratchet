use std::fmt;

#[derive(Clone, Debug, uniffi::Error)]
pub enum NdrError {
    InvalidKey(String),
    InvalidEvent(String),
    PeerMismatch(String),
    SessionNotReady(String),
    QueueFull(String),
    Storage(String),
    CryptoFailure(String),
}

impl fmt::Display for NdrError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKey(message) => write!(formatter, "Invalid key: {message}"),
            Self::InvalidEvent(message) => write!(formatter, "Invalid event: {message}"),
            Self::PeerMismatch(message) => write!(formatter, "Peer mismatch: {message}"),
            Self::SessionNotReady(message) => {
                write!(formatter, "Session not ready: {message}")
            }
            Self::QueueFull(message) => write!(formatter, "Queue full: {message}"),
            Self::Storage(message) => write!(formatter, "Storage error: {message}"),
            Self::CryptoFailure(message) => write!(formatter, "Crypto failure: {message}"),
        }
    }
}

impl std::error::Error for NdrError {}

impl From<nostr_double_ratchet_pairwise::PairwiseError> for NdrError {
    fn from(error: nostr_double_ratchet_pairwise::PairwiseError) -> Self {
        use nostr_double_ratchet_pairwise::PairwiseError;

        let message = error.to_string();
        match error {
            PairwiseError::InvalidKey(_) => Self::InvalidKey(message),
            PairwiseError::InvalidEvent(_)
            | PairwiseError::InvalidLimits
            | PairwiseError::OwnerDeviceMismatch
            | PairwiseError::InputTooLarge { .. }
            | PairwiseError::CorruptState(_)
            | PairwiseError::UnsupportedFormat(_)
            | PairwiseError::UnsupportedSchema(_)
            | PairwiseError::Serialization(_) => Self::InvalidEvent(message),
            PairwiseError::PeerMismatch { .. } | PairwiseError::IdentityMismatch { .. } => {
                Self::PeerMismatch(message)
            }
            PairwiseError::SessionNotReady(_) => Self::SessionNotReady(message),
            PairwiseError::QueueFull { .. } => Self::QueueFull(message),
            PairwiseError::Storage(_) => Self::Storage(message),
            PairwiseError::Crypto(_) => Self::CryptoFailure(message),
        }
    }
}

impl From<serde_json::Error> for NdrError {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidEvent(error.to_string())
    }
}

impl From<nostr::key::Error> for NdrError {
    fn from(error: nostr::key::Error) -> Self {
        Self::InvalidKey(error.to_string())
    }
}
