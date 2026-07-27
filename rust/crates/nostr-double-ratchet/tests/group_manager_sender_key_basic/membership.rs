use super::*;

#[test]
fn sender_key_added_member_receives_distribution_at_current_iteration() -> Result<()> {
    let mut fixture = established_sender_key_fixture(20, 1_900_045_000)?;
    let carol = manager_device(22, 62);
    let mut carol_manager = session_manager(&carol);
    let mut carol_groups = GroupManager::new(carol.owner_pubkey);

    observe_signed_peer_app_keys(
        &mut carol_manager,
        &fixture.alice,
        &[&fixture.alice],
        1_900_045_010,
    )?;
    observe_signed_peer_app_keys(&mut fixture.alice_manager, &carol, &[&carol], 1_900_045_011)?;
    fixture.alice_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_045_012, 1_900_045_012)?,
    )?;

    let first = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_045_013, 1_900_045_013),
        &fixture.group_id,
        b"before carol".to_vec(),
    )?;
    let first_result =
        fixture
            .bob_groups
            .handle_sender_key_message(sender_key_message_from_envelope(
                &first.remote.sender_key_messages[0],
            ))?;
    assert!(matches!(
        first_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"before carol".to_vec()
    ));

    let added = fixture.alice_groups.add_members(
        &mut fixture.alice_manager,
        &mut context(1_900_045_014, 1_900_045_014),
        &fixture.group_id,
        vec![carol.owner_pubkey],
    )?;
    observe_matching_invite_responses(
        &mut carol_manager,
        &added.remote.invite_responses,
        1_900_045_015,
        1_900_045_015,
    )?;
    let carol_events = deliver_pairwise_group_events_for(
        &mut carol_manager,
        &mut carol_groups,
        carol.owner_pubkey,
        fixture.alice.owner_pubkey,
        &added,
        1_900_045_016,
        1_900_045_016,
    )?;
    assert_eq!(carol_events.len(), 2);

    let future = fixture.alice_groups.send_message(
        &mut fixture.alice_manager,
        &mut context(1_900_045_017, 1_900_045_017),
        &fixture.group_id,
        b"welcome carol".to_vec(),
    )?;
    let result = carol_groups.handle_sender_key_message(sender_key_message_from_envelope(
        &future.remote.sender_key_messages[0],
    ))?;

    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"welcome carol".to_vec()
                && message.sender_device == Some(fixture.alice.device_pubkey)
    ));

    Ok(())
}

