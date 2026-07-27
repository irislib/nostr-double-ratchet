use super::*;

impl GroupPayloadCodec for JsonGroupPayloadCodecV1 {
    fn is_pairwise_payload(&self, payload: &[u8]) -> bool {
        self.decode_pairwise_command(payload)
            .map(|command| command.is_some())
            .unwrap_or(false)
    }

    fn encode_pairwise_command(
        &self,
        ctx: GroupPayloadEncodeContext,
        command: &GroupPairwiseCommand,
    ) -> Result<Vec<u8>> {
        match command {
            GroupPairwiseCommand::MetadataSnapshot { snapshot } => {
                encode_master_metadata_snapshot(ctx, snapshot)
            }
            GroupPairwiseCommand::GroupMessage {
                group_id,
                revision,
                body,
            } => encode_envelope(GroupPairwisePayloadV1::GroupMessage {
                group_id: group_id.clone(),
                revision: *revision,
                body: body.clone(),
            }),
            GroupPairwiseCommand::SenderKeyDistribution { distribution } => {
                encode_sender_key_distribution(ctx, distribution)
            }
            GroupPairwiseCommand::SenderKeyRepairRequest { request } => {
                encode_sender_key_repair_request(ctx, request)
            }
        }
    }

    fn decode_pairwise_command(&self, payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
        if let Some(command) = decode_master_metadata_snapshot(payload)? {
            return Ok(Some(command));
        }
        if let Some(command) = decode_sender_key_distribution(payload)? {
            return Ok(Some(command));
        }
        if let Some(command) = decode_sender_key_repair_request(payload)? {
            return Ok(Some(command));
        }

        let Ok(envelope) = serde_json::from_slice::<GroupWireEnvelopeV1>(payload) else {
            return Ok(None);
        };
        if envelope.wire_format_version != GROUP_WIRE_FORMAT_VERSION_V1 {
            return Ok(None);
        }
        command_from_v1_payload(envelope.payload)
    }

    fn encode_sender_key_plaintext(
        &self,
        ctx: GroupPayloadEncodeContext,
        plaintext: &GroupSenderKeyPlaintext,
    ) -> Result<Vec<u8>> {
        let content = String::from_utf8(plaintext.body.clone())
            .map_err(|error| Error::Parse(error.to_string()))?;
        let millis = ctx.created_at.get().saturating_mul(1000).to_string();
        let revision = plaintext.revision.to_string();
        let event = EventBuilder::new(Kind::from(CHAT_MESSAGE_KIND as u16), content)
            .tags(vec![
                tag([GROUP_LABEL_TAG, plaintext.group_id.as_str()])?,
                tag([MS_TAG, millis.as_str()])?,
                tag([REVISION_TAG, revision.as_str()])?,
            ])
            .custom_created_at(Timestamp::from(ctx.created_at.get()))
            .build(ctx.local_device_pubkey.to_nostr()?);
        Ok(serde_json::to_vec(&event)?)
    }

    fn decode_sender_key_plaintext(
        &self,
        ctx: GroupSenderKeyPlaintextDecodeContext<'_>,
        payload: &[u8],
    ) -> Result<Option<GroupSenderKeyPlaintext>> {
        let Some(event) = decode_verified_unsigned_event(payload)? else {
            return Ok(None);
        };
        if event.kind.as_u16() as u32 != CHAT_MESSAGE_KIND {
            return Ok(None);
        }
        let Some(group_id) = first_tag_value(&event, GROUP_LABEL_TAG) else {
            return Ok(None);
        };
        if group_id != ctx.group_id {
            return Ok(None);
        }
        let revision = first_tag_value(&event, REVISION_TAG)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(ctx.current_revision);
        Ok(Some(GroupSenderKeyPlaintext {
            group_id,
            revision,
            body: event.content.into_bytes(),
        }))
    }
}

fn encode_master_metadata_snapshot(
    ctx: GroupPayloadEncodeContext,
    snapshot: &GroupSnapshot,
) -> Result<Vec<u8>> {
    let event = EventBuilder::new(Kind::from(GROUP_ROSTER_FACT_KIND as u16), "")
        .tags(group_roster_fact_tags(snapshot)?)
        .custom_created_at(Timestamp::from(ctx.created_at.get()))
        .build(ctx.local_device_pubkey.to_nostr()?);
    Ok(serde_json::to_vec(&event)?)
}

fn decode_master_metadata_snapshot(payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
    let Some(event) = decode_verified_unsigned_event(payload)? else {
        return Ok(None);
    };
    if event.kind.as_u16() as u32 != GROUP_ROSTER_FACT_KIND
        || !unsigned_is_group_roster_fact_event(&event)
    {
        return Ok(None);
    }

    let snapshot = group_roster_snapshot_from_unsigned_event(&event)?;
    Ok(Some(GroupPairwiseCommand::MetadataSnapshot { snapshot }))
}

