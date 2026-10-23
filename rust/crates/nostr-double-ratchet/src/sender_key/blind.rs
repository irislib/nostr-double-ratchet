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

    fn messages_through(last: u32) -> (SenderKeyState, Vec<Vec<u8>>) {
        let initial = SenderKeyState::new(1, [23; 32], 0);
        let mut sender = initial.clone();
        let messages = (0..=last)
            .map(|number| {
                sender
                    .encrypt_to_bytes(format!("message-{number}").as_bytes())
                    .unwrap()
                    .1
            })
            .collect();
        (initial, messages)
    }

    fn assert_partitioned_plan(
        initial: &SenderKeyState,
        number: u32,
        ciphertext: &[u8],
        expected_trials: usize,
        budget: usize,
    ) {
        let before = serde_json::to_string(initial).unwrap();
        let expected = initial
            .plan_decrypt(&SenderKeyMessageContent {
                key_id: initial.key_id,
                message_number: number,
                ciphertext: ciphertext.to_vec(),
            })
            .unwrap();
        let mut cursor = BlindDecryptCursor::new(initial);
        assert!(matches!(
            cursor.advance(ciphertext, &mut 0).unwrap(),
            BlindDecryptStep::Pending
        ));
        let mut trials = 0;
        loop {
            let mut remaining = budget;
            let step = cursor.advance(ciphertext, &mut remaining).unwrap();
            trials += budget - remaining;
            match step {
                BlindDecryptStep::Pending => {
                    assert_eq!(remaining, 0);
                    assert!(trials < expected_trials);
                    // A checkpoint's clone must retain the exact continuation.
                    cursor = cursor.clone();
                }
                BlindDecryptStep::Complete(plan) => {
                    assert_eq!(trials, expected_trials);
                    assert_eq!(plan.key_id, initial.key_id);
                    assert_eq!(plan.message_number, number);
                    assert_eq!(plan.plaintext, expected.plaintext);
                    assert_eq!(plan.next_state, expected.next_state);
                    assert_eq!(
                        serde_json::to_string(&plan.next_state).unwrap(),
                        serde_json::to_string(&expected.next_state).unwrap()
                    );
                    break;
                }
                BlindDecryptStep::Exhausted => panic!("lost an authentic message"),
            }
        }
        assert_eq!(serde_json::to_string(initial).unwrap(), before);
    }

    #[test]
    fn blind_search_budget_partitions_preserve_authenticated_state() {
        let (initial, messages) = messages_through(2_501);
        for number in [0, 31, 513, 2_501] {
            for budget in [1, 7, 256] {
                assert_partitioned_plan(
                    &initial,
                    number,
                    &messages[number as usize],
                    number as usize + 1,
                    budget,
                );
            }
        }
    }

    #[test]
    fn blind_search_retained_keys_keep_trial_order_and_remove_only_match() {
        let (mut initial, messages) = messages_through(20);
        initial.decrypt_from_bytes(20, &messages[20]).unwrap();
        assert_eq!(initial.skipped_len(), 20);
        for number in [0, 7, 19] {
            for budget in [1, 7, 256] {
                assert_partitioned_plan(
                    &initial,
                    number,
                    &messages[number as usize],
                    number as usize + 1,
                    budget,
                );
            }
        }
    }

    #[test]
    fn blind_search_exhaustion_counts_every_trial_without_mutating_source() {
        let (mut initial, messages) = messages_through(4);
        initial.decrypt_from_bytes(4, &messages[4]).unwrap();
        let before = initial.clone();
        let expected_trials = initial.skipped_len() + SENDER_KEY_MAX_SKIP + 1;
        for budget in [1, 7, 256] {
            let mut cursor = BlindDecryptCursor::new(&initial);
            let mut trials = 0;
            loop {
                let mut remaining = budget;
                let step = cursor.advance(&[], &mut remaining).unwrap();
                trials += budget - remaining;
                match step {
                    BlindDecryptStep::Pending => {
                        assert_eq!(remaining, 0);
                        assert!(trials <= expected_trials);
                    }
                    BlindDecryptStep::Exhausted => break,
                    BlindDecryptStep::Complete(_) => panic!("authenticated an invalid payload"),
                }
            }
            assert_eq!(trials, expected_trials);
            assert_eq!(initial, before);
        }
    }

    #[test]
    fn blind_search_preserves_ordered_retention_from_serialized_state() {
        let (mut initial, messages) = messages_through(2_501);
        // Deserialization permits retained numbers ahead of the chain. Preserve
        // the existing ordered replacement/pruning semantics for those too.
        initial.skipped_message_keys = BTreeMap::from([(4, [7; 32]), (4_000, [8; 32])]);
        let initial: SenderKeyState =
            serde_json::from_str(&serde_json::to_string(&initial).unwrap()).unwrap();
        for budget in [7, 256] {
            assert_partitioned_plan(&initial, 2_501, &messages[2_501], 2 + 2_502, budget);
        }
    }

    #[test]
    fn blind_search_preserves_oversized_initial_retention_until_forward_search() {
        let (initial, messages) = messages_through(2_501);
        let mut sender = initial.clone();
        let mut oversized = initial.clone();
        // Model an old or unusual snapshot with more retained keys than today's
        // cap. A skipped-key hit must remove only that key, without pruning.
        for number in 0..2_501 {
            let (chain, key) = derive_message_key(&sender.chain_key);
            sender.chain_key = chain;
            sender.iteration += 1;
            oversized.skipped_message_keys.insert(number, key);
        }
        oversized.chain_key = sender.chain_key;
        oversized.iteration = sender.iteration;
        let oversized: SenderKeyState =
            serde_json::from_str(&serde_json::to_string(&oversized).unwrap()).unwrap();
        assert_partitioned_plan(&oversized, 7, &messages[7], 8, 7);
        assert_partitioned_plan(&oversized, 2_501, &messages[2_501], 2_502, 256);

        // Forward search must replace matching numbers, prune after failures,
        // and retain future entries in the same order as the durable map.
        let mut unusual = initial;
        unusual.skipped_message_keys = (2..=2_502).map(|number| (number, [31; 32])).collect();
        assert_partitioned_plan(&unusual, 2_501, &messages[2_501], 2_501 + 2_502, 256);
    }

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
