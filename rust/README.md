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

The `test-rust` package job and `interop` job in `.github/workflows/ci.yml`
use the reviewed inputs in `rust/ci/build-inputs.json`: Rust 1.99.0 for
`x86_64-unknown-linux-gnu`, Node 24.22.1, pnpm 9.15.0, and a full-commit
Rust-cache action. `rust/scripts/ci-build-inputs.py` verifies each downloaded
archive against its digest in source before extracting or executing it. It does
not trust a checksum downloaded alongside the archive at build time. Rust
compiler, standard library, Cargo, rustfmt and Clippy components come from the
dated official Rust distribution; Node and pnpm come from their official
publishers. Pin provenance URLs are retained in the JSON. Updating inputs means
reviewing and committing new versions and hashes together.

These jobs run on GitHub's `ubuntu-24.04` x86-64 hosted image with two Cargo
jobs. They use the default Rust features except the explicitly minimal pairwise
FFI check, `Cargo.lock` with `--locked`, and `pnpm-lock.yaml` with
`--frozen-lockfile`. The installer bypasses mutable toolchain/package-manager
setup downloads and preserves the workspace's normal `rust/target` cache path.
Its cache key includes the reviewed-input file and compiler identity; cached
Cargo-installed helper binaries are disabled.

The hosted image remains an external input: its kernel, glibc, C compiler,
linker, Python 3.12 or newer, shell, certificate store, and GitHub Actions
runtime are preinstalled and are not pinned by this change. No system packages
are installed by these two jobs. Their receipt records the runner image version,
OS release, Python, C compiler/linker/libc and installed tool versions, plus
lockfile and pin-file hashes. The Rust package artifact includes that receipt,
the reviewed pins and the `.crate` checksum. Cache contents and hosted-system
updates can still affect builds; this is input verification, not proof of
bit-for-bit binary reproducibility or a comprehensive dependency/Haps audit.
The separate `test-ts`, formal/source-size jobs and npm publication workflow are
outside this pinning scope. Their existing checks remain required where used.

The source checks below run offline without installing tools or compiling:

```bash
python3 rust/scripts/ci-build-inputs.py --check
python3 rust/scripts/test-ci-build-inputs.py
./scripts/check-source-size.sh
```

Only the hosted jobs invoke `--install`. Package publication still requires a
successful package verification at the exact source revision; a publish-script
dry run that uses `--no-verify` is not that verification.

```bash
./rust/scripts/publish.sh --dry-run
./rust/scripts/publish.sh
```

For detailed core-library API and behavior, see [`rust/crates/nostr-double-ratchet/README.md`](./crates/nostr-double-ratchet/README.md).
