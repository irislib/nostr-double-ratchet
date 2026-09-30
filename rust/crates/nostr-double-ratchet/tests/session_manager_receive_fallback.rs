mod support;

use nostr_double_ratchet::{wire as codec, Invite, Result, UnixSeconds};
use support::{
    context, manager_device, manager_device_snapshot, manager_user_snapshot,
    observe_signed_peer_app_keys, public_invite_via_url, receive_message, send_text,
    session_manager, snapshot,
};

#[test]
fn reply_to_new_session_is_tried_after_old_active_session_with_same_invite_author() -> Result<()> {
    receive_reply_after_stale_candidates(0)
}

#[test]
fn reply_to_new_session_is_tried_after_earlier_inactive_session_with_same_invite_author(
) -> Result<()> {
    receive_reply_after_stale_candidates(1)
}

fn receive_reply_after_stale_candidates(stale_inactive_count: usize) -> Result<()> {
    let alice = manager_device(31, 131);
    let bob = manager_device(32, 132);
    let now = 1_820_000_000;
    let mut invite_ctx = context(1, now);
    let mut owned_invite = Invite::create_new_with_context(
        &mut invite_ctx,
        bob.device_pubkey,
        Some(bob.owner_pubkey),
        None,
    )?;
    let public_invite = public_invite_via_url(&owned_invite)?;

    // Two real acceptances of the same public invitation have the same first
    // reply author, but different session secrets.
    let mut old_ctx = context(2, now + 1);
    let (mut old_session, old_response) = public_invite.accept_with_owner_context(
        &mut old_ctx,
        alice.device_pubkey,
        alice.secret_key,
        Some(alice.owner_pubkey),
    )?;
    let old_first = send_text(&mut old_session, &mut old_ctx, "old first message")?;
    send_text(&mut old_session, &mut old_ctx, "old second message")?;
    let mut old_bob_ctx = context(7, now + 1);
    let old_response_event = codec::invite_response_event(&old_response)?;
    let mut old_bob_session = owned_invite
        .process_response(
            &mut old_bob_ctx,
            &codec::parse_invite_response_event(&old_response_event)?,
            bob.secret_key,
        )?
        .session;
    receive_message(&mut old_bob_session, &mut old_bob_ctx, &old_first.incoming)?;
    let old_reply = send_text(&mut old_bob_session, &mut old_bob_ctx, "old reply")?;

    let mut new_ctx = context(3, now + 2);
    let (mut new_session, response) = public_invite.accept_with_owner_context(
        &mut new_ctx,
        alice.device_pubkey,
        alice.secret_key,
        Some(alice.owner_pubkey),
    )?;
    let first = send_text(&mut new_session, &mut new_ctx, "new first message")?;
    let response_event = codec::invite_response_event(&response)?;
    let incoming_response = codec::parse_invite_response_event(&response_event)?;
    let mut bob_ctx = context(4, now + 3);
    let mut bob_session = owned_invite
        .process_response(&mut bob_ctx, &incoming_response, bob.secret_key)?
        .session;
    assert_eq!(
        receive_message(&mut bob_session, &mut bob_ctx, &first.incoming)?,
        b"new first message"
    );
    let reply = send_text(&mut bob_session, &mut bob_ctx, "reply to new session")?;

    // Prove the routing ambiguity and the valid later candidate independently
    // of SessionManager, without modifying either candidate's ratchet state.
    assert!(old_session.matches_sender(reply.incoming.sender));
    assert!(new_session.matches_sender(reply.incoming.sender));
    let mut check_ctx = context(5, now + 4);
    assert!(old_session
        .plan_receive(&mut check_ctx, &reply.incoming)
        .is_err());
    assert_eq!(
        new_session
            .plan_receive(&mut check_ctx, &reply.incoming)?
            .payload,
        b"reply to new session"
    );

    let mut manager = session_manager(&alice);
    observe_signed_peer_app_keys(&mut manager, &bob, &[&bob], now)?;
    manager.import_session_state(
        bob.owner_pubkey,
        bob.device_pubkey,
        old_session.state.clone(),
        UnixSeconds(now + 4),
    );
    for index in 0..stale_inactive_count {
        let mut stale_ctx = context(10 + index as u64, now + 2);
        let (mut stale_session, _) = public_invite.accept_with_owner_context(
            &mut stale_ctx,
            alice.device_pubkey,
            alice.secret_key,
            Some(alice.owner_pubkey),
        )?;
        send_text(
            &mut stale_session,
            &mut stale_ctx,
            "earlier inactive message",
        )?;
        assert!(stale_session.matches_sender(reply.incoming.sender));
        assert!(stale_session
            .plan_receive(&mut stale_ctx, &reply.incoming)
            .is_err());
        manager.import_session_state(
            bob.owner_pubkey,
            bob.device_pubkey,
            stale_session.state,
            UnixSeconds(now + 4),
        );
    }
    manager.import_session_state(
        bob.owner_pubkey,
        bob.device_pubkey,
        new_session.state.clone(),
        UnixSeconds(now + 4),
    );
    let before = manager.snapshot();
    let device = manager_device_snapshot(
        manager_user_snapshot(&before, bob.owner_pubkey),
        bob.device_pubkey,
    );
    assert_eq!(device.active_session.as_ref(), Some(&old_session.state));
    assert_eq!(device.inactive_sessions.len(), stale_inactive_count + 1);
    assert_eq!(device.inactive_sessions.last(), Some(&new_session.state));

    // A matching author is only a routing hint: even after a valid header,
    // payload authentication can fail. No candidate may advance in that case.
    let mut invalid_reply = reply.incoming.clone();
    invalid_reply.ciphertext = "invalid ciphertext".to_owned();
    let mut failed_ctx = context(8, now + 5);
    let original_error = old_session
        .plan_receive(&mut failed_ctx, &invalid_reply)
        .unwrap_err();
    let error = manager
        .receive(&mut failed_ctx, bob.owner_pubkey, &invalid_reply)
        .expect_err("all matching sessions reject the invalid reply");
    assert_eq!(error.to_string(), original_error.to_string());
    assert_eq!(snapshot(&manager.snapshot()), snapshot(&before));

    let mut receive_ctx = context(6, now + 5);
    let received = manager
        .receive(&mut receive_ctx, bob.owner_pubkey, &reply.incoming)
        .expect("an earlier matching session's decryption failure must not hide a valid session")
        .expect("the newer session must receive its reply");
    assert_eq!(received.owner_pubkey, bob.owner_pubkey);
    assert_eq!(received.device_pubkey, bob.device_pubkey);
    assert_eq!(received.payload, b"reply to new session");

    let after = manager.snapshot();
    let device = manager_device_snapshot(
        manager_user_snapshot(&after, bob.owner_pubkey),
        bob.device_pubkey,
    );
    assert!(device.inactive_sessions.contains(&old_session.state));
    let old_received = manager
        .receive(&mut receive_ctx, bob.owner_pubkey, &old_reply.incoming)?
        .expect("trying a failed candidate must preserve its later valid messages");
    assert_eq!(old_received.payload, b"old reply");
    Ok(())
}
