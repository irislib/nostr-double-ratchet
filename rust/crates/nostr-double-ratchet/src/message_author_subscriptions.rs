//! Live subscriptions to kind 1060 message authors, sized for relay limits.
//!
//! Message events carry no recipient tag, so the sender ratchet keys a device
//! subscribes to are the only way it finds its messages. See the README
//! section "Why message events carry no recipient tag".

use crate::{DevicePubkey, SessionState, MESSAGE_EVENT_KIND, METADATA_PRIVACY_VERSION};
use nostr::{Filter, Kind, PublicKey};
use std::collections::HashSet;

/// Sized for the tightest relays in common use: 131,072-byte frames (about
/// 1,950 hex authors per REQ), 2,047 items per filter, 20 subscriptions per
/// connection. One chunk per subscription stays well inside all three.
pub const MESSAGE_AUTHOR_FILTER_CHUNK_SIZE: usize = 1_000;
pub const MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT: usize = 12_000;

/// Chunk counts tried before giving up on a key-selected layout.
const KEYED_LAYOUT_ATTEMPTS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageAuthorSubscriptionPlan {
    /// One live subscription each. A small author set stays in a single filter.
    pub filters: Vec<Filter>,
    /// Authors left out because the limit was reached, least important last.
    pub dropped: Vec<PublicKey>,
}

/// Split message authors, most important first, into filters every relay
/// accepts. Past `max_authors` the tail is dropped.
///
/// An author normally lands in the chunk its key selects, so one ratchet step
/// replaces one subscription, not all of them. Keys chosen to defeat that
/// (many sharing a prefix) fall back to fixed-size chunks in key order, so the
/// function always returns and no chunk exceeds `chunk_size`.
pub fn build_message_author_subscription_filters(
    authors: impl IntoIterator<Item = PublicKey>,
    chunk_size: usize,
    max_authors: usize,
) -> MessageAuthorSubscriptionPlan {
    let chunk_size = chunk_size.max(1);
    let mut seen = HashSet::new();
    let mut kept: Vec<PublicKey> = authors
        .into_iter()
        .filter(|author| seen.insert(*author))
        .collect();
    let dropped = kept.split_off(kept.len().min(max_authors));

    let chunks = keyed_chunks(&kept, chunk_size).unwrap_or_else(|| {
        kept.sort();
        kept.chunks(chunk_size).map(<[PublicKey]>::to_vec).collect()
    });
    let filters = chunks
        .into_iter()
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            Filter::new()
                .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
                .authors(chunk)
        })
        .collect();
    MessageAuthorSubscriptionPlan { filters, dropped }
}

fn keyed_chunks(authors: &[PublicKey], chunk_size: usize) -> Option<Vec<Vec<PublicKey>>> {
    // Aim for chunks four fifths full so uneven key distribution rarely needs another.
    let first = if authors.len() <= chunk_size {
        1
    } else {
        (authors.len() * 5).div_ceil(chunk_size * 4)
    };
    (first..first + KEYED_LAYOUT_ATTEMPTS).find_map(|count| {
        let mut chunks = vec![Vec::new(); count];
        for author in authors {
            let bytes = author.to_bytes();
            let selector = u64::from_be_bytes(bytes[..8].try_into().expect("eight bytes"));
            chunks[(selector % count as u64) as usize].push(*author);
        }
        chunks
            .iter()
            .all(|chunk| chunk.len() <= chunk_size)
            .then_some(chunks)
    })
}

