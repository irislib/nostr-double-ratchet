#[cfg(feature = "full")]
use crate::DeviceRoster;
use crate::{
    owner_pubkey_from_device_pubkey, random_secret_key_bytes, secret_key_from_bytes, DevicePubkey,
    DomainError, OwnerPubkey, ProtocolContext, Result, Session, UnixSeconds,
};
use base64::Engine;
use nostr::nips::nip44::{self, Version};
use nostr::secp256k1::schnorr::Signature;
use nostr::secp256k1::Message;
use nostr::{
    EventId, JsonUtil, Keys, Kind, PublicKey, Tag, Tags, Timestamp, UnsignedEvent, SECP256K1,
};
use rand::rngs::OsRng;
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Invite {
    pub inviter_device_pubkey: DevicePubkey,
    pub inviter_ephemeral_public_key: DevicePubkey,
    #[serde(with = "hex::serde")]
    pub shared_secret: [u8; 32],
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_hex::option"
    )]
    pub inviter_ephemeral_private_key: Option<[u8; 32]>,
    pub max_uses: Option<usize>,
    pub used_by: Vec<DevicePubkey>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_response_contents: Vec<String>,
    pub created_at: UnixSeconds,
    pub inviter_owner_pubkey: Option<OwnerPubkey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    pub inviter: PublicKey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_public_key: Option<PublicKey>,
}

#[derive(Debug, Clone)]
pub struct InviteResponse {
    pub session: Session,
    pub invitee_device_pubkey: DevicePubkey,
    pub invitee_owner_pubkey: Option<OwnerPubkey>,
    pub invitee_identity: PublicKey,
    pub device_id: Option<String>,
    pub owner_public_key: Option<PublicKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteResponseEnvelope {
    pub sender: DevicePubkey,
    pub signer_secret_key: [u8; 32],
    pub recipient: DevicePubkey,
    pub created_at: UnixSeconds,
    pub content: String,
}

impl InviteResponse {
    pub fn resolved_owner_pubkey(&self) -> PublicKey {
        self.owner_public_key.unwrap_or(self.invitee_identity)
    }

    pub fn claimed_owner_pubkey(&self) -> Option<OwnerPubkey> {
        self.invitee_owner_pubkey
    }

    pub fn has_verified_owner_claim(&self, verifier: Option<&dyn OwnerClaimVerifier>) -> bool {
        let owner_pubkey = self
            .invitee_owner_pubkey
            .unwrap_or_else(|| owner_pubkey_from_device_pubkey(self.invitee_device_pubkey));

        if owner_pubkey == owner_pubkey_from_device_pubkey(self.invitee_device_pubkey) {
            return true;
        }

        verifier.is_some_and(|verifier| {
            verifier.has_device(self.invitee_device_pubkey, self.invitee_identity)
        })
    }
}

pub trait OwnerClaimVerifier {
    fn has_device(&self, device_pubkey: DevicePubkey, device_identity: PublicKey) -> bool;
}

#[cfg(feature = "full")]
impl OwnerClaimVerifier for DeviceRoster {
    fn has_device(&self, device_pubkey: DevicePubkey, _device_identity: PublicKey) -> bool {
        self.get_device(&device_pubkey).is_some()
    }
}

impl Invite {
    pub fn create_new(
        inviter: PublicKey,
        device_id: Option<String>,
        max_uses: Option<usize>,
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
        let mut invite = Self::create_new_with_context(
            &mut ctx,
            DevicePubkey::from_bytes(inviter.to_bytes()),
            None,
            max_uses,
        )?;
        invite.device_id = device_id;
        Ok(invite)
    }

    pub fn create_new_with_context<R>(
        ctx: &mut ProtocolContext<'_, R>,
        inviter_device_pubkey: DevicePubkey,
        inviter_owner_pubkey: Option<OwnerPubkey>,
        max_uses: Option<usize>,
    ) -> Result<Self>
    where
        R: RngCore + CryptoRng,
    {
        let inviter_ephemeral_private_key = random_secret_key_bytes(ctx.rng)?;
        let inviter_ephemeral_public_key =
            crate::device_pubkey_from_secret_bytes(&inviter_ephemeral_private_key)?;
        let shared_secret = random_secret_key_bytes(ctx.rng)?;

        Ok(Self {
            inviter_device_pubkey,
            inviter_ephemeral_public_key,
            shared_secret,
            inviter_ephemeral_private_key: Some(inviter_ephemeral_private_key),
            max_uses,
            used_by: Vec::new(),
            used_response_contents: Vec::new(),
            created_at: ctx.now,
            inviter_owner_pubkey,
            purpose: None,
            inviter: inviter_device_pubkey.to_nostr()?,
            device_id: None,
            owner_public_key: inviter_owner_pubkey
                .map(|owner| owner.to_nostr())
                .transpose()?,
        })
    }

