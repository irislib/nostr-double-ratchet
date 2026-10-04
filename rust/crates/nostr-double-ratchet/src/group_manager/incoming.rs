use super::*;

impl<C> GroupManager<C>
where
    C: GroupPayloadCodec,
{
    pub fn handle_incoming(
        &mut self,
        sender_owner: OwnerPubkey,
        payload: &[u8],
    ) -> Result<Option<GroupIncomingEvent>> {
        self.handle_pairwise_payload_inner(sender_owner, None, payload)
    }

    pub fn handle_pairwise_payload(
        &mut self,
        sender_owner: OwnerPubkey,
        sender_device: DevicePubkey,
        payload: &[u8],
    ) -> Result<Option<GroupIncomingEvent>> {
        self.handle_pairwise_payload_inner(sender_owner, Some(sender_device), payload)
    }

    pub(super) fn handle_pairwise_payload_inner(
        &mut self,
        sender_owner: OwnerPubkey,
        sender_device: Option<DevicePubkey>,
        payload: &[u8],
    ) -> Result<Option<GroupIncomingEvent>> {
        let Some(command) = self.payload_codec.decode_pairwise_command(payload)? else {
            return Ok(None);
        };

        let event = match command {
            GroupPairwiseCommand::MetadataSnapshot { snapshot } => {
                let record = GroupRecord::from_metadata_snapshot(snapshot)?;
                let is_self_sync = sender_owner == self.local_owner_pubkey;

                if let Some(existing) = self.groups.get(&record.group_id) {
                    if existing.protocol != record.protocol {
                        return Err(group_error(format!(
                            "group `{}` protocol mismatch: expected {:?}, got {:?}",
                            record.group_id, existing.protocol, record.protocol
                        )));
                    }
                    if record.revision < existing.revision || existing == &record {
                        GroupIncomingEvent::MetadataUpdated(existing.snapshot())
                    } else if record.revision == existing.revision {
                        return Err(group_error(format!(
                            "conflicting metadata snapshot for group `{}` at revision {}",
                            record.group_id, record.revision
                        )));
                    } else {
                        if !is_self_sync && !existing.admins.contains(&sender_owner) {
                            return Err(group_error(format!(
                                "owner {sender_owner} is not an admin of group `{}`",
                                record.group_id
                            )));
                        }
                        let snapshot = record.snapshot();
                        self.groups.insert(record.group_id.clone(), record);
                        GroupIncomingEvent::MetadataUpdated(snapshot)
                    }
                } else {
                    if !record.members.contains(&self.local_owner_pubkey) {
                        return Ok(None);
                    }
                    if !is_self_sync && !record.admins.contains(&sender_owner) {
                        return Err(group_error(format!(
                            "owner {sender_owner} is not an admin of group `{}`",
                            record.group_id
                        )));
                    }
                    let snapshot = record.snapshot();
                    self.groups.insert(record.group_id.clone(), record);
                    GroupIncomingEvent::MetadataUpdated(snapshot)
                }
            }
            GroupPairwiseCommand::GroupMessage {
                group_id,
                revision,
                body,
            } => {
                let group = self.group_record(&group_id)?;
                group.ensure_member(sender_owner)?;
                if revision > group.revision {
                    return Err(pending_group_revision_error(
                        group_id,
                        group.revision,
                        revision,
                    ));
                }
                if revision < group.revision {
                    return Ok(None);
                }
                GroupIncomingEvent::Message(GroupReceivedMessage {
                    group_id,
                    sender_owner,
                    sender_device,
                    body,
                    revision,
                })
            }
            GroupPairwiseCommand::SenderKeyDistribution { distribution } => {
                let Some(sender_device) = sender_device else {
                    return Err(group_error(
                        "sender-key distribution requires authenticated sender device",
                    ));
                };
                let group_id = distribution.group_id.clone();
                self.observe_sender_key_distribution(sender_owner, sender_device, distribution)?;
                let snapshot = self.group_record(&group_id)?.snapshot();
                GroupIncomingEvent::MetadataUpdated(snapshot)
            }
            GroupPairwiseCommand::SenderKeyRepairRequest { request } => {
                let group = self.group_record(&request.group_id)?;
                if !group.protocol.is_sender_key_v1() || !group.members.contains(&sender_owner) {
                    return Ok(None);
                }
                GroupIncomingEvent::SenderKeyRepairRequested(GroupSenderKeyRepairRequestEvent {
                    requester_owner: sender_owner,
                    requester_device: sender_device,
                    request,
                })
            }
        };

        Ok(Some(event))
    }

    pub fn handle_sender_key_message(
        &mut self,
        message: GroupSenderKeyMessage,
    ) -> Result<GroupSenderKeyHandleResult> {
        let mut remaining = usize::MAX;
        self.handle_sender_key_message_with_budget(message, &mut None, &mut remaining)?
            .ok_or_else(|| group_error("unlimited sender-key search did not finish"))
    }

    /// Handle one message consuming a shared remaining blind-key trial budget. `None`
    /// yields without mutating the ratchet; pass the cursor back to continue.
    /// Current sender authorization and key inputs are revalidated every call.
    /// If `None` leaves an empty cursor, key inputs changed: requeue fairly and
    /// start a fresh pass. New key IDs join the next pass, not this frozen workset.
    /// A caller may drop the cursor at any time to cancel safely.
    pub fn handle_sender_key_message_with_budget(
        &mut self,
        message: GroupSenderKeyMessage,
        cursor: &mut Option<GroupSenderKeyDecryptCursor>,
        remaining_key_attempts: &mut usize,
    ) -> Result<Option<GroupSenderKeyHandleResult>> {
        self.plan_sender_key_message_with_budget(message, cursor, remaining_key_attempts)?
            .map(|plan| self.apply_sender_key_receive_plan(plan))
            .transpose()
    }

    /// Pure resumable receive planning, for callers that checkpoint only when a
    /// result is ready. No ratchet/session state is changed by an unfinished slice.
    pub fn plan_sender_key_message_with_budget(
        &self,
        message: GroupSenderKeyMessage,
        cursor: &mut Option<GroupSenderKeyDecryptCursor>,
        remaining_key_attempts: &mut usize,
    ) -> Result<Option<GroupSenderKeyReceivePlan>> {
        let result = self.plan_sender_key_message_step(message, cursor, remaining_key_attempts);
        if !matches!(result, Ok(None)) {
            *cursor = None;
        }
        result
    }

    fn plan_sender_key_message_step(
        &self,
        message: GroupSenderKeyMessage,
        cursor: &mut Option<GroupSenderKeyDecryptCursor>,
        remaining_key_attempts: &mut usize,
    ) -> Result<Option<GroupSenderKeyReceivePlan>> {
        let complete = |result| {
            Ok(Some(GroupSenderKeyReceivePlan {
                result,
                mutation: None,
            }))
        };
        let known_position = if message.encrypted_header.is_some() {
            None
        } else {
            Some((message.key_id, message.message_number))
        };
        let Some(id) = self
            .sender_event_index
            .get(&message.sender_event_pubkey)
            .cloned()
        else {
            return complete(GroupSenderKeyHandleResult::PendingDistribution {
                group_id: message.group_id,
                sender_event_pubkey: message.sender_event_pubkey,
                key_id: known_position.map(|(key_id, _)| key_id),
                message_number: known_position.map(|(_, message_number)| message_number),
            });
        };
        if id.group_id != message.group_id
            || self
                .sender_keys
                .get(&id)
                .is_some_and(|record| record.sender_event_secret_key.is_some())
        {
            // Our sending chain has already advanced; relay echoes cannot be decrypted.
            return complete(GroupSenderKeyHandleResult::Ignored);
        }

        let group = self
            .groups
            .get(&id.group_id)
            .ok_or_else(|| group_error(format!("unknown group `{}`", id.group_id)))?;
        if !group.protocol.is_sender_key_v1() || !group.members.contains(&id.sender_owner) {
            return complete(GroupSenderKeyHandleResult::Ignored);
        }

        if known_position.is_none() {
            use crate::sender_key::BlindDecryptStep;
            let plan =
                match self.advance_blind_message(&id, &message, cursor, remaining_key_attempts)? {
                    BlindDecryptStep::Pending => return Ok(None),
                    BlindDecryptStep::Exhausted => {
                        return complete(GroupSenderKeyHandleResult::PendingDistribution {
                            group_id: message.group_id,
                            sender_event_pubkey: message.sender_event_pubkey,
                            key_id: None,
                            message_number: None,
                        });
                    }
                    BlindDecryptStep::Complete(plan) => plan,
                };
            let key_id = plan.key_id;
            let Some(plaintext) = self.payload_codec.decode_sender_key_plaintext(
                GroupSenderKeyPlaintextDecodeContext {
                    group_id: &group.group_id,
                    current_revision: group.revision,
                },
                &plan.plaintext,
            )?
            else {
                return complete(GroupSenderKeyHandleResult::Ignored);
            };
            if plaintext.group_id != group.group_id {
                return complete(GroupSenderKeyHandleResult::Ignored);
            }
            if plaintext.revision > group.revision {
                return complete(GroupSenderKeyHandleResult::PendingRevision {
                    group_id: group.group_id.clone(),
                    current_revision: group.revision,
                    required_revision: plaintext.revision,
                    key_id: plan.key_id,
                    message_number: plan.message_number,
                });
            }
            if plaintext.revision < group.revision {
                return complete(GroupSenderKeyHandleResult::Ignored);
            }

            let state = self
                .sender_keys
                .get(&id)
                .and_then(|record| record.states.get(&key_id))
                .ok_or_else(|| group_error("sender-key index points to missing state"))?;
            return Ok(Some(GroupSenderKeyReceivePlan {
                mutation: Some(super::decrypt::GroupSenderKeyMutation {
                    identity: id.clone(),
                    author: message.sender_event_pubkey,
                    expected: state.clone(),
                    next: plan.next_state,
                    revision: group.revision,
                    local_member: group.members.contains(&self.local_owner_pubkey),
                }),
                result: GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(
                    GroupReceivedMessage {
                        group_id: plaintext.group_id,
                        sender_owner: id.sender_owner,
                        sender_device: Some(id.sender_device),
                        body: plaintext.body,
                        revision: plaintext.revision,
                    },
                )),
            }));
        }

        let (key_id, message_number) = known_position.expect("checked above");
        let content = SenderKeyMessageContent {
            key_id,
            message_number,
            ciphertext: message.ciphertext,
        };
        let record = self
            .sender_keys
            .get(&id)
            .ok_or_else(|| group_error("sender-key index points to missing state"))?;
        let Some(state) = record.states.get(&key_id) else {
            return complete(GroupSenderKeyHandleResult::PendingDistribution {
                group_id: message.group_id,
                sender_event_pubkey: message.sender_event_pubkey,
                key_id: Some(key_id),
                message_number: Some(message_number),
            });
        };
        let plan = state.plan_decrypt(&content)?;
        let plaintext = plan.plaintext.clone();

        let Some(plaintext) = self.payload_codec.decode_sender_key_plaintext(
            GroupSenderKeyPlaintextDecodeContext {
                group_id: &group.group_id,
                current_revision: group.revision,
            },
            &plaintext,
        )?
        else {
            return complete(GroupSenderKeyHandleResult::Ignored);
        };
        if plaintext.group_id != group.group_id {
            return complete(GroupSenderKeyHandleResult::Ignored);
        }
        if plaintext.revision > group.revision {
            return complete(GroupSenderKeyHandleResult::PendingRevision {
                group_id: group.group_id.clone(),
                current_revision: group.revision,
                required_revision: plaintext.revision,
                key_id,
                message_number,
            });
        }
        if plaintext.revision < group.revision {
            return complete(GroupSenderKeyHandleResult::Ignored);
        }

        Ok(Some(GroupSenderKeyReceivePlan {
            mutation: Some(super::decrypt::GroupSenderKeyMutation {
                identity: id.clone(),
                author: message.sender_event_pubkey,
                expected: state.clone(),
                next: plan.next_state,
                revision: group.revision,
                local_member: group.members.contains(&self.local_owner_pubkey),
            }),
            result: GroupSenderKeyHandleResult::Event(GroupIncomingEvent::Message(
                GroupReceivedMessage {
                    group_id: plaintext.group_id,
                    sender_owner: id.sender_owner,
                    sender_device: Some(id.sender_device),
                    body: plaintext.body,
                    revision: plaintext.revision,
                },
            )),
        }))
    }

    pub(super) fn local_sibling_sync<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        record: &GroupRecord,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        if !session_manager.has_authorized_local_siblings() {
            return Ok(GroupPreparedPublish::empty());
        }
        let payload = self.payload_codec.encode_pairwise_command(
            encode_context(session_manager, ctx),
            &record.metadata_payload(),
        )?;
        self.local_sibling_payload_bytes(session_manager, ctx, payload)
    }

    pub(super) fn local_sibling_payload<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        _group_id: &str,
        payload: &GroupPairwiseCommand,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        if !session_manager.has_authorized_local_siblings() {
            return Ok(GroupPreparedPublish::empty());
        }
        self.local_sibling_payload_bytes(
            session_manager,
            ctx,
            self.payload_codec
                .encode_pairwise_command(encode_context(session_manager, ctx), payload)?,
        )
    }

    pub(super) fn local_sibling_payload_bytes<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        payload: Vec<u8>,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        let prepared = session_manager
            .prepare_local_sibling_send_reusing_all_sessions(ctx, payload.clone())?;
        let pending_fanouts = if prepared.relay_gaps.is_empty() {
            Vec::new()
        } else {
            vec![GroupPendingFanout::LocalSiblings { payload }]
        };
        Ok(GroupPreparedPublish {
            deliveries: prepared.deliveries,
            invite_responses: prepared.invite_responses,
            sender_key_messages: Vec::new(),
            relay_gaps: prepared.relay_gaps,
            pending_fanouts,
        })
    }

    pub(super) fn fanout_payload<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        _group_id: &str,
        recipients: Vec<OwnerPubkey>,
        payload: &GroupPairwiseCommand,
    ) -> Result<GroupPreparedPublish>
    where
        R: RngCore + CryptoRng,
    {
        let mut prepared = GroupPreparedPublish::empty();
        let payload_bytes = self
            .payload_codec
            .encode_pairwise_command(encode_context(session_manager, ctx), payload)?;

        for recipient in recipients {
            let next =
                session_manager.prepare_remote_send(ctx, recipient, payload_bytes.clone())?;
            prepared.deliveries.extend(next.deliveries);
            prepared.invite_responses.extend(next.invite_responses);
            if !next.relay_gaps.is_empty() {
                prepared.pending_fanouts.push(GroupPendingFanout::Remote {
                    recipient_owner: recipient,
                    payload: payload_bytes.clone(),
                });
            }
            prepared.relay_gaps.extend(next.relay_gaps);
        }

        prepared.relay_gaps.sort();
        prepared.relay_gaps.dedup();
        Ok(prepared)
    }

    pub(super) fn repair_payload_to_owner<R>(
        &mut self,
        session_manager: &mut SessionManager,
        ctx: &mut ProtocolContext<'_, R>,
        requester_owner: OwnerPubkey,
        payload: &GroupPairwiseCommand,
    ) -> Result<GroupPreparedSend>
    where
        R: RngCore + CryptoRng,
    {
        let group_id = match payload {
            GroupPairwiseCommand::MetadataSnapshot { snapshot } => snapshot.group_id.clone(),
            GroupPairwiseCommand::GroupMessage { group_id, .. }
            | GroupPairwiseCommand::SenderKeyDistribution {
                distribution: SenderKeyDistribution { group_id, .. },
            }
            | GroupPairwiseCommand::SenderKeyRepairRequest {
                request: SenderKeyRepairRequest { group_id, .. },
            } => group_id.clone(),
        };
        if requester_owner == self.local_owner_pubkey {
            return Ok(GroupPreparedSend {
                group_id: group_id.clone(),
                remote: GroupPreparedPublish::empty(),
                local_sibling: self.local_sibling_payload(
                    session_manager,
                    ctx,
                    &group_id,
                    payload,
                )?,
            });
        }
        Ok(GroupPreparedSend {
            group_id: group_id.clone(),
            remote: self.fanout_payload(
                session_manager,
                ctx,
                &group_id,
                vec![requester_owner],
                payload,
            )?,
            local_sibling: GroupPreparedPublish::empty(),
        })
    }
}
