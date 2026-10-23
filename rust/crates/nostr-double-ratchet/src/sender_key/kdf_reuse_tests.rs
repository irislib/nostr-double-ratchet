use super::*;
use rand::{rngs::StdRng, SeedableRng};

fn reference_keys(chain_key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(SENDER_KEY_KDF_SALT), chain_key);
    let (mut next, mut message) = ([0; 32], [0; 32]);
    hk.expand(&[1], &mut next).unwrap();
    hk.expand(&[2], &mut message).unwrap();
    (next, message)
}

fn ciphertext(key: [u8; 32]) -> Vec<u8> {
    nip44::v2::encrypt_to_bytes_with_rng(
        &mut StdRng::seed_from_u64(19),
        &nip44::v2::ConversationKey::new(key),
        &[b'x'; 1024],
    )
    .unwrap()
}

fn corrupt_ciphertext(initial: &SenderKeyState) -> Vec<u8> {
    let key = reference_keys(&initial.chain_key).1;
    let mut bytes = ciphertext(key);
    assert_eq!(
        decrypt_with_message_key(&key, &bytes).unwrap(),
        [b'x'; 1024]
    );
    *bytes.last_mut().unwrap() ^= 1;
    assert!(matches!(
        nip44::v2::decrypt_to_bytes(&nip44::v2::ConversationKey::new(key), &bytes),
        Err(nip44::Error::V2(nip44::v2::ErrorV2::InvalidHmac))
    ));
    bytes
}

#[test]
fn blind_kdf_initializes_fixed_salt_once_per_forward_advance() {
    let initial = SenderKeyState::new(1, [23; 32], 0);
    let before = initial.clone();
    let bytes = corrupt_ciphertext(&initial);
    let mut cursor = BlindDecryptCursor::new(&initial);
    SENDER_KEY_EXTRACT_INITIALIZATIONS.with(|count| count.set(Some(0)));
    let mut remaining = 256;
    let step = cursor.advance(&bytes, &mut remaining).unwrap();
    let initializations =
        SENDER_KEY_EXTRACT_INITIALIZATIONS.with(|count| count.replace(None).unwrap());
    assert!(matches!(step, BlindDecryptStep::Pending));
    assert_eq!(remaining, 0);
    assert_eq!(cursor.iteration, 256);
    assert_eq!(initial, before);
    let mut reference = initial.clone();
    for number in 0..256 {
        let (next, key) = reference_keys(&reference.chain_key);
        reference.chain_key = next;
        reference.iteration += 1;
        reference.skipped_message_keys.insert(number, key);
    }
    assert_eq!(cursor.planned_state(None), reference);
    eprintln!("blind_kdf_initializations trials=256 initializations={initializations} maximum=1 invalid_hmac=true state_unchanged=true reference_state=true");
    assert_eq!(
        initializations, 1,
        "fixed-salt extraction must initialize once per forward advance"
    );
}

#[test]
fn blind_kdf_reference_keys_match_partitioned_boundary_states() {
    for seed in [0, 23, 255] {
        let initial = SenderKeyState::new(7, [seed; 32], 0);
        let mut chain = initial.chain_key;
        let keys = (0..=SENDER_KEY_MAX_SKIP)
            .map(|_| {
                let expected = reference_keys(&chain);
                assert_eq!(derive_message_key(&chain), expected);
                chain = expected.0;
                expected
            })
            .collect::<Vec<_>>();
        for number in [255, 256, 1_999, 2_000, SENDER_KEY_MAX_SKIP] {
            let bytes = ciphertext(keys[number].1);
            let expected = SenderKeyState {
                key_id: 7,
                chain_key: keys[number].0,
                iteration: number as u32 + 1,
                skipped_message_keys: (number.saturating_sub(SENDER_KEY_MAX_STORED_SKIPPED_KEYS)
                    ..number)
                    .map(|n| (n as u32, keys[n].1))
                    .collect(),
            };
            for budget in [7, 256] {
                let mut cursor = BlindDecryptCursor::new(&initial);
                let mut trials = 0;
                loop {
                    let mut remaining = budget;
                    let step = cursor.advance(&bytes, &mut remaining).unwrap();
                    trials += budget - remaining;
                    match step {
                        BlindDecryptStep::Pending => assert!(trials < number + 1),
                        BlindDecryptStep::Complete(plan) => {
                            assert_eq!(trials, number + 1);
                            assert_eq!(plan.message_number, number as u32);
                            assert_eq!(plan.plaintext, [b'x'; 1024]);
                            assert_eq!(plan.next_state, expected);
                            let reloaded: SenderKeyState = serde_json::from_str(
                                &serde_json::to_string(&plan.next_state).unwrap(),
                            )
                            .unwrap();
                            assert_eq!(reloaded, expected);
                            break;
                        }
                        BlindDecryptStep::Exhausted => panic!("lost a reference-key ciphertext"),
                    }
                }
            }
            assert_eq!(initial.iteration, 0);
            assert!(initial.skipped_message_keys.is_empty());
        }
    }
}

