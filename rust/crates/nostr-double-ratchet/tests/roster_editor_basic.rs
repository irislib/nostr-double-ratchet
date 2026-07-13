mod support;
use support::SessionManagerCompatExt;

use nostr_double_ratchet::{DevicePubkey, Result, RosterEditor, UnixSeconds};
use support::{
    context, manager_device, manager_device_snapshot, manager_public_device_invite,
    manager_user_snapshot, prepared_targets, roster_for, session_manager,
};

#[test]
fn device_pubkey_can_be_derived_from_secret_bytes() -> Result<()> {
    let alice = manager_device(1, 11);
    assert_eq!(
        DevicePubkey::from_secret_bytes(alice.secret_key)?,
        alice.device_pubkey
    );
    Ok(())
}

#[test]
fn roster_editor_builds_authoritative_snapshot_with_add_and_remove() {
    let alice1 = manager_device(2, 21);
    let alice2 = manager_device(2, 22);

    let mut editor = RosterEditor::new();
    assert!(editor.authorize_device(alice1.device_pubkey, UnixSeconds(10)));
    assert!(editor.authorize_device(alice2.device_pubkey, UnixSeconds(12)));
    assert!(!editor.authorize_device(alice2.device_pubkey, UnixSeconds(13)));
    assert!(editor.authorize_device(alice2.device_pubkey, UnixSeconds(9)));
    assert!(editor.contains_device(alice1.device_pubkey));
    assert!(editor.revoke_device(alice1.device_pubkey));
    assert!(!editor.contains_device(alice1.device_pubkey));

    let roster = editor.build(UnixSeconds(20));
    assert_eq!(roster.created_at, UnixSeconds(20));
    assert_eq!(roster.devices().len(), 1);
    assert_eq!(roster.devices()[0].device_pubkey, alice2.device_pubkey);
    assert_eq!(roster.devices()[0].created_at, UnixSeconds(9));
}

#[test]
fn removing_device_via_roster_editor_marks_it_stale_when_applied() {
    let alice1 = manager_device(3, 31);
    let alice2 = manager_device(3, 32);
    let mut manager = session_manager(&alice1);

    let mut editor = RosterEditor::new();
    editor.authorize_device(alice1.device_pubkey, UnixSeconds(30));
    editor.authorize_device(alice2.device_pubkey, UnixSeconds(30));
    manager.apply_local_roster(editor.build(UnixSeconds(30)));

    assert!(editor.revoke_device(alice2.device_pubkey));
    manager.apply_local_roster(editor.build(UnixSeconds(31)));

    let snapshot = manager.snapshot();
    let local_user = manager_user_snapshot(&snapshot, alice1.owner_pubkey);
    let alice2_record = manager_device_snapshot(local_user, alice2.device_pubkey);
    assert!(!alice2_record.authorized);
    assert!(alice2_record.is_stale);
    assert_eq!(alice2_record.stale_since, Some(UnixSeconds(31)));
}

#[test]
fn roster_editor_can_drive_local_sibling_fanout_without_session_manager_crud() -> Result<()> {
    let alice1 = manager_device(4, 41);
    let alice2 = manager_device(4, 42);
    let bob = manager_device(5, 51);

    let mut alice_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob_manager = session_manager(&bob);

    let mut local_roster = RosterEditor::new();
    local_roster.authorize_device(alice1.device_pubkey, UnixSeconds(40));
    local_roster.authorize_device(alice2.device_pubkey, UnixSeconds(41));
    alice_manager.apply_local_roster(local_roster.build(UnixSeconds(42)));

    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut alice2_manager,
        &alice2,
        42,
        1_850_000_042,
    )?)?;

    alice_manager.observe_peer_roster(bob.owner_pubkey, roster_for(&[&bob], 43));
    alice_manager.observe_device_invite(manager_public_device_invite(
        &mut bob_manager,
        &bob,
        43,
        1_850_000_043,
    )?)?;

    let mut send_ctx = context(44, 1_850_000_044);
    let prepared =
        alice_manager.prepare_send(&mut send_ctx, bob.owner_pubkey, b"fanout".to_vec())?;

    let targets: std::collections::BTreeSet<_> = prepared_targets(&prepared).into_iter().collect();
    assert!(targets.contains(&(bob.owner_pubkey, bob.device_pubkey)));
    assert!(targets.contains(&(alice1.owner_pubkey, alice2.device_pubkey)));
    assert!(!targets.contains(&(alice1.owner_pubkey, alice1.device_pubkey)));
    Ok(())
}
