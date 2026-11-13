//! Simulation-only clock override (added to scratch copies by the comparison harness).
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static NOW_MS: AtomicU64 = AtomicU64::new(0);

pub fn set_ms(ms: u64) {
    NOW_MS.store(ms, Ordering::Relaxed);
}

pub fn system_now() -> SystemTime {
    match NOW_MS.load(Ordering::Relaxed) {
        0 => SystemTime::now(),
        ms => UNIX_EPOCH + Duration::from_millis(ms),
    }
}

/// Monotonic clock on the same virtual timeline. Work measured across a call
/// reads as zero because virtual time does not advance inside one call, so
/// CPU-time based pacing sees an infinitely fast device.
pub fn instant_now() -> std::time::Instant {
    static BASE: std::sync::OnceLock<(std::time::Instant, u64)> = std::sync::OnceLock::new();
    let now_ms = NOW_MS.load(Ordering::Relaxed);
    if now_ms == 0 {
        return std::time::Instant::now();
    }
    let (base, base_ms) = *BASE.get_or_init(|| (std::time::Instant::now(), now_ms));
    base + Duration::from_millis(now_ms.saturating_sub(base_ms))
}
