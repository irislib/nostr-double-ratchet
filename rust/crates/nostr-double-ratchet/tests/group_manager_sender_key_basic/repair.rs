use super::*;

#[test]
fn sender_key_repair_request_restores_original_distribution_after_sender_chain_advanced(
) -> Result<()> {
    let alice = manager_device(46, 86);
    let bob = manager_device(47, 87);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 1_900_070_000)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 1_900_070_001)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 1_900_070_002, 1_900_070_002)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(1_900_070_003, 1_900_070_003),
        "Repair dist".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        1_900_070_004,
        1_900_070_004,
    )?;

    let metadata_delivery = created.prepared.remote.deliveries[0].clone();
    let received_metadata = manager_receive_delivery(
        &mut bob_manager,
        &mut context(1_900_070_005, 1_900_070_005),
        alice.owner_pubkey,
        &metadata_delivery,
    )?
    .expect("metadata delivery");
    assert!(matches!(
        bob_groups.handle_pairwise_payload(
            received_metadata.owner_pubkey,
            received_metadata.device_pubkey,
            &received_metadata.payload,
        )?,
        Some(GroupIncomingEvent::MetadataUpdated(_))
    ));

    let first = alice_groups.send_message(
        &mut alice_manager,
        &mut context(1_900_070_006, 1_900_070_006),
        &created.group.group_id,
        b"repair me".to_vec(),
    )?;
    let first_outer = first.remote.sender_key_messages[0].clone();
    assert!(matches!(
        bob_groups.handle_sender_key_message(sender_key_message_from_envelope(&first_outer))?,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    let _advanced = alice_groups.send_message(
        &mut alice_manager,
        &mut context(1_900_070_007, 1_900_070_007),
        &created.group.group_id,
        b"chain advanced".to_vec(),
    )?;

    let request = SenderKeyRepairRequest {
        group_id: created.group.group_id.clone(),
        sender_event_pubkey: first_outer.sender_event_pubkey,
        key_id: Some(first_outer.key_id),
        message_number: Some(first_outer.message_number),
        required_revision: None,
        created_at: UnixSeconds(1_900_070_008),
    };
    let repair_request = bob_groups.request_sender_key_repair(
        &mut bob_manager,
        &mut context(1_900_070_009, 1_900_070_009),
        &request,
    )?;
    let alice_events = deliver_pairwise_group_events_for(
        &mut alice_manager,
        &mut alice_groups,
        alice.owner_pubkey,
        bob.owner_pubkey,
        &repair_request,
        1_900_070_010,
        1_900_070_010,
    )?;
    assert!(matches!(
        alice_events.as_slice(),
        [GroupIncomingEvent::SenderKeyRepairRequested(event)]
            if event.request == request && event.requester_owner == bob.owner_pubkey
    ));

    let repair_response = alice_groups.respond_to_sender_key_repair_request(
        &mut alice_manager,
        &mut context(1_900_070_011, 1_900_070_011),
        bob.owner_pubkey,
        &request,
    )?;
    let bob_events = deliver_pairwise_group_events_for(
        &mut bob_manager,
        &mut bob_groups,
        bob.owner_pubkey,
        alice.owner_pubkey,
        &repair_response,
        1_900_070_012,
        1_900_070_012,
    )?;
    assert!(
        bob_events.iter().any(|event| {
            matches!(
                event,
                GroupIncomingEvent::MetadataUpdated(snapshot)
                    if snapshot.group_id == created.group.group_id
            )
        }),
        "repair responses should refresh group metadata alongside sender keys"
    );

    let repaired =
        bob_groups.handle_sender_key_message(sender_key_message_from_envelope(&first_outer))?;
    assert!(matches!(
        repaired,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"repair me".to_vec()
                && message.sender_device == Some(alice.device_pubkey)
    ));

    Ok(())
}

#[test]
fn sender_key_repair_request_from_removed_member_does_not_leak_distribution() -> Result<()> {
    let mut fixture = established_sender_key_fixture(48, 1_900_071_000)?;
    let sent = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_071_010, 1_900_071_010),
        &fixture.group_id,
        b"before removal".to_vec(),
    )?;
    let outer = sent.remote.sender_key_messages[0].clone();
    let removed = fixture.alice_groups.remove_members(
        &mut fixture.alice_manager,
        &mut context(1_900_071_011, 1_900_071_011),
        &fixture.group_id,
        vec![fixture.bob_groups.snapshot().local_owner_pubkey],
    )?;
    assert!(!removed.remote.deliveries.is_empty());

    let request = SenderKeyRepairRequest {
        group_id: fixture.group_id.clone(),
        sender_event_pubkey: outer.sender_event_pubkey,
        key_id: Some(outer.key_id),
        message_number: Some(outer.message_number),
        required_revision: None,
        created_at: UnixSeconds(1_900_071_012),
    };
    let response = fixture.alice_groups.respond_to_sender_key_repair_request(
        &mut fixture.alice_manager,
        &mut context(1_900_071_013, 1_900_071_013),
        fixture.bob_groups.snapshot().local_owner_pubkey,
        &request,
    )?;

    assert!(response.remote.deliveries.is_empty());
    assert!(response.local_sibling.deliveries.is_empty());
    assert!(response.remote.sender_key_messages.is_empty());
    assert!(response.local_sibling.sender_key_messages.is_empty());

    Ok(())
}

