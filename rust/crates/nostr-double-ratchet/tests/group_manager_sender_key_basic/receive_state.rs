use super::*;

#[test]
fn sender_key_corrupted_outer_message_does_not_advance_receiver() -> Result<()> {
    let mut fixture = established_sender_key_fixture(10, 1_900_040_000)?;

    let first = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_040_010, 1_900_040_010),
        &fixture.group_id,
        b"first valid".to_vec(),
    )?;
    let second = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_040_011, 1_900_040_011),
        &fixture.group_id,
        b"second valid".to_vec(),
    )?;

    let mut corrupted = sender_key_message_from_envelope(&first.remote.sender_key_messages[0]);
    let last = corrupted
        .ciphertext
        .last_mut()
        .expect("ciphertext must not be empty");
    *last ^= 0x44;
    let before = snapshot(&fixture.bob_groups.snapshot());

    assert!(fixture
        .bob_groups
        .handle_sender_key_message(corrupted)
        .is_err());
    assert_eq!(snapshot(&fixture.bob_groups.snapshot()), before);

    let first_result =
        fixture
            .bob_groups
            .handle_sender_key_message(sender_key_message_from_envelope(
                &first.remote.sender_key_messages[0],
            ))?;
    assert!(matches!(
        first_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"first valid".to_vec()
    ));

    let second_result =
        fixture
            .bob_groups
            .handle_sender_key_message(sender_key_message_from_envelope(
                &second.remote.sender_key_messages[0],
            ))?;
    assert!(matches!(
        second_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"second valid".to_vec()
    ));

    Ok(())
}

#[test]
fn sender_key_duplicate_outer_message_is_rejected_without_losing_next_message() -> Result<()> {
    let mut fixture = established_sender_key_fixture(12, 1_900_041_000)?;

    let first = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_041_010, 1_900_041_010),
        &fixture.group_id,
        b"once".to_vec(),
    )?;
    let second = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_041_011, 1_900_041_011),
        &fixture.group_id,
        b"after duplicate".to_vec(),
    )?;
    let first_message = sender_key_message_from_envelope(&first.remote.sender_key_messages[0]);

    let first_result = fixture
        .bob_groups
        .handle_sender_key_message(first_message.clone())?;
    assert!(matches!(
        first_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"once".to_vec()
    ));
    let after_first = snapshot(&fixture.bob_groups.snapshot());

    assert!(fixture
        .bob_groups
        .handle_sender_key_message(first_message)
        .is_err());
    assert_eq!(snapshot(&fixture.bob_groups.snapshot()), after_first);

    let second_result =
        fixture
            .bob_groups
            .handle_sender_key_message(sender_key_message_from_envelope(
                &second.remote.sender_key_messages[0],
            ))?;
    assert!(matches!(
        second_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"after duplicate".to_vec()
    ));

    Ok(())
}

#[test]
fn sender_key_unknown_key_id_is_pending_without_mutating_state() -> Result<()> {
    let mut fixture = established_sender_key_fixture(14, 1_900_042_000)?;
    let sent = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_042_010, 1_900_042_010),
        &fixture.group_id,
        b"known sender unknown key".to_vec(),
    )?;
    let mut message = sender_key_message_from_envelope(&sent.remote.sender_key_messages[0]);
    message.key_id = message.key_id.wrapping_add(1);
    let before = snapshot(&fixture.bob_groups.snapshot());

    let result = fixture.bob_groups.handle_sender_key_message(message)?;

    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));
    assert_eq!(snapshot(&fixture.bob_groups.snapshot()), before);

    Ok(())
}