#[test]
fn blind_kdf_corrupt_mac_preserves_exhaustion_and_skipped_only_work() {
    let initial = SenderKeyState::new(1, [23; 32], 0);
    let before = initial.clone();
    let bytes = corrupt_ciphertext(&initial);
    for budget in [1, 256] {
        let mut cursor = BlindDecryptCursor::new(&initial);
        let mut trials = 0;
        loop {
            let mut remaining = budget;
            let step = cursor.advance(&bytes, &mut remaining).unwrap();
            trials += budget - remaining;
            match step {
                BlindDecryptStep::Pending => assert!(trials <= SENDER_KEY_MAX_SKIP + 1),
                BlindDecryptStep::Exhausted => break,
                BlindDecryptStep::Complete(_) => panic!("accepted a corrupt MAC"),
            }
        }
        assert_eq!(trials, SENDER_KEY_MAX_SKIP + 1);
        assert_eq!(cursor.iteration as usize, trials);
        assert_eq!(
            cursor.skipped_message_keys.len(),
            SENDER_KEY_MAX_STORED_SKIPPED_KEYS
        );
        assert_eq!(initial, before);
    }
    let (next, key) = reference_keys(&initial.chain_key);
    let mut retained = SenderKeyState::new(1, next, 1);
    retained.skipped_message_keys.insert(0, key);
    let mut cursor = BlindDecryptCursor::new(&retained);
    let valid = ciphertext(key);
    SENDER_KEY_EXTRACT_INITIALIZATIONS.with(|count| count.set(Some(0)));
    assert!(matches!(
        cursor.advance(&valid, &mut 0).unwrap(),
        BlindDecryptStep::Pending
    ));
    let step = cursor.advance(&valid, &mut 1).unwrap();
    let initializations =
        SENDER_KEY_EXTRACT_INITIALIZATIONS.with(|count| count.replace(None).unwrap());
    let BlindDecryptStep::Complete(plan) = step else {
        panic!("lost retained key")
    };
    assert_eq!(
        initializations, 0,
        "zero-budget and retained-key hits need no extract context"
    );
    assert_eq!(plan.next_state.chain_key, next);
    assert_eq!(plan.next_state.iteration, 1);
    assert!(plan.next_state.skipped_message_keys.is_empty());
    assert_eq!(retained.skipped_len(), 1);
}

#[test]
#[ignore = "bounded hosted microbenchmark; not application CPU qualification"]
fn blind_kdf_corrupt_mac_microbenchmark() {
    use std::{hint::black_box, time::Instant};
    let initial = SenderKeyState::new(1, [23; 32], 0);
    let before = initial.clone();
    let bytes = corrupt_ciphertext(&initial);
    let run = || {
        let mut trials = 0;
        for _ in 0..16 {
            let mut cursor = BlindDecryptCursor::new(black_box(&initial));
            loop {
                let mut remaining = 256;
                let step = cursor.advance(black_box(&bytes), &mut remaining).unwrap();
                trials += 256 - remaining;
                match step {
                    BlindDecryptStep::Pending => {}
                    BlindDecryptStep::Exhausted => break,
                    BlindDecryptStep::Complete(_) => panic!("accepted a corrupt MAC"),
                }
            }
            black_box(cursor);
        }
        assert_eq!(trials, 16 * (SENDER_KEY_MAX_SKIP + 1));
        trials
    };
    run(); // One identical warmup, excluded from samples.
    for sample in 0..7 {
        let start = Instant::now();
        let trials = run();
        let elapsed = start.elapsed().as_secs_f64();
        assert_eq!(initial, before);
        eprintln!("blind_kdf_benchmark sample={sample} searches=16 trials={trials} budget=256 ciphertext_bytes={} elapsed_seconds={elapsed:.9} invalid_hmac=true state_unchanged=true", bytes.len());
    }
}
