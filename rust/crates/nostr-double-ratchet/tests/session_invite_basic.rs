mod support;

use nostr_double_ratchet::wire as codec;
use nostr_double_ratchet::{Invite, Result, MAX_SKIP};
use support::{
    actor, assert_payload_eq, bootstrap_via_invite_event, bootstrap_via_invite_url, context,
    direct_session_pair, payload_text, receive_event, restore_session, send_bytes, send_text,
    snapshot, ROOT_URL,
};

#[test]
fn invite_url_bootstrap_first_message_end_to_end() -> Result<()> {
    let mut boot = bootstrap_via_invite_url(1_700_100_000)?;

    let mut send_ctx = context(1, 1_700_100_010);
    let sent = send_text(&mut boot.bob_session, &mut send_ctx, "hello via url")?;

    let mut recv_ctx = context(2, 1_700_100_011);
    let received = receive_event(&mut boot.alice_session, &mut recv_ctx, &sent.event)?;
    assert_payload_eq(&received, &sent.payload);
    Ok(())
}

#[test]
fn invite_event_bootstrap_first_message_end_to_end() -> Result<()> {
    let mut boot = bootstrap_via_invite_event(1_700_100_100)?;

    let mut send_ctx = context(3, 1_700_100_110);
    let sent = send_text(&mut boot.bob_session, &mut send_ctx, "hello via event")?;

    let mut recv_ctx = context(4, 1_700_100_111);
    let received = receive_event(&mut boot.alice_session, &mut recv_ctx, &sent.event)?;
    assert_payload_eq(&received, &sent.payload);
    Ok(())
}

#[test]
fn post_bootstrap_bidirectional_ping_pong_over_many_turns() -> Result<()> {
    let mut boot = bootstrap_via_invite_url(1_700_100_200)?;
    let mut expected = Vec::new();
    let mut actual = Vec::new();

    for (index, text) in ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]
        .into_iter()
        .enumerate()
    {
        let secs = 1_700_100_210 + index as u64 * 2;
        if index % 2 == 0 {
            let mut send_ctx = context(10 + index as u64, secs);
            let sent = send_text(&mut boot.bob_session, &mut send_ctx, text)?;
            let mut recv_ctx = context(100 + index as u64, secs + 1);
            let received = receive_event(&mut boot.alice_session, &mut recv_ctx, &sent.event)?;
            expected.push(text.to_string());
            actual.push(payload_text(&received));
        } else {
            let mut send_ctx = context(10 + index as u64, secs);
            let sent = send_text(&mut boot.alice_session, &mut send_ctx, text)?;
            let mut recv_ctx = context(100 + index as u64, secs + 1);
            let received = receive_event(&mut boot.bob_session, &mut recv_ctx, &sent.event)?;
            expected.push(text.to_string());
            actual.push(payload_text(&received));
        }
    }

    assert_eq!(actual, expected);
    Ok(())
}

#[test]
fn same_sender_burst_before_reply() -> Result<()> {
    let (_alice, _bob, mut alice_session, mut bob_session) =
        direct_session_pair(1, 2, 1_700_100_300)?;

    let mut sent_messages = Vec::new();
    for index in 0..5 {
        let mut send_ctx = context(200 + index, 1_700_100_310 + index);
        sent_messages.push(send_text(
            &mut alice_session,
            &mut send_ctx,
            format!("burst-{index}"),
        )?);
    }

    for (index, sent) in sent_messages.iter().enumerate() {
        let mut recv_ctx = context(300 + index as u64, 1_700_100_320 + index as u64);
        let received = receive_event(&mut bob_session, &mut recv_ctx, &sent.event)?;
        assert_payload_eq(&received, &sent.payload);
    }

    let mut reply_ctx = context(400, 1_700_100_400);
    let reply = send_text(&mut bob_session, &mut reply_ctx, "reply")?;
    let mut recv_ctx = context(401, 1_700_100_401);
    let received = receive_event(&mut alice_session, &mut recv_ctx, &reply.event)?;
    assert_payload_eq(&received, &reply.payload);
    Ok(())
}

