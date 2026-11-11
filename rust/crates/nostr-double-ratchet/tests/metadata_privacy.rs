mod support;

use nostr::{EventBuilder, Keys, Kind, SecretKey, Tag, Timestamp};
use nostr_double_ratchet::{
    message_event, parse_message_event, PreparedSend, Result, SessionState, UnixSeconds,
    MESSAGE_EVENT_KIND,
};
use support::{
    bootstrap_via_invite_event, context, manager_device, manager_public_device_invite,
    observe_signed_peer_app_keys, receive_event, restore_session, roster_for, session_manager,
};

fn tag_names(event: &nostr::Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| tag.as_slice().first().cloned())
        .collect()
}

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
        let envelope = sender
            .apply_send(
                sender.plan_send(payload.as_bytes(), nostr_double_ratchet::UnixSeconds(now))?,
            )
            .envelope;
        let event = message_event(&envelope)?;
        event.verify().unwrap();
        assert_eq!(tag_names(&event), ["v", "header"]);
        assert!(!serde_json::to_string(&event)?.contains(&recipient.to_string()));
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

#[test]
fn session_manager_fanout_never_reveals_a_recipient_device() -> Result<()> {
    let alice1 = manager_device(5, 51);
    let alice2 = manager_device(5, 52);
    let bob1 = manager_device(6, 61);
    let bob2 = manager_device(6, 62);
    let mut alice_manager = session_manager(&alice1);
    let mut alice2_manager = session_manager(&alice2);
    let mut bob1_manager = session_manager(&bob1);
    let mut bob2_manager = session_manager(&bob2);

    alice_manager.apply_local_roster(roster_for(&[&alice1, &alice2], 20));
    alice_manager.observe_device_invite(
        alice1.owner_pubkey,
        manager_public_device_invite(&mut alice2_manager, &alice2, 20, 1_800_000_200)?,
    )?;
    observe_signed_peer_app_keys(&mut alice_manager, &bob1, &[&bob1, &bob2], 21)?;
    alice_manager.observe_device_invite(
        bob1.owner_pubkey,
        manager_public_device_invite(&mut bob1_manager, &bob1, 21, 1_800_000_201)?,
    )?;
    alice_manager.observe_device_invite(
        bob2.owner_pubkey,
        manager_public_device_invite(&mut bob2_manager, &bob2, 22, 1_800_000_202)?,
    )?;

    let identities: Vec<String> = [&alice1, &alice2, &bob1, &bob2]
        .iter()
        .flat_map(|device| {
            [
                device.owner_pubkey.to_string(),
                device.device_pubkey.to_string(),
            ]
        })
        .collect();
    let assert_private = |prepared: &PreparedSend| -> Result<()> {
        assert_eq!(prepared.deliveries.len(), 3);
        for delivery in &prepared.deliveries {
            assert_eq!(delivery.envelope.recipient, None);
            let event = message_event(&delivery.envelope)?;
            assert_eq!(tag_names(&event), ["v", "header"]);
            let wire = serde_json::to_string(&event)?;
            for identity in &identities {
                assert!(!wire.contains(identity), "message event reveals {identity}");
            }
        }
        Ok(())
    };

    // First contact goes through freshly accepted public invites, later sends
    // through the established sessions. Neither may name the recipient.
    let mut first_ctx = context(23, 1_800_000_203);
    let first = alice_manager.prepare_send(&mut first_ctx, bob1.owner_pubkey, b"cold".to_vec())?;
    assert_eq!(first.invite_responses.len(), 3);
    assert_private(&first)?;
    let mut second_ctx = context(24, 1_800_000_204);
    let second =
        alice_manager.prepare_send(&mut second_ctx, bob1.owner_pubkey, b"warm".to_vec())?;
    assert_private(&second)?;
    Ok(())
}

#[test]
fn recipient_tagged_envelopes_cannot_be_published_but_received_ones_still_decrypt() -> Result<()> {
    let mut boot = bootstrap_via_invite_event(1_700_100_100)?;
    let recipient = boot.alice.device_pubkey;
    let envelope = boot
        .bob_session
        .apply_send(
            boot.bob_session
                .plan_send(b"legacy", UnixSeconds(1_700_100_110))?,
        )
        .envelope;

    let mut tagged = envelope.clone();
    tagged.recipient = Some(recipient);
    assert!(message_event(&tagged).is_err());

    // Clients that still tag the recipient device remain readable.
    let signer = Keys::new(SecretKey::from_slice(&envelope.signer_secret_key).unwrap());
    let legacy = EventBuilder::new(Kind::from(MESSAGE_EVENT_KIND as u16), &envelope.ciphertext)
        .tag(Tag::parse(["v", "2"]).unwrap())
        .tag(Tag::parse(["header", envelope.encrypted_header.as_str()]).unwrap())
        .tag(Tag::parse(["p", &recipient.to_string()]).unwrap())
        .custom_created_at(Timestamp::from(envelope.created_at.get()))
        .sign_with_keys(&signer)
        .unwrap();
    assert_eq!(parse_message_event(&legacy)?.recipient, Some(recipient));
    let mut recv_ctx = context(1, 1_700_100_111);
    assert_eq!(
        receive_event(&mut boot.alice_session, &mut recv_ctx, &legacy)?,
        b"legacy"
    );
    Ok(())
}
