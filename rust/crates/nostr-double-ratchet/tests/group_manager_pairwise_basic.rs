mod support;

use nostr_double_ratchet::GroupEventManager as GroupManager;
use nostr_double_ratchet::{
    GroupIncomingEvent, GroupManagerSnapshot, GroupPreparedSend, GroupProtocol, OwnerPubkey, Result,
};
use support::{
    context, manager_device, manager_observe_invite_response, manager_public_device_invite,
    manager_receive_delivery, observe_signed_peer_app_keys, roster_for, session_manager, snapshot,
};

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

fn observe_matching_group_invite_responses(
    manager: &mut nostr_double_ratchet::SessionManager,
    prepared: &GroupPreparedSend,
    seed: u64,
    now_secs: u64,
) -> Result<()> {
    observe_matching_invite_responses(manager, &prepared.remote.invite_responses, seed, now_secs)?;
    observe_matching_invite_responses(
        manager,
        &prepared.local_sibling.invite_responses,
        seed,
        now_secs,
    )
}

fn deliver_group_events(
    manager: &mut nostr_double_ratchet::SessionManager,
    groups: &mut GroupManager,
    sender_owner: OwnerPubkey,
    prepared: &GroupPreparedSend,
    target_device: nostr_double_ratchet::DevicePubkey,
    seed: u64,
    now_secs: u64,
) -> Result<Vec<GroupIncomingEvent>> {
    let mut ctx = context(seed, now_secs);
    let mut events = Vec::new();

    for delivery in prepared
        .remote
        .deliveries
        .iter()
        .chain(prepared.local_sibling.deliveries.iter())
        .filter(|delivery| delivery.device_pubkey == target_device)
    {
        if let Some(received) = manager_receive_delivery(manager, &mut ctx, sender_owner, delivery)?
        {
            if let Some(event) = groups.handle_incoming(received.owner_pubkey, &received.payload)? {
                events.push(event);
            }
        }
    }

    Ok(events)
}

#[test]
fn create_group_creates_local_state_and_snapshot_roundtrip() -> Result<()> {
    let alice = manager_device(1, 11);
    let bob = manager_device(2, 21);
    let mut manager = session_manager(&alice);
    let mut groups = GroupManager::new(alice.owner_pubkey);

    let mut create_ctx = context(1, 1_900_000_000);
    let created = groups.create_group(
        &mut manager,
        &mut create_ctx,
        "Friends".to_string(),
        vec![bob.owner_pubkey],
    )?;

    assert!(!created.group.group_id.is_empty());
    assert_eq!(created.group.protocol, GroupProtocol::PairwiseFanoutV1);
    assert_eq!(created.group.name, "Friends");
    assert_eq!(created.group.created_by, alice.owner_pubkey);
    assert_eq!(
        created.group.members,
        vec![alice.owner_pubkey, bob.owner_pubkey]
    );
    assert_eq!(created.group.admins, vec![alice.owner_pubkey]);
    assert_eq!(created.group.revision, 1);
    assert_eq!(created.prepared.group_id, created.group.group_id);
    assert_eq!(
        created.prepared.remote.relay_gaps,
        vec![nostr_double_ratchet::RelayGap::MissingRoster {
            owner_pubkey: bob.owner_pubkey,
        }]
    );

    let group_snapshot = groups.snapshot();
    let restored = GroupManager::from_snapshot(serde_json::from_str::<GroupManagerSnapshot>(
        &snapshot(&group_snapshot),
    )?)?;
    assert_eq!(
        restored.group(&created.group.group_id),
        Some(created.group.clone())
    );
    assert_eq!(restored.groups(), vec![created.group]);
    Ok(())
}

