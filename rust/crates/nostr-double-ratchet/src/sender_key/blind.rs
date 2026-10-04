use super::*;

#[derive(Clone)]
pub(crate) struct BlindDecryptCursor {
    next_state: SenderKeyState,
    next_skipped: Option<u32>,
    searching_skipped: bool,
    max_message_number: u32,
}

pub(crate) enum BlindDecryptStep {
    Pending,
    Exhausted,
    Complete(SenderKeyBlindDecryptPlan),
}

impl BlindDecryptCursor {
    pub(crate) fn new(state: &SenderKeyState) -> Self {
        Self {
            next_state: state.clone(),
            next_skipped: None,
            searching_skipped: true,
            max_message_number: state.iteration.saturating_add(SENDER_KEY_MAX_SKIP as u32),
        }
    }

    /// Consumes at most `remaining` key trials, including retained skipped keys.
    /// The real ratchet remains untouched until the authenticated plan is applied.
    pub(crate) fn advance(
        &mut self,
        ciphertext: &[u8],
        remaining: &mut usize,
    ) -> Result<BlindDecryptStep> {
        while *remaining > 0 {
            if self.searching_skipped {
                use std::ops::Bound::{Excluded, Unbounded};
                let start = self.next_skipped.map_or(Unbounded, Excluded);
                let next = self
                    .next_state
                    .skipped_message_keys
                    .range((start, Unbounded))
                    .next();
                if let Some((&number, key)) = next {
                    *remaining -= 1;
                    self.next_skipped = Some(number);
                    if let Ok(plaintext) = decrypt_with_message_key(key, ciphertext) {
                        let mut next_state = self.next_state.clone();
                        next_state.skipped_message_keys.remove(&number);
                        return Ok(BlindDecryptStep::Complete(SenderKeyBlindDecryptPlan {
                            key_id: next_state.key_id,
                            next_state,
                            message_number: number,
                            plaintext,
                        }));
                    }
                    continue;
                }
                self.searching_skipped = false;
            }
            if self.next_state.iteration > self.max_message_number {
                return Ok(BlindDecryptStep::Exhausted);
            }
            *remaining -= 1;
            let number = self.next_state.iteration;
            let (chain_key, message_key) = derive_message_key(&self.next_state.chain_key);
            self.next_state.chain_key = chain_key;
            self.next_state.iteration = number.checked_add(1).ok_or_else(|| {
                crate::Error::Decryption("sender-key iteration overflow".to_string())
            })?;
            if let Ok(plaintext) = decrypt_with_message_key(&message_key, ciphertext) {
                prune_skipped(&mut self.next_state.skipped_message_keys);
                return Ok(BlindDecryptStep::Complete(SenderKeyBlindDecryptPlan {
                    next_state: self.next_state.clone(),
                    key_id: self.next_state.key_id,
                    message_number: number,
                    plaintext,
                }));
            }
            self.next_state
                .skipped_message_keys
                .insert(number, message_key);
            // The original complete plan retains only this same newest-key tail.
            // Pruning during search also bounds a suspended cursor's extra memory.
            prune_skipped(&mut self.next_state.skipped_message_keys);
        }
        Ok(BlindDecryptStep::Pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blind_search_yields_and_retains_the_complete_window() {
        let initial = SenderKeyState::new(1, [7; 32], 0);
        let mut sender = initial.clone();
        let mut ciphertext = Vec::new();
        for _ in 0..=SENDER_KEY_MAX_SKIP {
            ciphertext = sender.encrypt_to_bytes(b"last position").unwrap().1;
        }
        let expected = initial
            .plan_decrypt(&SenderKeyMessageContent {
                key_id: 1,
                message_number: SENDER_KEY_MAX_SKIP as u32,
                ciphertext: ciphertext.clone(),
            })
            .unwrap();
        let mut cursor = BlindDecryptCursor::new(&initial);
        let mut turns = 0;
        loop {
            turns += 1;
            match cursor.advance(&ciphertext, &mut 256).unwrap() {
                BlindDecryptStep::Pending => assert!(turns < 50),
                BlindDecryptStep::Complete(plan) => {
                    assert_eq!(plan.next_state, expected.next_state);
                    assert_eq!(plan.plaintext, expected.plaintext);
                    assert_eq!(plan.message_number, SENDER_KEY_MAX_SKIP as u32);
                    assert!(turns > 1);
                    break;
                }
                BlindDecryptStep::Exhausted => panic!("lost original recovery window"),
            }
            assert!(cursor.next_state.skipped_len() <= SENDER_KEY_MAX_STORED_SKIPPED_KEYS);
        }
        assert_eq!(initial.iteration(), 0);
    }
}
