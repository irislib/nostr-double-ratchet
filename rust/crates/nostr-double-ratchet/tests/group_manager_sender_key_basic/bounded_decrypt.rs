use super::*;
use nostr_double_ratchet::{
    GroupSenderKeyDecryptCursor, GroupSenderKeyReceivePlan, SenderKeyState,
};

fn frame(fixture: &SenderKeyFixture, number: u32) -> Result<GroupSenderKeyMessage> {
    let snapshot = fixture.bob_groups.snapshot();
    let record = &snapshot.sender_keys[0];
    let group = &snapshot.groups[0];
    let plaintext = JsonGroupPayloadCodecV1.encode_sender_key_plaintext(
        GroupPayloadEncodeContext {
            local_device_pubkey: fixture.alice.device_pubkey,
            created_at: UnixSeconds(50),
        },
        &nostr_double_ratchet::GroupSenderKeyPlaintext {
            group_id: group.group_id.clone(),
            revision: group.revision,
            body: b"bounded recovery".to_vec(),
        },
    )?;
    let mut sender = record.states[0].clone();
    let mut ciphertext = Vec::new();
    for _ in sender.iteration()..=number {
        ciphertext = sender.encrypt_to_bytes(&plaintext)?.1;
    }
    Ok(GroupSenderKeyMessage {
        group_id: group.group_id.clone(),
        sender_event_pubkey: record.sender_event_pubkey,
        key_id: sender.key_id(),
        message_number: number,
        encrypted_header: Some("hidden".into()),
        created_at: UnixSeconds(50),
        ciphertext,
    })
}

fn finish(
    groups: &GroupManager,
    message: &GroupSenderKeyMessage,
    cursor: &mut Option<GroupSenderKeyDecryptCursor>,
) -> Result<GroupSenderKeyReceivePlan> {
    for _ in 0..128 {
        if let Some(plan) =
            groups.plan_sender_key_message_with_budget(message.clone(), cursor, &mut 256)?
        {
            return Ok(plan);
        }
    }
    panic!("frozen workset must complete in a bounded number of turns");
}

fn metadata(
    fixture: &mut SenderKeyFixture,
    update: impl FnOnce(&mut nostr_double_ratchet::GroupSnapshot),
) -> Result<()> {
    let mut snapshot = fixture.bob_groups.snapshot().groups.remove(0);
    snapshot.revision += 1;
    update(&mut snapshot);
    let payload = JsonGroupPayloadCodecV1.encode_pairwise_command(
        GroupPayloadEncodeContext {
            local_device_pubkey: fixture.alice.device_pubkey,
            created_at: UnixSeconds(60),
        },
        &GroupPairwiseCommand::MetadataSnapshot { snapshot },
    )?;
    fixture.bob_groups.handle_pairwise_payload(
        fixture.alice.owner_pubkey,
        fixture.alice.device_pubkey,
        &payload,
    )?;
    Ok(())
}

#[test]
fn bounded_receive_is_pure_and_cancelable_until_apply() -> Result<()> {
    let mut fixture = established_sender_key_fixture(120, 1_900_090_000)?;
    let message = frame(&fixture, 700)?;
    let before = fixture.bob_groups.snapshot();
    let mut cursor = None;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_with_budget(message.clone(), &mut cursor, &mut 64)?
        .is_none());
    assert!(cursor.is_some());
    assert_eq!(fixture.bob_groups.snapshot(), before);
    cursor = None;
    let plan = finish(&fixture.bob_groups, &message, &mut cursor)?;
    assert!(cursor.is_none());
    assert_eq!(fixture.bob_groups.snapshot(), before);
    let mut legacy = GroupManager::from_snapshot(before)?;
    assert_eq!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        legacy.handle_sender_key_message(message)?
    );
    assert_eq!(fixture.bob_groups.snapshot(), legacy.snapshot());
    Ok(())
}

#[test]
fn bounded_receive_resets_for_different_ciphertext_author_or_group() -> Result<()> {
    let mut fixture = established_sender_key_fixture(122, 1_900_090_100)?;
    let long = frame(&fixture, 700)?;
    let short = frame(&fixture, 10)?;
    let mut cursor = None;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_with_budget(long.clone(), &mut cursor, &mut 64)?
        .is_none());
    let plan = fixture
        .bob_groups
        .plan_sender_key_message_with_budget(short, &mut cursor, &mut 64)?
        .expect("new ciphertext restarts from its actual state");
    assert!(matches!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        GroupSenderKeyHandleResult::Event(_)
    ));
    for change_author in [false, true] {
        assert!(fixture
            .bob_groups
            .plan_sender_key_message_with_budget(long.clone(), &mut cursor, &mut 64)?
            .is_none());
        let mut changed = long.clone();
        if change_author {
            changed.sender_event_pubkey = manager_device(200, 201).device_pubkey;
        } else {
            changed.group_id = "another group".into();
        }
        let plan = fixture
            .bob_groups
            .plan_sender_key_message_with_budget(changed, &mut cursor, &mut 64)?
            .expect("unmapped/mismatched identity completes without using old cursor");
        assert!(cursor.is_none());
        assert!(!matches!(
            fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
            GroupSenderKeyHandleResult::Event(_)
        ));
    }
    Ok(())
}