fn encode_sender_key_distribution(
    ctx: GroupPayloadEncodeContext,
    distribution: &SenderKeyDistribution,
) -> Result<Vec<u8>> {
    let content = serde_json::to_string(&SenderKeyDistributionContent {
        group_id: distribution.group_id.clone(),
        key_id: distribution.key_id,
        chain_key: hex::encode(distribution.chain_key),
        iteration: distribution.iteration,
        created_at: distribution.created_at,
        sender_event_pubkey: distribution.sender_event_pubkey.to_string(),
    })?;
    let millis = ctx.created_at.get().saturating_mul(1000).to_string();
    let key_id = distribution.key_id.to_string();
    let event = EventBuilder::new(
        Kind::from(GROUP_SENDER_KEY_DISTRIBUTION_KIND as u16),
        content,
    )
    .tags(vec![
        tag([GROUP_LABEL_TAG, distribution.group_id.as_str()])?,
        tag([KEY_TAG, key_id.as_str()])?,
        tag([MS_TAG, millis.as_str()])?,
    ])
    .custom_created_at(Timestamp::from(ctx.created_at.get()))
    .build(ctx.local_device_pubkey.to_nostr()?);
    Ok(serde_json::to_vec(&event)?)
}

fn decode_sender_key_distribution(payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
    let Some(event) = decode_verified_unsigned_event(payload)? else {
        return Ok(None);
    };
    if event.kind.as_u16() as u32 != GROUP_SENDER_KEY_DISTRIBUTION_KIND {
        return Ok(None);
    }

    let content = serde_json::from_str::<SenderKeyDistributionContent>(&event.content)?;
    if content.group_id.is_empty() {
        return Ok(None);
    }
    if let Some(tagged_group_id) = first_tag_value(&event, GROUP_LABEL_TAG) {
        if tagged_group_id != content.group_id {
            return Err(Error::Parse(
                "sender-key distribution group id/tag mismatch".to_string(),
            ));
        }
    }
    if let Some(tagged_key_id) = first_tag_value(&event, KEY_TAG) {
        let tagged_key_id = tagged_key_id
            .parse::<u32>()
            .map_err(|error| Error::Parse(error.to_string()))?;
        if tagged_key_id != content.key_id {
            return Err(Error::Parse(
                "sender-key distribution key id/tag mismatch".to_string(),
            ));
        }
    }
    let chain_key =
        hex::decode(&content.chain_key).map_err(|error| Error::Parse(error.to_string()))?;
    let chain_key = <[u8; 32]>::try_from(chain_key.as_slice()).map_err(|_| {
        Error::Parse("sender-key distribution chain key must be 32 bytes".to_string())
    })?;
    let sender_event_pubkey = parse_device_pubkey_hex(&content.sender_event_pubkey)?;

    Ok(Some(GroupPairwiseCommand::SenderKeyDistribution {
        distribution: SenderKeyDistribution {
            group_id: content.group_id,
            key_id: content.key_id,
            sender_event_pubkey,
            chain_key,
            iteration: content.iteration,
            created_at: content.created_at,
        },
    }))
}

fn encode_sender_key_repair_request(
    ctx: GroupPayloadEncodeContext,
    request: &SenderKeyRepairRequest,
) -> Result<Vec<u8>> {
    let content = serde_json::to_string(&SenderKeyRepairRequestContent {
        group_id: request.group_id.clone(),
        sender_event_pubkey: request.sender_event_pubkey.to_string(),
        key_id: request.key_id,
        message_number: request.message_number,
        required_revision: request.required_revision,
        created_at: request.created_at,
    })?;
    let millis = ctx.created_at.get().saturating_mul(1000).to_string();
    let sender_event_pubkey = request.sender_event_pubkey.to_string();
    let mut tags = vec![
        tag([GROUP_LABEL_TAG, request.group_id.as_str()])?,
        tag([SENDER_TAG, sender_event_pubkey.as_str()])?,
        tag([MS_TAG, millis.as_str()])?,
    ];
    let key_id;
    if let Some(request_key_id) = request.key_id {
        key_id = request_key_id.to_string();
        tags.push(tag([KEY_TAG, key_id.as_str()])?);
    }
    let message_number;
    if let Some(request_message_number) = request.message_number {
        message_number = request_message_number.to_string();
        tags.push(tag([MESSAGE_TAG, message_number.as_str()])?);
    }
    let revision;
    if let Some(required_revision) = request.required_revision {
        revision = required_revision.to_string();
        tags.push(tag([REVISION_TAG, revision.as_str()])?);
    }

    let event = EventBuilder::new(
        Kind::from(GROUP_SENDER_KEY_REPAIR_REQUEST_KIND as u16),
        content,
    )
    .tags(tags)
    .custom_created_at(Timestamp::from(ctx.created_at.get()))
    .build(ctx.local_device_pubkey.to_nostr()?);
    Ok(serde_json::to_vec(&event)?)
}

