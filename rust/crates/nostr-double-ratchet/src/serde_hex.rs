use hex::FromHex;

fn decode_32<E>(value: &str) -> Result<[u8; 32], E>
where
    E: serde::de::Error,
{
    <[u8; 32]>::from_hex(value).map_err(E::custom)
}

pub(crate) mod option {
    use serde::{Deserialize, Deserializer, Serializer};

    pub(crate) fn serialize<S>(value: &Option<[u8; 32]>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(bytes) => hex::serde::serialize(bytes, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<Option<[u8; 32]>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(|value| super::decode_32(&value))
            .transpose()
    }
}

pub(crate) mod btreemap_u32 {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    pub(crate) fn serialize<S>(
        value: &BTreeMap<u32, [u8; 32]>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value
            .iter()
            .map(|(key, value)| (key.to_string(), hex::encode(value)))
            .collect::<BTreeMap<_, _>>()
            .serialize(serializer)
    }

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<BTreeMap<u32, [u8; 32]>, D::Error>
    where
        D: Deserializer<'de>,
    {
        BTreeMap::<String, String>::deserialize(deserializer)?
            .into_iter()
            .map(|(key, value)| {
                Ok((
                    key.parse().map_err(serde::de::Error::custom)?,
                    super::decode_32(&value)?,
                ))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::collections::BTreeMap;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct WireShapes {
        #[serde(with = "hex::serde")]
        required: [u8; 32],
        #[serde(with = "option")]
        optional: Option<[u8; 32]>,
        #[serde(with = "btreemap_u32")]
        mapped: BTreeMap<u32, [u8; 32]>,
    }

    #[test]
    fn preserves_all_32_byte_hex_wire_shapes() {
        let value = WireShapes {
            required: [0x11; 32],
            optional: Some([0x22; 32]),
            mapped: BTreeMap::from([(7, [0x33; 32])]),
        };
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(json["required"], "11".repeat(32));
        assert_eq!(json["optional"], "22".repeat(32));
        assert_eq!(json["mapped"]["7"], "33".repeat(32));
        assert_eq!(serde_json::from_value::<WireShapes>(json).unwrap(), value);

        let value = WireShapes {
            optional: None,
            ..value
        };
        let json = serde_json::to_value(&value).unwrap();
        assert!(json["optional"].is_null());
        assert_eq!(serde_json::from_value::<WireShapes>(json).unwrap(), value);
    }
}