#[test]
fn retry_create_group_reuses_existing_group_id_without_remutating_state() -> Result<()> {
    let alice = manager_device(15, 151);
    let bob = manager_device(16, 161);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    let mut create_ctx = context(17, 1_900_001_100);
    let created = alice_groups.create_group(
        &mut alice_manager,
        &mut create_ctx,
        "RetryCreate".to_string(),
        vec![bob.owner_pubkey],
    )?;
    assert_eq!(created.prepared.remote.deliveries.len(), 0);
    assert_eq!(alice_groups.groups().len(), 1);

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 60)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 61)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 18, 1_900_001_101)?,
    )?;

    let mut retry_ctx = context(19, 1_900_001_102);
    let retried = alice_groups.retry_create_group(
        &mut alice_manager,
        &mut retry_ctx,
        &created.group.group_id,
        vec![bob.owner_pubkey],
    )?;

    assert_eq!(alice_groups.groups().len(), 1);
    assert_eq!(
        alice_groups
            .group(&created.group.group_id)
            .expect("group exists")
            .group_id,
        created.group.group_id
    );
    assert_eq!(retried.group_id, created.group.group_id);
    assert_eq!(retried.remote.deliveries.len(), 1);

    observe_matching_group_invite_responses(&mut bob_manager, &retried, 20, 1_900_001_103)?;
    let events = deliver_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice.owner_pubkey,
        &retried,
        bob.device_pubkey,
        21,
        1_900_001_104,
    )?;
    assert!(
        matches!(events.as_slice(), [GroupIncomingEvent::MetadataUpdated(snapshot)] if snapshot.group_id == created.group.group_id)
    );
    Ok(())
}

#[test]
fn add_members_bootstraps_new_member_with_current_group_state() -> Result<()> {
    let alice = manager_device(3, 31);
    let bob = manager_device(4, 41);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    let mut create_ctx = context(2, 1_900_000_100);
    let created = alice_groups.create_group(
        &mut alice_manager,
        &mut create_ctx,
        "Crew".to_string(),
        vec![],
    )?;

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 10)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 11)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 3, 1_900_000_101)?,
    )?;

    let mut add_ctx = context(4, 1_900_000_102);
    let prepared = alice_groups.add_members(
        &mut alice_manager,
        &mut add_ctx,
        &created.group.group_id,
        vec![bob.owner_pubkey],
    )?;

    observe_matching_group_invite_responses(&mut bob_manager, &prepared, 5, 1_900_000_103)?;
    let events = deliver_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice.owner_pubkey,
        &prepared,
        bob.device_pubkey,
        6,
        1_900_000_104,
    )?;

    assert_eq!(events.len(), 1);
    match &events[0] {
        GroupIncomingEvent::MetadataUpdated(snapshot) => {
            assert_eq!(snapshot.group_id, created.group.group_id);
            assert_eq!(snapshot.protocol, GroupProtocol::PairwiseFanoutV1);
            assert_eq!(snapshot.name, "Crew");
            assert_eq!(snapshot.revision, 2);
            let members: std::collections::BTreeSet<_> = snapshot.members.iter().copied().collect();
            assert_eq!(
                members,
                std::collections::BTreeSet::from([alice.owner_pubkey, bob.owner_pubkey])
            );
            assert_eq!(snapshot.admins, vec![alice.owner_pubkey]);
        }
        other => panic!("expected metadata update, got {other:?}"),
    }

    assert_eq!(
        bob_groups
            .group(&created.group.group_id)
            .expect("group created on new member")
            .revision,
        2
    );
    Ok(())
}

#[test]
fn retry_add_members_reuses_applied_group_state() -> Result<()> {
    let alice = manager_device(22, 221);
    let bob = manager_device(23, 231);

    let mut alice_manager = session_manager(&alice);
    let mut bob_manager = session_manager(&bob);
    let mut alice_groups = GroupManager::new(alice.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    let mut create_ctx = context(22, 1_900_001_200);
    let created = alice_groups.create_group(
        &mut alice_manager,
        &mut create_ctx,
        "RetryAdd".to_string(),
        vec![],
    )?;

    let mut add_ctx = context(24, 1_900_001_202);
    let initial = alice_groups.add_members(
        &mut alice_manager,
        &mut add_ctx,
        &created.group.group_id,
        vec![bob.owner_pubkey],
    )?;
    assert!(initial.remote.deliveries.is_empty());
    assert_eq!(
        initial.remote.relay_gaps,
        vec![nostr_double_ratchet::RelayGap::MissingRoster {
            owner_pubkey: bob.owner_pubkey,
        }]
    );

    observe_signed_peer_app_keys(&mut bob_manager, &alice, &[&alice], 62)?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob, &[&bob], 63)?;
    alice_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 23, 1_900_001_201)?,
    )?;

    let mut retry_ctx = context(25, 1_900_001_203);
    let retried = alice_groups.retry_add_members(
        &mut alice_manager,
        &mut retry_ctx,
        &created.group.group_id,
        vec![bob.owner_pubkey],
    )?;

    assert_eq!(
        alice_groups
            .group(&created.group.group_id)
            .expect("group exists")
            .revision,
        2
    );
    assert_eq!(retried.remote.deliveries.len(), 1);

    observe_matching_group_invite_responses(&mut bob_manager, &retried, 26, 1_900_001_204)?;
    let events = deliver_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice.owner_pubkey,
        &retried,
        bob.device_pubkey,
        27,
        1_900_001_205,
    )?;
    assert!(
        matches!(events.as_slice(), [GroupIncomingEvent::MetadataUpdated(snapshot)] if snapshot.revision == 2 && snapshot.protocol == GroupProtocol::PairwiseFanoutV1)
    );
    Ok(())
}

