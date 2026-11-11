use crate::{
    utils::pubkey_from_hex, APP_KEYS_EVENT_KIND, INVITE_EVENT_KIND, INVITE_LIST_LABEL,
    INVITE_RESPONSE_KIND, MESSAGE_EVENT_KIND,
};
use nostr::{Alphabet, Filter, Kind, PublicKey, SingleLetterTag};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const DIRECT_MESSAGE_RUNTIME_SUBSCRIPTION_ID: &str = "ndr-runtime-messages";
const DIRECT_MESSAGE_RUNTIME_SUBSCRIPTION_PREFIX: &str = "ndr-runtime-messages-";
const DIRECT_MESSAGE_PROTOCOL_SUBSCRIPTION_ID: &str = "icp-messages";
const DIRECT_MESSAGE_PROTOCOL_SUBSCRIPTION_PREFIX: &str = "icp-messages-";
const SESSION_CURRENT_SUBSCRIPTION_PREFIX: &str = "session-current-";
const SESSION_NEXT_SUBSCRIPTION_PREFIX: &str = "session-next-";
const INVITE_RESPONSE_SUBSCRIPTION_PREFIX: &str = "invite-responses-";

#[derive(Debug, Default, Clone)]
pub struct DirectMessageSubscriptionTracker {
    authors_by_subid: HashMap<String, Vec<PublicKey>>,
    author_ref_counts: HashMap<PublicKey, usize>,
}

impl DirectMessageSubscriptionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_subscription(
        &mut self,
        subid: impl AsRef<str>,
        filter_json: impl AsRef<str>,
    ) -> Vec<PublicKey> {
        let subid = subid.as_ref().trim();
        if subid.is_empty() {
            return Vec::new();
        }

        self.unregister_subscription(subid);

        let authors = direct_message_subscription_authors(subid, filter_json.as_ref());
        if authors.is_empty() {
            return Vec::new();
        }

        let mut added = Vec::new();
        for author in &authors {
            let ref_count = self.author_ref_counts.entry(*author).or_insert(0);
            if *ref_count == 0 {
                added.push(*author);
            }
            *ref_count += 1;
        }
        self.authors_by_subid.insert(subid.to_string(), authors);
        added.sort_by_key(|pubkey| pubkey.to_hex());
        added
    }

    pub fn unregister_subscription(&mut self, subid: impl AsRef<str>) {
        let subid = subid.as_ref().trim();
        if subid.is_empty() {
            return;
        }

        let Some(previous_authors) = self.authors_by_subid.remove(subid) else {
            return;
        };

        for author in previous_authors {
            let next_count = self
                .author_ref_counts
                .get(&author)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if next_count == 0 {
                self.author_ref_counts.remove(&author);
            } else {
                self.author_ref_counts.insert(author, next_count);
            }
        }
    }

    pub fn tracked_authors(&self) -> Vec<PublicKey> {
        let mut authors: Vec<PublicKey> = self.author_ref_counts.keys().copied().collect();
        authors.sort_by_key(|pubkey| pubkey.to_hex());
        authors
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RuntimeSubscriptionRegistration {
    pub added_app_keys_authors: Vec<PublicKey>,
    pub added_message_authors: Vec<PublicKey>,
    pub added_message_recipients: Vec<PublicKey>,
    pub added_invite_response_recipients: Vec<PublicKey>,
}

#[derive(Debug, Default, Clone)]
pub struct RuntimeSubscriptionTracker {
    app_keys_authors_by_subid: HashMap<String, Vec<PublicKey>>,
    app_keys_author_ref_counts: HashMap<PublicKey, usize>,
    message_authors_by_subid: HashMap<String, Vec<PublicKey>>,
    message_author_ref_counts: HashMap<PublicKey, usize>,
    message_recipients_by_subid: HashMap<String, Vec<PublicKey>>,
    message_recipient_ref_counts: HashMap<PublicKey, usize>,
    invite_response_recipients_by_subid: HashMap<String, Vec<PublicKey>>,
    invite_response_recipient_ref_counts: HashMap<PublicKey, usize>,
}

impl RuntimeSubscriptionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_subscription(
        &mut self,
        subid: impl AsRef<str>,
        filter_json: impl AsRef<str>,
    ) -> RuntimeSubscriptionRegistration {
        let subid = subid.as_ref().trim();
        if subid.is_empty() {
            return RuntimeSubscriptionRegistration::default();
        }

        self.unregister_subscription(subid);

        let added_app_keys_authors = register_pubkeys(
            &mut self.app_keys_authors_by_subid,
            &mut self.app_keys_author_ref_counts,
            subid,
            app_keys_subscription_authors(subid, filter_json.as_ref()),
        );
        let added_message_authors = register_pubkeys(
            &mut self.message_authors_by_subid,
            &mut self.message_author_ref_counts,
            subid,
            direct_message_subscription_authors(subid, filter_json.as_ref()),
        );
        let added_message_recipients = register_pubkeys(
            &mut self.message_recipients_by_subid,
            &mut self.message_recipient_ref_counts,
            subid,
            direct_message_subscription_recipients(subid, filter_json.as_ref()),
        );
        let added_invite_response_recipients = register_pubkeys(
            &mut self.invite_response_recipients_by_subid,
            &mut self.invite_response_recipient_ref_counts,
            subid,
            invite_response_subscription_recipients(subid, filter_json.as_ref()),
        );

        RuntimeSubscriptionRegistration {
            added_app_keys_authors,
            added_message_authors,
            added_message_recipients,
            added_invite_response_recipients,
        }
    }

    pub fn unregister_subscription(&mut self, subid: impl AsRef<str>) {
        let subid = subid.as_ref().trim();
        if subid.is_empty() {
            return;
        }

        unregister_pubkeys(
            &mut self.app_keys_authors_by_subid,
            &mut self.app_keys_author_ref_counts,
            subid,
        );
        unregister_pubkeys(
            &mut self.message_authors_by_subid,
            &mut self.message_author_ref_counts,
            subid,
        );
        unregister_pubkeys(
            &mut self.message_recipients_by_subid,
            &mut self.message_recipient_ref_counts,
            subid,
        );
        unregister_pubkeys(
            &mut self.invite_response_recipients_by_subid,
            &mut self.invite_response_recipient_ref_counts,
            subid,
        );
    }

    pub fn tracked_app_keys_authors(&self) -> Vec<PublicKey> {
        sorted_pubkeys(&self.app_keys_author_ref_counts)
    }

    pub fn tracked_message_authors(&self) -> Vec<PublicKey> {
        sorted_pubkeys(&self.message_author_ref_counts)
    }

    pub fn tracked_message_recipients(&self) -> Vec<PublicKey> {
        sorted_pubkeys(&self.message_recipient_ref_counts)
    }

    pub fn tracked_invite_response_recipients(&self) -> Vec<PublicKey> {
        sorted_pubkeys(&self.invite_response_recipient_ref_counts)
    }
}

