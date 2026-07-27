use super::*;
use crate::{DevicePubkey, GroupProtocol};
use nostr::{EventId, Keys};
use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GroupRosterFactVector {
    description: String,
    event: serde_json::Value,
    expected: GroupRosterFactExpected,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GroupRosterFactExpected {
    group_id: String,
    name: String,
    created_by: String,
    members: Vec<String>,
    admins: Vec<String>,
    revision: u64,
    created_at: u64,
    updated_at: u64,
}

fn owner(byte: u8) -> OwnerPubkey {
    OwnerPubkey::from_bytes([byte; 32])
}

fn device(byte: u8) -> DevicePubkey {
    DevicePubkey::from_bytes([byte; 32])
}

fn encode_context() -> GroupPayloadEncodeContext {
    GroupPayloadEncodeContext {
        local_device_pubkey: device(9),
        created_at: UnixSeconds(12),
    }
}

fn snapshot() -> GroupSnapshot {
    GroupSnapshot {
        group_id: "group-1".to_string(),
        protocol: GroupProtocol::sender_key_v1(),
        name: "Team".to_string(),
        picture: None,
        about: None,
        created_by: owner(1),
        members: vec![owner(1), owner(2)],
        admins: vec![owner(1)],
        revision: 3,
        created_at: UnixSeconds(10),
        updated_at: UnixSeconds(11),
    }
}

fn owner_from_keys(keys: &Keys) -> OwnerPubkey {
    OwnerPubkey::from_bytes(keys.public_key().to_bytes())
}

fn test_vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("test-vectors")
}

fn expected_from_snapshot(snapshot: &GroupSnapshot) -> GroupRosterFactExpected {
    let mut members: Vec<_> = snapshot
        .members
        .iter()
        .map(|owner| owner.to_hex())
        .collect();
    let mut admins: Vec<_> = snapshot.admins.iter().map(|owner| owner.to_hex()).collect();
    members.sort();
    admins.sort();
    GroupRosterFactExpected {
        group_id: snapshot.group_id.clone(),
        name: snapshot.name.clone(),
        created_by: snapshot.created_by.to_hex(),
        members,
        admins,
        revision: snapshot.revision,
        created_at: snapshot.created_at.get(),
        updated_at: snapshot.updated_at.get(),
    }
}

fn assert_vector_decodes(vector: &GroupRosterFactVector) {
    let codec = JsonGroupPayloadCodecV1;
    let payload = serde_json::to_vec(&vector.event).unwrap();
    let decoded = codec.decode_pairwise_command(&payload).unwrap();
    let Some(GroupPairwiseCommand::MetadataSnapshot { snapshot }) = decoded else {
        panic!("expected metadata snapshot");
    };
    assert_eq!(snapshot.group_id, vector.expected.group_id);
    assert_eq!(snapshot.name, vector.expected.name);
    assert_eq!(snapshot.created_by.to_hex(), vector.expected.created_by);
    assert_eq!(
        expected_from_snapshot(&snapshot).members,
        vector.expected.members
    );
    assert_eq!(
        expected_from_snapshot(&snapshot).admins,
        vector.expected.admins
    );
    assert_eq!(snapshot.revision, vector.expected.revision);
    assert_eq!(snapshot.created_at.get(), vector.expected.created_at);
    assert_eq!(snapshot.updated_at.get(), vector.expected.updated_at);
}

#[test]
fn metadata_snapshot_command_encodes_group_roster_fact_rumor() {
    let codec = JsonGroupPayloadCodecV1;
    let command = GroupPairwiseCommand::MetadataSnapshot {
        snapshot: snapshot(),
    };

    let encoded = codec
        .encode_pairwise_command(encode_context(), &command)
        .unwrap();

    assert!(codec.is_pairwise_payload(&encoded));
    let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    assert_eq!(event.kind.as_u16() as u32, GROUP_ROSTER_FACT_KIND);
    assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
    assert_eq!(event.content, "");
    assert_eq!(
        first_tag_value(&event, "type").as_deref(),
        Some(GROUP_ROSTER_FACT_TYPE)
    );
    assert_eq!(first_tag_value(&event, "d").as_deref(), Some("group-1"));
    assert!(event.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.first().map(String::as_str) == Some("i")
            && values.get(1).map(String::as_str) == Some("group-1")
            && values.get(2).map(String::as_str) == Some("subject")
    }));
    assert_eq!(
        first_tag_value(&event, "group_id").as_deref(),
        Some("group-1")
    );
    assert_eq!(first_tag_value(&event, "revision").as_deref(), Some("3"));
    assert_eq!(
        first_tag_value(&event, "created_by"),
        Some(owner(1).to_hex())
    );

    assert_eq!(
        codec.decode_pairwise_command(&encoded).unwrap(),
        Some(command)
    );
}