#[test]
fn sender_key_existing_member_distributes_current_key_to_late_member_on_next_send() -> Result<()> {
    let alice = manager_device(24, 64);
    let bob = manager_device(25, 65);
    let carol = manager_device(26, 66);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut carol_manager = session_manager(&carol);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);
    let mut carol_groups = GroupManager::new(carol.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 1_900_045_100)?;
    observe_signed_peer_app_keys(&mut carol_manager, &alice, &[&alice], 1_900_045_101)?;
    observe_signed_peer_app_keys(&mut carol_manager, &bob, &[&bob], 1_900_045_102)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 1_900_045_103)?;
    observe_signed_peer_app_keys(&mut alice_manager, &carol, &[&carol], 1_900_045_104)?;
    observe_signed_peer_app_keys(&mut bob_manager, &carol, &[&carol], 1_900_045_105)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 1_900_045_106, 1_900_045_106)?,
    )?;
    alice_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_045_107, 1_900_045_107)?,
    )?;
    bob_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_045_108, 1_900_045_108)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(1_900_045_109, 1_900_045_109),
        "Late member existing sender".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        1_900_045_110,
        1_900_045_110,
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &created.prepared,
            1_900_045_111,
            1_900_045_111,
        )?
        .len(),
        2
    );

    let before_add = bob_groups.send_message(
        &mut bob_manager,
        &mut context(1_900_045_112, 1_900_045_112),
        &created.group.group_id,
        b"before carol".to_vec(),
    )?;
    assert!(
        before_add
            .remote
            .deliveries
            .iter()
            .any(|delivery| delivery.owner_pubkey == alice.owner_pubkey),
        "bob's first send should distribute its sender key to existing member alice"
    );

    let added = alice_groups.add_members(
        &mut alice_manager,
        &mut context(1_900_045_113, 1_900_045_113),
        &created.group.group_id,
        vec![carol.owner_pubkey],
    )?;
    observe_matching_invite_responses(
        &mut carol_manager,
        &added.remote.invite_responses,
        1_900_045_114,
        1_900_045_114,
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &added,
            1_900_045_115,
            1_900_045_115,
        )?
        .len(),
        2
    );
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut carol_manager,
            &mut carol_groups,
            carol.owner_pubkey,
            alice.owner_pubkey,
            &added,
            1_900_045_116,
            1_900_045_116,
        )?
        .len(),
        2
    );

    let future = bob_groups.send_message(
        &mut bob_manager,
        &mut context(1_900_045_117, 1_900_045_117),
        &created.group.group_id,
        b"welcome from existing sender".to_vec(),
    )?;
    assert!(
        future
            .remote
            .deliveries
            .iter()
            .any(|delivery| delivery.owner_pubkey == carol.owner_pubkey),
        "existing sender must pairwise-distribute its current sender key to the late member"
    );
    observe_matching_invite_responses(
        &mut carol_manager,
        &future.remote.invite_responses,
        1_900_045_118,
        1_900_045_118,
    )?;
    deliver_pairwise_group_events_for(
        &mut carol_manager,
        &mut carol_groups,
        carol.owner_pubkey,
        bob.owner_pubkey,
        &future,
        1_900_045_119,
        1_900_045_119,
    )?;
    let result = carol_groups.handle_sender_key_message(sender_key_message_from_envelope(
        &future.remote.sender_key_messages[0],
    ))?;

    assert!(matches!(
        result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"welcome from existing sender".to_vec()
                && message.sender_device == Some(bob.device_pubkey)
    ));

    Ok(())
}

