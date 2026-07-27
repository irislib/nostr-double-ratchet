//! Durable single-device pairwise runtime.

mod action;
mod error;
mod manager;
mod persistence;
mod state;
mod storage;

pub use action::{
    PairwiseAcceptResult, PairwiseAction, PairwiseActionKind, PairwiseSendResult,
    PairwiseSessionInfo,
};
pub use error::{PairwiseError, Result};
pub use manager::PairwiseManager;
pub use state::RuntimeLimits;
pub use storage::{FileStore, MemoryStore, PairwiseStore, MAX_FILE_STORE_PAYLOAD_BYTES};