#[test]
fn metadata_snapshot_decodes_typescript_group_roster_fact_vector() {
    let vectors_path = test_vectors_path().join("ts-group-roster-fact-vectors.json");
    if !vectors_path.exists() {
        println!(
            "TypeScript group roster fact vectors not found at {:?}, skipping...",
            vectors_path
        );
        return;
    }

    let content = fs::read_to_string(&vectors_path).unwrap();
    let vector: GroupRosterFactVector = serde_json::from_str(&content).unwrap();
    assert_vector_decodes(&vector);
}

#[test]
#[ignore = "writes an interop fixture; run the explicit vector-generation lane"]
fn generate_rust_group_roster_fact_vector() {
    let codec = JsonGroupPayloadCodecV1;
    let snapshot = snapshot();
    let encoded = codec
        .encode_pairwise_command(
            encode_context(),
            &GroupPairwiseCommand::MetadataSnapshot {
                snapshot: snapshot.clone(),
            },
        )
        .unwrap();
    let event: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
    let vector = GroupRosterFactVector {
        description: "Group roster fact vector generated by Rust".to_string(),
        event,
        expected: expected_from_snapshot(&snapshot),
    };
    let vectors_path = test_vectors_path().join("rust-group-roster-fact-vectors.json");
    let should_regenerate =
        env::var("REGENERATE_VECTORS").ok().as_deref() == Some("true") || !vectors_path.exists();
    if should_regenerate {
        fs::create_dir_all(vectors_path.parent().unwrap()).unwrap();
        fs::write(
            &vectors_path,
            serde_json::to_string_pretty(&vector).unwrap(),
        )
        .unwrap();
    }

    let content = fs::read_to_string(&vectors_path).unwrap();
    let written: GroupRosterFactVector = serde_json::from_str(&content).unwrap();
    assert_vector_decodes(&written);
}

#[test]
fn group_roster_fact_filter_builder_and_snapshot_roundtrip() {
    let admin = Keys::generate();
    let bob = Keys::generate();
    let carol = Keys::generate();
    let admin_owner = owner_from_keys(&admin);
    let bob_owner = owner_from_keys(&bob);
    let carol_owner = owner_from_keys(&carol);
    let snapshot = GroupSnapshot {
        group_id: "group-facts".to_string(),
        protocol: GroupProtocol::sender_key_v1(),
        name: "Fact Friends".to_string(),
        picture: Some("https://example.test/group.png".to_string()),
        about: Some("tag-native roster".to_string()),
        created_by: admin_owner,
        members: vec![carol_owner, admin_owner, bob_owner],
        admins: vec![bob_owner, admin_owner],
        revision: 4,
        created_at: UnixSeconds(1_700_000_000),
        updated_at: UnixSeconds(1_700_000_123),
    };

    let filter = build_group_roster_fact_filter(["group-facts"], [admin.public_key()]);
    let filter_json = serde_json::to_value(&filter).unwrap();
    assert_eq!(
        filter_json["kinds"],
        serde_json::json!([GROUP_ROSTER_FACT_KIND])
    );
    assert_eq!(
        filter_json["authors"],
        serde_json::json!([admin.public_key()])
    );
    assert_eq!(filter_json["#d"], serde_json::json!(["group-facts"]));

    let unsigned = group_roster_unsigned_event(admin.public_key(), &snapshot).unwrap();
    assert_eq!(unsigned.kind.as_u16() as u32, GROUP_ROSTER_FACT_KIND);
    assert_eq!(GROUP_ROSTER_FACT_KIND, 37368);
    assert_eq!(unsigned.content, "");
    assert_eq!(
        first_tag_value(&unsigned, "type").as_deref(),
        Some(GROUP_ROSTER_FACT_TYPE)
    );
    assert_eq!(
        first_tag_value(&unsigned, "d").as_deref(),
        Some("group-facts")
    );
    assert!(unsigned.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.first().map(String::as_str) == Some("i")
            && values.get(1).map(String::as_str) == Some("group-facts")
            && values.get(2).map(String::as_str) == Some("subject")
    }));
    assert_eq!(
        first_tag_value(&unsigned, "group_id").as_deref(),
        Some("group-facts")
    );
    assert_eq!(first_tag_value(&unsigned, "revision").as_deref(), Some("4"));
    assert_eq!(
        first_tag_value(&unsigned, "name").as_deref(),
        Some("Fact Friends")
    );
    let unsigned_json = serde_json::to_string(&unsigned).unwrap();
    assert!(!unsigned_json.contains("secret"));

    let signed = unsigned.sign_with_keys(&admin).unwrap();
    let parsed = parse_group_roster_fact_event(&signed).unwrap();
    assert_eq!(parsed.group_id, "group-facts");
    assert_eq!(parsed.revision, 4);
    assert_eq!(parsed.signer_pubkey, admin.public_key());
    assert_eq!(parsed.snapshot.name, "Fact Friends");
    assert_eq!(
        parsed.snapshot.picture.as_deref(),
        Some("https://example.test/group.png")
    );
    assert_eq!(parsed.snapshot.about.as_deref(), Some("tag-native roster"));
    let mut expected_members = vec![admin_owner, bob_owner, carol_owner];
    expected_members.sort();
    let mut expected_admins = vec![admin_owner, bob_owner];
    expected_admins.sort();
    assert_eq!(parsed.snapshot.members, expected_members);
    assert_eq!(parsed.snapshot.admins, expected_admins);
}

