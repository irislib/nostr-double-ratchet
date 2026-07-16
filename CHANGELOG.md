# Changelog

## 0.0.165 - 2026-07-16

- Refresh supported TypeScript runtime and development dependencies, including
  `nostr-tools`, Vite, Vitest, ESLint, and WebSocket tooling; the frozen lock now
  has no known OSV advisories.
- Preserve the existing ratchet wire and public API while revalidating
  TypeScript-to-Rust and Rust-to-TypeScript message vectors.

## 0.0.164 - 2026-07-16

- Add trusted AppKeys snapshot import and export APIs for transferring verified device rosters between runtimes without introducing another wire format.
- Preserve roster timestamps and local device labels across transfer, persistence, restart, and direct-message subscription updates while rejecting stale snapshots.
- Emit Node-compatible `.js` specifiers in TypeScript declarations so cold ESM consumers can type-check the package with NodeNext resolution.

## 0.0.163 - 2026-07-02

- Encode invite-response inner payloads as unsigned kind `1060` rumors with valid event ids, matching the NIP-118-style wrapper while keeping the deeper session payload unchanged.
- Add Rust/TypeScript invite-response interop vectors for the hard-cut inner rumor format.

## 0.0.162 - 2026-07-01

- Encode compact linked-device requests as strict three-part codes carrying QR-safe metadata for requested device/client labels.
- Keep deterministic link invite derivation independent of label metadata across TypeScript and Rust.

## 0.0.161 - 2026-07-01

- Remove the Rust `nostr-double-ratchet-runtime` crate and old `ndr-ffi` UniFFI crate; reusable app runtime and mobile FFI now live in `iris-chat-rs`.
- Keep direct-message and invite-response subscription catch-up helpers in `nostr-double-ratchet` without depending on the removed runtime event layer.

## 0.0.147 - 2026-05-23

- Hide sender-key key ids and message counters from new one-to-many outer messages, including the standalone Rust and TypeScript helpers.
- Keep legacy no-header one-to-many messages readable while new events carry only ciphertext plus an encrypted cover header.
- Add blind sender-key decrypt support so hidden-counter group messages can still recover from out-of-order delivery.
- Allow sender-key repair requests for hidden-counter messages without re-publishing the hidden key id or message number.

## 0.0.146 - 2026-05-20

- Expose the default sender-key repair retry cadence as a deterministic helper so clients can share the same backoff without moving app scheduling state into the protocol core.
- Add a helper for deriving a sender-key repair request from a blocked sender-key message and its pending handle result.
- Bring the TypeScript group sender-key path to repair parity with Rust: 10447 repair request rumors, request/response APIs, durable sender-key repair snapshots, and removed-member authorization checks.
- Preserve TypeScript receiver sender-key state until decrypted group plaintext passes validation, so malformed or wrong-group ciphertext cannot burn the next valid message key.
- Add TypeScript/Rust sender-key repair request vectors to lock down the cross-language 10447 wire format.
- Add a larger TLA+ sender-key repair safety config that checks repair after the sender chain has advanced.

## 0.0.145 - 2026-05-20

- Add sender-key repair requests so receivers can ask a sender to resend the key material and, when needed, the current group metadata for a blocked group message.
- Record sender-key repair snapshots with recipient authorization windows, preventing removed members and pre-join late members from receiving keys they were not meant to have.
- Encode sender-key repair requests as authenticated kind 10447 rumors with group, sender, key, message, and optional revision tags.
- Expand the formal group sender-key and direct-message subscription models for repair and liveness cases.

## 0.0.144 - 2026-05-19

- Add optional `picture` and `about` fields to `GroupSnapshot` so the group avatar URL and free-text description travel in the same revisioned metadata snapshot as name/membership, rather than over a separate side channel that out-of-sync members can miss.
- Add `GroupManager::update_picture` / `GroupManager::update_about` admin APIs mirroring `update_name`.
- Wire-compatible: missing fields decode as `None`, and outbound snapshots omit them when unset, so older 0.0.x peers keep round-tripping snapshots unchanged.

## 0.0.143 - 2026-05-19

- Sync remote-created group metadata to local sibling devices for AppCore-owned protocol engines.
- Heal duplicate sender-key snapshot records left by older local-sibling sender-key forwarding behavior.

## 0.0.142 - 2026-05-08

