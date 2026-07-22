use crate::{
    device_pubkey_from_secret_bytes, kdf, random_secret_key_bytes, secret_key_from_bytes,
    DevicePubkey, DomainError, ProtocolContext, Result, UnixSeconds, MAX_SKIP,
};
use base64::Engine;
use nostr::nips::nip44::{self, Version};
use nostr::PublicKey;
use rand::rngs::OsRng;
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub number: u32,
    pub previous_chain_length: u32,
    pub next_public_key: DevicePubkey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SerializableKeyPair {
    pub public_key: DevicePubkey,
    #[serde(with = "hex::serde")]
    pub private_key: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SkippedKeysEntry {
    #[serde(with = "crate::serde_hex::btreemap_u32")]
    pub message_keys: BTreeMap<u32, [u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionState {
    #[serde(with = "hex::serde")]
    pub root_key: [u8; 32],
    pub their_current_nostr_public_key: Option<DevicePubkey>,
    pub their_next_nostr_public_key: Option<DevicePubkey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub our_previous_nostr_key: Option<SerializableKeyPair>,
    pub our_current_nostr_key: Option<SerializableKeyPair>,
    pub our_next_nostr_key: SerializableKeyPair,
    #[serde(default, with = "crate::serde_hex::option")]
    pub receiving_chain_key: Option<[u8; 32]>,
    #[serde(default, with = "crate::serde_hex::option")]
    pub sending_chain_key: Option<[u8; 32]>,
    pub sending_chain_message_number: u32,
    pub receiving_chain_message_number: u32,
    pub previous_sending_chain_message_count: u32,
    pub skipped_keys: BTreeMap<DevicePubkey, SkippedKeysEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageEnvelope {
    pub sender: DevicePubkey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<DevicePubkey>,
    pub signer_secret_key: [u8; 32],
    pub created_at: UnixSeconds,
    pub encrypted_header: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone)]
pub struct SendPlan {
    pub next_state: SessionState,
    pub envelope: MessageEnvelope,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SendOutcome {
    pub envelope: MessageEnvelope,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ReceivePlan {
    pub next_state: SessionState,
    pub payload: Vec<u8>,
    pub sender: DevicePubkey,
}

#[derive(Debug, Clone)]
pub struct ReceiveOutcome {
    pub payload: Vec<u8>,
    pub sender: DevicePubkey,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub state: SessionState,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderDecryptionTarget {
    Current,
    Next,
    Previous,
}

impl Session {
    pub fn from_state(state: SessionState) -> Self {
        Self {
            state,
            name: String::new(),
        }
    }

    pub fn new(state: SessionState, name: String) -> Self {
        Self { state, name }
    }

    pub fn init(
        their_ephemeral_nostr_public_key: PublicKey,
        our_ephemeral_nostr_private_key: [u8; 32],
        is_initiator: bool,
        shared_secret: [u8; 32],
        _name: Option<String>,
    ) -> Result<Self> {
        let mut rng = OsRng;
        let mut ctx = ProtocolContext::new(
            UnixSeconds(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            ),
            &mut rng,
        );
        let peer = DevicePubkey::from_bytes(their_ephemeral_nostr_public_key.to_bytes());
        let mut session = if is_initiator {
            Self::new_initiator(
                &mut ctx,
                peer,
                our_ephemeral_nostr_private_key,
                shared_secret,
            )
        } else {
            Self::new_responder(
                &mut ctx,
                peer,
                our_ephemeral_nostr_private_key,
                shared_secret,
            )
        }?;
        session.name = _name.unwrap_or_default();
        Ok(session)
    }

    pub fn new_initiator<R>(
        ctx: &mut ProtocolContext<'_, R>,
        their_ephemeral_public_key: DevicePubkey,
        our_ephemeral_private_key: [u8; 32],
        shared_secret: [u8; 32],
    ) -> Result<Self>
    where
        R: RngCore + CryptoRng,
    {
        Self::init_with_context(
            ctx,
            their_ephemeral_public_key,
            our_ephemeral_private_key,
            true,
            shared_secret,
        )
    }

    pub fn new_responder<R>(
        ctx: &mut ProtocolContext<'_, R>,
        their_ephemeral_public_key: DevicePubkey,
        our_ephemeral_private_key: [u8; 32],
        shared_secret: [u8; 32],
    ) -> Result<Self>
    where
        R: RngCore + CryptoRng,
    {
        Self::init_with_context(
            ctx,
            their_ephemeral_public_key,
            our_ephemeral_private_key,
            false,
            shared_secret,
        )
    }

    fn init_with_context<R>(
        ctx: &mut ProtocolContext<'_, R>,
        their_ephemeral_public_key: DevicePubkey,
        our_ephemeral_private_key: [u8; 32],
        is_initiator: bool,
        shared_secret: [u8; 32],
    ) -> Result<Self>
    where
        R: RngCore + CryptoRng,
    {
        let our_keys = nostr::Keys::new(secret_key_from_bytes(&our_ephemeral_private_key)?);
        let our_next_private_key = random_secret_key_bytes(ctx.rng)?;
        let our_next_keys = nostr::Keys::new(secret_key_from_bytes(&our_next_private_key)?);

        let (root_key, sending_chain_key, our_current_nostr_key, our_next_nostr_key) =
            if is_initiator {
                let our_current_pubkey = DevicePubkey::from_nostr(our_keys.public_key());
                let conversation_key = nip44::v2::ConversationKey::derive(
                    our_next_keys.secret_key(),
                    &their_ephemeral_public_key.to_nostr()?,
                )?;
                let kdf_outputs = kdf(&shared_secret, conversation_key.as_bytes(), 2);
                (
                    kdf_outputs[0],
                    Some(kdf_outputs[1]),
                    Some(SerializableKeyPair {
                        public_key: our_current_pubkey,
                        private_key: our_ephemeral_private_key,
                    }),
                    SerializableKeyPair {
                        public_key: DevicePubkey::from_nostr(our_next_keys.public_key()),
                        private_key: our_next_private_key,
                    },
                )
            } else {
                (
                    shared_secret,
                    None,
                    None,
                    SerializableKeyPair {
                        public_key: DevicePubkey::from_nostr(our_keys.public_key()),
                        private_key: our_ephemeral_private_key,
                    },
                )
            };

        Ok(Self {
            state: SessionState {
                root_key,
                their_current_nostr_public_key: None,
                their_next_nostr_public_key: Some(their_ephemeral_public_key),
                our_previous_nostr_key: None,
                our_current_nostr_key,
                our_next_nostr_key,
                receiving_chain_key: None,
                sending_chain_key,
                sending_chain_message_number: 0,
                receiving_chain_message_number: 0,
                previous_sending_chain_message_count: 0,
                skipped_keys: BTreeMap::new(),
            },
            name: String::new(),
        })
    }

    pub fn can_send(&self) -> bool {
        self.state.their_next_nostr_public_key.is_some()
            && self.state.our_current_nostr_key.is_some()
    }

    pub fn matches_sender(&self, sender: DevicePubkey) -> bool {
        self.state.their_current_nostr_public_key == Some(sender)
            || self.state.their_next_nostr_public_key == Some(sender)
            || self.state.skipped_keys.contains_key(&sender)
    }

    pub fn plan_send(&self, payload: &[u8], now: UnixSeconds) -> Result<SendPlan> {
        if !self.can_send() {
            return Err(DomainError::CannotSendYet.into());
        }

        let mut next_state = self.state.clone();
        let (header, ciphertext) = ratchet_encrypt(&mut next_state, payload)?;
        let our_current = self
            .state
            .our_current_nostr_key
            .as_ref()
            .ok_or(DomainError::SessionNotReady)?;
        let our_secret = secret_key_from_bytes(&our_current.private_key)?;
        let their_next = self
            .state
            .their_next_nostr_public_key
            .ok_or(DomainError::SessionNotReady)?;
        let encrypted_header = nip44::encrypt(
            &our_secret,
            &their_next.to_nostr()?,
            &serde_json::to_string(&header)?,
            Version::V2,
        )?;

        Ok(SendPlan {
            next_state,
            envelope: MessageEnvelope {
                sender: our_current.public_key,
                recipient: None,
                signer_secret_key: our_current.private_key,
                created_at: now,
                encrypted_header,
                ciphertext,
            },
            payload: payload.to_vec(),
        })
    }

    pub fn apply_send(&mut self, plan: SendPlan) -> SendOutcome {
        self.state = plan.next_state;
        SendOutcome {
            envelope: plan.envelope,
            payload: plan.payload,
        }
    }

    pub fn plan_receive<R>(
        &self,
        ctx: &mut ProtocolContext<'_, R>,
        envelope: &MessageEnvelope,
    ) -> Result<ReceivePlan>
    where
        R: RngCore + CryptoRng,
    {
        if !self.matches_sender(envelope.sender) {
            return Err(DomainError::UnexpectedSender.into());
        }

        let mut next_state = self.state.clone();
        let previous_chain_sender = next_state
            .their_current_nostr_public_key
            .or(next_state.their_next_nostr_public_key);
        let (header, decryption_target) =
            decrypt_header(&next_state, &envelope.encrypted_header, envelope.sender)?;
        let should_ratchet = decryption_target == HeaderDecryptionTarget::Next;

        let expected_next = next_state.their_next_nostr_public_key;
        if should_ratchet && expected_next != Some(header.next_public_key) {
            next_state.their_current_nostr_public_key = next_state.their_next_nostr_public_key;
            next_state.their_next_nostr_public_key = Some(header.next_public_key);
        }

        if should_ratchet {
            if next_state.receiving_chain_key.is_some() {
                let skipped_sender = previous_chain_sender.ok_or(DomainError::SessionNotReady)?;
                skip_message_keys(
                    &mut next_state,
                    header.previous_chain_length,
                    skipped_sender,
                )?;
            }
            ratchet_step(&mut next_state, ctx.rng)?;
        }

        let payload = ratchet_decrypt(
            &mut next_state,
            &header,
            &envelope.ciphertext,
            envelope.sender,
        )?;

        Ok(ReceivePlan {
            next_state,
            payload,
            sender: envelope.sender,
        })
    }

    pub fn apply_receive(&mut self, plan: ReceivePlan) -> ReceiveOutcome {
        self.state = plan.next_state;
        ReceiveOutcome {
            payload: plan.payload,
            sender: plan.sender,
        }
    }

    pub fn close(&self) {}
}

fn ratchet_encrypt(state: &mut SessionState, plaintext: &[u8]) -> Result<(Header, String)> {
    let sending_chain_key = state
        .sending_chain_key
        .ok_or(DomainError::SessionNotReady)?;

    let kdf_outputs = kdf(&sending_chain_key, &[1u8], 2);
    state.sending_chain_key = Some(kdf_outputs[0]);
    let message_key = kdf_outputs[1];

    let header = Header {
        number: state.sending_chain_message_number,
        next_public_key: state.our_next_nostr_key.public_key,
        previous_chain_length: state.previous_sending_chain_message_count,
    };

    state.sending_chain_message_number += 1;

    let conversation_key = nip44::v2::ConversationKey::new(message_key);
    let encrypted_bytes = nip44::v2::encrypt_to_bytes(&conversation_key, plaintext)?;
    let ciphertext = base64::engine::general_purpose::STANDARD.encode(encrypted_bytes);
    Ok((header, ciphertext))
}

fn ratchet_decrypt(
    state: &mut SessionState,
    header: &Header,
    ciphertext: &str,
    sender: DevicePubkey,
) -> Result<Vec<u8>> {
    if let Some(plaintext) = try_skipped_message_keys(state, header, ciphertext, sender)? {
        return Ok(plaintext);
    }

    if state.receiving_chain_key.is_none() {
        return Err(DomainError::SessionNotReady.into());
    }

    skip_message_keys(state, header.number, sender)?;

    let receiving_chain_key = state
        .receiving_chain_key
        .ok_or(DomainError::SessionNotReady)?;

    let kdf_outputs = kdf(&receiving_chain_key, &[1u8], 2);
    state.receiving_chain_key = Some(kdf_outputs[0]);
    let message_key = kdf_outputs[1];
    state.receiving_chain_message_number += 1;

    let conversation_key = nip44::v2::ConversationKey::new(message_key);
    let ciphertext_bytes = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|e| crate::Error::Decryption(e.to_string()))?;

    nip44::v2::decrypt_to_bytes(&conversation_key, &ciphertext_bytes).map_err(Into::into)
}

fn ratchet_step<R>(state: &mut SessionState, rng: &mut R) -> Result<()>
where
    R: RngCore + CryptoRng,
{
    state.previous_sending_chain_message_count = state.sending_chain_message_number;
    state.sending_chain_message_number = 0;
    state.receiving_chain_message_number = 0;

    let our_next_sk = secret_key_from_bytes(&state.our_next_nostr_key.private_key)?;
    let their_next_pk = state
        .their_next_nostr_public_key
        .ok_or(DomainError::SessionNotReady)?;

    let conversation_key1 =
        nip44::v2::ConversationKey::derive(&our_next_sk, &their_next_pk.to_nostr()?)?;
    let kdf_outputs = kdf(&state.root_key, conversation_key1.as_bytes(), 2);
    state.receiving_chain_key = Some(kdf_outputs[1]);
    state.our_previous_nostr_key = state.our_current_nostr_key.clone();
    state.our_current_nostr_key = Some(state.our_next_nostr_key.clone());

    let our_next_private_key = random_secret_key_bytes(rng)?;
    state.our_next_nostr_key = SerializableKeyPair {
        public_key: device_pubkey_from_secret_bytes(&our_next_private_key)?,
        private_key: our_next_private_key,
    };

    let our_next_sk2 = secret_key_from_bytes(&our_next_private_key)?;
    let conversation_key2 =
        nip44::v2::ConversationKey::derive(&our_next_sk2, &their_next_pk.to_nostr()?)?;
    let kdf_outputs2 = kdf(&kdf_outputs[0], conversation_key2.as_bytes(), 2);
    state.root_key = kdf_outputs2[0];
    state.sending_chain_key = Some(kdf_outputs2[1]);
    Ok(())
}

fn skip_message_keys(state: &mut SessionState, until: u32, sender: DevicePubkey) -> Result<()> {
    if until <= state.receiving_chain_message_number {
        return Ok(());
    }

    if (until - state.receiving_chain_message_number) as usize > MAX_SKIP {
        return Err(DomainError::TooManySkippedMessages.into());
    }

    let entry = state.skipped_keys.entry(sender).or_default();

    while state.receiving_chain_message_number < until {
        let receiving_chain_key = state
            .receiving_chain_key
            .ok_or(DomainError::SessionNotReady)?;
        let kdf_outputs = kdf(&receiving_chain_key, &[1u8], 2);
        state.receiving_chain_key = Some(kdf_outputs[0]);
        entry
            .message_keys
            .insert(state.receiving_chain_message_number, kdf_outputs[1]);
        state.receiving_chain_message_number += 1;
    }

    prune_skipped_message_keys(&mut entry.message_keys);
    Ok(())
}

fn try_skipped_message_keys(
    state: &mut SessionState,
    header: &Header,
    ciphertext: &str,
    sender: DevicePubkey,
) -> Result<Option<Vec<u8>>> {
    if let Some(entry) = state.skipped_keys.get_mut(&sender) {
        if let Some(message_key) = entry.message_keys.remove(&header.number) {
            let conversation_key = nip44::v2::ConversationKey::new(message_key);
            let ciphertext_bytes = base64::engine::general_purpose::STANDARD
                .decode(ciphertext)
                .map_err(|e| crate::Error::Decryption(e.to_string()))?;
            let plaintext = nip44::v2::decrypt_to_bytes(&conversation_key, &ciphertext_bytes)?;
            if entry.message_keys.is_empty() {
                state.skipped_keys.remove(&sender);
            }
            return Ok(Some(plaintext));
        }
    }

    Ok(None)
}

fn decrypt_header(
    state: &SessionState,
    encrypted_header: &str,
    sender: DevicePubkey,
) -> Result<(Header, HeaderDecryptionTarget)> {
    if let Some(current) = &state.our_current_nostr_key {
        let current_sk = secret_key_from_bytes(&current.private_key)?;
        if let Ok(decrypted) = nip44::decrypt(&current_sk, &sender.to_nostr()?, encrypted_header) {
            let header: Header = serde_json::from_str(&decrypted)?;
            return Ok((header, HeaderDecryptionTarget::Current));
        }
    }

    let next_sk = secret_key_from_bytes(&state.our_next_nostr_key.private_key)?;
    if let Ok(decrypted) = nip44::decrypt(&next_sk, &sender.to_nostr()?, encrypted_header) {
        let header: Header = serde_json::from_str(&decrypted)?;
        return Ok((header, HeaderDecryptionTarget::Next));
    }

    if let Some(previous) = &state.our_previous_nostr_key {
        let previous_sk = secret_key_from_bytes(&previous.private_key)?;
        if let Ok(decrypted) = nip44::decrypt(&previous_sk, &sender.to_nostr()?, encrypted_header) {
            let header: Header = serde_json::from_str(&decrypted)?;
            return Ok((header, HeaderDecryptionTarget::Previous));
        }
    }

    Err(crate::Error::Parse("invalid header".to_string()))
}

fn prune_skipped_message_keys(map: &mut BTreeMap<u32, [u8; 32]>) {
    while map.len() > MAX_SKIP {
        let Some(first) = map.keys().next().copied() else {
            break;
        };
        map.remove(&first);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, SeedableRng};

    fn context(seed: u64) -> ProtocolContext<'static, StdRng> {
        let rng = Box::new(StdRng::seed_from_u64(seed));
        let rng = Box::leak(rng);
        ProtocolContext::new(UnixSeconds(1_700_000_000), rng)
    }

    #[test]
    fn header_json_uses_camel_case_wire_fields() {
        let header = Header {
            number: 3,
            previous_chain_length: 2,
            next_public_key: DevicePubkey::from_bytes([9u8; 32]),
        };

        let json = serde_json::to_value(&header).unwrap();
        assert_eq!(json["number"], serde_json::json!(3));
        assert_eq!(json["previousChainLength"], serde_json::json!(2));
        assert_eq!(
            json["nextPublicKey"],
            serde_json::json!(header.next_public_key.to_string())
        );
        assert!(json.get("previous_chain_length").is_none());
        assert!(json.get("next_public_key").is_none());

        let decoded: Header = serde_json::from_value(json).unwrap();
        assert_eq!(decoded, header);
    }

    #[test]
    fn header_json_rejects_snake_case_wire_fields() {
        let old_header = serde_json::json!({
            "number": 3,
            "previous_chain_length": 2,
            "next_public_key": DevicePubkey::from_bytes([9u8; 32]).to_string(),
        });

        assert!(serde_json::from_value::<Header>(old_header).is_err());
    }

    #[test]
    fn plan_send_and_apply_receive_roundtrip() {
        let alice_secret = [1u8; 32];
        let bob_secret = [2u8; 32];
        let alice_pub = device_pubkey_from_secret_bytes(&alice_secret).unwrap();
        let bob_pub = device_pubkey_from_secret_bytes(&bob_secret).unwrap();
        let shared_secret = [7u8; 32];

        let mut init_ctx_alice = context(1);
        let alice =
            Session::new_initiator(&mut init_ctx_alice, bob_pub, alice_secret, shared_secret)
                .unwrap();
        let mut init_ctx_bob = context(2);
        let mut bob =
            Session::new_responder(&mut init_ctx_bob, alice_pub, bob_secret, shared_secret)
                .unwrap();

        let payload = b"hello".to_vec();
        let send_plan = alice
            .plan_send(&payload, UnixSeconds(1_700_000_010))
            .unwrap();
        let send_outcome = alice.clone().apply_send(send_plan.clone());

        let mut recv_ctx = context(10);
        let receive_plan = bob
            .plan_receive(&mut recv_ctx, &send_outcome.envelope)
            .unwrap();
        let outcome = bob.apply_receive(receive_plan);
        assert_eq!(outcome.payload, payload);
    }

    #[test]
    fn plan_receive_does_not_mutate_original_session() {
        let alice_secret = [3u8; 32];
        let bob_secret = [4u8; 32];
        let alice_pub = device_pubkey_from_secret_bytes(&alice_secret).unwrap();
        let bob_pub = device_pubkey_from_secret_bytes(&bob_secret).unwrap();
        let shared_secret = [8u8; 32];

        let mut init_ctx_alice = context(3);
        let alice =
            Session::new_initiator(&mut init_ctx_alice, bob_pub, alice_secret, shared_secret)
                .unwrap();
        let mut init_ctx_bob = context(4);
        let bob = Session::new_responder(&mut init_ctx_bob, alice_pub, bob_secret, shared_secret)
            .unwrap();
        let bob_before = bob.state.clone();

        let payload = b"typing".to_vec();
        let send_plan = alice
            .plan_send(&payload, UnixSeconds(1_700_000_011))
            .unwrap();

        let mut recv_ctx = context(13);
        let _ = bob
            .plan_receive(&mut recv_ctx, &send_plan.envelope)
            .unwrap();

        assert_eq!(bob.state, bob_before);
    }

    #[test]
    fn duplicate_receive_fails_without_corrupting_state() {
        let alice_secret = [5u8; 32];
        let bob_secret = [6u8; 32];
        let alice_pub = device_pubkey_from_secret_bytes(&alice_secret).unwrap();
        let bob_pub = device_pubkey_from_secret_bytes(&bob_secret).unwrap();
        let shared_secret = [9u8; 32];

        let mut init_ctx_alice = context(5);
        let alice =
            Session::new_initiator(&mut init_ctx_alice, bob_pub, alice_secret, shared_secret)
                .unwrap();
        let mut init_ctx_bob = context(6);
        let mut bob =
            Session::new_responder(&mut init_ctx_bob, alice_pub, bob_secret, shared_secret)
                .unwrap();

        let payload = b"hello".to_vec();
        let send_plan = alice
            .plan_send(&payload, UnixSeconds(1_700_000_012))
            .unwrap();
        let envelope = alice.clone().apply_send(send_plan).envelope;

        let mut recv_ctx = context(15);
        let first_plan = bob.plan_receive(&mut recv_ctx, &envelope).unwrap();
        let _ = bob.apply_receive(first_plan);
        let after_first = bob.state.clone();

        let mut replay_ctx = context(16);
        let replay = bob.plan_receive(&mut replay_ctx, &envelope);
        assert!(replay.is_err());
        assert_eq!(bob.state, after_first);
    }

    #[test]
    fn invalid_sender_is_rejected() {
        let alice_secret = [7u8; 32];
        let bob_secret = [8u8; 32];
        let alice_pub = device_pubkey_from_secret_bytes(&alice_secret).unwrap();
        let shared_secret = [10u8; 32];

        let mut init_ctx_bob = context(7);
        let bob = Session::new_responder(&mut init_ctx_bob, alice_pub, bob_secret, shared_secret)
            .unwrap();

        let mut recv_ctx = context(17);
        let err = bob
            .plan_receive(
                &mut recv_ctx,
                &MessageEnvelope {
                    sender: device_pubkey_from_secret_bytes(&bob_secret).unwrap(),
                    recipient: None,
                    signer_secret_key: bob_secret,
                    created_at: UnixSeconds(1),
                    encrypted_header: "bad".to_string(),
                    ciphertext: "bad".to_string(),
                },
            )
            .unwrap_err();
        assert!(matches!(
            err,
            crate::Error::Domain(DomainError::UnexpectedSender)
        ));
    }
}
