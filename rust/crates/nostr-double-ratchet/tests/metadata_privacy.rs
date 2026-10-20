mod support;

use nostr_double_ratchet::{message_event, Result, SessionState, UnixSeconds};
use support::{bootstrap_via_invite_event, context, receive_event, restore_session};

#[test]
fn public_invite_transcript_never_signs_replies_with_the_announced_key() -> Result<()> {
    let mut boot = bootstrap_via_invite_event(1_700_100_100)?;
    let response = nostr_double_ratchet::invite_response_event(&boot.response_envelope)?;
    assert_eq!(
        response.tags.public_keys().next().unwrap().to_bytes(),
        boot.owned_invite.inviter_ephemeral_public_key.to_bytes()
    );
    for identity in [boot.alice.device_pubkey, boot.bob.device_pubkey] {
        assert!(!serde_json::to_string(&response)?.contains(&identity.to_string()));
    }
    for turn in 0..8 {
        let (sender, receiver, recipient, sender_identity) = if turn % 2 == 0 {
            (
                &mut boot.bob_session,
                &mut boot.alice_session,
                boot.alice.device_pubkey,
                boot.bob.device_pubkey,
            )
        } else {
            (
                &mut boot.alice_session,
                &mut boot.bob_session,
                boot.bob.device_pubkey,
                boot.alice.device_pubkey,
            )
        };
        let now = 1_700_100_110 + turn;
        let payload = format!("turn {turn}");
        let mut envelope = sender
            .apply_send(
                sender.plan_send(payload.as_bytes(), nostr_double_ratchet::UnixSeconds(now))?,
            )
            .envelope;
        envelope.recipient = Some(recipient);
        let event = message_event(&envelope)?;
        event.verify().unwrap();
        assert_ne!(
            event.pubkey.to_bytes(),
            boot.owned_invite.inviter_ephemeral_public_key.to_bytes()
        );
        assert!(!serde_json::to_string(&event)?.contains(&sender_identity.to_string()));
        let mut recv_ctx = context(turn, now);
        assert_eq!(
            receive_event(receiver, &mut recv_ctx, &event)?,
            payload.as_bytes()
        );
        boot.alice_session = restore_session(&boot.alice_session.state);
        boot.bob_session = restore_session(&boot.bob_session.state);
    }
    Ok(())
}

#[test]
fn unversioned_session_and_prepared_envelope_cannot_publish_or_route() -> Result<()> {
    let boot = bootstrap_via_invite_event(1_700_100_100)?;
    let mut state = serde_json::to_value(&boot.bob_session.state)?;
    state
        .as_object_mut()
        .unwrap()
        .remove("metadata_privacy_version");
    let old: SessionState = serde_json::from_value(state)?;
    let old_session = nostr_double_ratchet::Session::from_state(old);
    assert!(!old_session.can_send());
    assert!(!old_session.matches_sender(boot.owned_invite.inviter_ephemeral_public_key));
    assert!(old_session.plan_send(b"blocked", UnixSeconds(1)).is_err());
    let mut envelope = boot
        .bob_session
        .plan_send(b"pending", UnixSeconds(1))?
        .envelope;
    envelope.metadata_privacy_version = 0;
    assert!(message_event(&envelope).is_err());
    Ok(())
}