    pub fn serialize(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn deserialize(json: &str) -> Result<Self> {
        Ok(serde_json::from_str(json)?)
    }

    pub fn accept(
        &self,
        invitee_public_key: PublicKey,
        invitee_private_key: [u8; 32],
        device_id: Option<String>,
    ) -> Result<(Session, InviteResponseEnvelope)> {
        self.accept_with_owner(invitee_public_key, invitee_private_key, device_id, None)
    }

    pub fn accept_with_owner(
        &self,
        invitee_public_key: PublicKey,
        invitee_private_key: [u8; 32],
        device_id: Option<String>,
        owner_public_key: Option<PublicKey>,
    ) -> Result<(Session, InviteResponseEnvelope)> {
        let mut rng = OsRng;
        let mut ctx = ProtocolContext::new(now_seconds(), &mut rng);
        self.accept_with_owner_context_and_device(
            &mut ctx,
            DevicePubkey::from_bytes(invitee_public_key.to_bytes()),
            invitee_private_key,
            owner_public_key.map(|owner| OwnerPubkey::from_bytes(owner.to_bytes())),
            device_id,
        )
    }

    pub fn accept_with_context<R>(
        &self,
        ctx: &mut ProtocolContext<'_, R>,
        invitee_public_key: DevicePubkey,
        invitee_private_key: [u8; 32],
    ) -> Result<(Session, InviteResponseEnvelope)>
    where
        R: RngCore + CryptoRng,
    {
        self.accept_with_owner_context(ctx, invitee_public_key, invitee_private_key, None)
    }

    pub fn accept_with_owner_context<R>(
        &self,
        ctx: &mut ProtocolContext<'_, R>,
        invitee_public_key: DevicePubkey,
        invitee_private_key: [u8; 32],
        invitee_owner_pubkey: Option<OwnerPubkey>,
    ) -> Result<(Session, InviteResponseEnvelope)>
    where
        R: RngCore + CryptoRng,
    {
        self.accept_with_owner_context_and_device(
            ctx,
            invitee_public_key,
            invitee_private_key,
            invitee_owner_pubkey,
            None,
        )
    }

    fn accept_with_owner_context_and_device<R>(
        &self,
        ctx: &mut ProtocolContext<'_, R>,
        invitee_public_key: DevicePubkey,
        invitee_private_key: [u8; 32],
        invitee_owner_pubkey: Option<OwnerPubkey>,
        device_id: Option<String>,
    ) -> Result<(Session, InviteResponseEnvelope)>
    where
        R: RngCore + CryptoRng,
    {
        self.ensure_accept_allowed(invitee_public_key)?;

        let invitee_session_key = random_secret_key_bytes(ctx.rng)?;
        let invitee_session_public_key =
            crate::device_pubkey_from_secret_bytes(&invitee_session_key)?;

        let proof_digest = invite_session_proof_digest(
            self.inviter_device_pubkey,
            self.inviter_ephemeral_public_key,
            invitee_public_key,
            invitee_session_public_key,
            self.shared_secret,
        );
        let proof_message = Message::from_digest(proof_digest);
        let session_keys = Keys::new(secret_key_from_bytes(&invitee_session_key)?);
        let session_proof = session_keys.sign_schnorr_with_ctx(SECP256K1, &proof_message, ctx.rng);

        let session = Session::new_initiator(
            ctx,
            self.inviter_ephemeral_public_key,
            invitee_session_key,
            self.shared_secret,
        )?;

        let payload = InviteResponsePayload {
            session_key: invitee_session_public_key,
            session_proof,
            owner_pubkey: invitee_owner_pubkey,
            device_id,
        };

        let invitee_sk = secret_key_from_bytes(&invitee_private_key)?;
        let dh_encrypted = nip44::encrypt(
            &invitee_sk,
            &self.inviter_device_pubkey.to_nostr()?,
            serde_json::to_string(&payload)?,
            Version::V2,
        )?;

        let conversation_key = nip44::v2::ConversationKey::new(self.shared_secret);
        let encrypted_bytes =
            nip44::v2::encrypt_to_bytes(&conversation_key, dh_encrypted.as_bytes())?;
        let mut inner_event = UnsignedEvent::new(
            invitee_public_key.to_nostr()?,
            Timestamp::from(ctx.now.get()),
            Kind::from(INVITE_RESPONSE_INNER_RUMOR_KIND as u16),
            Vec::<Tag>::new(),
            base64::engine::general_purpose::STANDARD.encode(encrypted_bytes),
        );
        inner_event.ensure_id();

        let random_sender_secret = random_secret_key_bytes(ctx.rng)?;
        let random_sender_pubkey = crate::device_pubkey_from_secret_bytes(&random_sender_secret)?;
        let envelope_content = nip44::encrypt(
            &secret_key_from_bytes(&random_sender_secret)?,
            &self.inviter_ephemeral_public_key.to_nostr()?,
            inner_event.try_as_json()?,
            Version::V2,
        )?;

        let jitter = if ctx.now.get() == 0 {
            0
        } else {
            ctx.rng.next_u64() % (2 * 24 * 60 * 60)
        };
        let created_at = UnixSeconds(ctx.now.get().saturating_sub(jitter));

        Ok((
            session,
            InviteResponseEnvelope {
                sender: random_sender_pubkey,
                signer_secret_key: random_sender_secret,
                recipient: self.inviter_ephemeral_public_key,
                created_at,
                content: envelope_content,
            },
        ))
    }

    pub fn process_response<R>(
        &mut self,
        ctx: &mut ProtocolContext<'_, R>,
        envelope: &InviteResponseEnvelope,
        inviter_private_key: [u8; 32],
    ) -> Result<InviteResponse>
    where
        R: RngCore + CryptoRng,
    {
        let inviter_ephemeral_private_key = self
            .inviter_ephemeral_private_key
            .ok_or_else(|| crate::Error::Parse("ephemeral key not available".to_string()))?;

        let inviter_ephemeral_sk = secret_key_from_bytes(&inviter_ephemeral_private_key)?;
        let decrypted = nip44::decrypt(
            &inviter_ephemeral_sk,
            &envelope.sender.to_nostr()?,
            &envelope.content,
        )?;
        let inner_event = InviteResponseRumor::from_json(&decrypted)?.into_unsigned_event();
        validate_invite_response_inner_rumor(&inner_event)?;

        let ciphertext_bytes = base64::engine::general_purpose::STANDARD
            .decode(inner_event.content.as_bytes())
            .map_err(|e| crate::Error::Decryption(e.to_string()))?;
        let conversation_key = nip44::v2::ConversationKey::new(self.shared_secret);
        let dh_encrypted_ciphertext = String::from_utf8(nip44::v2::decrypt_to_bytes(
            &conversation_key,
            &ciphertext_bytes,
        )?)
        .map_err(|e| crate::Error::Decryption(e.to_string()))?;

        let inviter_sk = secret_key_from_bytes(&inviter_private_key)?;
        let dh_decrypted =
            nip44::decrypt(&inviter_sk, &inner_event.pubkey, &dh_encrypted_ciphertext)?;

        let payload: InviteResponsePayload = serde_json::from_str(&dh_decrypted)?;
        if self.used_response_contents.contains(&envelope.content) {
            return Err(DomainError::InviteAlreadyUsed.into());
        }
        let owner_public_key = payload
            .owner_pubkey
            .map(|owner| -> Result<PublicKey> {
                let public_key = PublicKey::from_slice(&owner.to_bytes()).map_err(|error| {
                    crate::Error::Parse(format!("invalid owner pubkey: {error}"))
                })?;
                public_key.xonly().map_err(|error| {
                    crate::Error::Parse(format!("invalid owner pubkey: {error}"))
                })?;
                Ok(public_key)
            })
            .transpose()?;
        let invitee_device_pubkey = DevicePubkey::from_bytes(inner_event.pubkey.to_bytes());
        self.ensure_accept_allowed(invitee_device_pubkey)?;
        let proof_digest = invite_session_proof_digest(
            self.inviter_device_pubkey,
            self.inviter_ephemeral_public_key,
            invitee_device_pubkey,
            payload.session_key,
            self.shared_secret,
        );
        let session_public_key = payload
            .session_key
            .to_nostr()?
            .xonly()
            .map_err(|error| crate::Error::Parse(format!("invalid session key: {error}")))?;
        SECP256K1
            .verify_schnorr(
                &payload.session_proof,
                &Message::from_digest(proof_digest),
                &session_public_key,
            )
            .map_err(|_| crate::Error::Parse("invalid invite session proof".to_string()))?;
        let session = Session::new_responder(
            ctx,
            payload.session_key,
            inviter_ephemeral_private_key,
            self.shared_secret,
        )?;
        self.record_use(invitee_device_pubkey);
        self.record_response_content(envelope.content.clone());

        Ok(InviteResponse {
            session,
            invitee_device_pubkey,
            invitee_owner_pubkey: payload.owner_pubkey,
            invitee_identity: inner_event.pubkey,
            device_id: payload.device_id,
            owner_public_key,
        })
    }

    fn ensure_accept_allowed(&self, invitee_public_key: DevicePubkey) -> Result<()> {
        if self.used_by.contains(&invitee_public_key) {
            return Ok(());
        }
        if self
            .max_uses
            .is_some_and(|max_uses| self.used_by.len() >= max_uses)
        {
            return Err(DomainError::InviteExhausted.into());
        }
        Ok(())
    }

    fn record_use(&mut self, invitee_public_key: DevicePubkey) {
        if self.used_by.contains(&invitee_public_key) {
            return;
        }
        self.used_by.push(invitee_public_key);
        self.used_by.sort();
    }

    fn record_response_content(&mut self, content: String) {
        if self.used_response_contents.contains(&content) {
            return;
        }
        self.used_response_contents.push(content);
        self.used_response_contents.sort();
    }
}

const INVITE_RESPONSE_INNER_RUMOR_KIND: u32 = 1060;

const SESSION_PROOF_DOMAIN: &[u8] = b"NIP-118/session-proof/v1";

fn invite_session_proof_digest(
    inviter_identity: DevicePubkey,
    inviter_ephemeral: DevicePubkey,
    invitee_identity: DevicePubkey,
    session_key: DevicePubkey,
    shared_secret: [u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(SESSION_PROOF_DOMAIN);
    hasher.update(inviter_identity.to_bytes());
    hasher.update(inviter_ephemeral.to_bytes());
    hasher.update(invitee_identity.to_bytes());
    hasher.update(session_key.to_bytes());
    hasher.update(shared_secret);
    hasher.finalize().into()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InviteResponseRumor {
    id: EventId,
    pubkey: PublicKey,
    created_at: Timestamp,
    kind: Kind,
    tags: Tags,
    content: String,
}

impl InviteResponseRumor {
    fn from_json(json: &str) -> Result<Self> {
        Ok(serde_json::from_str(json)?)
    }

    fn into_unsigned_event(self) -> UnsignedEvent {
        UnsignedEvent {
            id: Some(self.id),
            pubkey: self.pubkey,
            created_at: self.created_at,
            kind: self.kind,
            tags: self.tags,
            content: self.content,
        }
    }
}

fn validate_invite_response_inner_rumor(rumor: &UnsignedEvent) -> Result<()> {
    if rumor.id.is_none() {
        return Err(crate::Error::Parse(
            "invite response rumor missing id".to_string(),
        ));
    }
    rumor.verify_id()?;
    if rumor.kind.as_u16() as u32 != INVITE_RESPONSE_INNER_RUMOR_KIND {
        return Err(crate::Error::Parse(
            "invalid invite response rumor kind".to_string(),
        ));
    }
    if !rumor.tags.is_empty() {
        return Err(crate::Error::Parse(
            "invite response rumor tags must be empty".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteResponsePayload {
    #[serde(rename = "sessionKey")]
    session_key: DevicePubkey,
    #[serde(rename = "sessionProof")]
    session_proof: Signature,
    #[serde(rename = "deviceId", skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(rename = "ownerPublicKey", skip_serializing_if = "Option::is_none")]
    owner_pubkey: Option<OwnerPubkey>,
}

fn now_seconds() -> UnixSeconds {
    UnixSeconds(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    )
}
