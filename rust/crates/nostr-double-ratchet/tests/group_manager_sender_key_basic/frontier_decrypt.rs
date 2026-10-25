use super::*;

fn populated() -> Result<(SenderKeyFixture, GroupSenderKeyMessage)> {
    let mut fixture = established_sender_key_fixture(140, 1_900_091_000)?;
    let mut snapshot = fixture.bob_groups.snapshot();
    snapshot.sender_keys[0].states[0].key_id = 7;
    snapshot.sender_keys[0].latest_key_id = Some(7);
    fixture.bob_groups = GroupManager::from_snapshot(snapshot)?;
    let mut previous = frame(&fixture, 2_000)?;
    previous.encrypted_header = None;
    fixture.bob_groups.handle_sender_key_message(previous)?;
    let current = frame(&fixture, 2_001)?;
    let mut snapshot = fixture.bob_groups.snapshot();
    assert_eq!(snapshot.sender_keys[0].states[0].skipped_len(), 2_000);
    snapshot.sender_keys[0].states.extend([
        SenderKeyState::new(1, [1; 32], 0),
        SenderKeyState::new(9, [9; 32], 0),
    ]);
    fixture.bob_groups = GroupManager::from_snapshot(snapshot)?;
    Ok((fixture, current))
}

#[test]
fn frontier_latest_epoch_authenticates_in_one_trial_without_consuming_skipped_keys() -> Result<()> {
    let (mut fixture, mut message) = populated()?;
    // These placeholders are not trusted positions. The hidden header stays intact.
    message.key_id = u32::MAX;
    message.message_number = u32::MAX;
    let original_message = message.clone();
    let before = fixture.bob_groups.snapshot();
    let mut remaining = 1;
    let plan = fixture
        .bob_groups
        .plan_sender_key_message_frontier_with_budget(&message, &mut remaining)?
        .expect("the locally latest epoch's next message needs one trial");
    assert_eq!(remaining, 0);
    assert_eq!(message, original_message);
    assert_eq!(fixture.bob_groups.snapshot(), before);
    assert!(
        matches!(fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(received))
            if received.body == b"bounded recovery")
    );
    let after = fixture.bob_groups.snapshot();
    let old = before.sender_keys[0]
        .states
        .iter()
        .find(|state| state.key_id() == 7)
        .unwrap();
    let new = after.sender_keys[0]
        .states
        .iter()
        .find(|state| state.key_id() == 7)
        .unwrap();
    assert_eq!(new.iteration(), old.iteration() + 1);
    assert_eq!(new.skipped_len(), 2_000);
    assert_eq!(
        serde_json::to_value(old)?["skipped_message_keys"],
        serde_json::to_value(new)?["skipped_message_keys"]
    );
    for key in [1, 9] {
        assert_eq!(
            before.sender_keys[0]
                .states
                .iter()
                .find(|state| state.key_id() == key),
            after.sender_keys[0]
                .states
                .iter()
                .find(|state| state.key_id() == key)
        );
    }
    Ok(())
}

#[test]
fn frontier_budget_bounds_misses_and_other_epoch_trials_without_mutation() -> Result<()> {
    let (mut fixture, message) = populated()?;
    let mut snapshot = fixture.bob_groups.snapshot();
    snapshot.sender_keys[0].latest_key_id = Some(9);
    fixture.bob_groups = GroupManager::from_snapshot(snapshot)?;
    let before = fixture.bob_groups.snapshot();
    for budget in [0, 1] {
        let mut remaining = budget;
        assert!(fixture
            .bob_groups
            .plan_sender_key_message_frontier_with_budget(&message, &mut remaining)?
            .is_none());
        assert_eq!(remaining, 0);
        assert_eq!(fixture.bob_groups.snapshot(), before);
    }
    let mut remaining = 2;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_frontier_with_budget(&message, &mut remaining)?
        .is_some());
    assert_eq!(remaining, 0);
    for malformed in [false, true] {
        let mut invalid = message.clone();
        if malformed {
            invalid.ciphertext.clear();
        } else {
            invalid.ciphertext[20] ^= 1;
        }
        for budget in [0, 1, 2, 5] {
            let mut remaining = budget;
            assert!(fixture
                .bob_groups
                .plan_sender_key_message_frontier_with_budget(&invalid, &mut remaining)?
                .is_none());
            assert_eq!(remaining, budget.saturating_sub(3));
            assert_eq!(fixture.bob_groups.snapshot(), before);
        }
    }
    Ok(())
}