pub fn build_direct_message_backfill_filter(
    authors: impl IntoIterator<Item = PublicKey>,
    limit: usize,
) -> Filter {
    let mut unique_authors = Vec::new();
    let mut seen_authors = HashSet::new();
    for author in authors {
        if seen_authors.insert(author) {
            unique_authors.push(author);
        }
    }

    Filter::new()
        .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
        .authors(unique_authors)
        .limit(limit)
}

/// Sized for the tightest relays in common use: 131,072-byte frames (about
/// 1,950 hex authors per REQ), 2,047 items per filter, 20 subscriptions per
/// connection. One chunk per subscription stays well inside all three.
pub const MESSAGE_AUTHOR_FILTER_CHUNK_SIZE: usize = 1_000;
pub const MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT: usize = 12_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageAuthorSubscriptionPlan {
    /// One live subscription each. A small author set stays in a single filter.
    pub filters: Vec<Filter>,
    /// Authors left out because the limit was reached, least important last.
    pub dropped: Vec<PublicKey>,
}

/// Split message authors, most important first, into filters every relay
/// accepts. Past `max_authors` the tail is dropped. An author always lands in
/// the chunk its key selects, so one ratchet step replaces one subscription,
/// not all of them.
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
    if kept.is_empty() {
        return MessageAuthorSubscriptionPlan {
            filters: Vec::new(),
            dropped,
        };
    }

    // Aim for chunks four fifths full so uneven key distribution rarely needs another.
    let mut count = if kept.len() <= chunk_size {
        1
    } else {
        (kept.len() * 5).div_ceil(chunk_size * 4)
    };
    loop {
        let mut chunks = vec![Vec::new(); count];
        for author in &kept {
            let bytes = author.to_bytes();
            let selector = usize::from(u16::from_be_bytes([bytes[0], bytes[1]]));
            chunks[selector % count].push(*author);
        }
        if chunks.iter().all(|chunk| chunk.len() <= chunk_size) {
            let filters = chunks
                .into_iter()
                .filter(|chunk| !chunk.is_empty())
                .map(|chunk| {
                    Filter::new()
                        .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
                        .authors(chunk)
                })
                .collect();
            return MessageAuthorSubscriptionPlan { filters, dropped };
        }
        count += 1;
    }
}