/// Message authors of these sessions, most important first: the live ratchet
/// keys of every session in the order given, then keys that only still have
/// missed messages from older ratchet periods. Pass active sessions before
/// inactive ones; subscriptions that hit a relay limit drop from the end.
pub fn prioritized_message_authors<'a>(
    sessions: impl IntoIterator<Item = &'a SessionState>,
) -> Vec<PublicKey> {
    let sessions: Vec<&SessionState> = sessions
        .into_iter()
        .filter(|session| session.metadata_privacy_version == METADATA_PRIVACY_VERSION)
        .collect();
    let mut seen = HashSet::new();
    let mut ranked = Vec::new();
    let mut push = |author: DevicePubkey| {
        if let Ok(author) = author.to_nostr() {
            if seen.insert(author) {
                ranked.push(author);
            }
        }
    };
    for session in &sessions {
        session.their_current_nostr_public_key.map(&mut push);
        session.their_next_nostr_public_key.map(&mut push);
    }
    for session in &sessions {
        session.skipped_keys.keys().copied().for_each(&mut push);
    }
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn author(index: usize) -> PublicKey {
        // Not every 32-byte string is a valid key; the TypeScript suite uses the same inputs.
        let digest: [u8; 32] = Sha256::digest(format!("author-{index}")).into();
        PublicKey::from_slice(&digest).expect("vector author must be a valid x-only key")
    }

    fn authors(count: usize) -> Vec<PublicKey> {
        (0..count).map(author).collect()
    }

    fn chunk_authors(plan: &MessageAuthorSubscriptionPlan) -> Vec<Vec<String>> {
        plan.filters
            .iter()
            .map(|filter| {
                filter
                    .authors
                    .iter()
                    .flatten()
                    .map(PublicKey::to_hex)
                    .collect()
            })
            .collect()
    }

    fn layout_digest(plan: &MessageAuthorSubscriptionPlan) -> String {
        hex::encode(Sha256::digest(
            serde_json::to_string(&chunk_authors(plan)).unwrap(),
        ))
    }

    fn default_plan(authors: Vec<PublicKey>) -> MessageAuthorSubscriptionPlan {
        build_message_author_subscription_filters(
            authors,
            MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
            MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
        )
    }

    #[test]
    fn small_sets_stay_in_one_filter_and_large_sets_split_without_loss() {
        let small = default_plan(authors(5));
        assert_eq!(small.filters.len(), 1);
        assert!(small.dropped.is_empty());
        assert!(default_plan(Vec::new()).filters.is_empty());

        let all = authors(2_500);
        let chunks = chunk_authors(&default_plan(all.clone()));
        assert!(chunks.len() > 2);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= MESSAGE_AUTHOR_FILTER_CHUNK_SIZE));
        let mut subscribed: Vec<String> = chunks.concat();
        subscribed.sort();
        let mut expected: Vec<String> = all.iter().map(PublicKey::to_hex).collect();
        expected.sort();
        assert_eq!(subscribed, expected);

        // One more author replaces one subscription, not all of them.
        let grown = chunk_authors(&default_plan(authors(2_501)));
        assert_eq!(grown.len(), chunks.len());
        assert_eq!(
            grown.iter().filter(|chunk| !chunks.contains(chunk)).count(),
            1
        );
    }

    #[test]
    fn limit_drops_the_tail_and_layout_matches_typescript() {
        let all = authors(13);
        let plan = build_message_author_subscription_filters(all.clone(), 4, 10);
        assert_eq!(plan.dropped, all[10..].to_vec());
        let chunks = chunk_authors(&plan);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 4));
        assert_eq!(chunks.concat().len(), 10);
        assert_eq!(
            layout_digest(&plan),
            "0cad60712eeb59d4a141dc7ae83491e0f422f4bad79b181b2c39381a2dc6f565"
        );
    }

    /// Keys that cannot be spread by their prefix must not hang the caller
    /// or produce an oversized filter.
    #[test]
    fn layout_that_keys_cannot_spread_falls_back_to_ordered_chunks() {
        let all = authors(300);
        let plan = build_message_author_subscription_filters(all.clone(), 1, 1_000);
        let chunks = chunk_authors(&plan);
        assert_eq!(chunks.len(), 300);
        assert!(chunks.iter().all(|chunk| chunk.len() == 1));
        let mut sorted = chunks.concat();
        sorted.sort();
        assert_eq!(chunks.concat(), sorted);
        assert_eq!(
            layout_digest(&build_message_author_subscription_filters(
                authors(40),
                1,
                1_000
            )),
            "fa8be9cabff1ef9e7c5c898a02e878c62fac20c384790679fc2840d1b4e028fe"
        );
    }

    #[test]
    fn live_ratchet_keys_rank_above_keys_with_only_missed_messages() {
        use crate::{SerializableKeyPair, SkippedKeysEntry};
        let device = |index: usize| DevicePubkey::from_bytes(author(index).to_bytes());
        let session = |current: usize, next: usize, skipped: &[usize]| SessionState {
            metadata_privacy_version: METADATA_PRIVACY_VERSION,
            root_key: [0; 32],
            their_current_nostr_public_key: Some(device(current)),
            their_next_nostr_public_key: Some(device(next)),
            our_previous_nostr_key: None,
            our_current_nostr_key: None,
            our_next_nostr_key: SerializableKeyPair {
                public_key: device(0),
                private_key: [1; 32],
            },
            receiving_chain_key: None,
            sending_chain_key: None,
            sending_chain_message_number: 0,
            receiving_chain_message_number: 0,
            previous_sending_chain_message_count: 0,
            skipped_keys: skipped
                .iter()
                .map(|index| (device(*index), SkippedKeysEntry::default()))
                .collect(),
        };
        let first = session(1, 2, &[7, 1]);
        let second = session(3, 4, &[8]);
        let mut old = session(5, 6, &[]);
        old.metadata_privacy_version = 0;
        let ranked = prioritized_message_authors([&first, &second, &old]);
        assert_eq!(ranked[..4], [author(1), author(2), author(3), author(4)]);
        let mut tail = ranked[4..].to_vec();
        tail.sort();
        let mut expected_tail = vec![author(7), author(8)];
        expected_tail.sort();
        assert_eq!(tail, expected_tail);
    }
}