#[test]
fn out_of_order_within_single_chain_recovers_skipped_messages() -> Result<()> {
    let (_alice, _bob, mut alice_session, mut bob_session) =
        direct_session_pair(3, 4, 1_700_100_500)?;

    let mut sent = Vec::new();
    for index in 0..4 {
        let mut send_ctx = context(500 + index, 1_700_100_510 + index);
        sent.push(send_text(
            &mut alice_session,
            &mut send_ctx,
            format!("ooo-{index}"),
        )?);
    }

    for (receive_index, sent_index) in [3usize, 1, 0, 2].into_iter().enumerate() {
        let mut recv_ctx = context(
            600 + receive_index as u64,
            1_700_100_520 + receive_index as u64,
        );
        let received = receive_event(&mut bob_session, &mut recv_ctx, &sent[sent_index].event)?;
        assert_payload_eq(&received, &sent[sent_index].payload);
    }

    Ok(())
}

#[test]
fn session_state_serde_roundtrip_mid_conversation() -> Result<()> {
    let (_alice, _bob, mut alice_session, mut bob_session) =
        direct_session_pair(7, 8, 1_700_100_700)?;

    for index in 0..3 {
        let mut send_ctx = context(800 + index, 1_700_100_710 + index);
        let sent = send_text(&mut alice_session, &mut send_ctx, format!("before-{index}"))?;
        let mut recv_ctx = context(900 + index, 1_700_100_720 + index);
        let received = receive_event(&mut bob_session, &mut recv_ctx, &sent.event)?;
        assert_payload_eq(&received, &sent.payload);
    }

    alice_session = restore_session(&alice_session.state);
    bob_session = restore_session(&bob_session.state);

    let mut bob_send_ctx = context(950, 1_700_100_750);
    let sent = send_text(&mut bob_session, &mut bob_send_ctx, "after-restore")?;
    let mut recv_ctx = context(951, 1_700_100_751);
    let received = receive_event(&mut alice_session, &mut recv_ctx, &sent.event)?;
    assert_payload_eq(&received, &sent.payload);
    Ok(())
}

#[test]
fn owned_invite_serde_roundtrip_preserves_bootstrap_capability() -> Result<()> {
    let alice = actor(13);
    let bob = actor(14);
    let mut invite_ctx = context(1000, 1_700_100_800);
    let invite = Invite::create_new_with_context(&mut invite_ctx, alice.device_pubkey, None, None)?;
    let mut restored_owned_invite: Invite =
        serde_json::from_str(&serde_json::to_string(&invite).unwrap()).unwrap();

    let public_invite =
        codec::parse_invite_url(&codec::invite_url(&restored_owned_invite, ROOT_URL)?)?;

    let mut bob_accept_ctx = context(1001, 1_700_100_801);
    let (mut bob_session, response_envelope) = public_invite.accept_with_context(
        &mut bob_accept_ctx,
        bob.device_pubkey,
        bob.secret_key,
    )?;
    let response_event = codec::invite_response_event(&response_envelope)?;
    let incoming_response = codec::parse_invite_response_event(&response_event)?;

    let mut alice_process_ctx = context(1002, 1_700_100_802);
    let invite_response = restored_owned_invite.process_response(
        &mut alice_process_ctx,
        &incoming_response,
        alice.secret_key,
    )?;
    let mut alice_session = invite_response.session;

    let mut send_ctx = context(1003, 1_700_100_803);
    let sent = send_text(&mut bob_session, &mut send_ctx, "serde-owned-invite")?;
    let mut recv_ctx = context(1004, 1_700_100_804);
    let received = receive_event(&mut alice_session, &mut recv_ctx, &sent.event)?;
    assert_payload_eq(&received, &sent.payload);
    Ok(())
}

#[test]
fn opaque_binary_payload_survives_full_wire_path() -> Result<()> {
    let (_alice, _bob, mut alice_session, mut bob_session) =
        direct_session_pair(18, 19, 1_700_101_000)?;

    let payload = vec![0, 1, 2, 3, 0xff, 0x80, 0x7f, 42];
    let mut send_ctx = context(1200, 1_700_101_001);
    let sent = send_bytes(&mut alice_session, &mut send_ctx, payload.clone())?;
    let mut recv_ctx = context(1201, 1_700_101_002);
    let received = receive_event(&mut bob_session, &mut recv_ctx, &sent.event)?;
    assert_eq!(received, payload);
    let _ = MAX_SKIP;
    let _ = snapshot(&sent.payload);
    Ok(())
}
