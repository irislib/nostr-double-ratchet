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
