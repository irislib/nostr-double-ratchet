use super::*;
use crate::sender_key::{BlindDecryptCursor, BlindDecryptStep};

/// Ephemeral progress for one hidden-position ciphertext. Dropping this value
/// cancels the search without changing group/session state. It is never persisted.
#[derive(Clone)]
pub struct GroupSenderKeyDecryptCursor {
    message: GroupSenderKeyMessage,
    identity: SenderKeyRecordId,
    key_ids: Vec<u32>,
    key_index: usize,
    active: Option<(SenderKeyState, BlindDecryptCursor)>,
}

/// An authenticated receive result which has not changed the ratchet yet.
/// Apply immediately after arranging the caller's durable transaction/checkpoint.
#[derive(Clone)]
pub struct GroupSenderKeyReceivePlan {
    pub(super) result: GroupSenderKeyHandleResult,
    pub(super) mutation: Option<GroupSenderKeyMutation>,
}

#[derive(Clone)]
pub(super) struct GroupSenderKeyMutation {
    pub(super) identity: SenderKeyRecordId,
    pub(super) author: SenderEventPubkey,
    pub(super) expected: SenderKeyState,
    pub(super) next: SenderKeyState,
    pub(super) revision: u64,
    pub(super) local_member: bool,
}

impl<C: GroupPayloadCodec> GroupManager<C> {
    /// Probe local next positions, trying the latest known key ID first and then
    /// the other key IDs in descending order, with at most one trial per key ID.
    /// Neither message counter fields nor its cover header select the position.
    ///
    /// This is a pure, non-resumable optimization: `None` means no authenticated
    /// hit within the shared trial budget, not that the message is invalid. The
    /// caller must retain ordinary history/distribution recovery and pace repeated
    /// probes. No history cursor is read, replaced, or advanced by this method.
    /// Successful plans use the normal validation and apply-time freshness checks.
    pub fn plan_sender_key_message_frontier_with_budget(
        &self,
        message: &GroupSenderKeyMessage,
        remaining_key_attempts: &mut usize,
    ) -> Result<Option<GroupSenderKeyReceivePlan>> {
        if *remaining_key_attempts == 0 {
            return Ok(None);
        }
        let Some(id) = self.sender_event_index.get(&message.sender_event_pubkey) else {
            return Ok(None);
        };
        let record = self
            .sender_keys
            .get(id)
            .ok_or_else(|| group_error("sender-key index points to missing state"))?;
        let group = self
            .groups
            .get(&id.group_id)
            .ok_or_else(|| group_error(format!("unknown group `{}`", id.group_id)))?;
        if id.group_id != message.group_id
            || record.sender_event_secret_key.is_some()
            || !group.protocol.is_sender_key_v1()
            || !group.members.contains(&id.sender_owner)
        {
            return Ok(None);
        }
        let latest = record.latest_key_id.and_then(|key| record.states.get(&key));
        let others = record
            .states
            .iter()
            .rev()
            .filter_map(|(key, state)| (Some(*key) != record.latest_key_id).then_some(state));
        for state in latest.into_iter().chain(others) {
            if *remaining_key_attempts == 0 {
                break;
            }
            *remaining_key_attempts -= 1;
            if let Ok(plan) = state.plan_decrypt_frontier(&message.ciphertext) {
                return self.sender_key_receive_plan(id, message, plan).map(Some);
            }
        }
        Ok(None)
    }

    pub(super) fn sender_key_receive_plan(
        &self,
        id: &SenderKeyRecordId,
        message: &GroupSenderKeyMessage,
        plan: crate::SenderKeyBlindDecryptPlan,
    ) -> Result<GroupSenderKeyReceivePlan> {
        let complete = |result| {
            Ok(GroupSenderKeyReceivePlan {
                result,
                mutation: None,
            })
        };
        let group = self
            .groups
            .get(&id.group_id)
            .ok_or_else(|| group_error(format!("unknown group `{}`", id.group_id)))?;
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
            .get(id)
            .and_then(|record| record.states.get(&plan.key_id))
            .ok_or_else(|| group_error("sender-key index points to missing state"))?;
        Ok(GroupSenderKeyReceivePlan {
            mutation: Some(GroupSenderKeyMutation {
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
        })
    }

    /// Commit a prepared receive only if its authenticated key/group inputs are
    /// still current. A stale plan never replaces newer ratchet state.
    pub fn apply_sender_key_receive_plan(
        &mut self,
        plan: GroupSenderKeyReceivePlan,
    ) -> Result<GroupSenderKeyHandleResult> {
        if let Some(GroupSenderKeyMutation {
            identity,
            author,
            expected,
            next,
            revision,
            local_member,
        }) = plan.mutation
        {
            let group = self
                .groups
                .get(&identity.group_id)
                .ok_or_else(|| group_error("group disappeared before sender-key apply"))?;
            let record = self
                .sender_keys
                .get_mut(&identity)
                .ok_or_else(|| group_error("sender disappeared before sender-key apply"))?;
            if !group.protocol.is_sender_key_v1()
                || group.revision != revision
                || group.members.contains(&self.local_owner_pubkey) != local_member
                || self.sender_event_index.get(&author) != Some(&identity)
                || record.sender_event_pubkey != author
                || !group.members.contains(&identity.sender_owner)
                || record.sender_event_secret_key.is_some()
                || record.states.get(&expected.key_id()) != Some(&expected)
            {
                return Err(group_error(
                    "sender-key decryption inputs changed before apply",
                ));
            }
            record.states.insert(next.key_id(), next);
        }
        Ok(plan.result)
    }

    pub(super) fn advance_blind_message(
        &self,
        identity: &SenderKeyRecordId,
        message: &GroupSenderKeyMessage,
        cursor: &mut Option<GroupSenderKeyDecryptCursor>,
        remaining: &mut usize,
    ) -> Result<BlindDecryptStep> {
        let record = self
            .sender_keys
            .get(identity)
            .ok_or_else(|| group_error("sender-key index points to missing state"))?;
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.identity != *identity || cursor.message != *message)
        {
            *cursor = None;
        }
        if cursor.as_ref().is_some_and(|cursor| {
            cursor
                .active
                .as_ref()
                .is_some_and(|(initial, _)| record.states.get(&initial.key_id()) != Some(initial))
        }) {
            // Never apply a plan based on an obsolete ratchet. Returning an empty
            // cursor lets the caller move this changed candidate behind other work.
            *cursor = None;
            return Ok(BlindDecryptStep::Pending);
        }
        let cursor = cursor.get_or_insert_with(|| GroupSenderKeyDecryptCursor {
            message: message.clone(),
            identity: identity.clone(),
            // Freeze the workset: incoming rotations cannot extend this pass forever.
            key_ids: record.states.keys().copied().collect(),
            key_index: 0,
            active: None,
        });
        loop {
            let Some(key) = cursor.key_ids.get(cursor.key_index) else {
                return Ok(BlindDecryptStep::Exhausted);
            };
            let Some(state) = record.states.get(key) else {
                cursor.active = None;
                cursor.key_index += 1;
                continue;
            };
            if *remaining == 0 {
                return Ok(BlindDecryptStep::Pending);
            }
            let (_, active) = cursor
                .active
                .get_or_insert_with(|| (state.clone(), BlindDecryptCursor::new(state)));
            match active.advance(&message.ciphertext, remaining) {
                Ok(BlindDecryptStep::Exhausted) | Err(_) => {
                    cursor.active = None;
                    cursor.key_index += 1;
                }
                Ok(result) => return Ok(result),
            }
        }
    }
}