#[test]
fn sender_key_late_member_repair_denies_pre_join_outer() -> Result<()> {
    let mut fixture = late_member_repair_fixture(50, 1_900_074_000)?;
    assert!(matches!(
        fixture
            .carol_groups
            .handle_sender_key_message(sender_key_message_from_envelope(&fixture.pre_join_outer))?,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    let request = SenderKeyRepairRequest {
        group_id: fixture.group_id.clone(),
        sender_event_pubkey: fixture.pre_join_outer.sender_event_pubkey,
        key_id: Some(fixture.pre_join_outer.key_id),
        message_number: Some(fixture.pre_join_outer.message_number),
        required_revision: None,
        created_at: UnixSeconds(1_900_074_020),
    };
    let response = fixture.bob_groups.respond_to_sender_key_repair_request(
        &mut fixture.bob_manager,
        &mut context(1_900_074_021, 1_900_074_021),
        fixture.carol.owner_pubkey,
        &request,
    )?;

    assert!(response.remote.deliveries.is_empty());
    assert!(response.local_sibling.deliveries.is_empty());
    assert!(response.remote.sender_key_messages.is_empty());
    assert!(response.local_sibling.sender_key_messages.is_empty());

    Ok(())
}

#[test]
fn sender_key_late_member_repair_allows_post_join_missed_distribution() -> Result<()> {
    let mut fixture = late_member_repair_fixture(53, 1_900_075_000)?;
    assert!(matches!(
        fixture
            .carol_groups
            .handle_sender_key_message(sender_key_message_from_envelope(
                &fixture.post_join_outer
            ))?,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    let request = SenderKeyRepairRequest {
        group_id: fixture.group_id.clone(),
        sender_event_pubkey: fixture.post_join_outer.sender_event_pubkey,
        key_id: Some(fixture.post_join_outer.key_id),
        message_number: Some(fixture.post_join_outer.message_number),
        required_revision: None,
        created_at: UnixSeconds(1_900_075_020),
    };
    let response = fixture.bob_groups.respond_to_sender_key_repair_request(
        &mut fixture.bob_manager,
        &mut context(1_900_075_021, 1_900_075_021),
        fixture.carol.owner_pubkey,
        &request,
    )?;
    assert!(
        response
            .remote
            .deliveries
            .iter()
            .any(|delivery| delivery.owner_pubkey == fixture.carol.owner_pubkey),
        "late member should receive a repair distribution for a post-join sender-key message"
    );
    observe_matching_invite_responses(
        &mut fixture.carol_manager,
        &response.remote.invite_responses,
        1_900_075_022,
        1_900_075_022,
    )?;

    let events = deliver_pairwise_group_events_for(
        &mut fixture.carol_manager,
        &mut fixture.carol_groups,
        fixture.carol.owner_pubkey,
        fixture.bob.owner_pubkey,
        &response,
        1_900_075_023,
        1_900_075_023,
    )?;
    assert_eq!(events.len(), 1);

    let pre_join_result = fixture
        .carol_groups
        .handle_sender_key_message(sender_key_message_from_envelope(&fixture.pre_join_outer));
    assert!(
        pre_join_result.is_err(),
        "post-join repair distribution must not decrypt pre-join sender-key messages"
    );

    let post_join_result = fixture
        .carol_groups
        .handle_sender_key_message(sender_key_message_from_envelope(&fixture.post_join_outer))?;
    assert!(matches!(
        post_join_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"post-join from bob".to_vec()
                && message.sender_owner == fixture.bob.owner_pubkey
                && message.sender_device == Some(fixture.bob.device_pubkey)
    ));

    Ok(())
}

#[test]
fn sender_key_late_member_repair_snapshot_roundtrip_preserves_authorization() -> Result<()> {
    let mut fixture = late_member_repair_fixture(56, 1_900_076_000)?;
    let restored_snapshot: GroupManagerSnapshot =
        serde_json::from_str(&snapshot(&fixture.bob_groups.snapshot())).unwrap();
    fixture.bob_groups = GroupManager::from_snapshot(restored_snapshot)?;

    let request = SenderKeyRepairRequest {
        group_id: fixture.group_id.clone(),
        sender_event_pubkey: fixture.pre_join_outer.sender_event_pubkey,
        key_id: Some(fixture.pre_join_outer.key_id),
        message_number: Some(fixture.pre_join_outer.message_number),
        required_revision: None,
        created_at: UnixSeconds(1_900_076_020),
    };
    let response = fixture.bob_groups.respond_to_sender_key_repair_request(
        &mut fixture.bob_manager,
        &mut context(1_900_076_021, 1_900_076_021),
        fixture.carol.owner_pubkey,
        &request,
    )?;

    assert!(response.remote.deliveries.is_empty());
    assert!(response.local_sibling.deliveries.is_empty());
    assert!(response.remote.sender_key_messages.is_empty());
    assert!(response.local_sibling.sender_key_messages.is_empty());

    Ok(())
}

#[test]
fn sender_key_distribution_requires_authenticated_device_provenance() -> Result<()> {
    let alice = manager_device(5, 51);
    let bob = manager_device(6, 61);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 30)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 31)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 32, 1_900_030_000)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(33, 1_900_030_001),
        "Authenticated dist".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        34,
        1_900_030_002,
    )?;

    let metadata = manager_receive_delivery(
        &mut bob_manager,
        &mut context(35, 1_900_030_003),
        alice.owner_pubkey,
        &created.prepared.remote.deliveries[0],
    )?
    .expect("metadata delivery");
    let _ = bob_groups.handle_pairwise_payload(
        metadata.owner_pubkey,
        metadata.device_pubkey,
        &metadata.payload,
    )?;

    let distribution = manager_receive_delivery(
        &mut bob_manager,
        &mut context(36, 1_900_030_004),
        alice.owner_pubkey,
        &created.prepared.remote.deliveries[1],
    )?
    .expect("sender-key distribution delivery");
    let unauthenticated =
        bob_groups.handle_incoming(distribution.owner_pubkey, &distribution.payload);

    assert!(unauthenticated.is_err());
    assert!(bob_groups.known_sender_event_pubkeys().is_empty());

    Ok(())
}