#[test]
fn sender_key_removed_member_does_not_receive_rotated_future_key() -> Result<()> {
    let alice = manager_device(30, 70);
    let bob = manager_device(31, 71);
    let carol = manager_device(32, 72);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut carol_manager = session_manager(&carol);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);
    let mut carol_groups = GroupManager::new(carol.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 1_900_046_000)?;
    observe_signed_peer_app_keys(&mut carol_manager, &alice, &[&alice], 1_900_046_001)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 1_900_046_002)?;
    observe_signed_peer_app_keys(&mut alice_manager, &carol, &[&carol], 1_900_046_003)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 1_900_046_004, 1_900_046_004)?,
    )?;
    alice_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_046_005, 1_900_046_005)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(1_900_046_006, 1_900_046_006),
        "Remove rotation".to_string(),
        vec![bob.owner_pubkey, carol.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        1_900_046_007,
        1_900_046_007,
    )?;
    observe_matching_invite_responses(
        &mut carol_manager,
        &created.prepared.remote.invite_responses,
        1_900_046_008,
        1_900_046_008,
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &created.prepared,
            1_900_046_009,
            1_900_046_009,
        )?
        .len(),
        2
    );
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut carol_manager,
            &mut carol_groups,
            carol.owner_pubkey,
            alice.owner_pubkey,
            &created.prepared,
            1_900_046_010,
            1_900_046_010,
        )?
        .len(),
        2
    );

    let removed = alice_groups.remove_members(
        &mut alice_manager,
        &mut context(1_900_046_011, 1_900_046_011),
        &created.group.group_id,
        vec![carol.owner_pubkey],
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &removed,
            1_900_046_012,
            1_900_046_012,
        )?
        .len(),
        2
    );
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut carol_manager,
            &mut carol_groups,
            carol.owner_pubkey,
            alice.owner_pubkey,
            &removed,
            1_900_046_013,
            1_900_046_013,
        )?
        .len(),
        1
    );

    let future = alice_groups.send_message(
        &mut alice_manager,
        &mut context(1_900_046_014, 1_900_046_014),
        &created.group.group_id,
        b"after removal".to_vec(),
    )?;
    let future_message = sender_key_message_from_envelope(&future.remote.sender_key_messages[0]);
    let bob_result = bob_groups.handle_sender_key_message(future_message.clone())?;
    assert!(matches!(
        bob_result,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"after removal".to_vec()
    ));

    let carol_result = carol_groups.handle_sender_key_message(future_message)?;
    assert!(matches!(
        carol_result,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    Ok(())
}

#[test]
fn sender_key_existing_member_rotates_after_another_admin_removes_prior_recipient() -> Result<()> {
    let alice = manager_device(34, 74);
    let bob = manager_device(35, 75);
    let carol = manager_device(36, 76);
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut carol_manager = session_manager(&carol);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);
    let mut carol_groups = GroupManager::new(carol.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 1_900_046_100)?;
    observe_signed_peer_app_keys(&mut carol_manager, &alice, &[&alice], 1_900_046_101)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 1_900_046_102)?;
    observe_signed_peer_app_keys(&mut alice_manager, &carol, &[&carol], 1_900_046_103)?;
    observe_signed_peer_app_keys(&mut bob_manager, &carol, &[&carol], 1_900_046_104)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 1_900_046_105, 1_900_046_105)?,
    )?;
    alice_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_046_106, 1_900_046_106)?,
    )?;
    bob_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, 1_900_046_107, 1_900_046_107)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(1_900_046_108, 1_900_046_108),
        "Removed member existing sender".to_string(),
        vec![bob.owner_pubkey, carol.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        1_900_046_109,
        1_900_046_109,
    )?;
    observe_matching_invite_responses(
        &mut carol_manager,
        &created.prepared.remote.invite_responses,
        1_900_046_110,
        1_900_046_110,
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &created.prepared,
            1_900_046_111,
            1_900_046_111,
        )?
        .len(),
        2
    );
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut carol_manager,
            &mut carol_groups,
            carol.owner_pubkey,
            alice.owner_pubkey,
            &created.prepared,
            1_900_046_112,
            1_900_046_112,
        )?
        .len(),
        2
    );

    let before_remove = bob_groups.send_message(
        &mut bob_manager,
        &mut context(1_900_046_113, 1_900_046_113),
        &created.group.group_id,
        b"before carol removed".to_vec(),
    )?;
    assert!(
        before_remove
            .remote
            .deliveries
            .iter()
            .any(|delivery| delivery.owner_pubkey == carol.owner_pubkey),
        "bob's sender key should be distributed to carol before removal"
    );
    let bob_distribution =
        latest_sender_key_distribution(&bob_groups, &created.group.group_id, bob.owner_pubkey);
    let _ =
        install_sender_key_distribution(&mut carol_groups, &bob, bob_distribution, 1_900_046_114)?;
    let carol_before = carol_groups.handle_sender_key_message(sender_key_message_from_envelope(
        &before_remove.remote.sender_key_messages[0],
    ))?;
    assert!(
        matches!(
            &carol_before,
            GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
                if message.body == b"before carol removed".to_vec()
        ),
        "unexpected pre-removal result: {carol_before:?}"
    );

    let removed = alice_groups.remove_members(
        &mut alice_manager,
        &mut context(1_900_046_116, 1_900_046_116),
        &created.group.group_id,
        vec![carol.owner_pubkey],
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &removed,
            1_900_046_117,
            1_900_046_117,
        )?
        .len(),
        2
    );
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut carol_manager,
            &mut carol_groups,
            carol.owner_pubkey,
            alice.owner_pubkey,
            &removed,
            1_900_046_118,
            1_900_046_118,
        )?
        .len(),
        1
    );

    let future = bob_groups.send_message(
        &mut bob_manager,
        &mut context(1_900_046_119, 1_900_046_119),
        &created.group.group_id,
        b"after carol removed".to_vec(),
    )?;
    assert!(
        future
            .remote
            .deliveries
            .iter()
            .all(|delivery| delivery.owner_pubkey != carol.owner_pubkey),
        "removed member must not receive the rotated sender-key distribution"
    );
    let carol_result = carol_groups.handle_sender_key_message(sender_key_message_from_envelope(
        &future.remote.sender_key_messages[0],
    ))?;
    assert!(matches!(
        carol_result,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));

    Ok(())
}
