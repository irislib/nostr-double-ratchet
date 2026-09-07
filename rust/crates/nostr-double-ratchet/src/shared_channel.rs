use base64::Engine;
use nostr::nips::nip44;
use nostr::{EventBuilder, Keys, PublicKey, Tag};

use crate::{Error, Result, SHARED_CHANNEL_KIND};

/// A shared NIP-44 encrypted channel derived from a secret key.
/// All participants who know the secret can publish and read events.
/// Inner content is rumor JSON identifying the real author.
pub struct SharedChannel {
    public_key: PublicKey,
    secret_key: [u8; 32],
    conversation_key: nip44::v2::ConversationKey,
}

impl SharedChannel {
    /// Create a new SharedChannel from a 32-byte secret.
    pub fn new(secret_bytes: &[u8; 32]) -> Result<Self> {
        let secret_key = nostr::SecretKey::from_slice(secret_bytes)?;
        let keys = Keys::new(secret_key);
        let public_key = keys.public_key();

        // Self-encryption: derive conversation key from secret_key + own public_key
        let conversation_key = nip44::v2::ConversationKey::derive(keys.secret_key(), &public_key)?;

        Ok(Self {
            public_key,
            secret_key: *secret_bytes,
            conversation_key,
        })
    }

    /// Encrypt a rumor JSON string and return a signed kind 4 outer event.
    pub fn create_event(&self, rumor_json: &str) -> Result<nostr::Event> {
        let encrypted = nip44::v2::encrypt_to_bytes(&self.conversation_key, rumor_json.as_bytes())?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&encrypted);

        let secret_key = nostr::SecretKey::from_slice(&self.secret_key)?;
        let keys = Keys::new(secret_key);
        let public_key_tag = Tag::parse(["p".to_string(), keys.public_key().to_hex()])
            .map_err(|e| Error::InvalidEvent(e.to_string()))?;

        let unsigned = EventBuilder::new(nostr::Kind::Custom(SHARED_CHANNEL_KIND as u16), &encoded)
            .tag(public_key_tag)
            .allow_self_tagging()
            .build(keys.public_key());

        let event = unsigned
            .sign_with_keys(&keys)
            .map_err(|e| Error::InvalidEvent(e.to_string()))?;

