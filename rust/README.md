# nostr-double-ratchet (Rust)

Rust implementation and tooling for Double Ratchet messaging on Nostr.

## Crates

| Crate | Description |
|-------|-------------|
| [nostr-double-ratchet](./crates/nostr-double-ratchet) | Sessions, invites, groups, AppKeys fact events, and event wire helpers |
| [nostr-double-ratchet-pairwise-codec](./crates/nostr-double-ratchet-pairwise-codec) | Pairwise group payload codec |

## Security Properties (Rust Stack)

- End-to-end confidentiality for 1:1 messaging (NIP-44 + Double Ratchet).
- Forward secrecy and post-compromise recovery through ratchet evolution.
- Signed outer events with owner/device attribution bound to authenticated session context.
- Multi-device owner claims checked via AppKeys when owner and device keys differ.
- Inner rumor `pubkey` is not used as a trusted sender identity source.
- Inner rumors are unsigned, giving plausible deniability rather than non-repudiation.

## Shared Multi-Device Helpers

Prefer the shared helper functions in `nostr-double-ratchet` over local policy copies in apps,
CLI commands, or FFI wrappers.

- `apply_app_keys_snapshot(...)`: orders AppKeys by `created_at`, ignores stale snapshots, and
  merges same-second snapshots monotonically.
- `select_latest_app_keys_from_events(...)`: converges a relay/event history into the latest
  monotonic AppKeys view.
- `evaluate_device_registration_state(...)`: centralizes readiness and device-registration
  decisions.
- `should_require_relay_registration_confirmation(...)`: distinguishes first-device bootstrap from
  adding a new device to an existing owner timeline.
- `resolve_invite_owner_routing(...)`: keeps invite owner/device attribution consistent,
  including link bootstrap and fallback-to-device routing.
- `resolve_conversation_candidate_pubkeys(...)`: centralizes self-DM and linked-device
  conversation routing so clients do not fork the same rumor/owner/sender heuristic.
- `resolve_rumor_peer_pubkey(...)`: resolves the immediate peer for a rumor when callers only need
  the normalized peer identity rather than the full ordered candidate list.
- `RuntimeSubscriptionTracker` + `build_runtime_backfill_filters(...)`: detect newly added AppKeys
  authors, invite-response recipients, and message authors and issue bounded relay replay
  immediately instead of waiting for a periodic sweep.

AppKeys should be treated as an authorization timeline. Reduced AppKeys sets should only be
published for explicit revocation or first-device bootstrap. Imported owner-key logins on a fresh
device should either register that device or remain explicitly single-device. First-device
bootstrap can proceed from locally published AppKeys; public-invite fanout for additional devices
should wait until relays reflect the updated AppKeys snapshot.

## Runtime Catch-Up

Apps and protocol runtimes still own relay history fetch. If AppKeys authors, invite-response
recipients, or message authors are newly added to runtime subscriptions, consume that signal
immediately:

```rust
use nostr_double_ratchet::{
    build_runtime_backfill_filters, RuntimeSubscriptionTracker,
};

let mut tracker = RuntimeSubscriptionTracker::new();

let registration = tracker.register_subscription(subid, filter_json);
for filter in build_runtime_backfill_filters(&registration, 200) {
    // Hand `filter` to your relay client for a short replay/backfill.
}

tracker.unregister_subscription(subid);
```

## Group Model

- Group membership is represented by owner pubkeys.
- Group metadata and sender-key distributions are delivered over authenticated 1:1 sessions.
- Group messages are published once using per-sender one-to-many outer events.
- Shared-channel events are used for signed group bootstrap invites when needed to establish missing pairwise sessions.

## Quick Start

Commands below assume you run them from the repository root.

```bash
# Run all Rust tests in workspace
cargo test --manifest-path rust/Cargo.toml
```

## Important Test Targets

```bash
# Core library
cargo test -p nostr-double-ratchet --manifest-path rust/Cargo.toml

# Regenerate interop fixtures (fixture writers are ignored in ordinary test runs)
REGENERATE_VECTORS=true cargo test --workspace --manifest-path rust/Cargo.toml generate -- --ignored --test-threads=1
```

## Multi-Device Test Policy

- Keep one explicit same-second AppKeys regression in the core library tests.
- Normal CLI and client interop tests should avoid same-second AppKeys publication unless they are
  intentionally testing that edge case.
- Keep heterogeneous clients in the matrix, not only library-level tests.

## Publishing

```bash
./rust/scripts/publish.sh --dry-run
./rust/scripts/publish.sh
```

For detailed core-library API and behavior, see [`rust/crates/nostr-double-ratchet/README.md`](./crates/nostr-double-ratchet/README.md).