#[test]
fn bounded_receive_revalidates_authenticated_membership_and_revision() -> Result<()> {
    for mode in 0..3 {
        let mut fixture =
            established_sender_key_fixture(124 + mode, 1_900_090_200 + u64::from(mode) * 100)?;
        let message = frame(&fixture, 700)?;
        let mut cursor = None;
        assert!(fixture
            .bob_groups
            .plan_sender_key_message_with_budget(message.clone(), &mut cursor, &mut 64)?
            .is_none());
        let plan = finish(&fixture.bob_groups, &message, &mut cursor)?;
        let local = fixture.bob_groups.snapshot().local_owner_pubkey;
        let sender = fixture.alice.owner_pubkey;
        metadata(&mut fixture, |group| match mode {
            0 => {}
            1 => group.members.retain(|member| *member != local),
            _ => {
                group.members.retain(|member| *member != sender);
                group.admins = vec![local];
            }
        })?;
        let before = fixture.bob_groups.snapshot();
        assert!(fixture
            .bob_groups
            .apply_sender_key_receive_plan(plan)
            .is_err());
        assert_eq!(fixture.bob_groups.snapshot(), before);
        let next = finish(&fixture.bob_groups, &message, &mut cursor)?;
        assert!(matches!(
            fixture.bob_groups.apply_sender_key_receive_plan(next)?,
            GroupSenderKeyHandleResult::Ignored
        ));
        assert_eq!(fixture.bob_groups.snapshot(), before);
    }
    Ok(())
}

#[test]
fn bounded_receive_cancels_if_live_ratchet_advances_without_losing_new_keys() -> Result<()> {
    let mut fixture = established_sender_key_fixture(130, 1_900_090_600)?;
    let long = frame(&fixture, 700)?;
    let mut short = frame(&fixture, 5)?;
    short.encrypted_header = None;
    let mut cursor = None;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_with_budget(long.clone(), &mut cursor, &mut 64)?
        .is_none());
    assert!(matches!(
        fixture.bob_groups.handle_sender_key_message(short)?,
        GroupSenderKeyHandleResult::Event(_)
    ));
    let advanced = fixture.bob_groups.snapshot();
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_with_budget(long.clone(), &mut cursor, &mut 64)?
        .is_none());
    assert!(
        cursor.is_none(),
        "changed input signals cancellation/fair requeue"
    );
    assert_eq!(fixture.bob_groups.snapshot(), advanced);
    let plan = finish(&fixture.bob_groups, &long, &mut cursor)?;
    let mut reference = GroupManager::from_snapshot(advanced)?;
    assert_eq!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        reference.handle_sender_key_message(long)?
    );
    assert_eq!(fixture.bob_groups.snapshot(), reference.snapshot());
    Ok(())
}

#[test]
fn bounded_receive_skips_exhausted_key_state_instead_of_aborting_later_keys() -> Result<()> {
    let mut fixture = established_sender_key_fixture(132, 1_900_090_700)?;
    let message = frame(&fixture, 10)?;
    let mut snapshot = fixture.bob_groups.snapshot();
    snapshot.sender_keys[0]
        .states
        .insert(0, SenderKeyState::new(0, [1; 32], u32::MAX));
    fixture.bob_groups = GroupManager::from_snapshot(snapshot)?;
    let plan = finish(&fixture.bob_groups, &message, &mut None)?;
    assert!(matches!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        GroupSenderKeyHandleResult::Event(_)
    ));
    Ok(())
}

#[test]
fn bounded_receive_freezes_workset_while_authenticated_keys_keep_arriving() -> Result<()> {
    let mut fixture = established_sender_key_fixture(134, 1_900_090_800)?;
    let mut message = frame(&fixture, 0)?;
    message.ciphertext[20] ^= 1;
    let mut cursor = None;
    let mut completed = None;
    let original = fixture.bob_groups.snapshot().sender_keys[0].states[0].key_id();
    for turn in 0..45 {
        if let Some(plan) = fixture.bob_groups.plan_sender_key_message_with_budget(
            message.clone(),
            &mut cursor,
            &mut 256,
        )? {
            completed = Some(plan);
            break;
        }
        install_sender_key_distribution(
            &mut fixture.bob_groups,
            &fixture.alice,
            SenderKeyDistribution {
                group_id: fixture.group_id.clone(),
                key_id: original.wrapping_add(turn + 1),
                sender_event_pubkey: message.sender_event_pubkey,
                chain_key: [2; 32],
                iteration: 0,
                created_at: UnixSeconds(70 + u64::from(turn)),
            },
            70 + u64::from(turn),
        )?;
    }
    let plan = completed.expect("new key IDs cannot extend this search forever");
    assert!(matches!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        GroupSenderKeyHandleResult::PendingDistribution { .. }
    ));
    assert!(cursor.is_none());
    Ok(())
}
