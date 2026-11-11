use super::*;
use nostr_double_ratchet::{GroupSnapshot, SenderKeyState};

fn install_group_metadata(
    groups: &mut GroupManager,
    sender: &support::ManagerDevice,
    snapshot: GroupSnapshot,
    now_secs: u64,
) -> Result<Option<GroupIncomingEvent>> {
    let codec = JsonGroupPayloadCodecV1;
    let payload = GroupPayloadCodec::encode_pairwise_command(
        &codec,
        GroupPayloadEncodeContext {
            local_device_pubkey: sender.device_pubkey,
            created_at: UnixSeconds(now_secs),
        },
        &GroupPairwiseCommand::MetadataSnapshot { snapshot },
    )?;
    groups.handle_pairwise_payload(sender.owner_pubkey, sender.device_pubkey, &payload)
}

fn outer_message(
    envelope: &GroupSenderKeyMessageEnvelope,
    hidden_counter: bool,
) -> GroupSenderKeyMessage {
    let mut message = sender_key_message_from_envelope(envelope);
    if hidden_counter {
        message.encrypted_header = Some(String::new());
    }
    message
}

fn delivered_body(result: Result<GroupSenderKeyHandleResult>) -> Option<Vec<u8>> {
    match result {
        Ok(GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message))) => {
            Some(message.body)
        }
        _ => None,
    }
}

/// A device that was offline applies the newer roster first and then reads its
/// backlog. Messages from someone who is still a member must not be dropped
/// just because they were sent under the previous roster revision.
#[test]
fn sender_key_message_sent_before_a_roster_change_is_delivered_after_it() -> Result<()> {
    for hidden_counter in [true, false] {
        let mut fixture = established_sender_key_fixture(70, 1_900_070_000)?;
        let sent = fixture.alice_groups.send_message(
            &mut fixture.alice_manager,
            &mut context(1_900_070_010, 1_900_070_010),
            &fixture.group_id,
            b"sent before the rename".to_vec(),
        )?;
        let old_revision = fixture
            .alice_groups
            .group(&fixture.group_id)
            .expect("group")
            .revision;

        fixture.alice_groups.update_name(
            &mut fixture.alice_manager,
            &mut context(1_900_070_011, 1_900_070_011),
            &fixture.group_id,
            "Renamed".to_string(),
        )?;
        let renamed = fixture
            .alice_groups
            .group(&fixture.group_id)
            .expect("group");
        assert!(renamed.revision > old_revision);
        install_group_metadata(
            &mut fixture.bob_groups,
            &fixture.alice,
            renamed.clone(),
            1_900_070_012,
        )?;
        assert_eq!(
            fixture
                .bob_groups
                .group(&fixture.group_id)
                .expect("group")
                .revision,
            renamed.revision
        );

        let result = fixture.bob_groups.handle_sender_key_message(outer_message(
            &sent.remote.sender_key_messages[0],
            hidden_counter,
        ))?;
        match result {
            GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(message)) => {
                assert_eq!(message.body, b"sent before the rename");
                assert_eq!(message.revision, old_revision);
            }
            other => panic!("backlog message was not delivered: {other:?}"),
        }
    }
    Ok(())
}

fn advanced(origin: &SenderKeyDistribution, steps: usize) -> Result<SenderKeyDistribution> {
    let mut chain = SenderKeyState::new(origin.key_id, origin.chain_key, origin.iteration);
    for _ in 0..steps {
        chain.encrypt_to_bytes(b"advance")?;
    }
    let mut later = origin.clone();
    later.chain_key = chain.chain_key();
    later.iteration = chain.iteration();
    Ok(later)
}