- Verify unsigned inner event ids before pairwise codec decode, runtime queue storage, and old group unsigned-event wrapper decode.
- Reject outbound `NdrRuntime::send_event` rumors whose inner author does not match the runtime owner.

## 0.0.141 - 2026-05-07

- Include sender-key group messages in local-sibling prepared sends so linked devices receive AppCore group messages from sibling devices.

## 0.0.140 - 2026-05-07

- Expose session-manager support APIs for AppCore-owned protocol engines, including targeted remote and local-sibling sends.
- Preserve claimed owner metadata on processed invite responses so host apps can reconcile device sessions without `NdrRuntime` ownership.

## 0.0.139 - 2026-05-06

- Add canonical nearby envelope helpers for atomic `inv`/`want` messages without top-level peer routing fields.
- Include optional author metadata on nearby inventory announcements so mobile peers can decide whether to request a payload before fetching it.

## 0.0.138 - 2026-05-04

- Switch group metadata to a snapshot-only model and slim `group_manager` accordingly.
- Restore the legacy sender-key group wire format so older peers and snapshot consumers stay interoperable.
- Make sibling workspace dev-deps path-only and refresh the crates.io publish script.

## 0.0.137 - 2026-05-04

- Merge htree/master with the latest private invite, linked-device fanout, and runtime durability work into the published Rust crates.

## 0.0.136 - 2026-05-02

- Let apps create additional local private invites without publishing them as relay-discoverable invite events.
- Preserve private invite URL metadata and enforce one-use invite links after a successful response.
- Accept owner claims carried by private capability invites/responses so multi-device private links install sessions under owner keys immediately.

## 0.0.135 - 2026-05-02

- Align the TLA+ models with the current runtime subscription, group sender-key, and session send-selection behavior.
- Include skipped-key sender authors in message-push subscription filters and match TypeScript/Rust active session send preference.
- Add a local triad relay churn/latency benchmark for direct and group `NdrRuntime` traffic.

## 0.0.134 - 2026-05-02

- Move chat inner-event construction into neutral Rust/TypeScript message builder helpers.
- Keep `Session` focused on ratchet encryption/decryption of unsigned inner events; update tests, FFI, and docs to build text/reaction/typing/receipt rumors outside `Session`.
- Route `SessionManager` message creation through the shared builders while preserving direct-message, expiration, reaction, receipt, and typing behavior.

## 0.0.133 - 2026-05-02

- Include stored device-record identities in the Rust known-device roster helper, matching the TypeScript runtime surface when AppKeys are not cached.
- Add Rust coverage for loaded device records without AppKeys still contributing to protocol backfill/device roster inspection.

## 0.0.132 - 2026-05-02

- Expose known device identity rosters through `SessionManager` and `NdrRuntime` in Rust and TypeScript.
- Add Rust runtime coverage for a fresh same-owner device sending to an existing peer chat while the old same-owner device receives the sender copy as a self message.
- Assert the same roster helper in the TypeScript fresh same-nsec runtime regression.

## 0.0.131 - 2026-05-02

- Add runtime coverage for a fresh same-owner client with existing AppKeys sending into an existing peer chat and syncing the sender copy to the old device.
- Move TypeScript user-record storage, hydration, ordered writes, deletion, and legacy migrations out of `SessionManager`.

## 0.0.130 - 2026-05-02

- Remove the product-specific `IrisRuntime` alias from the neutral `nostr-double-ratchet` API and docs.
- Continue splitting TypeScript `SessionManager` internals into smaller policy and helper modules.

## 0.0.129 - 2026-05-02

- Split Rust `SessionManager` internals into focused policy, queue, invite bootstrap, and session-selection modules.
- Split TypeScript expiration policy and device session selection into reusable helpers with focused regression coverage.
- Rename nearby LAN service labels from `ndr` to `iris`.

## 0.0.128 - 2026-05-02

- Mark the `ndr` CLI crate as deprecated. Use the `iris` CLI from the
  `iris-chat` crate instead.
- Align TypeScript direct sends and queued flushes around the same best-session
  device path, so an inactive send-capable ratchet can recover when the active
  session is receive-only.

## 0.0.127 - 2026-04-30

- Apply a verified owner's full AppKeys roster immediately when accepting invite-link and public-invite devices, including sibling public invite discovery.
- Preserve the owner-device session when AppKeys lists delegate devices only, so replies keep using the established peer session.
- Carry inner-message and target-device publish metadata through Rust, FFI, and `ndr send` so CLI interop returns the encrypted event for the intended device.

