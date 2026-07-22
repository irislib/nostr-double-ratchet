use crate::{DomainError, Result};
use base64::Engine;
use nostr::nips::nip44;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SENDER_KEY_MAX_SKIP: usize = 10_000;
pub const SENDER_KEY_MAX_STORED_SKIPPED_KEYS: usize = 2_000;

const SENDER_KEY_KDF_SALT: &[u8] = b"ndr-sender-key-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SenderKeyState {
    pub key_id: u32,
    #[serde(with = "hex::serde")]
    chain_key: [u8; 32],
    iteration: u32,
    #[serde(default, with = "crate::serde_hex::btreemap_u32")]
    skipped_message_keys: BTreeMap<u32, [u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderKeyMessageContent {
    pub key_id: u32,
    pub message_number: u32,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderKeyEncryptPlan {
    pub next_state: SenderKeyState,
    pub key_id: u32,
    pub message_number: u32,
    pub ciphertext: Vec<u8>,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderKeyEncryptOutcome {
    pub key_id: u32,
    pub message_number: u32,
    pub ciphertext: Vec<u8>,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderKeyDecryptPlan {
    pub next_state: SenderKeyState,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderKeyDecryptOutcome {
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SenderKeyBlindDecryptPlan {
    pub next_state: SenderKeyState,
    pub key_id: u32,
    pub message_number: u32,
    pub plaintext: Vec<u8>,
}

impl SenderKeyState {
    pub fn new(key_id: u32, chain_key: [u8; 32], iteration: u32) -> Self {
        Self {
            key_id,
            chain_key,
            iteration,
            skipped_message_keys: BTreeMap::new(),
        }
    }

    pub fn key_id(&self) -> u32 {
        self.key_id
    }

    pub fn chain_key(&self) -> [u8; 32] {
        self.chain_key
    }

    pub fn iteration(&self) -> u32 {
        self.iteration
    }

    pub fn skipped_len(&self) -> usize {
        self.skipped_message_keys.len()
    }

    pub fn plan_encrypt(&self, plaintext: &[u8]) -> Result<SenderKeyEncryptPlan> {
        let mut next_state = self.clone();
        let message_number = next_state.iteration;
        let (next_chain_key, message_key) = derive_message_key(&next_state.chain_key);
        next_state.chain_key = next_chain_key;
        next_state.iteration = next_state
            .iteration
            .checked_add(1)
            .ok_or_else(|| crate::Error::Encryption("sender-key iteration overflow".to_string()))?;

        let conversation_key = nip44::v2::ConversationKey::new(message_key);
        let ciphertext = nip44::v2::encrypt_to_bytes(&conversation_key, plaintext)?;

        Ok(SenderKeyEncryptPlan {
            next_state,
            key_id: self.key_id,
            message_number,
            ciphertext,
            plaintext: plaintext.to_vec(),
        })
    }

    pub fn apply_encrypt(&mut self, plan: SenderKeyEncryptPlan) -> SenderKeyEncryptOutcome {
        self.clone_from(&plan.next_state);
        SenderKeyEncryptOutcome {
            key_id: plan.key_id,
            message_number: plan.message_number,
            ciphertext: plan.ciphertext,
            plaintext: plan.plaintext,
        }
    }

    pub fn plan_decrypt(&self, message: &SenderKeyMessageContent) -> Result<SenderKeyDecryptPlan> {
        if message.key_id != self.key_id {
            return Err(crate::Error::Decryption(format!(
                "sender-key id mismatch: expected {}, got {}",
                self.key_id, message.key_id
            )));
        }

        let mut next_state = self.clone();
        let plaintext = next_state.decrypt_in_place(message.message_number, &message.ciphertext)?;

        Ok(SenderKeyDecryptPlan {
            next_state,
            plaintext,
        })
    }

    pub fn plan_decrypt_blind(&self, ciphertext: &[u8]) -> Result<SenderKeyBlindDecryptPlan> {
        for (message_number, message_key) in &self.skipped_message_keys {
            if let Ok(plaintext) = decrypt_with_message_key(message_key, ciphertext) {
                let mut next_state = self.clone();
                next_state.skipped_message_keys.remove(message_number);
                return Ok(SenderKeyBlindDecryptPlan {
                    next_state,
                    key_id: self.key_id,
                    message_number: *message_number,
                    plaintext,
                });
            }
        }

        let mut next_state = self.clone();
        let max_message_number = self.iteration.saturating_add(SENDER_KEY_MAX_SKIP as u32);
        while next_state.iteration <= max_message_number {
            let message_number = next_state.iteration;
            let (next_chain_key, message_key) = derive_message_key(&next_state.chain_key);
            next_state.chain_key = next_chain_key;
            next_state.iteration = next_state.iteration.checked_add(1).ok_or_else(|| {
                crate::Error::Decryption("sender-key iteration overflow".to_string())
            })?;

            if let Ok(plaintext) = decrypt_with_message_key(&message_key, ciphertext) {
                prune_skipped(&mut next_state.skipped_message_keys);
                return Ok(SenderKeyBlindDecryptPlan {
                    next_state,
                    key_id: self.key_id,
                    message_number,
                    plaintext,
                });
            }

            next_state
                .skipped_message_keys
                .insert(message_number, message_key);
        }

        Err(crate::Error::Decryption(
            "sender-key blind decrypt failed".to_string(),
        ))
    }

    pub fn apply_decrypt(&mut self, plan: SenderKeyDecryptPlan) -> SenderKeyDecryptOutcome {
        self.clone_from(&plan.next_state);
        SenderKeyDecryptOutcome {
            plaintext: plan.plaintext,
        }
    }

    pub fn encrypt_to_bytes(&mut self, plaintext: &[u8]) -> Result<(u32, Vec<u8>)> {
        let plan = self.plan_encrypt(plaintext)?;
        let outcome = self.apply_encrypt(plan);
        Ok((outcome.message_number, outcome.ciphertext))
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(u32, String)> {
        let (message_number, ciphertext) = self.encrypt_to_bytes(plaintext)?;
        Ok((
            message_number,
            base64::engine::general_purpose::STANDARD.encode(ciphertext),
        ))
    }

    pub fn decrypt_from_bytes(
        &mut self,
        message_number: u32,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>> {
        let message = SenderKeyMessageContent {
            key_id: self.key_id,
            message_number,
            ciphertext: ciphertext.to_vec(),
        };
        let plan = self.plan_decrypt(&message)?;
        Ok(self.apply_decrypt(plan).plaintext)
    }

    pub fn decrypt(&mut self, message_number: u32, ciphertext: &str) -> Result<Vec<u8>> {
        if message_number >= self.iteration {
            let delta = (message_number - self.iteration) as usize;
            if delta > SENDER_KEY_MAX_SKIP {
                return Err(DomainError::TooManySkippedMessages.into());
            }
        }

        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(ciphertext)
            .map_err(|e| crate::Error::Decryption(e.to_string()))?;
        self.decrypt_from_bytes(message_number, &ciphertext)
    }

    fn decrypt_in_place(&mut self, message_number: u32, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if message_number < self.iteration {
            let message_key = self
                .skipped_message_keys
                .remove(&message_number)
                .ok_or_else(|| {
                    crate::Error::Decryption("duplicate or missing sender-key message".to_string())
                })?;
            return decrypt_with_message_key(&message_key, ciphertext);
        }

        let delta = (message_number - self.iteration) as usize;
        if delta > SENDER_KEY_MAX_SKIP {
            return Err(DomainError::TooManySkippedMessages.into());
        }

        while self.iteration < message_number {
            let (next_chain_key, message_key) = derive_message_key(&self.chain_key);
            self.chain_key = next_chain_key;
            self.skipped_message_keys
                .insert(self.iteration, message_key);
            self.iteration = self.iteration.checked_add(1).ok_or_else(|| {
                crate::Error::Decryption("sender-key iteration overflow".to_string())
            })?;
        }

        let (next_chain_key, message_key) = derive_message_key(&self.chain_key);
        self.chain_key = next_chain_key;
        self.iteration = self
            .iteration
            .checked_add(1)
            .ok_or_else(|| crate::Error::Decryption("sender-key iteration overflow".to_string()))?;
        prune_skipped(&mut self.skipped_message_keys);

        decrypt_with_message_key(&message_key, ciphertext)
    }
}

fn derive_message_key(chain_key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let outputs = crate::kdf(chain_key, SENDER_KEY_KDF_SALT, 2);
    (outputs[0], outputs[1])
}

fn decrypt_with_message_key(message_key: &[u8; 32], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let conversation_key = nip44::v2::ConversationKey::new(*message_key);
    nip44::v2::decrypt_to_bytes(&conversation_key, ciphertext).map_err(Into::into)
}

fn prune_skipped(map: &mut BTreeMap<u32, [u8; 32]>) {
    while map.len() > SENDER_KEY_MAX_STORED_SKIPPED_KEYS {
        let Some(first) = map.keys().next().copied() else {
            break;
        };
        map.remove(&first);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_key_roundtrip_single_message() {
        let chain_key = [7u8; 32];
        let mut sender = SenderKeyState::new(1, chain_key, 0);
        let mut receiver = SenderKeyState::new(1, chain_key, 0);

        let (message_number, ciphertext) = sender.encrypt_to_bytes(b"hello").unwrap();
        assert_eq!(message_number, 0);

        let plaintext = receiver
            .decrypt_from_bytes(message_number, &ciphertext)
            .unwrap();
        assert_eq!(plaintext, b"hello");
        assert_eq!(sender.iteration(), receiver.iteration());
        assert_eq!(sender.chain_key(), receiver.chain_key());
    }

    #[test]
    fn sender_key_decrypt_out_of_order() {
        let chain_key = [9u8; 32];
        let mut sender = SenderKeyState::new(1, chain_key, 0);
        let mut receiver = SenderKeyState::new(1, chain_key, 0);

        let (n0, c0) = sender.encrypt_to_bytes(b"m0").unwrap();
        let (n1, c1) = sender.encrypt_to_bytes(b"m1").unwrap();

        assert_eq!(receiver.decrypt_from_bytes(n1, &c1).unwrap(), b"m1");
        assert_eq!(receiver.decrypt_from_bytes(n0, &c0).unwrap(), b"m0");
    }

    #[test]
    fn sender_key_rejects_duplicate_message() {
        let chain_key = [11u8; 32];
        let mut sender = SenderKeyState::new(1, chain_key, 0);
        let mut receiver = SenderKeyState::new(1, chain_key, 0);
        let (n, c) = sender.encrypt_to_bytes(b"once").unwrap();

        assert_eq!(receiver.decrypt_from_bytes(n, &c).unwrap(), b"once");
        assert!(receiver.decrypt_from_bytes(n, &c).is_err());
    }

    #[test]
    fn sender_key_rejects_too_many_skipped_messages() {
        let chain_key = [3u8; 32];
        let mut receiver = SenderKeyState::new(1, chain_key, 0);
        let before = receiver.clone();

        let err = receiver.decrypt(100_000, "AA").unwrap_err();
        assert!(matches!(
            err,
            crate::Error::Domain(DomainError::TooManySkippedMessages)
        ));
        assert_eq!(receiver, before);
    }

    #[test]
    fn sender_key_plan_encrypt_is_pure_until_apply() {
        let chain_key = [4u8; 32];
        let mut sender = SenderKeyState::new(7, chain_key, 0);
        let before = sender.clone();

        let plan = sender.plan_encrypt(b"deferred").unwrap();

        assert_eq!(sender, before);
        assert_eq!(plan.key_id, 7);
        assert_eq!(plan.message_number, 0);

        let outcome = sender.apply_encrypt(plan);
        assert_eq!(outcome.plaintext, b"deferred");
        assert_eq!(sender.iteration(), 1);
        assert_ne!(sender, before);
    }

    #[test]
    fn sender_key_plan_decrypt_is_pure_until_apply() {
        let chain_key = [5u8; 32];
        let mut sender = SenderKeyState::new(9, chain_key, 0);
        let mut receiver = SenderKeyState::new(9, chain_key, 0);
        let (message_number, ciphertext) = sender.encrypt_to_bytes(b"planned").unwrap();
        let before = receiver.clone();

        let plan = receiver
            .plan_decrypt(&SenderKeyMessageContent {
                key_id: 9,
                message_number,
                ciphertext,
            })
            .unwrap();

        assert_eq!(receiver, before);
        assert_eq!(plan.plaintext, b"planned");

        let outcome = receiver.apply_decrypt(plan);
        assert_eq!(outcome.plaintext, b"planned");
        assert_eq!(receiver.iteration(), 1);
        assert_ne!(receiver, before);
    }

    #[test]
    fn sender_key_wrong_key_id_does_not_mutate_receiver() {
        let chain_key = [13u8; 32];
        let mut sender = SenderKeyState::new(1, chain_key, 0);
        let receiver = SenderKeyState::new(1, chain_key, 0);
        let (message_number, ciphertext) = sender.encrypt_to_bytes(b"wrong id").unwrap();
        let before = receiver.clone();

        let err = receiver
            .plan_decrypt(&SenderKeyMessageContent {
                key_id: 2,
                message_number,
                ciphertext,
            })
            .unwrap_err();

        assert!(matches!(err, crate::Error::Decryption(_)));
        assert_eq!(receiver, before);
    }

    #[test]
    fn sender_key_corrupted_ciphertext_does_not_mutate_receiver() {
        let chain_key = [15u8; 32];
        let mut sender = SenderKeyState::new(1, chain_key, 0);
        let mut receiver = SenderKeyState::new(1, chain_key, 0);
        let (message_number, ciphertext) =
            sender.encrypt_to_bytes(b"valid after corruption").unwrap();
        let mut corrupted = ciphertext.clone();
        let last = corrupted.last_mut().expect("ciphertext must not be empty");
        *last ^= 0x55;
        let before = receiver.clone();

        assert!(receiver
            .decrypt_from_bytes(message_number, &corrupted)
            .is_err());
        assert_eq!(receiver, before);
        assert_eq!(
            receiver
                .decrypt_from_bytes(message_number, &ciphertext)
                .unwrap(),
            b"valid after corruption"
        );
    }

    #[test]
    fn sender_key_encrypt_iteration_overflow_does_not_mutate_sender() {
        let sender = SenderKeyState::new(1, [17u8; 32], u32::MAX);
        let before = sender.clone();

        let err = sender.plan_encrypt(b"overflow").unwrap_err();

        assert!(matches!(err, crate::Error::Encryption(_)));
        assert_eq!(sender, before);
    }

    #[test]
    fn sender_key_snapshot_roundtrip_preserves_skipped_keys_and_future_decrypt() {
        let chain_key = [19u8; 32];
        let mut sender = SenderKeyState::new(1, chain_key, 0);
        let mut receiver = SenderKeyState::new(1, chain_key, 0);
        let (n0, c0) = sender.encrypt_to_bytes(b"m0").unwrap();
        let (n1, c1) = sender.encrypt_to_bytes(b"m1").unwrap();
        let (n2, c2) = sender.encrypt_to_bytes(b"m2").unwrap();

        assert_eq!(receiver.decrypt_from_bytes(n2, &c2).unwrap(), b"m2");
        assert_eq!(receiver.skipped_len(), 2);

        let json = serde_json::to_string(&receiver).unwrap();
        let mut restored: SenderKeyState = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.decrypt_from_bytes(n0, &c0).unwrap(), b"m0");
        assert_eq!(restored.decrypt_from_bytes(n1, &c1).unwrap(), b"m1");

        let (n3, c3) = sender.encrypt_to_bytes(b"m3").unwrap();
        assert_eq!(restored.decrypt_from_bytes(n3, &c3).unwrap(), b"m3");
    }
}
