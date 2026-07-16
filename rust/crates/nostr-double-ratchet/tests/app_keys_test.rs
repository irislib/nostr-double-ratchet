use nostr::Keys;
use nostr_double_ratchet::Result;
use nostr_double_ratchet::{
    build_app_keys_device_authorization_filter, resolve_app_keys_owner_for_device, AppKeys,
    DeviceEntry, DeviceMembership, VerifiedAppKeysIndex, APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT,
};

fn signed_app_keys(owner: &Keys, devices: &[nostr::PublicKey], created_at: u64) -> nostr::Event {
    AppKeys::new(
        devices
            .iter()
            .copied()
            .map(|device| DeviceEntry::new(device, created_at))
            .collect(),
    )
    .get_event_at(owner.public_key(), created_at)
    .sign_with_keys(owner)
    .expect("signed AppKeys")
}

#[test]
fn test_app_keys_roundtrip_and_merge() -> Result<()> {
    let owner_keys = Keys::generate();
    let device1 = Keys::generate();
    let device2 = Keys::generate();

    let app_keys = AppKeys::new(vec![
        DeviceEntry::new(device1.public_key(), 100),
        DeviceEntry::new(device2.public_key(), 200),
    ]);

    let event = app_keys.get_event(owner_keys.public_key());
    let signed = event.sign_with_keys(&owner_keys)?;

    let parsed = AppKeys::from_event(&signed)?;
    assert_eq!(parsed.get_all_devices().len(), 2);
    assert!(parsed.get_device(&device1.public_key()).is_some());
    assert!(parsed.get_device(&device2.public_key()).is_some());

    // Merge prefers earlier created_at for duplicates
    let mut other = AppKeys::new(vec![DeviceEntry::new(device1.public_key(), 50)]);
    other.add_device(DeviceEntry::new(device2.public_key(), 300));

    let merged = app_keys.merge(&other);
    let merged_device1 = merged.get_device(&device1.public_key()).unwrap();
    assert_eq!(merged_device1.created_at, 50);

    Ok(())
}

#[test]
fn test_app_keys_encrypts_labels_in_event_content() -> Result<()> {
    let owner_keys = Keys::generate();
    let device = Keys::generate();

    let mut app_keys = AppKeys::new(vec![DeviceEntry::new(device.public_key(), 100)]);
    app_keys.set_device_labels(
        device.public_key(),
        Some("Sirius MacBook".to_string()),
        Some("NDR Desktop".to_string()),
        Some(150),
    );

    let event = app_keys.get_encrypted_event(&owner_keys)?;

    assert!(event.content.is_empty());
    assert!(event.tags.iter().any(|tag| {
        let values = tag.clone().to_vec();
        values.first().map(|value| value.as_str()) == Some(APP_KEYS_ENCRYPTED_DEVICE_LABELS_FACT)
            && values.get(1).is_some_and(|value| !value.is_empty())
    }));
    assert!(!event.content.contains("Sirius MacBook"));
    assert!(!event.content.contains("NDR Desktop"));

    Ok(())
}

#[test]
fn test_app_keys_owner_can_decrypt_labels_but_public_parsing_cannot() -> Result<()> {
    let owner_keys = Keys::generate();
    let device = Keys::generate();

    let mut app_keys = AppKeys::new(vec![DeviceEntry::new(device.public_key(), 100)]);
    app_keys.set_device_labels(
        device.public_key(),
        Some("Office Laptop".to_string()),
        Some("NDR Mobile".to_string()),
        Some(200),
    );

    let signed = app_keys
        .get_encrypted_event(&owner_keys)?
        .sign_with_keys(&owner_keys)?;

    let parsed_public = AppKeys::from_event(&signed)?;
    assert!(parsed_public
        .get_device_labels(&device.public_key())
        .is_none());

    let parsed_owner = AppKeys::from_event_with_labels(&signed, &owner_keys)?;
    let labels = parsed_owner
        .get_device_labels(&device.public_key())
        .unwrap();
    assert_eq!(labels.device_label.as_deref(), Some("Office Laptop"));
    assert_eq!(labels.client_label.as_deref(), Some("NDR Mobile"));
    assert_eq!(labels.updated_at, 200);

    Ok(())
}

