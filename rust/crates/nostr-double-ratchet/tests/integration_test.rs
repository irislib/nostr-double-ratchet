use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag, UnsignedEvent};
use nostr_double_ratchet::{
    build_text_rumor, message_event, Result, Session, SessionNostrExt, UnixSeconds,
};

fn send_text(session: &mut Session, text: &str) -> Result<nostr::Event> {
    session.send_event(build_text_rumor(
        Keys::generate().public_key(),
        text,
        vec![],
    )?)
}

#[test]
fn test_alice_bob_conversation() -> Result<()> {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();

    let alice_sk = alice_keys.secret_key().to_secret_bytes();
    let bob_sk = bob_keys.secret_key().to_secret_bytes();

    let alice_pk = alice_keys.public_key();
    let bob_pk = bob_keys.public_key();

    let shared_secret = [42u8; 32];

    let mut alice = Session::init(
        bob_pk,
        alice_sk,
        true,
        shared_secret,
        Some("alice".to_string()),
    )?;

    let mut bob = Session::init(
        alice_pk,
        bob_sk,
        false,
        shared_secret,
        Some("bob".to_string()),
    )?;

    let message1 = send_text(&mut alice, "Hello Bob!")?;

    let received = bob.receive(&message1)?;
    assert!(received.is_some());

    let rumor: serde_json::Value = serde_json::from_str(&received.unwrap())?;
    assert_eq!(rumor["content"].as_str(), Some("Hello Bob!"));

    let message2 = send_text(&mut bob, "Hi Alice!")?;
    let received2 = alice.receive(&message2)?;
    assert!(received2.is_some());

    let rumor2: serde_json::Value = serde_json::from_str(&received2.unwrap())?;
    assert_eq!(rumor2["content"].as_str(), Some("Hi Alice!"));

    Ok(())
}

#[test]
fn test_multiple_messages_back_and_forth() -> Result<()> {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();

    let alice_sk = alice_keys.secret_key().to_secret_bytes();
    let bob_sk = bob_keys.secret_key().to_secret_bytes();

    let alice_pk = alice_keys.public_key();
    let bob_pk = bob_keys.public_key();

    let shared_secret = [0u8; 32];

    let mut alice = Session::init(
        bob_pk,
        alice_sk,
        true,
        shared_secret,
        Some("alice".to_string()),
    )?;
    let mut bob = Session::init(
        alice_pk,
        bob_sk,
        false,
        shared_secret,
        Some("bob".to_string()),
    )?;

    let messages = vec![
        ("alice", "Message 1"),
        ("bob", "Message 2"),
        ("alice", "Message 3"),
        ("bob", "Message 4"),
        ("bob", "Message 5"),
        ("alice", "Message 6"),
    ];

    for (sender, text) in messages {
        if sender == "alice" {
            let event = send_text(&mut alice, text)?;
            let received = bob.receive(&event)?;
            assert!(received.is_some());
            let rumor: serde_json::Value = serde_json::from_str(&received.unwrap())?;
            assert_eq!(rumor["content"].as_str(), Some(text));
        } else {
            let event = send_text(&mut bob, text)?;
            let received = alice.receive(&event)?;
            assert!(received.is_some());
            let rumor: serde_json::Value = serde_json::from_str(&received.unwrap())?;
            assert_eq!(rumor["content"].as_str(), Some(text));
        }
    }

    Ok(())
}

#[test]
fn test_session_persistence() -> Result<()> {
    use nostr_double_ratchet::utils::{deserialize_session_state, serialize_session_state};

    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();

    let alice_sk = alice_keys.secret_key().to_secret_bytes();
    let bob_sk = bob_keys.secret_key().to_secret_bytes();

    let alice_pk = alice_keys.public_key();
    let bob_pk = bob_keys.public_key();

    let shared_secret = [0u8; 32];

    let mut alice = Session::init(
        bob_pk,
        alice_sk,
        true,
        shared_secret,
        Some("alice".to_string()),
    )?;
    let mut bob = Session::init(
        alice_pk,
        bob_sk,
        false,
        shared_secret,
        Some("bob".to_string()),
    )?;

    let msg1 = send_text(&mut alice, "Before save 1")?;
    bob.receive(&msg1)?;

    let msg2 = send_text(&mut bob, "Before save 2")?;
    alice.receive(&msg2)?;

    let alice_state_json = serialize_session_state(&alice.state)?;
    let bob_state_json = serialize_session_state(&bob.state)?;

    let alice_restored_state = deserialize_session_state(&alice_state_json)?;
    let bob_restored_state = deserialize_session_state(&bob_state_json)?;

    let mut alice_restored = Session::new(alice_restored_state, "alice_restored".to_string());
    let mut bob_restored = Session::new(bob_restored_state, "bob_restored".to_string());

    let msg3 = send_text(&mut alice_restored, "After restore")?;
    let received = bob_restored.receive(&msg3)?;
    assert!(received.is_some());

    let rumor: serde_json::Value = serde_json::from_str(&received.unwrap())?;
    assert_eq!(rumor["content"].as_str(), Some("After restore"));

    Ok(())
}

#[test]
fn test_send_event_recomputes_id_with_ms_tag() -> Result<()> {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();

    let alice_sk = alice_keys.secret_key().to_secret_bytes();
    let bob_sk = bob_keys.secret_key().to_secret_bytes();

    let alice_pk = alice_keys.public_key();
    let bob_pk = bob_keys.public_key();

    let shared_secret = [7u8; 32];

    let mut alice = Session::init(
        bob_pk,
        alice_sk,
        true,
        shared_secret,
        Some("alice".to_string()),
    )?;
    let mut bob = Session::init(
        alice_pk,
        bob_sk,
        false,
        shared_secret,
        Some("bob".to_string()),
    )?;

    let tags = vec![
        Tag::parse(&["l".to_string(), "test-group-id".to_string()]).expect("valid group tag"),
        Tag::parse(&["ms".to_string(), "1700000000000".to_string()]).expect("valid ms tag"),
    ];

    let inner = EventBuilder::new(Kind::Custom(14), "Hello group with ms tag")
        .tags(tags)
        .build(alice_pk);

    let outer = alice.send_event(inner)?;
    let plaintext = bob.receive(&outer)?.expect("expected decrypted rumor");
    let rumor = UnsignedEvent::from_json(&plaintext).expect("valid rumor JSON");

    rumor
        .verify_id()
        .expect("rumor id should match computed hash");

    Ok(())
}

#[test]
fn receive_rejects_extended_rumor_without_committing_state() -> Result<()> {
    let alice_keys = Keys::generate();
    let bob_keys = Keys::generate();
    let shared_secret = [9u8; 32];
    let mut alice = Session::init(
        bob_keys.public_key(),
        alice_keys.secret_key().to_secret_bytes(),
        true,
        shared_secret,
        Some("alice".to_string()),
    )?;
    let mut bob = Session::init(
        alice_keys.public_key(),
        bob_keys.secret_key().to_secret_bytes(),
        false,
        shared_secret,
        Some("bob".to_string()),
    )?;

    let mut rumor = serde_json::to_value(build_text_rumor(
        alice_keys.public_key(),
        "strict rumor",
        vec![],
    )?)?;
    rumor["unexpected"] = serde_json::Value::Bool(true);
    let plan = alice.plan_send(&serde_json::to_vec(&rumor)?, UnixSeconds(1_700_000_000))?;
    let event = message_event(&alice.apply_send(plan).envelope)?;
    let before = serde_json::to_string(&bob.state)?;

    assert!(bob.receive(&event).is_err());
    assert_eq!(serde_json::to_string(&bob.state)?, before);
    Ok(())
}
