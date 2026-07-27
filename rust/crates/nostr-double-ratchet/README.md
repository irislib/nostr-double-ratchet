# nostr-double-ratchet

Rust library implementing Double Ratchet messaging for Nostr, including multi-device session management and sender-key group messaging.

## Features

- 1:1 Double Ratchet sessions over Nostr events
- Invite/bootstrap flows for secure session establishment
- `SessionManager` for multi-device owner/device routing
- AppKeys-based device authorization and owner-claim validation
- Sender-key + one-to-many group messaging primitives
- Persistent storage interfaces and message/discovery queues
- TypeScript/Rust interop test coverage

## Recommended Integration Paths

There are three practical layers:

- `Session`: smallest 1:1 primitive when the caller already owns bootstrap, persistence, and
  transport.
- `nostr-double-ratchet-pairwise`: durable single-device pairwise runtime with invite bootstrap,
  replay/skipped-key handling, disappearing messages, and an acknowledged transport-action
  journal. Mobile clients can use its `ndr-pairwise-ffi` UniFFI bindings.
- `SessionManager`: deterministic multi-device routing and invite handling primitives for apps
  that own relay I/O and runtime wiring.

Use [`iris-chat-rs`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat-rs)
when a native app needs AppKeys, linked devices, sibling sync, or groups.

## Security Properties

### Confidentiality

- 1:1 payloads are encrypted with Double Ratchet and NIP-44.
- Group payloads are encrypted with sender-key chains and published as one-to-many outer events.

### Forward Secrecy And Post-Compromise Recovery

- 1:1 chains ratchet continuously, providing forward secrecy.
- Future secrecy recovers after fresh ratchet steps if transient compromise ends.

### Author/Device Verification

- Outer Nostr events are signature-verified.
- Identity attribution is based on authenticated session context and owner/device mapping.
- For multi-device owner claims, AppKeys are used to verify device authorization.
- The latest AppKeys set is authoritative for device authorization; removing a device from AppKeys revokes it for future routing and owner-claim validation.
- Applications must not publish a reduced AppKeys set implicitly during startup/reopen. Publishing fewer devices should only happen for explicit device revocation or first-device bootstrap.
- Inner rumor `pubkey` is not treated as a trusted sender identity source.

### Plausible Deniability

- Inner rumors are unsigned payloads transported inside encrypted channels.
- This preserves deniability for inner content at the cost of strong non-repudiation.

## Group Messaging Architecture

Groups are handled with a hybrid model:

1. Membership is tracked by owner pubkeys.
2. Group metadata and sender-key distributions are sent over authenticated 1:1 sessions.
3. Each sender device uses a per-group sender-event keypair and sender-key state.
4. Group messages are published once (one-to-many), then decrypted by members with sender-key state.
5. Shared-channel events are used by higher-level integrations for signed bootstrap invites when pairwise sessions are missing.

## Basic 1:1 Usage

```rust
use nostr::Keys;
use nostr_double_ratchet::Session;

let alice_keys = Keys::generate();
let bob_keys = Keys::generate();

// Shared secret must come from a secure invite/bootstrap flow.
let shared_secret = [7u8; 32];

let mut alice = Session::init(
    bob_keys.public_key(),
    alice_keys.secret_key().to_secret_bytes(),
    true,
    shared_secret,
    Some("alice-chat".to_string()),
)?;

let mut bob = Session::init(
    alice_keys.public_key(),
    bob_keys.secret_key().to_secret_bytes(),
    false,
    shared_secret,
    Some("bob-chat".to_string()),
)?;

let inner = nostr_double_ratchet::build_text_rumor(
    alice_keys.public_key(),
    "hello bob",
    vec![],
)?;
let outer = alice.send_event(inner)?;
let plaintext = bob.receive(&outer)?;
assert!(plaintext.is_some());
# Ok::<(), nostr_double_ratchet::Error>(())
```

## App Runtime Integration

This crate exposes deterministic protocol state machines. Host apps or higher-level protocol
runtimes translate prepared sends into relay publishes, feed fetched relay events back into the
state machines, and persist snapshots. Use `nostr-double-ratchet-pairwise` /
`ndr-pairwise-ffi` for a single-device direct-message runtime, or `iris-chat-rs` for the full
multi-device/group protocol.

## Disappearing Messages

Use NIP-40-style `["expiration", "<unix seconds>"]` tags in inner rumors.  
`SessionManager` helpers support global, per-peer, and per-group defaults through `SendOptions`.

## Runtime Catch-Up

Runtime integrations should fetch AppKeys, device invites, invite responses, and active message
authors on startup, reconnect, and after AppKeys/invite changes. The
`nostr-double-ratchet` provides `RuntimeSubscriptionTracker` and
`build_runtime_backfill_filters(...)` for bounded relay replay when new runtime subscription
targets appear.

## 1:1 Chat Settings Signaling

- Kind: `CHAT_SETTINGS_KIND = 10448`
- Content: `{ "type": "chat-settings", "v": 1, "messageTtlSeconds": <seconds|null> }`
- Settings events themselves should not expire

Receivers can auto-adopt or reject incoming settings policy.

## Testing

```bash
cargo test -p nostr-double-ratchet --manifest-path rust/Cargo.toml
```
