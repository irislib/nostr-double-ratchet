mod support;

use nostr::{EventBuilder, Kind, Tag, Timestamp};
use nostr_double_ratchet::{GroupEventManager as GroupManager, JsonGroupPayloadCodecV1};
use nostr_double_ratchet::{
    GroupIncomingEvent, GroupManagerSnapshot, GroupPairwiseCommand, GroupPayloadCodec,
    GroupPayloadEncodeContext, GroupProtocol, GroupSenderKeyHandleResult, GroupSenderKeyMessage,
    GroupSenderKeyMessageEnvelope, Result, SenderKeyDistribution, SenderKeyRepairRequest,
    SessionManager, UnixSeconds,
};
use support::{
    context, manager_device, manager_observe_invite_response, manager_public_device_invite,
    manager_receive_delivery, observe_signed_peer_app_keys, roster_for, session_manager, snapshot,
};

struct SenderKeyFixture {
    alice: support::ManagerDevice,
    alice_manager: SessionManager,
    alice_groups: GroupManager,
    bob_groups: GroupManager,
    group_id: String,
}

struct SenderKeyLateMemberRepairFixture {
    bob: support::ManagerDevice,
    carol: support::ManagerDevice,
    bob_manager: SessionManager,
    carol_manager: SessionManager,
    bob_groups: GroupManager,
    carol_groups: GroupManager,
    group_id: String,
    pre_join_outer: GroupSenderKeyMessageEnvelope,
    post_join_outer: GroupSenderKeyMessageEnvelope,
}

fn sender_key_message_from_envelope(
    envelope: &GroupSenderKeyMessageEnvelope,
) -> GroupSenderKeyMessage {
    GroupSenderKeyMessage {
        group_id: envelope.group_id.clone(),
        sender_event_pubkey: envelope.sender_event_pubkey,
        key_id: envelope.key_id,
        message_number: envelope.message_number,
        encrypted_header: envelope.encrypted_header.clone(),
        created_at: envelope.created_at,
        ciphertext: envelope.ciphertext.clone(),
    }
}

fn observe_matching_invite_responses(
    manager: &mut nostr_double_ratchet::SessionManager,
    responses: &[nostr_double_ratchet::InviteResponseEnvelope],
    seed: u64,
    now_secs: u64,
) -> Result<()> {
    let recipient = manager
        .snapshot()
        .local_invite
        .expect("local invite must exist before filtering responses")
        .inviter_ephemeral_public_key;
    let mut ctx = context(seed, now_secs);
    for response in responses
        .iter()
        .filter(|response| response.recipient == recipient)
    {
        manager_observe_invite_response(manager, &mut ctx, response)?;
    }
    Ok(())
}

fn deliver_pairwise_group_events_for(
    manager: &mut nostr_double_ratchet::SessionManager,
    groups: &mut GroupManager,
    recipient_owner: nostr_double_ratchet::OwnerPubkey,
    sender_owner: nostr_double_ratchet::OwnerPubkey,
    prepared: &nostr_double_ratchet::GroupPreparedSend,
    seed: u64,
    now_secs: u64,
) -> Result<Vec<GroupIncomingEvent>> {
    let mut ctx = context(seed, now_secs);
    let mut events = Vec::new();
    for delivery in prepared
        .remote
        .deliveries
        .iter()
        .filter(|delivery| delivery.owner_pubkey == recipient_owner)
    {
        if let Some(received) = manager_receive_delivery(manager, &mut ctx, sender_owner, delivery)?
        {
            if let Some(event) = groups.handle_pairwise_payload(
                received.owner_pubkey,
                received.device_pubkey,
                &received.payload,
            )? {
                events.push(event);
            }
        }
    }
    Ok(events)
}

fn deliver_pairwise_group_events(
    manager: &mut nostr_double_ratchet::SessionManager,
    groups: &mut GroupManager,
    sender_owner: nostr_double_ratchet::OwnerPubkey,
    prepared: &nostr_double_ratchet::GroupPreparedSend,
    seed: u64,
    now_secs: u64,
) -> Result<Vec<GroupIncomingEvent>> {
    let mut ctx = context(seed, now_secs);
    let mut events = Vec::new();
    for delivery in prepared.remote.deliveries.iter() {
        if let Some(received) = manager_receive_delivery(manager, &mut ctx, sender_owner, delivery)?
        {
            if let Some(event) = groups.handle_pairwise_payload(
                received.owner_pubkey,
                received.device_pubkey,
                &received.payload,
            )? {
                events.push(event);
            }
        }
    }
    Ok(events)
}

fn latest_sender_key_distribution(
    groups: &GroupManager,
    group_id: &str,
    sender_owner: nostr_double_ratchet::OwnerPubkey,
) -> SenderKeyDistribution {
    let snapshot = groups.snapshot();
    let record = snapshot
        .sender_keys
        .into_iter()
        .find(|record| record.group_id == group_id && record.sender_owner == sender_owner)
        .expect("sender-key record");
    let key_id = record.latest_key_id.expect("latest sender key id");
    record
        .distribution_history
        .into_iter()
        .find(|distribution| distribution.key_id == key_id)
        .expect("sender-key distribution history")
}

fn install_sender_key_distribution(
    groups: &mut GroupManager,
    sender: &support::ManagerDevice,
    distribution: SenderKeyDistribution,
    now_secs: u64,
) -> Result<Option<GroupIncomingEvent>> {
    let codec = JsonGroupPayloadCodecV1;
    let payload = GroupPayloadCodec::encode_pairwise_command(
        &codec,
        GroupPayloadEncodeContext {
            local_device_pubkey: sender.device_pubkey,
            created_at: UnixSeconds(now_secs),
        },
        &GroupPairwiseCommand::SenderKeyDistribution { distribution },
    )?;
    groups.handle_pairwise_payload(sender.owner_pubkey, sender.device_pubkey, &payload)
}