#[test]
fn create_and_send_message_fan_out_to_remote_member_and_local_sibling() -> Result<()> {
    let alice1 = manager_device(5, 51);
    let alice2 = manager_device(5, 52);
    let bob = manager_device(6, 61);

    let mut alice1_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob_manager = session_manager(&bob);

    let mut alice1_groups = GroupManager::new(alice1.owner_pubkey);
    let mut alice2_groups = GroupManager::new(alice2.owner_pubkey);
    let mut bob_groups = GroupManager::new(bob.owner_pubkey);

    alice1_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 20));
    alice2_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 20));
    observe_signed_peer_app_keys(&mut bob_manager, &alice1, &[&alice1], 20)?;
    alice1_manager.observe_device_invite(
        alice1.owner_pubkey,
        manager_public_device_invite(&mut alice2_manager, &alice2, 20, 1_900_000_200)?,
    )?;
    observe_signed_peer_app_keys(&mut alice1_manager, &bob, &[&bob], 21)?;
    alice1_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 21, 1_900_000_201)?,
    )?;

    let mut create_ctx = context(7, 1_900_000_202);
    let created = alice1_groups.create_group(
        &mut alice1_manager,
        &mut create_ctx,
        "Sidecar".to_string(),
        vec![bob.owner_pubkey],
    )?;

    observe_matching_group_invite_responses(
        &mut alice2_manager,
        &created.prepared,
        8,
        1_900_000_203,
    )?;
    observe_matching_group_invite_responses(&mut bob_manager, &created.prepared, 9, 1_900_000_204)?;

    let alice2_events = deliver_group_events(
        &mut alice2_manager,
        &mut alice2_groups,
        alice1.owner_pubkey,
        &created.prepared,
        alice2.device_pubkey,
        10,
        1_900_000_205,
    )?;
    let bob_events = deliver_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice1.owner_pubkey,
        &created.prepared,
        bob.device_pubkey,
        11,
        1_900_000_206,
    )?;
    assert!(matches!(
        alice2_events.as_slice(),
        [GroupIncomingEvent::MetadataUpdated(_)]
    ));
    assert!(matches!(
        bob_events.as_slice(),
        [GroupIncomingEvent::MetadataUpdated(_)]
    ));

    let mut send_ctx = context(12, 1_900_000_207);
    let sent = alice1_groups.send_message(
        &mut alice1_manager,
        &mut send_ctx,
        &created.group.group_id,
        b"hello-group".to_vec(),
    )?;

    let alice2_messages = deliver_group_events(
        &mut alice2_manager,
        &mut alice2_groups,
        alice1.owner_pubkey,
        &sent,
        alice2.device_pubkey,
        13,
        1_900_000_208,
    )?;
    let bob_messages = deliver_group_events(
        &mut bob_manager,
        &mut bob_groups,
        alice1.owner_pubkey,
        &sent,
        bob.device_pubkey,
        14,
        1_900_000_209,
    )?;

    assert_eq!(alice2_messages.len(), 2);
    assert_eq!(bob_messages.len(), 1);
    assert!(matches!(
        alice2_messages.as_slice(),
        [GroupIncomingEvent::MetadataUpdated(snapshot), GroupIncomingEvent::Message(message)]
            if snapshot.group_id == created.group.group_id
                && snapshot.protocol == GroupProtocol::PairwiseFanoutV1
                && message.group_id == created.group.group_id
                && message.sender_owner == alice1.owner_pubkey
                && message.body == b"hello-group".to_vec()
                && message.revision == 1
    ));
    match &bob_messages[0] {
        GroupIncomingEvent::Message(message) => {
            assert_eq!(message.group_id, created.group.group_id);
            assert_eq!(message.sender_owner, alice1.owner_pubkey);
            assert_eq!(message.body, b"hello-group".to_vec());
            assert_eq!(message.revision, 1);
        }
        other => panic!("expected group message, got {other:?}"),
    }

    assert_eq!(
        alice2_groups
            .group(&created.group.group_id)
            .expect("local sibling has group")
            .revision,
        1
    );
    assert_eq!(
        bob_groups
            .group(&created.group.group_id)
            .expect("remote member has group")
            .revision,
        1
    );
    Ok(())
}

