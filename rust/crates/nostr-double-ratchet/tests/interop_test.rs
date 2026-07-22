//! Interop tests between TypeScript and Rust implementations

use nostr::{Event, JsonUtil, Keys};
use nostr_double_ratchet::{build_text_rumor, SessionNostrExt};
use nostr_double_ratchet::{Result, Session};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize)]
struct TestVector {
    description: String,
    alice_ephemeral_sk: String,
    alice_ephemeral_pk: String,
    bob_ephemeral_sk: String,
    bob_ephemeral_pk: String,
    shared_secret: String,
    messages: Vec<TestMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
struct TestMessage {
    sender: String,
    plaintext: String,
    encrypted_event: serde_json::Value,
}

fn get_test_vectors_path() -> PathBuf {
    // Go up from crates/nostr-double-ratchet to rust/, then to repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent() // crates/
        .unwrap()
        .parent() // rust/
        .unwrap()
        .parent() // repo root
        .unwrap()
        .join("test-vectors")
}

fn hex_to_bytes32(hex: &str) -> [u8; 32] {
    let bytes = hex::decode(hex).expect("Invalid hex");
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    arr
}

fn send_text(session: &mut Session, text: &str) -> Result<nostr::Event> {
    session.send_event(build_text_rumor(
        Keys::generate().public_key(),
        text,
        vec![],
    )?)
}

#[test]
fn test_decrypt_typescript_messages() -> Result<()> {
    let vectors_path = get_test_vectors_path().join("ts-generated.json");

    if !vectors_path.exists() {
        println!(
            "TypeScript vectors not found at {:?}, skipping...",
            vectors_path
        );
        println!("Run `pnpm vitest run tests/interop.test.ts` in ts/ to generate them.");
        return Ok(());
    }

    let content = fs::read_to_string(&vectors_path).expect("Failed to read vectors");
    let vectors: TestVector = serde_json::from_str(&content).expect("Failed to parse vectors");

    println!("Loaded test vectors: {}", vectors.description);
    println!("Messages: {}", vectors.messages.len());

    let _alice_sk = hex_to_bytes32(&vectors.alice_ephemeral_sk);
    let bob_sk = hex_to_bytes32(&vectors.bob_ephemeral_sk);
    let shared_secret = hex_to_bytes32(&vectors.shared_secret);

    let alice_pk = nostr::PublicKey::from_slice(&hex::decode(&vectors.alice_ephemeral_pk).unwrap())
        .expect("Invalid alice pk");
    let _bob_pk = nostr::PublicKey::from_slice(&hex::decode(&vectors.bob_ephemeral_pk).unwrap())
        .expect("Invalid bob pk");

    // Bob is responder, receives Alice's first message
    let mut bob = Session::init(
        alice_pk,
        bob_sk,
        false, // Bob is responder
        shared_secret,
        Some("bob".to_string()),
    )?;

    // Process Alice's first message
    let alice_msg = &vectors.messages[0];
    assert_eq!(alice_msg.sender, "alice");

    let event_json = serde_json::to_string(&alice_msg.encrypted_event).unwrap();
    let event: Event = Event::from_json(&event_json).expect("Failed to parse event");

    println!("Attempting to decrypt message from Alice...");
    println!("  Event ID: {}", event.id);
    println!("  Event pubkey: {}", event.pubkey);
    println!("  Expected plaintext: {}", alice_msg.plaintext);

    let decrypted = bob.receive(&event)?;
    assert!(decrypted.is_some(), "Failed to decrypt Alice's message");

    let rumor: serde_json::Value = serde_json::from_str(&decrypted.unwrap())?;
    let content = rumor["content"].as_str().unwrap();
    println!("  Decrypted content: {}", content);
    assert_eq!(content, alice_msg.plaintext);

    println!("✓ Successfully decrypted TypeScript message!");

    // Note: We only test the first message from TypeScript vectors since
    // subsequent messages in the vectors have ratchet state that depends
    // on specific random keys generated during vector creation.
    // The full conversation flow is tested in test_roundtrip_rust_only.

    Ok(())
}

#[test]
#[ignore = "writes an interop fixture; run the explicit vector-generation lane"]
fn test_generate_rust_vectors() -> Result<()> {
    let alice_sk =
        hex_to_bytes32("1111111111111111111111111111111111111111111111111111111111111111");
    let bob_sk = hex_to_bytes32("2222222222222222222222222222222222222222222222222222222222222222");
    let shared_secret =
        hex_to_bytes32("3333333333333333333333333333333333333333333333333333333333333333");

    let alice_keys = Keys::new(nostr::SecretKey::from_slice(&alice_sk)?);
    let bob_keys = Keys::new(nostr::SecretKey::from_slice(&bob_sk)?);

    let alice_pk = alice_keys.public_key();
    let bob_pk = bob_keys.public_key();

    // Alice is initiator
    let mut alice = Session::init(
        bob_pk,
        alice_sk,
        true,
        shared_secret,
        Some("alice".to_string()),
    )?;

    // Bob is responder
    let mut bob = Session::init(
        alice_pk,
        bob_sk,
        false,
        shared_secret,
        Some("bob".to_string()),
    )?;

    let mut messages = Vec::new();

    // Message 1: Alice -> Bob
    let msg1 = send_text(&mut alice, "Hello from Rust!")?;
    messages.push(TestMessage {
        sender: "alice".to_string(),
        plaintext: "Hello from Rust!".to_string(),
        encrypted_event: serde_json::from_str(&msg1.as_json()).unwrap(),
    });

    // Bob receives
    let _ = bob.receive(&msg1)?;

    // Message 2: Bob -> Alice
    let msg2 = send_text(&mut bob, "Hello back from Rust Bob!")?;
    messages.push(TestMessage {
        sender: "bob".to_string(),
        plaintext: "Hello back from Rust Bob!".to_string(),
        encrypted_event: serde_json::from_str(&msg2.as_json()).unwrap(),
    });

    // Alice receives
    let _ = alice.receive(&msg2)?;

    // Message 3: Alice -> Bob
    let msg3 = send_text(&mut alice, "Second message from Rust Alice")?;
    messages.push(TestMessage {
        sender: "alice".to_string(),
        plaintext: "Second message from Rust Alice".to_string(),
        encrypted_event: serde_json::from_str(&msg3.as_json()).unwrap(),
    });

    let vectors = TestVector {
        description: "Test vectors generated by Rust implementation".to_string(),
        alice_ephemeral_sk: "1111111111111111111111111111111111111111111111111111111111111111"
            .to_string(),
        alice_ephemeral_pk: hex::encode(alice_pk.to_bytes()),
        bob_ephemeral_sk: "2222222222222222222222222222222222222222222222222222222222222222"
            .to_string(),
        bob_ephemeral_pk: hex::encode(bob_pk.to_bytes()),
        shared_secret: "3333333333333333333333333333333333333333333333333333333333333333"
            .to_string(),
        messages,
    };

    let output_path = get_test_vectors_path().join("rust-generated.json");
    fs::create_dir_all(output_path.parent().unwrap()).ok();
    fs::write(&output_path, serde_json::to_string_pretty(&vectors)?)
        .map_err(|e| nostr_double_ratchet::Error::Storage(e.to_string()))?;

    println!("Generated Rust test vectors at {:?}", output_path);
    println!("Messages: {}", vectors.messages.len());

    Ok(())
}

#[test]
fn test_roundtrip_rust_only() -> Result<()> {
    // Simple test that Rust can encrypt and decrypt its own messages
    let alice_sk =
        hex_to_bytes32("1111111111111111111111111111111111111111111111111111111111111111");
    let bob_sk = hex_to_bytes32("2222222222222222222222222222222222222222222222222222222222222222");
    let shared_secret =
        hex_to_bytes32("3333333333333333333333333333333333333333333333333333333333333333");

    let alice_keys = Keys::new(nostr::SecretKey::from_slice(&alice_sk)?);
    let bob_keys = Keys::new(nostr::SecretKey::from_slice(&bob_sk)?);

    let alice_pk = alice_keys.public_key();
    let bob_pk = bob_keys.public_key();

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

    // Alice sends to Bob
    let msg1 = send_text(&mut alice, "Hello Bob!")?;
    let decrypted1 = bob.receive(&msg1)?;
    assert!(decrypted1.is_some());
    let rumor1: serde_json::Value = serde_json::from_str(&decrypted1.unwrap())?;
    assert_eq!(rumor1["content"].as_str().unwrap(), "Hello Bob!");

    // Bob sends to Alice
    let msg2 = send_text(&mut bob, "Hi Alice!")?;
    let decrypted2 = alice.receive(&msg2)?;
    assert!(decrypted2.is_some());
    let rumor2: serde_json::Value = serde_json::from_str(&decrypted2.unwrap())?;
    assert_eq!(rumor2["content"].as_str().unwrap(), "Hi Alice!");

    println!("✓ Rust roundtrip test passed!");
    Ok(())
}