/// Copies of one key distribution are made at different chain positions and
/// can arrive in any order. The first copy to arrive must not decide forever
/// which earlier messages are readable.
#[test]
fn earlier_sender_key_distribution_arriving_late_opens_earlier_messages() -> Result<()> {
    for hidden_counter in [true, false] {
        let mut fixture = established_sender_key_fixture(72, 1_900_072_000)?;
        let origin = latest_sender_key_distribution(
            &fixture.bob_groups,
            &fixture.group_id,
            fixture.alice.owner_pubkey,
        );
        let mut sent = Vec::new();
        for (index, body) in [&b"first"[..], b"second", b"third"].into_iter().enumerate() {
            let now = 1_900_072_010 + index as u64;
            let prepared = fixture.alice_groups.send_message(
                &mut fixture.alice_manager,
                &mut context(now, now),
                &fixture.group_id,
                body.to_vec(),
            )?;
            sent.push(outer_message(
                &prepared.remote.sender_key_messages[0],
                hidden_counter,
            ));
        }

        // This receiver first learns the key from a copy made two messages later.
        let mut snapshot = fixture.bob_groups.snapshot();
        snapshot.sender_keys.clear();
        let mut bob = GroupManager::from_snapshot(snapshot)?;
        install_sender_key_distribution(
            &mut bob,
            &fixture.alice,
            advanced(&origin, 2)?,
            1_900_072_020,
        )?;
        assert_eq!(
            delivered_body(bob.handle_sender_key_message(sent[2].clone())),
            Some(b"third".to_vec())
        );
        assert_eq!(
            delivered_body(bob.handle_sender_key_message(sent[0].clone())),
            None
        );

        // A copy that does not lead to the chain already held changes nothing.
        let mut unrelated = origin.clone();
        unrelated.chain_key = [9u8; 32];
        install_sender_key_distribution(&mut bob, &fixture.alice, unrelated, 1_900_072_021)?;
        assert_eq!(
            delivered_body(bob.handle_sender_key_message(sent[0].clone())),
            None
        );

        install_sender_key_distribution(&mut bob, &fixture.alice, origin.clone(), 1_900_072_022)?;
        assert_eq!(
            delivered_body(bob.handle_sender_key_message(sent[0].clone())),
            Some(b"first".to_vec())
        );
        assert_eq!(
            delivered_body(bob.handle_sender_key_message(sent[1].clone())),
            Some(b"second".to_vec())
        );

        // Nothing becomes readable twice, also when the early copy is repeated.
        install_sender_key_distribution(&mut bob, &fixture.alice, origin, 1_900_072_023)?;
        let mut restored = GroupManager::from_snapshot(bob.snapshot())?;
        for message in &sent {
            assert_eq!(
                delivered_body(restored.handle_sender_key_message(message.clone())),
                None
            );
        }
    }
    Ok(())
}

/// Two admins can edit the same roster revision while apart. Every device has
/// to settle on the same one of the two, whatever order they arrive in.
#[test]
fn conflicting_snapshots_at_one_revision_converge_in_any_arrival_order() -> Result<()> {
    for same_time in [false, true] {
        let mut winners = Vec::new();
        for reversed in [false, true] {
            let mut fixture = established_sender_key_fixture(74, 1_900_074_000)?;
            fixture.alice_groups.update_name(
                &mut fixture.alice_manager,
                &mut context(1_900_074_010, 1_900_074_010),
                &fixture.group_id,
                "One".to_string(),
            )?;
            let one = fixture
                .alice_groups
                .group(&fixture.group_id)
                .expect("group");
            let mut two = one.clone();
            two.name = "Two".to_string();
            if !same_time {
                two.updated_at = UnixSeconds(one.updated_at.get() + 1);
            }
            let mut order = [one.clone(), two.clone()];
            if reversed {
                order.reverse();
            }
            for snapshot in order {
                install_group_metadata(
                    &mut fixture.bob_groups,
                    &fixture.alice,
                    snapshot,
                    1_900_074_020,
                )?;
            }
            let settled = fixture.bob_groups.group(&fixture.group_id).expect("group");
            assert_eq!(settled.revision, one.revision);
            if !same_time {
                assert_eq!(settled.name, "Two", "the later edit wins");
            }
            winners.push(settled);
        }
        assert_eq!(winners[0], winners[1]);
    }
    Ok(())
}

#[test]
fn conflicting_snapshot_from_a_non_admin_is_rejected() -> Result<()> {
    let mut fixture = established_sender_key_fixture(76, 1_900_076_000)?;
    let stranger = manager_device(90, 130);
    let current = fixture.bob_groups.group(&fixture.group_id).expect("group");
    assert!(!current.admins.contains(&stranger.owner_pubkey));
    let mut forged = current.clone();
    forged.name = "Taken over".to_string();
    forged.updated_at = UnixSeconds(current.updated_at.get() + 100);
    assert!(
        install_group_metadata(&mut fixture.bob_groups, &stranger, forged, 1_900_076_010).is_err()
    );
    assert_eq!(
        fixture.bob_groups.group(&fixture.group_id).expect("group"),
        current
    );
    Ok(())
}
