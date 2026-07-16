use crate::{is_app_keys_event, AppKeys, DeviceEntry};
use nostr::{Event, PublicKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppKeysSnapshotDecision {
    Advanced,
    Stale,
    MergedStale,
    MergedEqualTimestamp,
}

#[derive(Debug, Clone)]
pub struct AppKeysSnapshot {
    pub decision: AppKeysSnapshotDecision,
    pub app_keys: AppKeys,
    pub created_at: u64,
}

pub fn apply_app_keys_snapshot(
    current_app_keys: Option<&AppKeys>,
    current_created_at: u64,
    incoming_app_keys: &AppKeys,
    incoming_created_at: u64,
) -> AppKeysSnapshot {
    if current_app_keys.is_none() || incoming_created_at > current_created_at {
        return AppKeysSnapshot {
            decision: AppKeysSnapshotDecision::Advanced,
            app_keys: incoming_app_keys.clone(),
            created_at: incoming_created_at,
        };
    }

    let current_app_keys = current_app_keys.expect("checked above");
    if incoming_created_at < current_created_at {
        return AppKeysSnapshot {
            decision: AppKeysSnapshotDecision::Stale,
            app_keys: current_app_keys.clone(),
            created_at: current_created_at,
        };
    }

    AppKeysSnapshot {
        decision: AppKeysSnapshotDecision::MergedEqualTimestamp,
        app_keys: current_app_keys.merge(incoming_app_keys),
        created_at: current_created_at,
    }
}

pub fn apply_app_keys_snapshot_with_required_device(
    current_app_keys: Option<&AppKeys>,
    current_created_at: u64,
    incoming_app_keys: &AppKeys,
    incoming_created_at: u64,
    required_device: Option<DeviceEntry>,
) -> AppKeysSnapshot {
    let Some(required_device) = required_device else {
        return apply_app_keys_snapshot(
            current_app_keys,
            current_created_at,
            incoming_app_keys,
            incoming_created_at,
        );
    };

    let mut incoming_with_required = incoming_app_keys.clone();
    incoming_with_required.add_device(required_device.clone());
    let mut applied = apply_app_keys_snapshot(
        current_app_keys,
        current_created_at,
        &incoming_with_required,
        incoming_created_at,
    );

    if applied
        .app_keys
        .get_device(&required_device.identity_pubkey)
        .is_none()
    {
        applied.app_keys.add_device(required_device.clone());
        applied.created_at = applied.created_at.max(required_device.created_at);
    }

    applied
}

pub fn select_latest_app_keys_from_events<'a, I>(events: I) -> Option<AppKeysSnapshot>
where
    I: IntoIterator<Item = &'a Event>,
{
    let mut latest: Option<AppKeysSnapshot> = None;

    for event in events {
        if !is_app_keys_event(event) {
            continue;
        }

        let Ok(app_keys) = AppKeys::from_event(event) else {
            continue;
        };

        latest = Some(match latest.as_ref() {
            Some(current) => apply_app_keys_snapshot(
                Some(&current.app_keys),
                current.created_at,
                &app_keys,
                event.created_at.as_secs(),
            ),
            None => AppKeysSnapshot {
                decision: AppKeysSnapshotDecision::Advanced,
                app_keys,
                created_at: event.created_at.as_secs(),
            },
        });
    }

    latest
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRegistrationState {
    pub is_current_device_registered: bool,
    pub has_known_registered_devices: bool,
    pub no_previous_devices_found: bool,
    pub requires_device_registration: bool,
    pub can_send_private_messages: bool,
}

pub fn evaluate_device_registration_state(
    current_device_pubkey_hex: Option<&str>,
    registered_device_pubkeys: &[String],
    has_local_app_keys: bool,
    app_keys_manager_ready: bool,
    session_manager_ready: bool,
) -> DeviceRegistrationState {
    let normalized_current = current_device_pubkey_hex
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|value| !value.is_empty());

    let is_current_device_registered = normalized_current.as_ref().is_some_and(|current| {
        registered_device_pubkeys
            .iter()
            .any(|device| device.trim().eq_ignore_ascii_case(current))
    });
    let has_known_registered_devices = !registered_device_pubkeys.is_empty();

    DeviceRegistrationState {
        is_current_device_registered,
        has_known_registered_devices,
        no_previous_devices_found: !has_known_registered_devices,
        requires_device_registration: normalized_current.is_some() && !is_current_device_registered,
        can_send_private_messages: app_keys_manager_ready
            && session_manager_ready
            && (has_local_app_keys || is_current_device_registered || has_known_registered_devices),
    }
}

pub fn should_require_relay_registration_confirmation(
    current_device_pubkey_hex: Option<&str>,
    registered_device_pubkeys: &[String],
    has_local_app_keys: bool,
    app_keys_manager_ready: bool,
    session_manager_ready: bool,
) -> bool {
    let state = evaluate_device_registration_state(
        current_device_pubkey_hex,
        registered_device_pubkeys,
        has_local_app_keys,
        app_keys_manager_ready,
        session_manager_ready,
    );
    state.requires_device_registration && state.has_known_registered_devices
}

fn normalize_pubkey_hex(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn first_tag_value(tags: &[Vec<String>], name: &str) -> Option<String> {
    tags.iter()
        .find(|tag| tag.first().is_some_and(|tag_name| tag_name == name) && tag.len() >= 2)
        .and_then(|tag| normalize_pubkey_hex(&tag[1]))
}

pub fn resolve_rumor_peer_pubkey(
    owner_pubkey_hex: &str,
    rumor_pubkey_hex: &str,
    rumor_tags: &[Vec<String>],
    sender_pubkey_hex: Option<&str>,
) -> Option<String> {
    let normalized_owner = normalize_pubkey_hex(owner_pubkey_hex)?;
    let normalized_rumor_pubkey = normalize_pubkey_hex(rumor_pubkey_hex)?;
    let normalized_sender_pubkey = sender_pubkey_hex.and_then(normalize_pubkey_hex);

    if normalized_rumor_pubkey == normalized_owner
        || normalized_sender_pubkey.as_deref() == Some(normalized_owner.as_str())
    {
        return first_tag_value(rumor_tags, "p");
    }

    Some(normalized_rumor_pubkey)
}

pub fn resolve_conversation_candidate_pubkeys(
    owner_pubkey_hex: &str,
    rumor_pubkey_hex: &str,
    rumor_tags: &[Vec<String>],
    sender_pubkey_hex: &str,
) -> Vec<String> {
    let Some(owner) = normalize_pubkey_hex(owner_pubkey_hex) else {
        return Vec::new();
    };
    let Some(sender) = normalize_pubkey_hex(sender_pubkey_hex) else {
        return Vec::new();
    };
    let Some(rumor_author) = normalize_pubkey_hex(rumor_pubkey_hex) else {
        return Vec::new();
    };
    let p_tag_pubkey = first_tag_value(rumor_tags, "p");

    let is_self_targeted_rumor = (rumor_author == owner || sender == owner)
        && match p_tag_pubkey.as_deref() {
            Some(p_tag) => p_tag.is_empty() || p_tag == owner,
            None => true,
        };

    let mut candidates = Vec::new();
    let mut add_candidate = |candidate: Option<String>| {
        let Some(candidate) = candidate else {
            return;
        };
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    };

    if is_self_targeted_rumor {
        if rumor_author != owner {
            add_candidate(Some(rumor_author));
        }
        if sender != owner {
            add_candidate(Some(sender));
        }
        add_candidate(Some(owner));
        return candidates;
    }

    add_candidate(resolve_rumor_peer_pubkey(
        owner.as_str(),
        rumor_pubkey_hex,
        rumor_tags,
        Some(sender.as_str()),
    ));
    add_candidate(Some(sender));
    candidates
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteOwnerRoutingResolution {
    pub owner_pubkey: PublicKey,
    pub claimed_owner_pubkey: PublicKey,
    pub verified_with_app_keys: bool,
    pub used_link_bootstrap_exception: bool,
    pub fell_back_to_device_identity: bool,
}

pub fn resolve_invite_owner_routing(
    device_pubkey: PublicKey,
    claimed_owner_pubkey: PublicKey,
    invite_purpose: Option<&str>,
    current_owner_pubkey: PublicKey,
    app_keys: Option<&AppKeys>,
) -> InviteOwnerRoutingResolution {
    if claimed_owner_pubkey == device_pubkey {
        return InviteOwnerRoutingResolution {
            owner_pubkey: device_pubkey,
            claimed_owner_pubkey,
            verified_with_app_keys: true,
            used_link_bootstrap_exception: false,
            fell_back_to_device_identity: false,
        };
    }

    let verified_with_app_keys = app_keys
        .and_then(|keys| keys.get_device(&device_pubkey))
        .is_some();
    if verified_with_app_keys {
        return InviteOwnerRoutingResolution {
            owner_pubkey: claimed_owner_pubkey,
            claimed_owner_pubkey,
            verified_with_app_keys: true,
            used_link_bootstrap_exception: false,
            fell_back_to_device_identity: false,
        };
    }

    let used_link_bootstrap_exception =
        invite_purpose == Some("link") && claimed_owner_pubkey == current_owner_pubkey;
    if used_link_bootstrap_exception {
        return InviteOwnerRoutingResolution {
            owner_pubkey: claimed_owner_pubkey,
            claimed_owner_pubkey,
            verified_with_app_keys: false,
            used_link_bootstrap_exception: true,
            fell_back_to_device_identity: false,
        };
    }

    InviteOwnerRoutingResolution {
        owner_pubkey: device_pubkey,
        claimed_owner_pubkey,
        verified_with_app_keys: false,
        used_link_bootstrap_exception: false,
        fell_back_to_device_identity: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DeviceEntry;
    use nostr::{EventBuilder, Keys, Kind, Timestamp};

    #[test]
    fn merges_same_second_app_keys_snapshots_monotonically() {
        let device1 = Keys::generate().public_key();
        let device2 = Keys::generate().public_key();
        let current = AppKeys::new(vec![DeviceEntry::new(device1, 100)]);
        let incoming = AppKeys::new(vec![
            DeviceEntry::new(device1, 100),
            DeviceEntry::new(device2, 100),
        ]);

        let applied = apply_app_keys_snapshot(Some(&current), 100, &incoming, 100);

        assert_eq!(
            applied.decision,
            AppKeysSnapshotDecision::MergedEqualTimestamp
        );
        assert!(applied.app_keys.get_device(&device1).is_some());
        assert!(applied.app_keys.get_device(&device2).is_some());
    }

    #[test]
    fn ignores_stale_app_keys_snapshots() {
        let device1 = Keys::generate().public_key();
        let device2 = Keys::generate().public_key();
        let current = AppKeys::new(vec![DeviceEntry::new(device1, 200)]);
        let incoming = AppKeys::new(vec![
            DeviceEntry::new(device1, 100),
            DeviceEntry::new(device2, 100),
        ]);

        let applied = apply_app_keys_snapshot(Some(&current), 200, &incoming, 100);

        assert_eq!(applied.decision, AppKeysSnapshotDecision::Stale);
        assert_eq!(applied.created_at, 200);
        assert!(applied.app_keys.get_device(&device1).is_some());
        assert!(applied.app_keys.get_device(&device2).is_none());
    }

    #[test]
    fn required_device_is_preserved_when_app_keys_snapshot_advances() {
        let remote_device = Keys::generate().public_key();
        let local_device = Keys::generate().public_key();
        let incoming = AppKeys::new(vec![DeviceEntry::new(remote_device, 100)]);

        let applied = apply_app_keys_snapshot_with_required_device(
            None,
            0,
            &incoming,
            100,
            Some(DeviceEntry::new(local_device, 200)),
        );

        assert_eq!(applied.decision, AppKeysSnapshotDecision::Advanced);
        assert!(applied.app_keys.get_device(&remote_device).is_some());
        assert!(applied.app_keys.get_device(&local_device).is_some());
    }

    #[test]
    fn required_device_is_preserved_when_app_keys_snapshot_is_stale() {
        let local_device = Keys::generate().public_key();
        let old_remote_device = Keys::generate().public_key();
        let current = AppKeys::new(vec![DeviceEntry::new(local_device, 200)]);
        let incoming = AppKeys::new(vec![DeviceEntry::new(old_remote_device, 100)]);

        let applied = apply_app_keys_snapshot_with_required_device(
            Some(&current),
            200,
            &incoming,
            100,
            Some(DeviceEntry::new(local_device, 200)),
        );

        assert_eq!(applied.decision, AppKeysSnapshotDecision::Stale);
        assert!(applied.app_keys.get_device(&local_device).is_some());
        assert!(applied.app_keys.get_device(&old_remote_device).is_none());
    }

    #[test]
    fn selects_newest_app_keys_event_by_created_at() {
        let owner_keys = Keys::generate();
        let device1 = Keys::generate().public_key();
        let device2 = Keys::generate().public_key();
        let sign_app_keys = |app_keys: AppKeys, created_at: u64| {
            let unsigned = app_keys.get_event(owner_keys.public_key());
            EventBuilder::new(Kind::from(crate::APP_KEYS_EVENT_KIND as u16), "")
                .tags(unsigned.tags.clone())
                .custom_created_at(Timestamp::from(created_at))
                .build(owner_keys.public_key())
                .sign_with_keys(&owner_keys)
                .unwrap()
        };

        let older_event = sign_app_keys(AppKeys::new(vec![DeviceEntry::new(device1, 100)]), 100);
        let newer_event = sign_app_keys(
            AppKeys::new(vec![
                DeviceEntry::new(device1, 100),
                DeviceEntry::new(device2, 101),
            ]),
            101,
        );

        let selected = select_latest_app_keys_from_events([&older_event, &newer_event])
            .expect("expected latest AppKeys snapshot");

        assert_eq!(selected.decision, AppKeysSnapshotDecision::Advanced);
        assert_eq!(selected.created_at, 101);
        assert!(selected.app_keys.get_device(&device1).is_some());
        assert!(selected.app_keys.get_device(&device2).is_some());
    }

    #[test]
    fn falls_back_to_device_identity_for_unverified_chat_invites() {
        let device = Keys::generate().public_key();
        let owner = Keys::generate().public_key();
        let current_owner = Keys::generate().public_key();

        let resolved =
            resolve_invite_owner_routing(device, owner, Some("chat"), current_owner, None);

        assert_eq!(resolved.owner_pubkey, device);
        assert!(resolved.fell_back_to_device_identity);
    }

    #[test]
    fn keeps_owner_side_link_bootstrap_before_appkeys_registration() {
        let device = Keys::generate().public_key();
        let owner = Keys::generate().public_key();

        let resolved = resolve_invite_owner_routing(device, owner, Some("link"), owner, None);

        assert_eq!(resolved.owner_pubkey, owner);
        assert!(resolved.used_link_bootstrap_exception);
    }

    #[test]
    fn private_invite_owner_claim_falls_back_to_device_without_appkeys() {
        let device = Keys::generate().public_key();
        let owner = Keys::generate().public_key();
        let current_owner = Keys::generate().public_key();

        let resolved =
            resolve_invite_owner_routing(device, owner, Some("private"), current_owner, None);

        assert_eq!(resolved.owner_pubkey, device);
        assert!(!resolved.verified_with_app_keys);
        assert!(resolved.fell_back_to_device_identity);
    }

    #[test]
    fn resolves_self_targeted_conversation_candidates_with_linked_device_first() {
        let candidates = resolve_conversation_candidate_pubkeys(
            "owner",
            "linked-device",
            &[vec!["p".into(), "owner".into()]],
            "owner",
        );

        assert_eq!(
            candidates,
            vec!["linked-device".to_string(), "owner".to_string()]
        );
    }

    #[test]
    fn evaluates_device_registration_state() {
        let state = evaluate_device_registration_state(
            Some("device-2"),
            &[String::from("device-1")],
            false,
            true,
            true,
        );

        assert!(!state.is_current_device_registered);
        assert!(state.has_known_registered_devices);
        assert!(!state.no_previous_devices_found);
        assert!(state.requires_device_registration);
        assert!(state.can_send_private_messages);
    }

    #[test]
    fn skips_relay_confirmation_for_first_device_bootstrap() {
        assert!(!should_require_relay_registration_confirmation(
            Some("device-1"),
            &[],
            false,
            true,
            true,
        ));
    }

    #[test]
    fn requires_relay_confirmation_for_new_device_on_existing_owner() {
        assert!(should_require_relay_registration_confirmation(
            Some("device-2"),
            &[String::from("device-1")],
            false,
            true,
            true,
        ));
    }
}