fn established_sender_key_fixture(owner_fill: u8, base_secs: u64) -> Result<SenderKeyFixture> {
    let alice = manager_device(owner_fill, owner_fill.wrapping_add(40));
    let bob = manager_device(owner_fill.wrapping_add(1), owner_fill.wrapping_add(41));
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], base_secs)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], base_secs + 1)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, base_secs + 2, base_secs + 2)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(base_secs + 3, base_secs + 3),
        "Sender-key fixture".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    let group_id = created.group.group_id.clone();
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        base_secs + 4,
        base_secs + 4,
    )?;
    let create_events = deliver_pairwise_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice.owner_pubkey,
        &created.prepared,
        base_secs + 5,
        base_secs + 5,
    )?;
    assert_eq!(create_events.len(), 2);
    assert_eq!(bob_groups.known_sender_event_pubkeys().len(), 1);

    Ok(SenderKeyFixture {
        alice,
        alice_manager,
        alice_groups,
        bob_groups,
        group_id,
    })
}

fn late_member_repair_fixture(
    owner_fill: u8,
    base_secs: u64,
) -> Result<SenderKeyLateMemberRepairFixture> {
    let alice = manager_device(owner_fill, owner_fill.wrapping_add(40));
    let bob = manager_device(owner_fill.wrapping_add(1), owner_fill.wrapping_add(41));
    let carol = manager_device(owner_fill.wrapping_add(2), owner_fill.wrapping_add(42));
    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut carol_manager = session_manager(&carol);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);
    let mut carol_groups = GroupManager::new(carol.owner_pubkey);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], base_secs)?;
    observe_signed_peer_app_keys(&mut carol_manager, &alice, &[&alice], base_secs + 1)?;
    observe_signed_peer_app_keys(&mut carol_manager, &bob, &[&bob], base_secs + 2)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], base_secs + 3)?;
    observe_signed_peer_app_keys(&mut alice_manager, &carol, &[&carol], base_secs + 4)?;
    observe_signed_peer_app_keys(&mut bob_manager, &carol, &[&carol], base_secs + 5)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, base_secs + 6, base_secs + 6)?,
    )?;
    alice_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, base_secs + 7, base_secs + 7)?,
    )?;
    bob_manager.observe_device_invite(
        carol.owner_pubkey,
        manager_public_device_invite(&mut carol_manager, &carol, base_secs + 8, base_secs + 8)?,
    )?;

    let created = alice_groups.create_group_with_protocol(
        &mut alice_manager,
        &mut context(base_secs + 9, base_secs + 9),
        "Late member repair".to_string(),
        vec![bob.owner_pubkey],
        GroupProtocol::sender_key_v1(),
    )?;
    let group_id = created.group.group_id.clone();
    observe_matching_invite_responses(
        &mut bob_manager,
        &created.prepared.remote.invite_responses,
        base_secs + 10,
        base_secs + 10,
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &created.prepared,
            base_secs + 11,
            base_secs + 11,
        )?
        .len(),
        2
    );

    let pre_join = bob_groups.send_message(
        &mut bob_manager,
        &mut context(base_secs + 12, base_secs + 12),
        &group_id,
        b"pre-join from bob".to_vec(),
    )?;
    assert!(
        pre_join
            .remote
            .deliveries
            .iter()
            .any(|delivery| delivery.owner_pubkey == alice.owner_pubkey),
        "bob's first sender-key send should distribute to existing member alice"
    );
    deliver_pairwise_group_events_for(
        &mut alice_manager,
        &mut alice_groups,
        alice.owner_pubkey,
        bob.owner_pubkey,
        &pre_join,
        base_secs + 13,
        base_secs + 13,
    )?;
    assert!(matches!(
        alice_groups.handle_sender_key_message(sender_key_message_from_envelope(
            &pre_join.remote.sender_key_messages[0],
        ))?,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))
            if message.body == b"pre-join from bob".to_vec()
    ));

    let added = alice_groups.add_members(
        &mut alice_manager,
        &mut context(base_secs + 14, base_secs + 14),
        &group_id,
        vec![carol.owner_pubkey],
    )?;
    observe_matching_invite_responses(
        &mut carol_manager,
        &added.remote.invite_responses,
        base_secs + 15,
        base_secs + 15,
    )?;
    assert_eq!(
        deliver_pairwise_group_events_for(
            &mut bob_manager,
            &mut bob_groups,
            bob.owner_pubkey,
            alice.owner_pubkey,
            &added,
            base_secs + 16,
            base_secs + 16,
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
            base_secs + 17,
            base_secs + 17,
        )?
        .len(),
        2
    );

    let post_join = bob_groups.send_message(
        &mut bob_manager,
        &mut context(base_secs + 18, base_secs + 18),
        &group_id,
        b"post-join from bob".to_vec(),
    )?;
    observe_matching_invite_responses(
        &mut carol_manager,
        &post_join.remote.invite_responses,
        base_secs + 19,
        base_secs + 19,
    )?;
    assert!(
        post_join
            .remote
            .deliveries
            .iter()
            .any(|delivery| delivery.owner_pubkey == carol.owner_pubkey),
        "bob must distribute the current sender key to late member carol"
    );

    Ok(SenderKeyLateMemberRepairFixture {
        bob,
        carol,
        bob_manager,
        carol_manager,
        bob_groups,
        carol_groups,
        group_id,
        pre_join_outer: pre_join.remote.sender_key_messages[0].clone(),
        post_join_outer: post_join.remote.sender_key_messages[0].clone(),
    })
}

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