## 0.0.126 - 2026-04-30

- Route `ndr-ffi` session operations through `NdrRuntime` wrapper APIs so FFI consumers do not depend on direct `SessionManager` access.

## 0.0.125 - 2026-04-30

- Add `NdrRuntime::protocol_backfill_filters(...)` so host apps fetch NDR protocol catch-up through the runtime boundary instead of rebuilding AppKeys, device-invite, invite-response, and message-author filters themselves.
- Include current-device invite-response backfill in the runtime-owned filter set so linked devices can recover sibling sessions after offline periods.

## 0.0.124 - 2026-04-29

- Fix linked-device direct-message fanout by preferring the active bidirectional ratchet session over stale inactive receive snapshots while still falling back to send-capable inactive sessions when needed.
- Backfill recent pairwise session events before one-shot `ndr send` delivery so the CLI can catch up with relay-visible device/session state.
- Align TypeScript header decryption with Rust for same-chain events authored by the peer's advertised next ratchet key.

## 0.0.123 - 2026-04-29

- Publish the Rust crates with linked-secondary group delivery fixed for `ndr listen`.
- Publish the runtime device invite after link acceptance so peer devices can establish sessions to linked devices without re-enabling public invite discovery.

## 0.0.122 - 2026-04-29

- Publish the Rust crates with `ndr` command handling routed through `NdrRuntime`.
- Add runtime support APIs for CLI session, invite, group, listen, and send workflows without direct `SessionManager` access.
- Harden public invite publication, preserve required AppKeys devices in snapshots, and reduce CLI relay send latency.

## 0.0.121 - 2026-04-28

- Decrypt encrypted AppKeys device labels when owner-key runtimes backfill or subscribe to their own AppKeys events, preserving human device labels after relay refreshes.

## 0.0.120 - 2026-04-28

- Pass group inner event ids through `NdrRuntime` publish callbacks so apps can correlate one-to-many group publishes with local group message records.

## 0.0.119 - 2026-04-28

- Pass the inner rumor event id through `NdrRuntime` publish callbacks so apps can correlate encrypted outer publishes with local message records.

## 0.0.118 - 2026-04-28

- Reject direct-message wrapper events whose outer author is not the expected ratchet author for the session, preventing same-invite linked-device bootstraps from corrupting sibling sessions.
- Keep accepting peer invites until an active device session can actually receive, improving same-owner fanout when multiple runtimes register concurrently.
- Add runtime coverage for same-owner fanout across three registered runtimes.

## 0.0.117 - 2026-04-28

- Feed the runtime's current local owner AppKeys snapshot into the session core before owner setup, so same-owner multi-device sends can fan out to newly registered sibling devices even if the session AppKeys subscription missed an update.

## 0.0.116 - 2026-04-28

- Feed AppKeys events observed by `NdrRuntime` into the session core as well as runtime device state, keeping owner-device session discovery aligned with runtime AppKeys subscriptions.
- Feed locally published AppKeys registrations/revocations back into the session core before updating runtime state, reducing same-owner multi-device fanout races.

## 0.0.115 - 2026-04-28

- Preserve freshly accepted own-device sessions across delayed AppKeys snapshots that do not yet list the linked device, preventing duplicate linked-device ratchets.
- Extend linked-device fanout coverage for stale AppKeys arriving between link acceptance and device registration.

## 0.0.114 - 2026-04-28

- Deduplicate concurrent link-invite accepts so the TypeScript runtime cannot create parallel ratchet sessions for the same linked device.
- Add linked-device fanout coverage for duplicate link-accept races.

## 0.0.113 - 2026-04-28

- Subscribe newly added runtime direct-message authors immediately while keeping stale-author removal throttled, reducing missed live delivery during rapid ratchet author changes.
- Install accepted invite sessions before emitting the invite response publish, preventing duplicate invite acceptance from racing the local session state and diverging linked-device ratchets.
- Reuse existing device-invite sessions when replayed device invite events arrive after a session has already been accepted.
- Preserve newly accepted own-device sessions when an older AppKeys event lacking that device arrives before the confirming multi-device AppKeys event.
- Add runtime coverage for immediate author additions during the direct-message subscription throttle window.