#[test]
fn group_roster_fact_projection_keeps_latest_revision_per_group() {
    let admin = Keys::generate();
    let admin_owner = owner_from_keys(&admin);
    let old_snapshot = GroupSnapshot {
        group_id: "group-facts".to_string(),
        protocol: GroupProtocol::sender_key_v1(),
        name: "Old".to_string(),
        picture: None,
        about: None,
        created_by: admin_owner,
        members: vec![admin_owner],
        admins: vec![admin_owner],
        revision: 1,
        created_at: UnixSeconds(10),
        updated_at: UnixSeconds(11),
    };
    let new_snapshot = GroupSnapshot {
        name: "New".to_string(),
        revision: 2,
        updated_at: UnixSeconds(12),
        ..old_snapshot.clone()
    };
    let old_event = group_roster_unsigned_event(admin.public_key(), &old_snapshot)
        .unwrap()
        .sign_with_keys(&admin)
        .unwrap();
    let new_event = group_roster_unsigned_event(admin.public_key(), &new_snapshot)
        .unwrap()
        .sign_with_keys(&admin)
        .unwrap();

    let projected = project_group_roster_fact_events([&new_event, &old_event]);
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].revision, 2);
    assert_eq!(projected[0].name, "New");
}

#[test]
fn transitional_create_and_sync_envelopes_decode_as_metadata_snapshots() {
    let codec = JsonGroupPayloadCodecV1;
    let create = serde_json::to_vec(&serde_json::json!({
        "wire_format_version": 1,
        "payload": {
            "kind": "create_group",
            "group_id": "group-1",
            "protocol": "sender_key_v1",
            "base_revision": 0,
            "new_revision": 1,
            "name": "Team",
            "created_by": owner(1),
            "members": [owner(1), owner(2)],
            "admins": [owner(1)],
            "created_at": 10,
            "updated_at": 10
        }
    }))
    .unwrap();

    let decoded = codec.decode_pairwise_command(&create).unwrap();
    assert!(matches!(
        decoded,
        Some(GroupPairwiseCommand::MetadataSnapshot { snapshot })
            if snapshot.revision == 1 && snapshot.name == "Team"
    ));

    let sync = encode_envelope(GroupPairwisePayloadV1::SyncGroup {
        group_id: "group-1".to_string(),
        protocol: GroupProtocol::sender_key_v1(),
        revision: 2,
        name: "Renamed".to_string(),
        picture: None,
        about: None,
        created_by: owner(1),
        members: vec![owner(1), owner(2)],
        admins: vec![owner(1)],
        created_at: UnixSeconds(10),
        updated_at: UnixSeconds(11),
    })
    .unwrap();

    let decoded = codec.decode_pairwise_command(&sync).unwrap();
    assert!(matches!(
        decoded,
        Some(GroupPairwiseCommand::MetadataSnapshot { snapshot })
            if snapshot.revision == 2 && snapshot.name == "Renamed"
    ));
}