        Ok(event)
    }

    /// Authenticate the channel's outer event and return the decrypted rumor JSON.
    pub fn decrypt_event(&self, event: &nostr::Event) -> Result<String> {
        if !self.is_channel_event(event) {
            return Err(Error::InvalidEvent(
                "event does not belong to this shared channel".to_string(),
            ));
        }
        event.verify()?;

        let ciphertext_bytes = base64::engine::general_purpose::STANDARD
            .decode(event.content.as_bytes())
            .map_err(|e| Error::Decryption(format!("Base64 decode error: {}", e)))?;

        let plaintext_bytes =
            nip44::v2::decrypt_to_bytes(&self.conversation_key, &ciphertext_bytes)?;

        String::from_utf8(plaintext_bytes)
            .map_err(|e| Error::Decryption(format!("UTF-8 decode error: {}", e)))
    }

    /// Check if an event belongs to this channel.
    pub fn is_channel_event(&self, event: &nostr::Event) -> bool {
        event.pubkey == self.public_key
            && event.kind == nostr::Kind::Custom(SHARED_CHANNEL_KIND as u16)
    }

    /// Get the channel's public key.
    pub fn public_key(&self) -> PublicKey {
        self.public_key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> [u8; 32] {
        let mut bytes = [0u8; 32];
        bytes[0] = 1;
        bytes[31] = 0xff;
        bytes
    }

    fn make_rumor_json(pubkey: &str, content: &str) -> String {
        serde_json::json!({
            "id": "abc123",
            "pubkey": pubkey,
            "created_at": 1700000000,
            "kind": 10445,
            "tags": [],
            "content": content
        })
        .to_string()
    }

    fn make_test_event(keys: &Keys, kind: nostr::Kind, content: &str) -> nostr::Event {
        let unsigned = EventBuilder::new(kind, content).build(keys.public_key());
        unsigned.sign_with_keys(keys).unwrap()
    }

    #[test]
    fn new_channel_from_secret() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let keys = Keys::new(nostr::SecretKey::from_slice(&secret).unwrap());
        assert_eq!(channel.public_key(), keys.public_key());
    }

    #[test]
    fn create_event_returns_kind_4() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let rumor = make_rumor_json("deadbeef", "hello");
        let event = channel.create_event(&rumor).unwrap();
        assert_eq!(event.kind, nostr::Kind::Custom(SHARED_CHANNEL_KIND as u16));
    }

    #[test]
    fn create_event_signed_by_channel_key() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let rumor = make_rumor_json("deadbeef", "hello");
        let event = channel.create_event(&rumor).unwrap();
        assert_eq!(event.pubkey, channel.public_key());
    }

    #[test]
    fn roundtrip_create_decrypt() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let rumor = make_rumor_json("deadbeef", "hello world");
        let event = channel.create_event(&rumor).unwrap();
        let decrypted = channel.decrypt_event(&event).unwrap();

        let original: serde_json::Value = serde_json::from_str(&rumor).unwrap();
        let result: serde_json::Value = serde_json::from_str(&decrypted).unwrap();
        assert_eq!(original, result);
    }

    #[test]
    fn decrypt_rejects_ciphertext_republished_by_another_author() {
        let channel = SharedChannel::new(&test_secret()).unwrap();
        let rumor = make_rumor_json("aabbcc", "captured channel message");
        let event = channel.create_event(&rumor).unwrap();
        let attacker = Keys::generate();
        let republished = make_test_event(&attacker, event.kind, &event.content);

        assert!(republished.verify().is_ok());
        assert_ne!(republished.id, event.id);
        assert!(channel.decrypt_event(&republished).is_err());
        assert_eq!(channel.decrypt_event(&event).unwrap(), rumor);
    }

    #[test]
    fn decrypt_rejects_channel_ciphertext_under_another_kind() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let event = channel
            .create_event(&make_rumor_json("aabbcc", "wrong kind"))
            .unwrap();
        let keys = Keys::new(nostr::SecretKey::from_slice(&secret).unwrap());
        let republished = make_test_event(&keys, nostr::Kind::TextNote, &event.content);

        assert!(republished.verify().is_ok());
        assert!(channel.decrypt_event(&republished).is_err());
    }

    #[test]
    fn decrypt_rejects_forged_channel_signature_with_valid_event_id() {
        let channel = SharedChannel::new(&test_secret()).unwrap();
        let mut event = channel
            .create_event(&make_rumor_json("aabbcc", "forged timestamp"))
            .unwrap();
        let mut forged = nostr::UnsignedEvent::new(
            event.pubkey,
            nostr::Timestamp::from(event.created_at.as_secs() + 1),
            event.kind,
            event.tags.clone().to_vec(),
            event.content.clone(),
        );
        forged.ensure_id();
        event.id = forged.id.unwrap();
        event.created_at = forged.created_at;

        assert!(forged.verify_id().is_ok());
        assert!(event.verify().is_err());
        assert!(channel.decrypt_event(&event).is_err());
    }

    #[test]
    fn decrypt_rejects_channel_event_with_invalid_id() {
        let channel = SharedChannel::new(&test_secret()).unwrap();
        let mut event = channel
            .create_event(&make_rumor_json("aabbcc", "tampered timestamp"))
            .unwrap();
        event.created_at = nostr::Timestamp::from(event.created_at.as_secs() + 1);

        assert!(event.verify().is_err());
        assert!(channel.decrypt_event(&event).is_err());
    }

    #[test]
    fn cross_decrypt_same_secret() {
        let secret = test_secret();
        let channel1 = SharedChannel::new(&secret).unwrap();
        let channel2 = SharedChannel::new(&secret).unwrap();

        let rumor = make_rumor_json("aabbcc", "cross-channel test");
        let event = channel1.create_event(&rumor).unwrap();
        let decrypted = channel2.decrypt_event(&event).unwrap();

        let original: serde_json::Value = serde_json::from_str(&rumor).unwrap();
        let result: serde_json::Value = serde_json::from_str(&decrypted).unwrap();
        assert_eq!(original, result);
    }

    #[test]
    fn different_secret_cannot_decrypt() {
        let secret1 = test_secret();
        let mut secret2 = test_secret();
        secret2[0] = 2;

        let channel1 = SharedChannel::new(&secret1).unwrap();
        let channel2 = SharedChannel::new(&secret2).unwrap();

        let rumor = make_rumor_json("aabbcc", "private");
        let event = channel1.create_event(&rumor).unwrap();
        assert!(channel2.decrypt_event(&event).is_err());
    }

    #[test]
    fn is_channel_event_true_for_own_events() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let rumor = make_rumor_json("aabbcc", "test");
        let event = channel.create_event(&rumor).unwrap();
        assert!(channel.is_channel_event(&event));
    }

    #[test]
    fn is_channel_event_false_for_wrong_pubkey() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let other_keys = Keys::generate();
        let event = make_test_event(
            &other_keys,
            nostr::Kind::Custom(SHARED_CHANNEL_KIND as u16),
            "content",
        );
        assert!(!channel.is_channel_event(&event));
    }

    #[test]
    fn is_channel_event_false_for_wrong_kind() {
        let secret = test_secret();
        let channel = SharedChannel::new(&secret).unwrap();
        let keys = Keys::new(nostr::SecretKey::from_slice(&secret).unwrap());
        let event = make_test_event(&keys, nostr::Kind::TextNote, "content");
        assert!(!channel.is_channel_event(&event));
    }

    #[test]
    fn channel_from_random_secret() {
        let secret: [u8; 32] = rand::random();
        let channel = SharedChannel::new(&secret).unwrap();
        let rumor = make_rumor_json("test", "random secret test");
        let event = channel.create_event(&rumor).unwrap();
        let decrypted = channel.decrypt_event(&event).unwrap();
        let original: serde_json::Value = serde_json::from_str(&rumor).unwrap();
        let result: serde_json::Value = serde_json::from_str(&decrypted).unwrap();
        assert_eq!(original, result);
    }
}
