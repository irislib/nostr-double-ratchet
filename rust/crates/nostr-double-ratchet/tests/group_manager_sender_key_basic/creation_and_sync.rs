use super::*;

#[test]
fn sender_key_group_create_distributes_key_and_shared_message_decrypts() -> Result<()> {
    let alice = manager_device(1, 11);
    let bob = manager_device(2, 21);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 10)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 11)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 12, 1_900_010_000)?,
    )?;

    let mut create_ctx = context(13, 1_900_010_001);
    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut create_ctx,
        "Sender keys".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    assert_eq!(created.group.protocol, GroupProtocol::sender_key_v1());
    assert_eq!(created.prepared.remote.sender_key_messages.len(), 0);
    assert_eq!(created.prepared.remote.deliveries.len(), 2);

    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        14,
        1_900_010_002,
    )?;
    let create_events = deliver_pairwise_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice.owner_pubkey,
        &created.prepared,
        15,
        1_900_010_003,
    )?;
    assert_eq!(create_events.len(), 2);
    assert_eq!(bob_groups.known_sender_event_pubkeys().len(), 1);

    let mut send_ctx = context(16, 1_900_010_004);
    let sent = alice_groups.send_message(
        &mut alice_manager,
        &mut send_ctx,
        &created.group.group_id,
        b"hello sender-key group".to_vec(),
    )?;
    assert_eq!(sent.remote.deliveries.len(), 0);
    assert_eq!(sent.remote.sender_key_messages.len(), 1);

    let outer = sent.remote.sender_key_messages[0].clone();
    let result = bob_groups.handle_sender_key_message(GroupSenderKeyMessage {
        group_id: outer.group_id,
        sender_event_pubkey: outer.sender_event_pubkey,
        key_id: outer.key_id,
        message_number: outer.message_number,
        encrypted_header: outer.encrypted_header,
        created_at: outer.created_at,
        ciphertext: outer.ciphertext,
    })?;
    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.group_id == created.group.group_id
                && message.sender_owner == alice.owner_pubkey
                && message.sender_device == Some(alice.device_pubkey)
                && message.body == b"hello sender-key group".to_vec()
    ));

    Ok(())
}

#[test]
fn sender_key_group_create_syncs_to_local_sibling() -> Result<()> {
    let alice1 = manager_device(30, 31);
    let alice2 = manager_device(30, 32);
    let bob = manager_device(33, 34);
    let mut alice1_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob_manager = session_manager(&bob);
    let mut alice1_groups = GroupManager::new(alice1.owner_pubkey);
    let mut alice2_groups = GroupManager::new(alice2.owner_pubkey);

    alice1_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 40));
    alice2_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 40));
    alice1_manager.observe_device_invite(
        alice1.owner_pubkey,
        manager_public_device_invite(&mut alice2_manager, &alice2, 41, 1_900_030_100)?,
    )?;
    observe_signed_peer_app_keys(&mut alice1_manager, &bob, &[&bob], 42)?;
    alice1_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 43, 1_900_030_101)?,
    )?;

    let created = alice1_groups.create_group_with_protocol(
        &mut alice1_manager,
        &mut context(44, 1_900_030_102),
        "Sender-key siblings".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;

    observe_matching_invite_responses(
        &mut alice2_manager,
        &created.prepared.local_sibling.invite_responses,
        45,
        1_900_030_103,
    )?;

    let mut ctx = context(46, 1_900_030_104);
    let mut events = Vec::new();
    for delivery in created
        .prepared
        .local_sibling
        .deliveries
        .iter()
        .filter(|delivery| delivery.device_pubkey == alice2.device_pubkey)
    {
        if let Some(received) =
            manager_receive_delivery(&mut alice2_manager, &mut ctx, alice1.owner_pubkey, delivery)?
        {
            if let Some(event) = alice2_groups.handle_pairwise_payload(
                received.owner_pubkey,
                received.device_pubkey,
                &received.payload,
            )? {
                events.push(event);
            }
        }
    }

    assert_eq!(events.len(), 2);
    assert!(matches!(
        events.as_slice(),
        [
            GroupIncomingEvent::MetadataUpdated(snapshot),
            GroupIncomingEvent::MetadataUpdated(_)
        ] if snapshot.group_id == created.group.group_id
            && snapshot.protocol == GroupProtocol::sender_key_v1()
    ));
    assert_eq!(alice2_groups.known_sender_event_pubkeys().len(), 1);
    assert_eq!(
        alice2_groups
            .group(&created.group.group_id)
            .expect("local sibling has sender-key group")
            .revision,
        1
    );

    Ok(())
}