#[test]
fn send_message_bootstraps_existing_group_to_new_local_sibling() -> Result<()> {
    let alice1 = manager_device(17, 171);
    let alice2 = manager_device(17, 172);
    let bob = manager_device(18, 181);

    let mut alice1_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob_manager = session_manager(&bob);

    let mut alice1_groups = GroupManager::new(alice1.owner_pubkey);
    let mut alice2_groups = GroupManager::new(alice2.owner_pubkey);
    let _bob_groups = GroupManager::new(bob.owner_pubkey);

    alice1_manager.apply_local_roster(roster_for(&[&alice1], 70));
    observe_signed_peer_app_keys(&mut alice1_manager, &bob, &[&bob], 71)?;
    alice1_manager.observe_device_invite(
        bob.owner_pubkey,
        manager_public_device_invite(&mut bob_manager, &bob, 72, 1_900_001_300)?,
    )?;

    let mut create_ctx = context(73, 1_900_001_301);
    let created = alice1_groups.create_group(
        &mut alice1_manager,
        &mut create_ctx,
        "Late sibling".to_string(),
        vec![bob.owner_pubkey],
    )?;

    alice1_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 76));
    alice2_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 76));
    alice1_manager.observe_device_invite(
        alice1.owner_pubkey,
        manager_public_device_invite(&mut alice2_manager, &alice2, 77, 1_900_001_304)?,
    )?;

    let mut send_ctx = context(78, 1_900_001_305);
    let sent = alice1_groups.send_message(
        &mut alice1_manager,
        &mut send_ctx,
        &created.group.group_id,
        b"hello-late-sibling".to_vec(),
    )?;

    observe_matching_group_invite_responses(&mut alice2_manager, &sent, 79, 1_900_001_306)?;
    observe_matching_group_invite_responses(&mut bob_manager, &sent, 80, 1_900_001_307)?;
    let alice2_events = deliver_group_events(
        &mut alice2_manager,
        &mut alice2_groups,
        alice1.owner_pubkey,
        &sent,
        alice2.device_pubkey,
        81,
        1_900_001_308,
    )?;
    assert_eq!(alice2_events.len(), 2);
    assert!(matches!(
        alice2_events.as_slice(),
        [GroupIncomingEvent::MetadataUpdated(snapshot), GroupIncomingEvent::Message(message)]
            if snapshot.group_id == created.group.group_id
                && snapshot.protocol == GroupProtocol::PairwiseFanoutV1
                && message.group_id == created.group.group_id
                && message.body == b"hello-late-sibling".to_vec()
    ));
    assert_eq!(
        alice2_groups
            .group(&created.group.group_id)
            .expect("local sibling has group after bootstrap")
            .revision,
        1
    );

    Ok(())
}

#[test]
fn send_message_merges_relay_gaps_from_members_without_transport_state() -> Result<()> {
    let alice = manager_device(7, 71);
    let bob = manager_device(8, 81);
    let carol = manager_device(9, 91);
    let mut manager = session_manager(&alice);
    let mut groups = GroupManager::new(alice.owner_pubkey);

    let mut create_ctx = context(15, 1_900_000_300);
    let created = groups.create_group(
        &mut manager,
        &mut create_ctx,
        "Gaps".to_string(),
        vec![bob.owner_pubkey, carol.owner_pubkey],
    )?;
    assert_eq!(created.prepared.remote.relay_gaps.len(), 2);

    observe_signed_peer_app_keys(&mut manager, &bob, &[&bob], 31)?;
    let mut send_ctx = context(16, 1_900_000_301);
    let prepared = groups.send_message(
        &mut manager,
        &mut send_ctx,
        &created.group.group_id,
        b"gap".to_vec(),
    )?;

    let expected = vec![
        nostr_double_ratchet::RelayGap::MissingRoster {
            owner_pubkey: carol.owner_pubkey,
        },
        nostr_double_ratchet::RelayGap::MissingDeviceInvite {
            owner_pubkey: bob.owner_pubkey,
            device_pubkey: bob.device_pubkey,
        },
    ];
    assert_eq!(prepared.remote.relay_gaps, expected);
    Ok(())
}
