use base64::Engine;

use crate::{wire::encrypted_cover_header_tag, Error, Result, SenderKeyState, MESSAGE_EVENT_KIND};

/// A lightweight helper for "one-to-many" publishing:
///
/// - Outer Nostr event is authored by a sender-controlled pubkey (eg per-group sender keypair).
/// - New outer content is only `base64(nip44_ciphertext_bytes)`.
/// - Legacy no-header outers with public `key_id_be || msg_num_be || ciphertext` still parse.
/// - Ciphertext bytes are produced/consumed by [`SenderKeyState`].
#[derive(Debug, Clone)]
pub struct OneToManyChannel {
    outer_kind: u32,
}

impl Default for OneToManyChannel {
    fn default() -> Self {
        Self {
            outer_kind: MESSAGE_EVENT_KIND,
        }
    }
}

/// Parsed one-to-many outer content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OneToManyMessage {
    pub key_id: u32,
    pub message_number: u32,
    pub encrypted_header: Option<String>,
    pub ciphertext: Vec<u8>,
}

impl OneToManyMessage {
    pub fn decrypt(&self, state: &mut SenderKeyState) -> Result<String> {
        let plaintext = if self.encrypted_header.is_some() {
            let plan = state.plan_decrypt_blind(&self.ciphertext)?;
            state.clone_from(&plan.next_state);
            plan.plaintext
        } else {
            state.decrypt_from_bytes(self.message_number, &self.ciphertext)?
        };
        String::from_utf8(plaintext).map_err(|e| Error::Decryption(e.to_string()))
    }
}

impl OneToManyChannel {
    pub fn new(outer_kind: u32) -> Self {
        Self { outer_kind }
    }

    pub fn outer_kind(&self) -> u32 {
        self.outer_kind
    }

    pub fn build_outer_content(
        &self,
        _key_id: u32,
        _message_number: u32,
        ciphertext_bytes: &[u8],
    ) -> String {
        self.build_hidden_outer_content(ciphertext_bytes)
    }

    pub fn build_hidden_outer_content(&self, ciphertext_bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(ciphertext_bytes)
    }

    pub fn build_legacy_outer_content(
        &self,
        key_id: u32,
        message_number: u32,
        ciphertext_bytes: &[u8],
    ) -> String {
        let mut payload: Vec<u8> = Vec::with_capacity(8 + ciphertext_bytes.len());
        payload.extend_from_slice(&key_id.to_be_bytes());
        payload.extend_from_slice(&message_number.to_be_bytes());
        payload.extend_from_slice(ciphertext_bytes);
        base64::engine::general_purpose::STANDARD.encode(payload)
    }

    pub fn parse_outer_content(&self, content: &str) -> Result<OneToManyMessage> {
        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|e| Error::InvalidEvent(e.to_string()))?;
        Ok(OneToManyMessage {
            key_id: 0,
            message_number: 0,
            encrypted_header: Some(String::new()),
            ciphertext,
        })
    }

    pub fn parse_legacy_outer_content(&self, content: &str) -> Result<OneToManyMessage> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|e| Error::InvalidEvent(e.to_string()))?;
        if bytes.len() < 8 {
            return Err(Error::InvalidEvent(
                "one-to-many payload too short".to_string(),
            ));
        }
        let key_id = u32::from_be_bytes(
            bytes[0..4]
                .try_into()
                .map_err(|_| Error::InvalidEvent("invalid key_id bytes".to_string()))?,
        );
        let message_number = u32::from_be_bytes(
            bytes[4..8]
                .try_into()
                .map_err(|_| Error::InvalidEvent("invalid message_number bytes".to_string()))?,
        );
        Ok(OneToManyMessage {
            key_id,
            message_number,
            encrypted_header: None,
            ciphertext: bytes[8..].to_vec(),
        })
    }

    pub fn parse_outer_event(&self, event: &nostr::Event) -> Result<OneToManyMessage> {
        if !crate::has_metadata_privacy_version(event) {
            return Err(Error::InvalidEvent(
                "group event requires a privacy upgrade".into(),
            ));
        }
        if event.kind != nostr::Kind::Custom(self.outer_kind as u16) {
            return Err(Error::InvalidEvent(format!(
                "unexpected kind {}, expected {}",
                event.kind, self.outer_kind
            )));
        }
        event
            .verify()
            .map_err(|e| Error::InvalidEvent(e.to_string()))?;

        if let Some(encrypted_header) = first_tag_value(event, "header") {
            let mut parsed = self.parse_outer_content(&event.content)?;
            parsed.encrypted_header = Some(encrypted_header);
            return Ok(parsed);
        }

        self.parse_legacy_outer_content(&event.content)
    }

    pub fn encrypt_to_outer_event(
        &self,
        sender_event_keys: &nostr::Keys,
        sender_key: &mut SenderKeyState,
        inner_plaintext: &str,
        created_at: nostr::Timestamp,
    ) -> Result<nostr::Event> {
        let (n, ciphertext_bytes) = sender_key.encrypt_to_bytes(inner_plaintext.as_bytes())?;
        let content = self.build_outer_content(sender_key.key_id, n, ciphertext_bytes.as_slice());

        let unsigned =
            nostr::EventBuilder::new(nostr::Kind::Custom(self.outer_kind as u16), &content)
                .tag(nostr::Tag::parse(["v", "2"]).expect("valid version tag"))
                .tag(encrypted_cover_header_tag(sender_event_keys)?)
                .custom_created_at(created_at)
                .build(sender_event_keys.public_key());

        let signed = unsigned.sign_with_keys(sender_event_keys)?;
        Ok(signed)
    }
}

fn first_tag_value(event: &nostr::Event, key: &str) -> Option<String> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(|value| value.as_str()) == Some(key))
        .and_then(|tag| tag.as_slice().get(1).map(ToOwned::to_owned))
}
