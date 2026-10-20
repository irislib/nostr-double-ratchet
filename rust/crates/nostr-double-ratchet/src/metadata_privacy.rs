use crate::{DevicePubkey, DomainError, Result};
use nostr::nips::nip44;
use nostr::secp256k1::{Parity, Scalar, SecretKey, SECP256K1};
use sha2::{Digest, Sha256};

pub const METADATA_PRIVACY_VERSION: u8 = 2;
const DOMAIN: &[u8] = b"NIP-118/responder-key-blinding/v2";

/// A format marker, not authentication: callers must also verify the event.
pub fn has_metadata_privacy_version(event: &nostr::Event) -> bool {
    let versions = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|v| v == "v"))
        .collect::<Vec<_>>();
    versions.len() == 1 && versions[0].as_slice() == ["v", "2"]
}

fn invalid_key() -> crate::Error {
    DomainError::InvalidState("invalid responder key tweak".into()).into()
}

fn responder_tweak(
    our_secret: [u8; 32],
    their_public: DevicePubkey,
    inviter_public: DevicePubkey,
    initiator_public: DevicePubkey,
) -> Result<Scalar> {
    let shared = nip44::v2::ConversationKey::derive(
        &crate::secret_key_from_bytes(&our_secret)?,
        &their_public.to_nostr()?,
    )?;
    let mut hash = Sha256::new();
    hash.update(DOMAIN);
    hash.update(shared.as_bytes());
    hash.update(inviter_public.to_bytes());
    hash.update(initiator_public.to_bytes());
    let scalar = Scalar::from_be_bytes(hash.finalize().into()).map_err(|_| invalid_key())?;
    if scalar == Scalar::ZERO {
        return Err(invalid_key());
    }
    Ok(scalar)
}

/// Derive an acceptance-specific responder public key without exposing its
/// connection to the public invite. Only the inviter can derive the private key.
pub(crate) fn private_responder_public_key(
    initiator_secret: [u8; 32],
    inviter_public: DevicePubkey,
) -> Result<DevicePubkey> {
    let initiator_public = crate::device_pubkey_from_secret_bytes(&initiator_secret)?;
    let tweak = responder_tweak(
        initiator_secret,
        inviter_public,
        inviter_public,
        initiator_public,
    )?;
    let (blinded, _) = inviter_public
        .to_nostr()?
        .xonly()
        .map_err(|_| invalid_key())?
        .add_tweak(SECP256K1, &tweak)
        .map_err(|_| invalid_key())?;
    Ok(DevicePubkey::from_bytes(blinded.serialize()))
}

pub(crate) fn private_responder_secret_key(
    inviter_secret: [u8; 32],
    initiator_public: DevicePubkey,
) -> Result<[u8; 32]> {
    let inviter_public = crate::device_pubkey_from_secret_bytes(&inviter_secret)?;
    let tweak = responder_tweak(
        inviter_secret,
        initiator_public,
        inviter_public,
        initiator_public,
    )?;
    let mut normalized = SecretKey::from_slice(&inviter_secret).map_err(|_| invalid_key())?;
    // X-only keys always denote the even-Y point.
    if normalized.x_only_public_key(SECP256K1).1 == Parity::Odd {
        normalized = normalized.negate();
    }
    Ok(normalized
        .add_tweak(&tweak)
        .map_err(|_| invalid_key())?
        .secret_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_even_and_odd_y_vectors() {
        for (last_byte, expected_public, expected_secret) in [
            (
                1,
                "dc9923d79b3ddc1389600085ad7224dbec36f6fd63597a1d1fd3e3e1128196f1",
                "4912fca7bc08b6038f448a07d8025c6856b5471636676ebcb67f629709643dda",
            ),
            (
                6,
                "dcaebdd6c4d364d27dba489acc336383ded31cfa6ad68b58ce4307e7c697069b",
                "d39901b9c513ae5b82bfd2128dc3569eadcd6cce9f1bdb8c55397092e33f267d",
            ),
        ] {
            let mut inviter = [0; 32];
            inviter[31] = last_byte;
            let mut initiator = [0; 32];
            initiator[31] = 21;
            let inviter_public = crate::device_pubkey_from_secret_bytes(&inviter).unwrap();
            let initiator_public = crate::device_pubkey_from_secret_bytes(&initiator).unwrap();
            let public = private_responder_public_key(initiator, inviter_public).unwrap();
            let secret = private_responder_secret_key(inviter, initiator_public).unwrap();
            assert_eq!(public.to_string(), expected_public);
            assert_eq!(hex::encode(secret), expected_secret);
            assert_eq!(
                crate::device_pubkey_from_secret_bytes(&secret).unwrap(),
                public
            );
            assert_ne!(public, inviter_public);
            initiator[31] = 22;
            assert_ne!(
                private_responder_public_key(initiator, inviter_public).unwrap(),
                public
            );
        }
    }
}
