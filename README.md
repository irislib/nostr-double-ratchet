[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/mmalmi/nostr-double-ratchet)

# nostr-double-ratchet

> Main development is on [decentralized git](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/nostr-double-ratchet): `htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/nostr-double-ratchet`

End-to-end encrypted messaging primitives for Nostr, implemented in TypeScript and Rust.

Reference integrations:
[`iris-client`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-client),
[`iris-chat`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat),
[`iris-chat-rs`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat-rs).
Used by [chat.iris.to](https://chat.iris.to). For command-line chat tooling,
use the `iris` CLI from the
[`iris-chat`](https://crates.io/crates/iris-chat) crate.

## Status

- 1:1 messaging via Double Ratchet over Nostr events
- Multi-device identity model (owner key + device keys) with AppKeys
- Invite and link flows for session bootstrapping
- Group messaging with sender keys and one-to-many outer events
- High-level TypeScript `NdrRuntime`; dedicated Rust pairwise runtime and mobile UniFFI
- Full Rust AppKeys, linked-device, and group runtime lives in `iris-chat-rs`
- Cross-language TS/Rust interoperability tests
- Breaking changes are still possible while APIs settle

## Integration Modes

| Mode | Use it when | What it owns |
| --- | --- | --- |
| TypeScript `NdrRuntime` | You want the default TypeScript production path with one app-facing surface for direct messages, linked devices, and groups. | `AppKeysManager`, `DelegateManager`, `SessionManager`, and `GroupManager` in TypeScript. |
| Rust pairwise runtime / mobile FFI | You have one local identity and need forward-secure asynchronous direct messages without AppKeys, sibling-device sync, or groups. | Durable encrypted ratchet state, invite bootstrap, replay/skipped-key handling, expiring messages, and an acknowledged transport-action journal. Use `nostr-double-ratchet-pairwise` or `ndr-pairwise-ffi`. |
| Rust full protocol runtime | You need AppKeys authorization, linked devices, sibling sync, or groups. | Use [`iris-chat-rs`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat-rs), which builds on these core crates. |
| Rust `SessionManager` | You want deterministic multi-device routing and storage primitives, but your app owns relay/runtime wiring. | Session orchestration, routing decisions, storage-backed session state, and prepared sends/receives. |
| `Session` | You want the simplest 1:1 primitive and you already own invite/bootstrap, persistence, and transport. Good for negotiated 1:1 channels or other app-specific direct links. | Only the ratchet session state itself. |

Add-ons around those layers:

- `SessionGroupRuntime`: in TypeScript, attach the same group transport surface that
  `NdrRuntime` uses to an existing `SessionManager`.
- `GroupManager`: direct group transport helper if you want to wire group state yourself.
- `Invite`: handshake/bootstrap primitive when you build around plain `Session`.

Use TypeScript `NdrRuntime` when you want one concrete app-facing surface for:

- `setupUser(...)`
- `sendEvent(...)`, `sendMessage(...)`
- `sendReceipt(...)`, `sendTyping(...)`
- `sendChatSettings(...)`, `setChatSettingsForPeer(...)`
- `waitForSessionManager(...)` and `onSessionEvent(...)`
- `getGroupManager()` / `waitForGroupManager(...)`
- `onGroupEvent(...)`
- `upsertGroup(...)`, `removeGroup(...)`, `syncGroups(...)`
- `createGroup(...)`
- `sendGroupEvent(...)`, `sendGroupMessage(...)`

Use Rust `SessionManager` when you want to keep your own app runtime, but you do not want to
rebuild multi-device routing, device authorization, or session persistence yourself.

Use plain `Session` when you want the smallest possible surface for 1:1 messaging and you do not
need owner/device fanout, AppKeys-driven authorization, or runtime-managed group transport.
Build inner rumors with `messageBuilders` first; `Session` only encrypts/decrypts unsigned inner
events and does not own chat features such as reactions, typing, receipts, or expiration policy.

## Security Guarantees And Properties

### Confidentiality

- 1:1 payloads are encrypted end-to-end (NIP-44 + Double Ratchet).
- Group payloads are encrypted with per-sender sender-key chains.
- Relays can still observe outer-event metadata (timing, pubkeys, kind), not plaintext.

### Forward Secrecy And Recovery

- Double Ratchet gives forward secrecy for 1:1 sessions.
- After compromise of a current chain key, future secrecy recovers after fresh ratchet steps (assuming attacker no longer controls endpoints).
- Group sender keys rotate and are redistributed to handle membership and key changes.

### Author And Device Verification

- Outer Nostr events are signature-verified.
- Session/identity attribution is bound to authenticated session context and owner/device mappings.
- `ownerPubkey` claims are verified against AppKeys for multi-device identities.
- The latest AppKeys set is authoritative for device authorization; removing a device from AppKeys revokes it for future routing and owner-claim validation.
- Applications must not publish a reduced AppKeys set implicitly during startup/reopen. Publishing fewer devices should only happen for explicit device revocation or first-device bootstrap.
- Inner rumor `pubkey` is not trusted for sender identity decisions.
- Shared-channel group invite bootstrap requires signed inner payloads and owner/device consistency checks.

### Plausible Deniability

- Inner rumors are unsigned payloads transported inside encrypted channels.
- Recipients can verify a message came through an established secure session, but there is no strong non-repudiation proof for inner message authorship.

### Not Guaranteed

- No protection against a compromised endpoint/device.
- No global availability guarantee; delivery depends on relay reachability.
- No perfect metadata privacy (Nostr relays still see network-level and outer-event metadata).

## Multi-Device Integration Contract

New clients and tools should use the shared multi-device helpers in this repo instead of
re-implementing policy ad hoc.

- AppKeys are an ordered authorization timeline, not just a set.
- Order AppKeys snapshots by Nostr `created_at`.
- Ignore stale AppKeys snapshots.
- If two AppKeys snapshots land in the same second, merge monotonically instead of letting
  arrival order shrink the authorized device set.
- Publishing a reduced AppKeys set is only valid for explicit device revocation or first-device
  bootstrap, not normal startup/reopen.
- Imported owner-key or `nsec` login on a fresh device must either register the current device or
  remain explicitly single-device.
- First-device bootstrap can proceed from locally published AppKeys. Adding a new device to an
  existing owner timeline should wait for relay-visible AppKeys before relying on public-invite
  fanout.
- After device registration or revocation, clients should refresh bootstrap state,
  subscriptions, and session routing.
- When a new direct-message session author appears in a `session-current-*` or
  `session-next-*` subscription, clients should do an immediate short replay/backfill for that
  author instead of waiting for the next periodic sweep.
- Self-DM routing must consider owner pubkey, sender/session pubkey, rumor author pubkey, `p`
  tags, and known own-device AppKeys/session state together. Inner rumor `pubkey` alone is not
  enough.
- Invite acceptance must preserve inviter owner/device attribution. Until AppKeys verifies a
  claimed owner, clients may need to fall back to device-identity routing rather than inventing
  ownership.
- Prefer the shared helpers over local policy forks:
- TypeScript: `applyAppKeysSnapshot`, `evaluateDeviceRegistrationState`,
  `shouldRequireRelayRegistrationConfirmation`, `resolveConversationCandidatePubkeys`,
  `resolveInviteOwnerRouting`, `DirectMessageSubscriptionTracker`,
  `buildDirectMessageBackfillFilter`,
  `resolveSessionPubkeyToOwner`, `hasExistingSessionWithRecipient`
- Rust: `apply_app_keys_snapshot`, `select_latest_app_keys_from_events`,
  `evaluate_device_registration_state`, `should_require_relay_registration_confirmation`,
  `resolve_invite_owner_routing`, `resolve_conversation_candidate_pubkeys`,
  `DirectMessageSubscriptionTracker`, `build_direct_message_backfill_filter`,
  `resolve_rumor_peer_pubkey`

Runtime integrations own relay history fetch. Consumers should treat new direct-message
subscription authors as a transport catch-up signal and run a short replay/backfill with the shared
helpers above.

## Group Messaging Model

Groups use a hybrid model:

1. Group metadata and sender-key distributions are sent over authenticated 1:1 ratchet sessions.
2. Each sending device has a per-group sender-event keypair and sender-key chain.
3. A group message is published once as a one-to-many encrypted outer event.
4. Members decrypt using sender-key state learned from pairwise distributions.
5. Shared-channel events are used only for signed bootstrap invites when members do not yet have a direct 1:1 session.

## Scalability And Tradeoffs

- Per-group message publish is O(1) (single outer event), which scales better than per-member ciphertext fanout.
- Sender-key distribution and metadata updates are O(number of members/devices), so membership churn is more expensive than steady-state messaging.
- Multi-device support improves usability but increases session count, subscriptions, and state management complexity.
- Delivery is eventually consistent; implementations use persistent queues/retries but cannot force relay delivery.

## Implementations

| Language   | Directory       | Package                                                    |
| ---------- | --------------- | ---------------------------------------------------------- |
| TypeScript | [ts/](./ts)     | [npm](https://www.npmjs.com/package/nostr-double-ratchet)  |
| Rust       | [rust/](./rust) | [crates.io](https://crates.io/crates/nostr-double-ratchet) |

## Mobile FFI (optional)

For single-device pairwise iOS/Android integration, use
[`ndr-pairwise-ffi`](./rust/crates/ndr-pairwise-ffi). It exposes invite exchange, durable
pairwise sessions, disappearing messages, and explicit pending-action acknowledgement without
compiling AppKeys, linked-device, or group code. Publish and out-of-band actions expose their
session id so an app can admit the out-of-band response before publishing that session's
bootstrap event. Per-peer retirement durably removes one identity's sessions and queued actions
without resetting unrelated chats.

Use [`iris-chat-rs`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat-rs)
when the app needs AppKeys, multiple devices, sibling sync, or groups.

## Repository Layout

- `ts/`: TypeScript library
- `rust/crates/nostr-double-ratchet/`: Rust library with sessions, groups, AppKeys fact events, and event wire helpers
- `rust/crates/nostr-double-ratchet-pairwise-codec/`: strict pairwise inner-rumor codec
- `rust/crates/nostr-double-ratchet-pairwise/`: durable single-device pairwise runtime
- `rust/crates/ndr-pairwise-ffi/`: UniFFI bindings for the pairwise runtime

## Development And Tests

```bash
# Source size (all tracked Rust <= 1000 lines; TypeScript <= 500)
./scripts/check-source-size.sh

# TypeScript tests
pnpm -C ts test:once

# Local relay churn/latency benchmark
pnpm -C ts bench:relay-churn

# Rust library tests
cargo test -p nostr-double-ratchet --manifest-path rust/Cargo.toml
```

For exact integration behavior, treat the README as onboarding and the session-manager, invite,
and group tests as the behavioral source of truth.

## Multi-Device Test Policy

- Keep one explicit same-second AppKeys regression in library tests.
- Normal end-to-end and interop tests should avoid same-second AppKeys publishes unless the test
  is explicitly about that edge case.
- Keep heterogeneous-client coverage in the matrix. `iris-chat`, `iris-client`, and
  `iris-chat-rs` should not each trust only their own same-client tests.
- When possible, assert both self-sync and peer fanout across owner and linked devices.

## Formal Models

The [`formal/`](./formal) directory contains small TLA+ models for the rules that are easiest to
get subtly wrong in multi-device and invite handling.

- [`formal/session_manager_fanout`](./formal/session_manager_fanout):
  AppKeys replay ordering, monotonic same-second merges, revocation, and eventual fanout recovery.
- [`formal/invite_handshake`](./formal/invite_handshake):
  invite replay handling, unauthorized owner-claim rejection, and single-device fallback.
- [`formal/device_registration_policy`](./formal/device_registration_policy):
  the split policy for imported-device registration:
  first-device bootstrap may trust locally published AppKeys, but an additional device on an
  existing owner timeline must wait for relay-visible AppKeys before public-invite fanout trusts
  it.

The main TLA+ learning from the latest multi-device work is that there is no single global
registration rule that fits both bootstrap and additional-device flows. Always trusting local
AppKeys is too weak for additional devices; always requiring relay visibility is too strict for
bootstrap and recovery.

For language-specific usage, see:

- [ts/README.md](./ts/README.md)
- [rust/README.md](./rust/README.md)
