// Only in the isolated simulation build. No plaintext is written by these hooks.
thread_local! {
    static SEALED: std::cell::RefCell<std::collections::HashMap<String, Vec<u8>>> = Default::default();
    static STAGES: std::cell::RefCell<std::collections::HashMap<String, &'static str>> = Default::default();
}

pub fn audit_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("NDR_RETRY_AUDIT").is_some())
}

pub fn observe_seal(ciphertext: &str, payload: &[u8]) {
    if audit_enabled() {
        SEALED.with_borrow_mut(|m| m.insert(ciphertext.to_owned(), payload.to_vec()));
    }
}

pub fn observe_source(ciphertext: &str, stage: &'static str) {
    STAGES.with_borrow_mut(|m| {
        m.entry(ciphertext.to_owned()).or_insert(stage);
    });
}

pub fn take_seal(ciphertext: &str) -> (Option<Vec<u8>>, Option<&'static str>) {
    (
        SEALED.with_borrow_mut(|m| m.remove(ciphertext)),
        STAGES.with_borrow_mut(|m| m.remove(ciphertext)),
    )
}