fn decode_sender_key_repair_request(payload: &[u8]) -> Result<Option<GroupPairwiseCommand>> {
    let Some(event) = decode_verified_unsigned_event(payload)? else {
        return Ok(None);
    };
    if event.kind.as_u16() as u32 != GROUP_SENDER_KEY_REPAIR_REQUEST_KIND {
        return Ok(None);
    }

    let content = serde_json::from_str::<SenderKeyRepairRequestContent>(&event.content)?;
    if content.group_id.is_empty() {
        return Ok(None);
    }
    require_tag_string(&event, GROUP_LABEL_TAG, &content.group_id)?;
    require_tag_string(&event, SENDER_TAG, &content.sender_event_pubkey)?;
    match content.key_id {
        Some(key_id) => require_tag_u32(&event, KEY_TAG, key_id)?,
        None => {
            if first_tag_value(&event, KEY_TAG).is_some() {
                return Err(Error::Parse("key tag mismatch".to_string()));
            }
        }
    }
    match content.message_number {
        Some(message_number) => require_tag_u32(&event, MESSAGE_TAG, message_number)?,
        None => {
            if first_tag_value(&event, MESSAGE_TAG).is_some() {
                return Err(Error::Parse("message tag mismatch".to_string()));
            }
        }
    }
    match content.required_revision {
        Some(required_revision) => require_tag_u64(&event, REVISION_TAG, required_revision)?,
        None => {
            if first_tag_value(&event, REVISION_TAG).is_some() {
                return Err(Error::Parse("revision tag mismatch".to_string()));
            }
        }
    }

    Ok(Some(GroupPairwiseCommand::SenderKeyRepairRequest {
        request: SenderKeyRepairRequest {
            group_id: content.group_id,
            sender_event_pubkey: parse_device_pubkey_hex(&content.sender_event_pubkey)?,
            key_id: content.key_id,
            message_number: content.message_number,
            required_revision: content.required_revision,
            created_at: content.created_at,
        },
    }))
}

fn decode_verified_unsigned_event(payload: &[u8]) -> Result<Option<UnsignedEvent>> {
    let Ok(mut event) = serde_json::from_slice::<UnsignedEvent>(payload) else {
        return Ok(None);
    };
    event.ensure_id();
    event
        .verify_id()
        .map_err(|error| Error::Parse(error.to_string()))?;
    Ok(Some(event))
}

fn command_from_v1_payload(
    payload: GroupPairwisePayloadV1,
) -> Result<Option<GroupPairwiseCommand>> {
    Ok(match payload {
        GroupPairwisePayloadV1::MetadataSnapshot { snapshot } => {
            Some(GroupPairwiseCommand::MetadataSnapshot { snapshot })
        }
        GroupPairwisePayloadV1::CreateGroup {
            group_id,
            protocol,
            base_revision,
            new_revision,
            name,
            picture,
            about,
            created_by,
            members,
            admins,
            created_at,
            updated_at,
        } => {
            if base_revision != 0 {
                return Err(Error::Parse(
                    "create group base revision must be 0".to_string(),
                ));
            }
            Some(GroupPairwiseCommand::MetadataSnapshot {
                snapshot: GroupSnapshot {
                    group_id,
                    protocol,
                    name,
                    picture,
                    about,
                    created_by,
                    members,
                    admins,
                    revision: new_revision,
                    created_at,
                    updated_at,
                },
            })
        }
        GroupPairwisePayloadV1::SyncGroup {
            group_id,
            protocol,
            revision,
            name,
            picture,
            about,
            created_by,
            members,
            admins,
            created_at,
            updated_at,
        } => Some(GroupPairwiseCommand::MetadataSnapshot {
            snapshot: GroupSnapshot {
                group_id,
                protocol,
                name,
                picture,
                about,
                created_by,
                members,
                admins,
                revision,
                created_at,
                updated_at,
            },
        }),
        GroupPairwisePayloadV1::GroupMessage {
            group_id,
            revision,
            body,
        } => Some(GroupPairwiseCommand::GroupMessage {
            group_id,
            revision,
            body,
        }),
        GroupPairwisePayloadV1::SenderKeyDistribution { .. } => None,
    })
}