#[test]
fn unsupported_pairwise_version_is_not_consumed_as_group_payload() {
    let codec = JsonGroupPayloadCodecV1;
    let encoded = serde_json::to_vec(&serde_json::json!({
        "wire_format_version": 255,
        "payload": {
            "kind": "group_message",
            "group_id": "group-1",
            "revision": 1,
            "body": []
        }
    }))
    .unwrap();

    assert!(!codec.is_pairwise_payload(&encoded));
    assert_eq!(codec.decode_pairwise_command(&encoded).unwrap(), None);
}

#[test]
fn sender_key_plaintext_roundtrips_through_old_inner_rumor() {
    let codec = JsonGroupPayloadCodecV1;
    let plaintext = GroupSenderKeyPlaintext {
        group_id: "group-1".to_string(),
        revision: 3,
        body: b"hello group".to_vec(),
    };

    let encoded = codec
        .encode_sender_key_plaintext(encode_context(), &plaintext)
        .unwrap();
    let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    assert_eq!(event.kind.as_u16() as u32, CHAT_MESSAGE_KIND);
    assert_eq!(event.content, "hello group");
    assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
    assert_eq!(
        first_tag_value(&event, GROUP_LABEL_TAG).as_deref(),
        Some("group-1")
    );
    assert_eq!(first_tag_value(&event, REVISION_TAG).as_deref(), Some("3"));

    assert_eq!(
        codec
            .decode_sender_key_plaintext(
                GroupSenderKeyPlaintextDecodeContext {
                    group_id: "group-1",
                    current_revision: 3,
                },
                &encoded,
            )
            .unwrap(),
        Some(plaintext)
    );
}