#[test]
fn test_app_keys_device_authorization_filter_and_owner_resolution() -> Result<()> {
    let owner_keys = Keys::generate();
    let device = Keys::generate();
    let other_device = Keys::generate();
    let app_keys = AppKeys::new(vec![DeviceEntry::new(device.public_key(), 100)]);

    let filter = build_app_keys_device_authorization_filter(device.public_key());
    let filter_json = serde_json::to_value(&filter)?;
    assert_eq!(filter_json["kinds"], serde_json::json!([37368]));
    assert_eq!(
        filter_json["#p"],
        serde_json::json!([device.public_key().to_hex()])
    );

    let signed = app_keys
        .get_event_at(owner_keys.public_key(), 1700000300)
        .sign_with_keys(&owner_keys)?;

    assert_eq!(
        resolve_app_keys_owner_for_device(&signed, device.public_key())?,
        Some(owner_keys.public_key())
    );
    assert_eq!(
        resolve_app_keys_owner_for_device(&signed, other_device.public_key())?,
        None
    );

    Ok(())
}

#[test]
fn ordinary_signed_app_keys_authorizes_exact_owner_device_binding() {
    let owner = Keys::generate();
    let device = Keys::generate().public_key();
    let event = signed_app_keys(&owner, &[device], 100);

    let mut index = VerifiedAppKeysIndex::default();
    assert!(index.ingest(event, 100).unwrap());
    assert_eq!(
        index.membership(owner.public_key(), device),
        DeviceMembership::Authorized
    );
}

#[test]
fn missing_app_keys_does_not_authorize() {
    let owner = Keys::generate();
    let device = Keys::generate().public_key();
    let index = VerifiedAppKeysIndex::default();

    assert_eq!(
        index.membership(owner.public_key(), device),
        DeviceMembership::Missing
    );
}

#[test]
fn newer_signed_exclusion_replaces_stale_inclusion() {
    let owner = Keys::generate();
    let device = Keys::generate().public_key();
    let included = signed_app_keys(&owner, &[device], 100);
    let excluded = signed_app_keys(&owner, &[], 101);

    let mut index = VerifiedAppKeysIndex::default();
    assert!(index.ingest(included, 101).unwrap());
    assert!(index.ingest(excluded, 101).unwrap());
    assert_eq!(
        index.membership(owner.public_key(), device),
        DeviceMembership::Excluded
    );
}

#[test]
fn equal_time_membership_conflict_is_ambiguous_in_both_orders() {
    let owner = Keys::generate();
    let device = Keys::generate().public_key();
    let included = signed_app_keys(&owner, &[device], 100);
    let excluded = signed_app_keys(&owner, &[], 100);

    for events in [
        vec![included.clone(), excluded.clone()],
        vec![excluded.clone(), included.clone()],
    ] {
        let mut index = VerifiedAppKeysIndex::default();
        for event in events {
            index.ingest(event, 100).unwrap();
        }
        assert_eq!(
            index.membership(owner.public_key(), device),
            DeviceMembership::Ambiguous
        );
    }
}

#[test]
fn wrong_owner_and_future_app_keys_do_not_authorize() {
    let owner = Keys::generate();
    let attacker = Keys::generate();
    let device = Keys::generate().public_key();
    let wrong_owner = signed_app_keys(&attacker, &[device], 100);
    let future = signed_app_keys(&owner, &[device], 401);

    let mut index = VerifiedAppKeysIndex::default();
    assert!(index.ingest(wrong_owner, 100).is_ok());
    assert!(index.ingest(future, 100).is_err());
    assert_eq!(
        index.membership(owner.public_key(), device),
        DeviceMembership::Missing
    );
}

#[test]
fn exact_heads_round_trip_for_restart_recovery() {
    let owner = Keys::generate();
    let device = Keys::generate().public_key();
    let event = signed_app_keys(&owner, &[device], 100);
    let mut index = VerifiedAppKeysIndex::default();
    index.ingest(event.clone(), 100).unwrap();

    assert_eq!(index.events_for_owner(owner.public_key()), vec![event]);
}
