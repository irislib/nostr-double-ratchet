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