/// Message authors of these sessions, most important first: the live ratchet
/// keys of every session in the order given, then keys that only still have
/// missed messages from older ratchet periods. Pass active sessions before
/// inactive ones; subscriptions that hit a relay limit drop from the end.
pub fn prioritized_message_authors<'a>(
    sessions: impl IntoIterator<Item = &'a crate::SessionState>,
) -> Vec<PublicKey> {
    let sessions: Vec<&crate::SessionState> = sessions
        .into_iter()
        .filter(|session| session.metadata_privacy_version == crate::METADATA_PRIVACY_VERSION)
        .collect();
    let mut seen = HashSet::new();
    let mut ranked = Vec::new();
    let mut push = |author: crate::DevicePubkey| {
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

pub fn build_direct_message_recipient_backfill_filter(
    recipients: impl IntoIterator<Item = PublicKey>,
    limit: usize,
) -> Filter {
    let mut unique_recipients = Vec::new();
    let mut seen_recipients = HashSet::new();
    for recipient in recipients {
        if seen_recipients.insert(recipient) {
            unique_recipients.push(recipient.to_hex());
        }
    }

    Filter::new()
        .kind(Kind::from(MESSAGE_EVENT_KIND as u16))
        .custom_tags(SingleLetterTag::lowercase(Alphabet::P), unique_recipients)
        .limit(limit)
}

pub fn build_app_keys_backfill_filter(
    authors: impl IntoIterator<Item = PublicKey>,
    limit: usize,
) -> Filter {
    let mut unique_authors = Vec::new();
    let mut seen_authors = HashSet::new();
    for author in authors {
        if seen_authors.insert(author) {
            unique_authors.push(author);
        }
    }

    Filter::new()
        .kind(Kind::from(APP_KEYS_EVENT_KIND as u16))
        .authors(unique_authors)
        .limit(limit)
}

pub fn build_invite_backfill_filter(
    authors: impl IntoIterator<Item = PublicKey>,
    limit: usize,
) -> Filter {
    let mut unique_authors = Vec::new();
    let mut seen_authors = HashSet::new();
    for author in authors {
        if seen_authors.insert(author) {
            unique_authors.push(author);
        }
    }

    Filter::new()
        .kind(Kind::from(INVITE_EVENT_KIND as u16))
        .authors(unique_authors)
        .custom_tag(SingleLetterTag::lowercase(Alphabet::L), INVITE_LIST_LABEL)
        .limit(limit)
}

pub fn build_invite_response_backfill_filter(
    recipients: impl IntoIterator<Item = PublicKey>,
    limit: usize,
) -> Filter {
    let mut unique_recipients = Vec::new();
    let mut seen_recipients = HashSet::new();
    for recipient in recipients {
        if seen_recipients.insert(recipient) {
            unique_recipients.push(recipient.to_hex());
        }
    }

    Filter::new()
        .kind(Kind::from(INVITE_RESPONSE_KIND as u16))
        .custom_tags(SingleLetterTag::lowercase(Alphabet::P), unique_recipients)
        .limit(limit)
}

pub fn build_runtime_backfill_filters(
    registration: &RuntimeSubscriptionRegistration,
    limit: usize,
) -> Vec<Filter> {
    let mut filters = Vec::new();
    if !registration.added_app_keys_authors.is_empty() {
        filters.push(build_app_keys_backfill_filter(
            registration.added_app_keys_authors.iter().copied(),
            limit,
        ));
    }
    if !registration.added_message_authors.is_empty() {
        filters.push(build_direct_message_backfill_filter(
            registration.added_message_authors.iter().copied(),
            limit,
        ));
    }
    if !registration.added_message_recipients.is_empty() {
        filters.push(build_direct_message_recipient_backfill_filter(
            registration.added_message_recipients.iter().copied(),
            limit,
        ));
    }
    if !registration.added_invite_response_recipients.is_empty() {
        filters.push(build_invite_response_backfill_filter(
            registration
                .added_invite_response_recipients
                .iter()
                .copied(),
            limit,
        ));
    }
    filters
}

pub fn build_protocol_discovery_filters(
    app_keys_authors: impl IntoIterator<Item = PublicKey>,
    invite_authors: impl IntoIterator<Item = PublicKey>,
    limit: usize,
) -> Vec<Filter> {
    let app_keys_authors = app_keys_authors.into_iter().collect::<Vec<_>>();
    let invite_authors = invite_authors.into_iter().collect::<Vec<_>>();
    let mut filters = Vec::new();
    if !app_keys_authors.is_empty() {
        filters.push(build_app_keys_backfill_filter(app_keys_authors, limit));
    }
    if !invite_authors.is_empty() {
        filters.push(build_invite_backfill_filter(invite_authors, limit));
    }
    filters
}

pub fn app_keys_subscription_authors(
    subid: impl AsRef<str>,
    filter_json: impl AsRef<str>,
) -> Vec<PublicKey> {
    let subid = subid.as_ref().trim();
    if subid.is_empty() {
        return Vec::new();
    }

    let Ok(decoded) = serde_json::from_str::<Value>(filter_json.as_ref()) else {
        return Vec::new();
    };
    let Some(decoded_filter) = decoded.as_object() else {
        return Vec::new();
    };

    if !has_kind(decoded_filter, APP_KEYS_EVENT_KIND) {
        return Vec::new();
    }

    parse_pubkey_values(decoded_filter.get("authors"))
}

pub fn direct_message_subscription_authors(
    subid: impl AsRef<str>,
    filter_json: impl AsRef<str>,
) -> Vec<PublicKey> {
    let subid = subid.as_ref().trim();
    if !is_direct_message_subscription_id(subid) {
        return Vec::new();
    }

    let Ok(decoded) = serde_json::from_str::<Value>(filter_json.as_ref()) else {
        return Vec::new();
    };
    let Some(decoded_filter) = decoded.as_object() else {
        return Vec::new();
    };

    if !has_kind(decoded_filter, MESSAGE_EVENT_KIND) {
        return Vec::new();
    }

    parse_pubkey_values(decoded_filter.get("authors"))
}

pub fn direct_message_subscription_recipients(
    subid: impl AsRef<str>,
    filter_json: impl AsRef<str>,
) -> Vec<PublicKey> {
    let subid = subid.as_ref().trim();
    if !is_direct_message_subscription_id(subid) {
        return Vec::new();
    }

    let Ok(decoded) = serde_json::from_str::<Value>(filter_json.as_ref()) else {
        return Vec::new();
    };
    let Some(decoded_filter) = decoded.as_object() else {
        return Vec::new();
    };

    if !has_kind(decoded_filter, MESSAGE_EVENT_KIND) {
        return Vec::new();
    }

    parse_pubkey_values(decoded_filter.get("#p"))
}

pub fn invite_response_subscription_recipients(
    subid: impl AsRef<str>,
    filter_json: impl AsRef<str>,
) -> Vec<PublicKey> {
    let subid = subid.as_ref().trim();
    if !is_invite_response_subscription_id(subid) {
        return Vec::new();
    }

    let Ok(decoded) = serde_json::from_str::<Value>(filter_json.as_ref()) else {
        return Vec::new();
    };
    let Some(decoded_filter) = decoded.as_object() else {
        return Vec::new();
    };

    if !has_kind(decoded_filter, INVITE_RESPONSE_KIND) {
        return Vec::new();
    }

    parse_pubkey_values(decoded_filter.get("#p"))
}

fn has_kind(decoded_filter: &serde_json::Map<String, Value>, kind: u32) -> bool {
    decoded_filter
        .get("kinds")
        .and_then(Value::as_array)
        .map(|kinds| {
            kinds
                .iter()
                .any(|value| value.as_u64() == Some(kind as u64))
        })
        .unwrap_or(false)
}

fn parse_pubkey_values(values: Option<&Value>) -> Vec<PublicKey> {
    let Some(values) = values.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let Some(pubkey_hex) = value.as_str() else {
            continue;
        };
        let normalized = pubkey_hex.trim().to_lowercase();
        if normalized.len() != 64 {
            continue;
        }
        let Ok(pubkey) = pubkey_from_hex(&normalized) else {
            continue;
        };
        if seen.insert(pubkey) {
            parsed.push(pubkey);
        }
    }
    parsed
}

fn register_pubkeys(
    pubkeys_by_subid: &mut HashMap<String, Vec<PublicKey>>,
    pubkey_ref_counts: &mut HashMap<PublicKey, usize>,
    subid: &str,
    pubkeys: Vec<PublicKey>,
) -> Vec<PublicKey> {
    if pubkeys.is_empty() {
        return Vec::new();
    }

    let mut added = Vec::new();
    for pubkey in &pubkeys {
        let ref_count = pubkey_ref_counts.entry(*pubkey).or_insert(0);
        if *ref_count == 0 {
            added.push(*pubkey);
        }
        *ref_count += 1;
    }
    pubkeys_by_subid.insert(subid.to_string(), pubkeys);
    added.sort_by_key(|pubkey| pubkey.to_hex());
    added
}

fn unregister_pubkeys(
    pubkeys_by_subid: &mut HashMap<String, Vec<PublicKey>>,
    pubkey_ref_counts: &mut HashMap<PublicKey, usize>,
    subid: &str,
) {
    let Some(previous_pubkeys) = pubkeys_by_subid.remove(subid) else {
        return;
    };

    for pubkey in previous_pubkeys {
        let next_count = pubkey_ref_counts
            .get(&pubkey)
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if next_count == 0 {
            pubkey_ref_counts.remove(&pubkey);
        } else {
            pubkey_ref_counts.insert(pubkey, next_count);
        }
    }
}

fn sorted_pubkeys(pubkey_ref_counts: &HashMap<PublicKey, usize>) -> Vec<PublicKey> {
    let mut pubkeys: Vec<PublicKey> = pubkey_ref_counts.keys().copied().collect();
    pubkeys.sort_by_key(|pubkey| pubkey.to_hex());
    pubkeys
}

fn is_direct_message_subscription_id(subid: &str) -> bool {
    !subid.is_empty()
        && (subid == DIRECT_MESSAGE_RUNTIME_SUBSCRIPTION_ID
            || subid.starts_with(DIRECT_MESSAGE_RUNTIME_SUBSCRIPTION_PREFIX)
            || subid == DIRECT_MESSAGE_PROTOCOL_SUBSCRIPTION_ID
            || subid.starts_with(DIRECT_MESSAGE_PROTOCOL_SUBSCRIPTION_PREFIX)
            || subid.starts_with(SESSION_CURRENT_SUBSCRIPTION_PREFIX)
            || subid.starts_with(SESSION_NEXT_SUBSCRIPTION_PREFIX))
}

fn is_invite_response_subscription_id(subid: &str) -> bool {
    !subid.is_empty() && subid.starts_with(INVITE_RESPONSE_SUBSCRIPTION_PREFIX)
}

#[cfg(test)]
mod tests {
    mod message_author_filters {
        use super::super::*;
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

        #[test]
        fn small_sets_stay_in_one_filter_and_large_sets_split_without_loss() {
            let small = build_message_author_subscription_filters(
                authors(5),
                MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
                MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
            );
            assert_eq!(small.filters.len(), 1);
            assert!(small.dropped.is_empty());

            let all = authors(2_500);
            let plan = build_message_author_subscription_filters(
                all.clone(),
                MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
                MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
            );
            assert!(plan.filters.len() > 2);
            let chunks = chunk_authors(&plan);
            assert!(chunks
                .iter()
                .all(|chunk| chunk.len() <= MESSAGE_AUTHOR_FILTER_CHUNK_SIZE));
            let mut subscribed: Vec<String> = chunks.concat();
            subscribed.sort();
            let mut expected: Vec<String> = all.iter().map(PublicKey::to_hex).collect();
            expected.sort();
            assert_eq!(subscribed, expected);

            // One more author replaces one subscription, not all of them.
            let grown = chunk_authors(&build_message_author_subscription_filters(
                authors(2_501),
                MESSAGE_AUTHOR_FILTER_CHUNK_SIZE,
                MESSAGE_AUTHOR_SUBSCRIPTION_LIMIT,
            ));
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
            let layout = serde_json::to_string(&chunks).unwrap();
            assert_eq!(
                hex::encode(Sha256::digest(layout)),
                "790c1c4646399fbc11069a6e30c318509935f0a06af4796acf07af94703b8e21"
            );
        }

        #[test]
        fn live_ratchet_keys_rank_above_keys_with_only_missed_messages() {
            use crate::{DevicePubkey, SerializableKeyPair, SessionState, SkippedKeysEntry};
            let device = |index: usize| DevicePubkey::from_bytes(author(index).to_bytes());
            let session = |current: usize, next: usize, skipped: &[usize]| SessionState {
                metadata_privacy_version: crate::METADATA_PRIVACY_VERSION,
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
            let expected_tail: std::collections::BTreeSet<_> = [author(7), author(8)].into();
            assert_eq!(ranked[..4], [author(1), author(2), author(3), author(4)]);
            assert_eq!(
                ranked[4..]
                    .iter()
                    .copied()
                    .collect::<std::collections::BTreeSet<_>>(),
                expected_tail
            );
        }
    }

    use super::*;

    fn pubkey(hex: &str) -> PublicKey {
        PublicKey::parse(hex).unwrap()
    }

    #[test]
    fn parses_app_keys_subscription_authors() {
        let authors = app_keys_subscription_authors(
            "ndr-protocol",
            r##"{
                "kinds":[37368],
                "authors":[
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "nope"
                ]
            }"##,
        );

        assert_eq!(
            authors,
            vec![
                pubkey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                pubkey("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            ]
        );
        assert!(app_keys_subscription_authors(
            "ndr-protocol",
            r##"{"kinds":[9999],"authors":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"##,
        )
        .is_empty());
        assert!(app_keys_subscription_authors(
            "",
            r##"{"kinds":[37368],"authors":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"##,
        )
        .is_empty());
    }

    #[test]
    fn parses_invite_response_subscription_recipients() {
        let recipients = invite_response_subscription_recipients(
            "invite-responses-a",
            r##"{
                "kinds":[1059],
                "#p":[
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "nope"
                ]
            }"##,
        );

        assert_eq!(
            recipients,
            vec![
                pubkey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                pubkey("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            ]
        );
        assert!(invite_response_subscription_recipients(
            "ndr-runtime-messages",
            r##"{"kinds":[1059],"#p":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"##,
        )
        .is_empty());
    }

    #[test]
    fn parses_direct_message_subscription_recipients() {
        let recipients = direct_message_subscription_recipients(
            "ndr-runtime-messages",
            r##"{
                "kinds":[1060],
                "#p":[
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "nope"
                ]
            }"##,
        );

        assert_eq!(
            recipients,
            vec![
                pubkey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                pubkey("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            ]
        );
        assert!(direct_message_subscription_recipients(
            "invite-responses-a",
            r##"{"kinds":[1060],"#p":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"##,
        )
        .is_empty());
    }

    #[test]
    fn tracks_runtime_message_authors_and_invite_response_recipients() {
        let mut tracker = RuntimeSubscriptionTracker::new();

        let first = tracker.register_subscription(
            "ndr-protocol",
            r#"{"kinds":[37368],"authors":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"#,
        );
        assert_eq!(
            first.added_app_keys_authors,
            vec![pubkey(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )]
        );
        assert!(first.added_message_authors.is_empty());
        assert!(first.added_message_recipients.is_empty());
        assert!(first.added_invite_response_recipients.is_empty());

        let second = tracker.register_subscription(
            "ndr-runtime-messages",
            r##"{
                "kinds":[1060],
                "authors":["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
                "#p":["dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]
            }"##,
        );
        assert!(second.added_app_keys_authors.is_empty());
        assert_eq!(
            second.added_message_authors,
            vec![pubkey(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            )]
        );
        assert_eq!(
            second.added_message_recipients,
            vec![pubkey(
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            )]
        );
        assert!(second.added_invite_response_recipients.is_empty());

        let third = tracker.register_subscription(
            "invite-responses-b",
            r##"{"kinds":[1059],"#p":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]}"##,
        );
        assert!(third.added_app_keys_authors.is_empty());
        assert!(third.added_message_authors.is_empty());
        assert_eq!(
            third.added_invite_response_recipients,
            vec![pubkey(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )]
        );
        assert_eq!(
            tracker.tracked_app_keys_authors(),
            vec![pubkey(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )]
        );
        assert_eq!(
            tracker.tracked_message_authors(),
            vec![pubkey(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            )]
        );
        assert_eq!(
            tracker.tracked_message_recipients(),
            vec![pubkey(
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            )]
        );
        assert_eq!(
            tracker.tracked_invite_response_recipients(),
            vec![pubkey(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )]
        );

        let fourth = tracker.register_subscription(
            "invite-responses-c",
            r##"{"kinds":[1059],"#p":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]}"##,
        );
        assert!(fourth.added_invite_response_recipients.is_empty());

        tracker.unregister_subscription("invite-responses-b");
        assert_eq!(
            tracker.tracked_invite_response_recipients(),
            vec![pubkey(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )]
        );
        tracker.unregister_subscription("invite-responses-c");
        assert!(tracker.tracked_invite_response_recipients().is_empty());
    }

    #[test]
    fn builds_runtime_backfill_filters() {
        let registration = RuntimeSubscriptionRegistration {
            added_app_keys_authors: vec![pubkey(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            )],
            added_message_authors: vec![pubkey(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
            added_message_recipients: vec![pubkey(
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            )],
            added_invite_response_recipients: vec![pubkey(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )],
        };

        let filters = build_runtime_backfill_filters(&registration, 50);
        assert_eq!(filters.len(), 4);
        let app_keys = serde_json::to_value(&filters[0]).unwrap();
        assert_eq!(app_keys["kinds"], serde_json::json!([37368]));
        assert_eq!(
            app_keys["authors"],
            serde_json::json!(["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"])
        );
        assert_eq!(app_keys["limit"], serde_json::json!(50));

        let direct = serde_json::to_value(&filters[1]).unwrap();
        assert_eq!(direct["kinds"], serde_json::json!([1060]));
        assert_eq!(
            direct["authors"],
            serde_json::json!(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
        );
        assert_eq!(direct["limit"], serde_json::json!(50));

        let recipient_direct = serde_json::to_value(&filters[2]).unwrap();
        assert_eq!(recipient_direct["kinds"], serde_json::json!([1060]));
        assert_eq!(
            recipient_direct["#p"],
            serde_json::json!(["dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"])
        );
        assert_eq!(recipient_direct["limit"], serde_json::json!(50));

        let invite_response = serde_json::to_value(&filters[3]).unwrap();
        assert_eq!(invite_response["kinds"], serde_json::json!([1059]));
        assert_eq!(
            invite_response["#p"],
            serde_json::json!(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"])
        );
        assert_eq!(invite_response["limit"], serde_json::json!(50));
    }

    #[test]
    fn builds_invite_backfill_filter() {
        let filter = build_invite_backfill_filter(
            [
                pubkey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                pubkey("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
                pubkey("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            ],
            50,
        );
        let json = serde_json::to_value(filter).unwrap();
        assert_eq!(json["kinds"], serde_json::json!([30078]));
        assert_eq!(
            json["authors"],
            serde_json::json!([
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ])
        );
        assert_eq!(json["#l"], serde_json::json!(["double-ratchet/invites"]));
        assert_eq!(json["limit"], serde_json::json!(50));
    }

    #[test]
    fn builds_protocol_discovery_filters() {
        let filters = build_protocol_discovery_filters(
            [pubkey(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            )],
            [pubkey(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )],
            50,
        );

        assert_eq!(filters.len(), 2);
        let app_keys = serde_json::to_value(&filters[0]).unwrap();
        assert_eq!(app_keys["kinds"], serde_json::json!([37368]));
        assert_eq!(
            app_keys["authors"],
            serde_json::json!(["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"])
        );
        assert_eq!(app_keys["limit"], serde_json::json!(50));

        let invite = serde_json::to_value(&filters[1]).unwrap();
        assert_eq!(invite["kinds"], serde_json::json!([30078]));
        assert_eq!(
            invite["authors"],
            serde_json::json!(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
        );
        assert_eq!(invite["#l"], serde_json::json!(["double-ratchet/invites"]));
        assert_eq!(invite["limit"], serde_json::json!(50));
    }
}