#[test]
fn sender_key_valid_ciphertext_with_invalid_group_plaintext_does_not_burn_message_number(
) -> Result<()> {
    let mut fixture = established_sender_key_fixture(16, 1_900_043_000)?;
    let receiver_snapshot = fixture.bob_groups.snapshot();
    let sender_record = receiver_snapshot
        .sender_keys
        .iter()
        .find(|record| record.group_id == fixture.group_id)
        .expect("sender-key record");
    let key_id = sender_record.latest_key_id.expect("latest sender key");
    let mut forged_sender_state = sender_record
        .states
        .iter()
        .find(|state| state.key_id() == key_id)
        .expect("sender-key state")
        .clone();
    let forged_inner = EventBuilder::new(Kind::from(14), "forged")
        .tags(vec![
            Tag::parse(["l".to_string(), fixture.group_id.clone()]).unwrap(),
            Tag::parse(["ms".to_string(), "1900043010000".to_string()]).unwrap(),
            Tag::parse(["revision".to_string(), "999".to_string()]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(1_900_043_010))
        .build(sender_record.sender_event_pubkey.to_nostr().unwrap());
    let forged_plaintext = serde_json::to_vec(&forged_inner).expect("forged plaintext json");
    let (message_number, ciphertext) = forged_sender_state
        .encrypt_to_bytes(&forged_plaintext)
        .expect("forge sender-key ciphertext");
    let forged = GroupSenderKeyMessage {
        group_id: fixture.group_id.clone(),
        sender_event_pubkey: sender_record.sender_event_pubkey,
        key_id,
        message_number,
        encrypted_header: None,
        created_at: UnixSeconds(1_900_043_010),
        ciphertext,
    };
    let before = snapshot(&fixture.bob_groups.snapshot());

    let result = fixture
        .bob_groups
        .handle_sender_key_message(forged)
        .expect("future revision should be queued, not rejected");

    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::PendingRevision {
            required_revision: 999,
            ..
        }
    ));
    assert_eq!(snapshot(&fixture.bob_groups.snapshot()), before);

    let legitimate = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_043_011, 1_900_043_011),
        &fixture.group_id,
        b"legitimate after forged".to_vec(),
    )?;
    let result = fixture
        .bob_groups
        .handle_sender_key_message(sender_key_message_from_envelope(
            &legitimate.remote.sender_key_messages[0],
        ))?;
    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"legitimate after forged".to_vec()
    ));

    Ok(())
}

#[test]
fn sender_key_group_manager_snapshot_roundtrip_preserves_pending_decrypt_state() -> Result<()> {
    let mut fixture = established_sender_key_fixture(18, 1_900_044_000)?;
    let sent = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_044_010, 1_900_044_010),
        &fixture.group_id,
        b"after restore".to_vec(),
    )?;
    let json = snapshot(&fixture.bob_groups.snapshot());
    let restored_snapshot: GroupManagerSnapshot = serde_json::from_str(&json).unwrap();
    let mut restored = GroupManager::from_snapshot(restored_snapshot)?;

    let result = restored.handle_sender_key_message(sender_key_message_from_envelope(
        &sent.remote.sender_key_messages[0],
    ))?;

    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"after restore".to_vec()
                && message.sender_device == Some(fixture.alice.device_pubkey)
    ));

    Ok(())
}

#[test]
fn sender_key_snapshot_discards_forwarded_duplicate_sender_event_record() -> Result<()> {
    let mut fixture = established_sender_key_fixture(19, 1_900_044_100)?;
    let sent = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_044_110, 1_900_044_110),
        &fixture.group_id,
        b"after duplicate restore".to_vec(),
    )?;
    let mut restored_snapshot = fixture.bob_groups.snapshot();
    let mut duplicate = restored_snapshot.sender_keys[0].clone();
    duplicate.sender_owner = restored_snapshot.local_owner_pubkey;
    duplicate.sender_event_secret_key = None;
    restored_snapshot.sender_keys.push(duplicate);

    let mut restored = GroupManager::from_snapshot(restored_snapshot)?;

    assert_eq!(restored.snapshot().sender_keys.len(), 1);
    let result = restored.handle_sender_key_message(sender_key_message_from_envelope(
        &sent.remote.sender_key_messages[0],
    ))?;
    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"after duplicate restore".to_vec()
    ));

    Ok(())
}
