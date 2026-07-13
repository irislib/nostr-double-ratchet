use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct UnixSeconds(pub u64);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OwnerPubkey([u8; 32]);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DevicePubkey([u8; 32]);

impl UnixSeconds {
    pub fn get(self) -> u64 {
        self.0
    }
}

impl OwnerPubkey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn to_bytes(self) -> [u8; 32] {
        self.0
    }

    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    pub fn to_nostr(self) -> Result<nostr::PublicKey, crate::Error> {
        nostr::PublicKey::from_slice(&self.0).map_err(|e| crate::Error::Parse(e.to_string()))
    }
}

impl DevicePubkey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_secret_bytes(secret_key_bytes: [u8; 32]) -> Result<Self, crate::Error> {
        let secret_key = nostr::SecretKey::from_slice(&secret_key_bytes)
            .map_err(|e| crate::Error::Parse(e.to_string()))?;
        let public_key = nostr::Keys::new(secret_key).public_key();
        Ok(Self(public_key.to_bytes()))
    }

    pub fn to_bytes(self) -> [u8; 32] {
        self.0
    }

    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    pub(crate) fn from_nostr(pubkey: nostr::PublicKey) -> Self {
        Self(pubkey.to_bytes())
    }

    pub fn to_nostr(self) -> Result<nostr::PublicKey, crate::Error> {
        nostr::PublicKey::from_slice(&self.0).map_err(|e| crate::Error::Parse(e.to_string()))
    }
}

impl fmt::Debug for OwnerPubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OwnerPubkey({})", hex::encode(self.0))
    }
}

impl fmt::Debug for DevicePubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DevicePubkey({})", hex::encode(self.0))
    }
}

impl fmt::Display for OwnerPubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl fmt::Display for DevicePubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl Serialize for OwnerPubkey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for OwnerPubkey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_hex_pubkey(&value)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

impl Serialize for DevicePubkey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for DevicePubkey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_hex_pubkey(&value)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

pub(crate) fn parse_hex_pubkey(value: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(value).map_err(|e| e.to_string())?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "expected 32-byte public key".to_string())
}