#[test]
fn sender_key_plaintext_decodes_old_ts_rumor_without_revision() {
    let codec = JsonGroupPayloadCodecV1;
    let event = EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), "legacy")
        .tags(vec![
            tag([GROUP_LABEL_TAG, "group-1"]).unwrap(),
            tag([MS_TAG, "12000"]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(12))
        .build(device(7).to_nostr().unwrap());
    let encoded = serde_json::to_vec(&event).unwrap();

    assert_eq!(
        codec
            .decode_sender_key_plaintext(
                GroupSenderKeyPlaintextDecodeContext {
                    group_id: "group-1",
                    current_revision: 8,
                },
                &encoded,
            )
            .unwrap(),
        Some(GroupSenderKeyPlaintext {
            group_id: "group-1".to_string(),
            revision: 8,
            body: b"legacy".to_vec(),
        })
    );
}

#[test]
fn sender_key_distribution_command_encodes_old_10446_rumor() {
    let codec = JsonGroupPayloadCodecV1;
    let distribution = SenderKeyDistribution {
        group_id: "group-1".to_string(),
        key_id: 7,
        sender_event_pubkey: device(3),
        chain_key: [4; 32],
        iteration: 9,
        created_at: UnixSeconds(11),
    };
    let command = GroupPairwiseCommand::SenderKeyDistribution {
        distribution: distribution.clone(),
    };

    let encoded = codec
        .encode_pairwise_command(encode_context(), &command)
        .unwrap();
    let mut event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    assert_eq!(
        event.kind.as_u16() as u32,
        GROUP_SENDER_KEY_DISTRIBUTION_KIND
    );
    assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
    assert_eq!(
        first_tag_value(&event, GROUP_LABEL_TAG).as_deref(),
        Some("group-1")
    );
    assert_eq!(first_tag_value(&event, KEY_TAG).as_deref(), Some("7"));
    assert_eq!(first_tag_value(&event, MS_TAG).as_deref(), Some("12000"));
    let content = serde_json::from_str::<serde_json::Value>(&event.content).unwrap();
    assert_eq!(content["groupId"], "group-1");
    assert_eq!(content["keyId"], 7);
    assert_eq!(content["chainKey"], hex::encode([4; 32]));
    assert_eq!(content["iteration"], 9);
    assert_eq!(content["createdAt"], 11);
    assert_eq!(content["senderEventPubkey"], device(3).to_string());

    // The old plaintext pubkey is compatibility-only. Core identity comes from authenticated
    // pairwise session context, so the codec must not depend on this field.
    event.pubkey = device(5).to_nostr().unwrap();
    event.id = None;
    event.ensure_id();
    let encoded = serde_json::to_vec(&event).unwrap();

    assert_eq!(
        codec.decode_pairwise_command(&encoded).unwrap(),
        Some(command)
    );
}

#[test]
fn old_sender_key_distribution_rejects_mismatched_event_id() {
    let codec = JsonGroupPayloadCodecV1;
    let distribution = SenderKeyDistribution {
        group_id: "group-1".to_string(),
        key_id: 7,
        sender_event_pubkey: device(3),
        chain_key: [4; 32],
        iteration: 9,
        created_at: UnixSeconds(11),
    };
    let command = GroupPairwiseCommand::SenderKeyDistribution { distribution };
    let encoded = codec
        .encode_pairwise_command(encode_context(), &command)
        .unwrap();
    let mut event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    event.id = Some(EventId::all_zeros());
    let encoded = serde_json::to_vec(&event).unwrap();

    assert!(matches!(
        codec.decode_pairwise_command(&encoded),
        Err(Error::Parse(_))
    ));
}

#[test]
fn current_sender_key_distribution_envelope_is_not_consumed() {
    let codec = JsonGroupPayloadCodecV1;
    let distribution = SenderKeyDistribution {
        group_id: "group-1".to_string(),
        key_id: 7,
        sender_event_pubkey: device(3),
        chain_key: [4; 32],
        iteration: 9,
        created_at: UnixSeconds(11),
    };
    let encoded =
        encode_envelope(GroupPairwisePayloadV1::SenderKeyDistribution { distribution }).unwrap();

    assert_eq!(codec.decode_pairwise_command(&encoded).unwrap(), None);
}

#[test]
fn sender_key_repair_request_command_encodes_10447_rumor() {
    let codec = JsonGroupPayloadCodecV1;
    let request = crate::SenderKeyRepairRequest {
        group_id: "group-1".to_string(),
        sender_event_pubkey: device(3),
        key_id: Some(7),
        message_number: Some(42),
        required_revision: Some(9),
        created_at: UnixSeconds(13),
    };
    let command = GroupPairwiseCommand::SenderKeyRepairRequest {
        request: request.clone(),
    };

    let encoded = codec
        .encode_pairwise_command(encode_context(), &command)
        .unwrap();
    let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    assert_eq!(
        event.kind.as_u16() as u32,
        GROUP_SENDER_KEY_REPAIR_REQUEST_KIND
    );
    assert_eq!(event.pubkey, device(9).to_nostr().unwrap());
    assert_eq!(
        first_tag_value(&event, GROUP_LABEL_TAG).as_deref(),
        Some("group-1")
    );
    assert_eq!(first_tag_value(&event, KEY_TAG).as_deref(), Some("7"));
    assert_eq!(
        first_tag_value(&event, SENDER_TAG).as_deref(),
        Some(device(3).to_string().as_str())
    );
    assert_eq!(first_tag_value(&event, MESSAGE_TAG).as_deref(), Some("42"));
    assert_eq!(first_tag_value(&event, REVISION_TAG).as_deref(), Some("9"));
    assert_eq!(first_tag_value(&event, MS_TAG).as_deref(), Some("12000"));
    let content = serde_json::from_str::<serde_json::Value>(&event.content).unwrap();
    assert_eq!(content["groupId"], "group-1");
    assert_eq!(content["senderEventPubkey"], device(3).to_string());
    assert_eq!(content["keyId"], 7);
    assert_eq!(content["messageNumber"], 42);
    assert_eq!(content["requiredRevision"], 9);
    assert_eq!(content["createdAt"], 13);

    assert_eq!(
        codec.decode_pairwise_command(&encoded).unwrap(),
        Some(command)
    );
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct SenderKeyRepairVectors {
    description: String,
    requester_device_pubkey: String,
    encoded_at_ms: u64,
    request: SenderKeyRepairVectorRequest,
    repair_request_event: serde_json::Value,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SenderKeyRepairVectorRequest {
    group_id: String,
    sender_event_pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_number: Option<u32>,
    #[serde(default)]
    required_revision: Option<u64>,
    created_at: u64,
}

#[test]
fn typescript_sender_key_repair_vector_decodes() {
    let vectors_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("test-vectors")
        .join("ts-sender-key-repair-vectors.json");

    if !vectors_path.exists() {
        println!(
            "TypeScript sender-key repair vectors not found at {:?}, skipping...",
            vectors_path
        );
        println!(
            "Run `pnpm vitest run tests/SenderKeyRepair.interop.test.ts` in ts/ to generate them."
        );
        return;
    }

    let content = std::fs::read_to_string(&vectors_path).expect("failed to read vectors");
    let vectors: SenderKeyRepairVectors =
        serde_json::from_str(&content).expect("failed to parse vectors");
    let encoded =
        serde_json::to_vec(&vectors.repair_request_event).expect("failed to encode event");

    let decoded = JsonGroupPayloadCodecV1
        .decode_pairwise_command(&encoded)
        .expect("failed to decode TS repair vector");
    let Some(GroupPairwiseCommand::SenderKeyRepairRequest { request }) = decoded else {
        panic!("expected sender-key repair request");
    };

    assert_eq!(request.group_id, vectors.request.group_id);
    assert_eq!(
        request.sender_event_pubkey.to_string(),
        vectors.request.sender_event_pubkey
    );
    assert_eq!(request.key_id, vectors.request.key_id);
    assert_eq!(request.message_number, vectors.request.message_number);
    assert_eq!(request.required_revision, vectors.request.required_revision);
    assert_eq!(request.created_at.get(), vectors.request.created_at);
}

#[test]
#[ignore = "writes an interop fixture; run the explicit vector-generation lane"]
fn generate_rust_sender_key_repair_vector() {
    let vectors_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("test-vectors")
        .join("rust-sender-key-repair-vectors.json");
    let should_regenerate = std::env::var("REGENERATE_VECTORS").ok().as_deref() == Some("true")
        || !vectors_path.exists();

    if should_regenerate {
        let ctx = encode_context();
        let request = crate::SenderKeyRepairRequest {
            group_id: "group-1".to_string(),
            sender_event_pubkey: device(3),
            key_id: Some(7),
            message_number: Some(42),
            required_revision: Some(9),
            created_at: UnixSeconds(13),
        };
        let encoded = JsonGroupPayloadCodecV1
            .encode_pairwise_command(
                ctx,
                &GroupPairwiseCommand::SenderKeyRepairRequest {
                    request: request.clone(),
                },
            )
            .unwrap();
        let repair_request_event = serde_json::from_slice::<serde_json::Value>(&encoded).unwrap();
        let vectors = SenderKeyRepairVectors {
            description: "SenderKeyRepair 10447 request vector generated by Rust".to_string(),
            requester_device_pubkey: ctx.local_device_pubkey.to_string(),
            encoded_at_ms: ctx.created_at.get() * 1000,
            request: SenderKeyRepairVectorRequest {
                group_id: request.group_id,
                sender_event_pubkey: request.sender_event_pubkey.to_string(),
                key_id: request.key_id,
                message_number: request.message_number,
                required_revision: request.required_revision,
                created_at: request.created_at.get(),
            },
            repair_request_event,
        };

        std::fs::create_dir_all(vectors_path.parent().unwrap()).ok();
        std::fs::write(
            &vectors_path,
            serde_json::to_string_pretty(&vectors).unwrap(),
        )
        .expect("failed to write Rust sender-key repair vectors");
    }

    let content = std::fs::read_to_string(&vectors_path).expect("failed to read vectors");
    let vectors: SenderKeyRepairVectors =
        serde_json::from_str(&content).expect("failed to parse vectors");
    let encoded =
        serde_json::to_vec(&vectors.repair_request_event).expect("failed to encode event");
    let decoded = JsonGroupPayloadCodecV1
        .decode_pairwise_command(&encoded)
        .expect("failed to decode Rust repair vector");
    let Some(GroupPairwiseCommand::SenderKeyRepairRequest { request }) = decoded else {
        panic!("expected sender-key repair request");
    };
    assert_eq!(request.group_id, vectors.request.group_id);
    assert_eq!(
        request.sender_event_pubkey.to_string(),
        vectors.request.sender_event_pubkey
    );
    assert_eq!(request.key_id, vectors.request.key_id);
    assert_eq!(request.message_number, vectors.request.message_number);
    assert_eq!(request.required_revision, vectors.request.required_revision);
    assert_eq!(request.created_at.get(), vectors.request.created_at);
}

#[test]
fn old_sender_key_repair_request_envelope_is_not_consumed() {
    let codec = JsonGroupPayloadCodecV1;
    let encoded = serde_json::to_vec(&serde_json::json!({
        "wire_format_version": 1,
        "payload": {
            "kind": "sender_key_repair_request",
            "request": {
                "group_id": "group-1",
                "sender_event_pubkey": device(3),
                "key_id": 7,
                "message_number": 42,
                "required_revision": 9,
                "created_at": 13
            }
        }
    }))
    .unwrap();

    assert_eq!(codec.decode_pairwise_command(&encoded).unwrap(), None);
}

#[test]
fn sender_key_repair_request_rejects_mismatched_tags() {
    let codec = JsonGroupPayloadCodecV1;
    let request = crate::SenderKeyRepairRequest {
        group_id: "group-1".to_string(),
        sender_event_pubkey: device(3),
        key_id: Some(7),
        message_number: Some(42),
        required_revision: Some(9),
        created_at: UnixSeconds(13),
    };
    let command = GroupPairwiseCommand::SenderKeyRepairRequest { request };
    let encoded = codec
        .encode_pairwise_command(encode_context(), &command)
        .unwrap();
    let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    let sender_hex = device(3).to_string();
    let event = EventBuilder::new(
        Kind::from(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND as u16),
        event.content,
    )
    .tags(vec![
        tag([GROUP_LABEL_TAG, "group-2"]).unwrap(),
        tag([KEY_TAG, "7"]).unwrap(),
        tag([SENDER_TAG, sender_hex.as_str()]).unwrap(),
        tag([MESSAGE_TAG, "42"]).unwrap(),
        tag([REVISION_TAG, "9"]).unwrap(),
    ])
    .custom_created_at(Timestamp::from(12))
    .build(device(9).to_nostr().unwrap());
    let encoded = serde_json::to_vec(&event).unwrap();

    assert!(matches!(
        codec.decode_pairwise_command(&encoded),
        Err(Error::Parse(_))
    ));
}

#[test]
fn sender_key_repair_request_without_revision_omits_revision_tag() {
    let codec = JsonGroupPayloadCodecV1;
    let request = crate::SenderKeyRepairRequest {
        group_id: "group-1".to_string(),
        sender_event_pubkey: device(3),
        key_id: Some(7),
        message_number: Some(42),
        required_revision: None,
        created_at: UnixSeconds(13),
    };
    let command = GroupPairwiseCommand::SenderKeyRepairRequest {
        request: request.clone(),
    };
    let encoded = codec
        .encode_pairwise_command(encode_context(), &command)
        .unwrap();
    let event = serde_json::from_slice::<UnsignedEvent>(&encoded).unwrap();
    assert_eq!(first_tag_value(&event, REVISION_TAG), None);

    assert_eq!(
        codec.decode_pairwise_command(&encoded).unwrap(),
        Some(GroupPairwiseCommand::SenderKeyRepairRequest { request })
    );
}

#[test]
fn sender_key_repair_request_rejects_missing_required_tags() {
    let codec = JsonGroupPayloadCodecV1;
    let content = serde_json::to_string(&SenderKeyRepairRequestContent {
        group_id: "group-1".to_string(),
        sender_event_pubkey: device(3).to_string(),
        key_id: Some(7),
        message_number: Some(42),
        required_revision: Some(9),
        created_at: UnixSeconds(13),
    })
    .unwrap();
    let event = EventBuilder::new(
        Kind::from(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND as u16),
        content,
    )
    .custom_created_at(Timestamp::from(12))
    .build(device(9).to_nostr().unwrap());
    let encoded = serde_json::to_vec(&event).unwrap();

    assert!(matches!(
        codec.decode_pairwise_command(&encoded),
        Err(Error::Parse(_))
    ));
}
