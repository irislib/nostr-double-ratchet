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

#[path = "group_manager_sender_key_basic/creation_and_sync.rs"]
mod creation_and_sync;
#[path = "group_manager_sender_key_basic/membership.rs"]
mod membership;
#[path = "group_manager_sender_key_basic/receive_state.rs"]
mod receive_state;
#[path = "group_manager_sender_key_basic/repair.rs"]
mod repair;