## 0.0.112 - 2026-04-28

- Preserve queued runtime sends when provisional single-device setup is replaced by real AppKeys, so messages sent before peer discovery completes flush to the newly authorized devices.
- Add runtime coverage for async peer discovery plus linked-device fanout.

## 0.0.111 - 2026-04-28

- Flush queued device targets after `SessionManager.sendEvent(...)` so messages queued during session setup are delivered as soon as the just-created session becomes usable.

## 0.0.110 - 2026-04-28

- Wait for relay-visible AppKeys when registering a linked device identity, matching current-device registration behavior and avoiding sends before linked-device fanout is established.

## 0.0.109 - 2026-04-28

- Emit decrypted TypeScript session messages through the same runtime event queue as publish/subscribe work, matching the Rust feed/drain model more closely.
- Keep `NdrRuntime.onSessionEvent` as the app-facing callback while routing it from drained runtime events instead of attaching directly to `SessionManager`.
- Add linked-device runtime coverage for owner messages delivered to a linked runtime after link invite registration.

## 0.0.108 - 2026-04-28

- Move TypeScript `NdrRuntime` to the Rust-style feed/emit split for session-manager relay work.
- Add runtime construction for `SessionManager` so AppKeys, invite, invite-response, and publish events are emitted by the session core and executed by `NdrRuntime`.

## 0.0.107 - 2026-04-28

- Expose session user records and message push author lookup through `NdrRuntime` so apps can treat the runtime as the production boundary.

## 0.0.106 - 2026-04-28

- Preserve relay AppKeys event timestamps when refreshing runtime device state, preventing linked devices from treating fresh registrations as stale.
- Forward the outer wrapper event through the SessionManager user-record bridge so `outerEventId` metadata is populated.

## 0.0.105 - 2026-04-28

- Add a notification-preview helper for decrypting candidate session events without mutating durable ratchet state.
- Include the outer wrapper event id in session event metadata so apps can cache notification previews by outer event id.

## 0.0.104 - 2026-04-28

- Publish a clean release after yanking/deprecating 0.0.103.
- Keep encrypted kind 1060 wrappers free of outer recipient routing tags.

## 0.0.102 - 2026-04-27

- Pin the Rust crates to `nostr` 0.44.2 and `nostr-sdk` 0.44.1.
- Speed up `e2e_group_listen` by bounding concurrent real relay/listener scenarios instead of blocking Tokio worker threads with a synchronous global test lock.

## 0.0.101 - 2026-04-27

- Update the Rust crates to `nostr` 0.44 and `nostr-sdk` 0.44.
- Adapt CLI relay fetch, subscribe, and publish paths to the current single-filter and borrowed-event APIs.
- Preserve shared-channel self `p` tags under the newer Nostr event builder behavior.
- Refresh Rust, FFI, CLI, and interop tests for the new SDK APIs.

## 0.0.100 - 2026-04-26

- Align the Rust workspace/crate versions with the TypeScript package release.
- Update TypeScript e2e harnesses to use the current `receiveEvent(...)` and
  `Invite.accept(...)` APIs.
- Mirror the runtime-owned direct-message subscription architecture in the TypeScript package.
- Add fed-event `Session.receiveEvent(...)` and `SessionManager.processReceivedEvent(...)` paths for external relay dispatch.
- Have `NdrRuntime` subscribe to current direct-message authors and resubscribe when ratchet/session state changes.
- Add TypeScript runtime coverage for direct messages delivered through `NdrRuntime`.

## 0.0.99 - 2026-04-26

- Move direct-message subscription ownership from `Session`/`SessionManager` into `NdrRuntime`.
- Keep `Session` focused on ratchet state and encryption/decryption; callers now feed received events through runtime/manager APIs.
- Speed up `ndr listen` startup by removing the redundant filesystem watcher path and flushing runtime subscriptions immediately.
- Fix shared-channel group invite acceptance so accepted sessions are imported into `SessionManager` before follow-up messages.
- Tighten group-listener e2e coverage so a single group send must reach every other participant.

## 0.0.98 - 2026-04-26

- Preserve original inner rumor IDs when queued session-manager publishes flush later.
- Surface queued publish metadata through Rust and FFI event streams so apps can attach relay ACKs to the original queued chat message.
- Add regression coverage for queued publish metadata preservation across setup and retry flows.