#[test]
fn sender_key_local_sibling_can_repair_missed_rotated_distribution() -> Result<()> {
    let alice1 = manager_device(70, 71);
    let alice2 = manager_device(70, 72);
    let bob = manager_device(73, 74);
    let carol = manager_device(75, 76);
    let mut alice1_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob_manager = session_manager(&bob);
    let mut carol_manager = session_manager(&carol);
    let mut alice1_groups = GroupManager::new(alice1.owner_pubkey);
    let mut alice2_groups = GroupManager::new(alice2.owner_pubkey);

    alice1_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 1_900_077_000));
    alice2_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 1_900_077_000));
    alice1_manager.observe_device_invite(
        alice1.owner_pubkey,
        manager_public_device_invite(&mut alice2_manager, &alice2, 1_900_077_001, 1_900_077_001)?,
    )?;
    observe_signed_peer_app_keys(&mut alice1_manager, &bob, &[&bob], 1_900_077_002)?;
    observe_signed_peer_app_keys(&mut alice1_manager, &carol, &[&carol], 1_900_077_003)?;
    alice1_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 1_900_077_004, 1_900_077_004)?,
    )?;
    alice1_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_077_005, 1_900_077_005)?,
    )?;

    let created = alice1_groups.create_group_with_protocol(
        &mut alice1_manager,
        &mut context(1_900_077_006, 1_900_077_006),
        "Sender-key sibling repair".to_string(),
        vec![bob.owner_pubkey, carol.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut alice2_manager,
        &created.prepared.local_sibling.invite_responses,
        1_900_077_007,
        1_900_077_007,
    )?;
    let mut create_events = Vec::new();
    let mut create_ctx = context(1_900_077_008, 1_900_077_008);
    for delivery in created
        .prepared
        .local_sibling
        .deliveries
        .iter()
        .filter(|delivery| delivery.device_pubkey == alice2.device_pubkey)
    {
        if let Some(received) = manager_receive_delivery(
            &mut alice2_manager,
            &mut create_ctx,
            alice1.owner_pubkey,
            delivery,
        )? {
            if let Some(event) = alice2_groups.handle_pairwise_payload(
                received.owner_pubkey,
                received.device_pubkey,
                &received.payload,
            )? {
                create_events.push(event);
            }
        }
    }
    assert_eq!(create_events.len(), 2);

    let removed = alice1_groups.remove_members(
        &mut alice1_manager,
        &mut context(1_900_077_009, 1_900_077_009),
        &created.group.group_id,
        vec![bob.owner_pubkey],
    )?;
    observe_matching_invite_responses(
        &mut alice2_manager,
        &removed.local_sibling.invite_responses,
        1_900_077_010,
        1_900_077_010,
    )?;
    let first_remove_delivery = removed
        .local_sibling
        .deliveries
        .iter()
        .find(|delivery| delivery.device_pubkey == alice2.device_pubkey)
        .expect("local sibling removal metadata delivery");
    let mut remove_ctx = context(1_900_077_011, 1_900_077_011);
    let received_remove = manager_receive_delivery(
        &mut alice2_manager,
        &mut remove_ctx,
        alice1.owner_pubkey,
        first_remove_delivery,
    )?
    .expect("alice2 receives removal metadata");
    let remove_event = alice2_groups
        .handle_pairwise_payload(
            received_remove.owner_pubkey,
            received_remove.device_pubkey,
            &received_remove.payload,
        )?
        .expect("removal metadata event");
    assert!(matches!(
        remove_event,
        GroupIncomingEvent::MetadataUpdated(_)
    ));

    let sent = alice1_groups.send_message(
        &mut alice1_manager,
        &mut context(1_900_077_012, 1_900_077_012),
        &created.group.group_id,
        b"after sibling missed rotation".to_vec(),
    )?;
    let outer = sent
        .local_sibling
        .sender_key_messages
        .first()
        .expect("local sibling sender-key outer")
        .clone();
    assert!(matches!(
        alice2_groups.handle_sender_key_message(sender_key_message_from_envelope(&outer))?,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    let request = SenderKeyRepairRequest {
        group_id: created.group.group_id.clone(),
        sender_event_pubkey: outer.sender_event_pubkey,
        key_id: Some(outer.key_id),
        message_number: Some(outer.message_number),
        required_revision: None,
        created_at: UnixSeconds(1_900_077_013),
    };
    let repair_request = alice2_groups.request_sender_key_repair(
        &mut alice2_manager,
        &mut context(1_900_077_014, 1_900_077_014),
        &request,
    )?;
    let request_delivery = repair_request
        .local_sibling
        .deliveries
        .iter()
        .find(|delivery| delivery.device_pubkey == alice1.device_pubkey)
        .expect("repair request to primary");
    let mut request_ctx = context(1_900_077_015, 1_900_077_015);
    let received_request = manager_receive_delivery(
        &mut alice1_manager,
        &mut request_ctx,
        alice2.owner_pubkey,
        request_delivery,
    )?
    .expect("alice1 receives repair request");
    let repair_event = alice1_groups
        .handle_pairwise_payload(
            received_request.owner_pubkey,
            received_request.device_pubkey,
            &received_request.payload,
        )?
        .expect("repair request event");
    assert!(matches!(
        repair_event,
        GroupIncomingEvent::SenderKeyRepairRequested(event)
            if event.request == request && event.requester_owner == alice2.owner_pubkey
    ));

    let repair_response = alice1_groups.respond_to_sender_key_repair_request(
        &mut alice1_manager,
        &mut context(1_900_077_016, 1_900_077_016),
        alice2.owner_pubkey,
        &request,
    )?;
    assert!(
        !repair_response.local_sibling.deliveries.is_empty(),
        "primary should answer local sibling repair for a distribution intended for local siblings"
    );
    observe_matching_invite_responses(
        &mut alice2_manager,
        &repair_response.local_sibling.invite_responses,
        1_900_077_017,
        1_900_077_017,
    )?;
    let response_delivery = repair_response
        .local_sibling
        .deliveries
        .iter()
        .find(|delivery| delivery.device_pubkey == alice2.device_pubkey)
        .expect("repair response to local sibling");
    let mut response_ctx = context(1_900_077_018, 1_900_077_018);
    let received_response = manager_receive_delivery(
        &mut alice2_manager,
        &mut response_ctx,
        alice1.owner_pubkey,
        response_delivery,
    )?
    .expect("alice2 receives repair response");
    alice2_groups.handle_pairwise_payload(
        received_response.owner_pubkey,
        received_response.device_pubkey,
        &received_response.payload,
    )?;

    let repaired =
        alice2_groups.handle_sender_key_message(sender_key_message_from_envelope(&outer))?;
    assert!(matches!(
        repaired,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"after sibling missed rotation".to_vec()
                && message.sender_owner == alice1.owner_pubkey
                && message.sender_device == Some(alice1.device_pubkey)
    ));

    Ok(())
}

#[test]
fn sender_key_outer_message_waits_for_distribution() -> Result<()> {
    let alice = manager_device(3, 31);
    let bob = manager_device(4, 41);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 20)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 21)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 22, 1_900_020_000)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(23, 1_900_020_001),
        "Pending dist".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        24,
        1_900_020_002,
    )?;

    let first_delivery = created.prepared.remote.deliveries[0].clone();
    let received = manager_receive_delivery(
        &mut bob_manager,
        &mut context(25, 1_900_020_003),
        alice.owner_pubkey,
        &first_delivery,
    )?
    .expect("metadata delivery");
    let _ = bob_groups.handle_pairwise_payload(
        received.owner_pubkey,
        received.device_pubkey,
        &received.payload,
    )?;

    let sent = alice_groups.send_message(
        &mut alice_manager,
        &mut context(26, 1_900_020_004),
        &created.group.group_id,
        b"before distribution".to_vec(),
    )?;
    let outer = sent.remote.sender_key_messages[0].clone();
    let result = bob_groups.handle_sender_key_message(GroupSenderKeyMessage {
        group_id: outer.group_id,
        sender_event_pubkey: outer.sender_event_pubkey,
        key_id: outer.key_id,
        message_number: outer.message_number,
        encrypted_header: outer.encrypted_header,
        created_at: outer.created_at,
        ciphertext: outer.ciphertext,
    })?;
    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    Ok(())
}