#[test]
fn frontier_probe_preserves_an_unfinished_history_cursor() -> Result<()> {
    let mut fixture = established_sender_key_fixture(142, 1_900_091_100)?;
    let current = frame(&fixture, 0)?;
    let history = frame(&fixture, 700)?;
    let before = fixture.bob_groups.snapshot();
    let mut cursor = None;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_with_budget(history.clone(), &mut cursor, &mut 64)?
        .is_none());
    let mut original_cursor = cursor.clone();
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_frontier_with_budget(&current, &mut 1)?
        .is_some());
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_frontier_with_budget(&history, &mut 1)?
        .is_none());
    assert_eq!(fixture.bob_groups.snapshot(), before);
    let plan = fixture
        .bob_groups
        .plan_sender_key_message_with_budget(history.clone(), &mut cursor, &mut 637)?
        .expect("the history cursor must resume after its first 64 trials");
    let mut reference = GroupManager::from_snapshot(before)?;
    let expected = reference
        .plan_sender_key_message_with_budget(history, &mut original_cursor, &mut 637)?
        .unwrap();
    assert_eq!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        reference.apply_sender_key_receive_plan(expected)?
    );
    assert_eq!(fixture.bob_groups.snapshot(), reference.snapshot());
    Ok(())
}

#[test]
fn frontier_miss_does_not_block_later_distribution_or_history_recovery() -> Result<()> {
    let mut fixture = established_sender_key_fixture(144, 1_900_091_200)?;
    let message = frame(&fixture, 5)?;
    let saved = fixture.bob_groups.snapshot();
    let state = saved.sender_keys[0].states[0].clone();
    let mut missing = saved.clone();
    missing.sender_keys[0].states.clear();
    missing.sender_keys[0].latest_key_id = None;
    fixture.bob_groups = GroupManager::from_snapshot(missing.clone())?;
    let mut remaining = 4;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_frontier_with_budget(&message, &mut remaining)?
        .is_none());
    assert_eq!(remaining, 4);
    assert_eq!(fixture.bob_groups.snapshot(), missing);
    install_sender_key_distribution(
        &mut fixture.bob_groups,
        &fixture.alice,
        SenderKeyDistribution {
            group_id: fixture.group_id.clone(),
            key_id: state.key_id(),
            sender_event_pubkey: message.sender_event_pubkey,
            chain_key: state.chain_key(),
            iteration: state.iteration(),
            created_at: UnixSeconds(70),
        },
        70,
    )?;
    assert!(fixture
        .bob_groups
        .plan_sender_key_message_frontier_with_budget(&message, &mut 4)?
        .is_none());
    let plan = finish(&fixture.bob_groups, &message, &mut None)?;
    assert!(matches!(
        fixture.bob_groups.apply_sender_key_receive_plan(plan)?,
        GroupSenderKeyHandleResult::Event(_)
    ));
    Ok(())
}

#[test]
fn frontier_plan_rechecks_ratchet_revision_membership_and_author_at_apply() -> Result<()> {
    for mode in 0..5 {
        let mut fixture =
            established_sender_key_fixture(146 + mode, 1_900_091_300 + u64::from(mode) * 100)?;
        let message = frame(&fixture, 0)?;
        let plan = fixture
            .bob_groups
            .plan_sender_key_message_frontier_with_budget(&message, &mut 1)?
            .unwrap();
        if mode == 0 {
            fixture
                .bob_groups
                .apply_sender_key_receive_plan(plan.clone())?;
        } else if mode == 4 {
            let mut snapshot = fixture.bob_groups.snapshot();
            snapshot.sender_keys[0].sender_event_pubkey = manager_device(210, 211).device_pubkey;
            fixture.bob_groups = GroupManager::from_snapshot(snapshot)?;
        } else {
            let local = fixture.bob_groups.snapshot().local_owner_pubkey;
            let sender = fixture.alice.owner_pubkey;
            metadata(&mut fixture, |group| match mode {
                1 => {}
                2 => group.members.retain(|member| *member != local),
                _ => {
                    group.members.retain(|member| *member != sender);
                    group.admins = vec![local];
                }
            })?;
        }
        let before = fixture.bob_groups.snapshot();
        assert!(fixture
            .bob_groups
            .apply_sender_key_receive_plan(plan)
            .is_err());
        assert_eq!(fixture.bob_groups.snapshot(), before);
    }
    Ok(())
}
