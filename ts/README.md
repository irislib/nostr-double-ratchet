# nostr-double-ratchet (TypeScript)

TypeScript implementation of end-to-end encrypted Nostr messaging using Double Ratchet, multi-device owner/device identity mapping, and sender-key-based group messaging.

## Installation

```bash
pnpm add nostr-double-ratchet
```

## Core Components

- `Session`: low-level 1:1 ratchet session
- `Invite`: handshake/bootstrap primitive
- `SessionManager`: multi-device session orchestration and routing
- `SessionGroupRuntime`: group transport bound to an existing `SessionManager`
- `DelegateManager` / `AppKeysManager`: device lifecycle and owner authorization
- `NdrRuntime`: high-level runtime that owns AppKeys, delegate/session state, and group transport
- `Group`: sender-key group messaging helper (transport-agnostic)
- `SharedChannel`: encrypted shared-channel primitive used by higher-level group bootstrap flows

## Integration Modes

| Mode | Use it when | What it owns |
| --- | --- | --- |
| `NdrRuntime` | You want the default production path for direct messages, linked devices, and groups. | `AppKeysManager`, `DelegateManager`, `SessionManager`, and `GroupManager`. |
| `SessionManager` | You want multi-device routing, but your app still wants to own more of the runtime wiring. | Session orchestration, routing, storage-backed session state, and emitted pubsub/decrypted-message events. |
| `Session` | You want the smallest 1:1 primitive and already own invite/bootstrap, persistence, and relay transport. Good for negotiated 1:1 channels or app-specific direct links. | Only the ratchet session state itself. |

Supporting pieces around those modes:

- `SessionGroupRuntime`: add the same group transport surface that `NdrRuntime` uses to an
  existing `SessionManager`.
- `Invite`: bootstrap primitive when you build around plain `Session`.

If you are unsure, start with `NdrRuntime`. Drop down to `SessionManager` only when you want to
keep more app-owned runtime structure, and use plain `Session` only when a small 1:1-only surface
is actually the goal.

## Minimal Integration Contract

Reference web integrations:
[`iris-client`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-client),
[`iris-chat`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat).

They use one `NdrRuntime` singleton over app-owned transport and persistent storage.

```typescript
type NostrSubscribe = (
  filter: Filter,
  onEvent: (event: VerifiedEvent) => void,
) => () => void;

type NostrFetch = (filter: Filter) => Promise<VerifiedEvent[]>;

type NostrPublish = (
  event: UnsignedEvent | VerifiedEvent,
) => Promise<VerifiedEvent>;

interface StorageAdapter {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

If you can provide those four pieces, start with `NdrRuntime`.

## Quick Start (`NdrRuntime`)

```typescript
import { NdrRuntime } from "nostr-double-ratchet";

const runtime = new NdrRuntime({
  nostrSubscribe,
  nostrPublish,
  nostrFetch,
  storage,
});

await runtime.initForOwner(ownerPublicKey);
await runtime.ensureCurrentDeviceRegistered(ownerPublicKey);

runtime.onSessionEvent((event, from) => {
  console.log(`${from}: ${event.content}`);
});
runtime.onGroupEvent((event) => {
  console.log(`group ${event.groupId}: ${event.inner.content}`);
});

const groupManager = await runtime.waitForGroupManager(ownerPublicKey);
await runtime.sendMessage(recipientPubkey, "Hello!");

const created = await runtime.createGroup("Friends", [recipientPubkey], {
  fanoutMetadata: false,
});
await runtime.sendGroupMessage(created.group.id, "Hello group!");
console.log(groupManager.managedGroupIds());
```

`NdrRuntime` does not own your relay client. It still relies on your `nostrSubscribe`,
`nostrFetch`, and `nostrPublish` functions.


Signed publication waits for local signing and `nostrEnqueue`, then starts `nostrPublish`
in the background. Relay acknowledgments never delay signed sends, setup, invite rotation,
or incoming events. Configure the optional hooks for a durable web integration:

```typescript
const runtime = new NdrRuntime({
  nostrSubscribe,
  nostrFetch,
  storage,
  nostrSign: signOwnerEvent,
  nostrEnqueue: (event, innerEventId) => outbox.persist(event, innerEventId),
  nostrPublish: (event, innerEventId) => outbox.publish(event, innerEventId),
  onPublishError: ({ error }) => reportDeliveryFailure(error),
});
```

`nostrSign` returns the signed owner event. `nostrEnqueue` must resolve only after saving
that exact signed envelope durably; it must not wait for a relay. The host retries stored
envelopes after restart or connectivity changes and deletes them only after delivery is
acknowledged. A failed enqueue rejects the local handoff and retains queued direct messages;
a transport rejection is observed by `onPublishError`, whose exceptions are isolated.
Without an enqueue hook, transport failures have no library-owned durable retry guarantee.

For compatibility, an **unsigned** event without `nostrSign` still awaits the legacy
`nostrPublish` result because that callback also supplies its signature. Supply a separate
signer (or `ownerIdentityKey`) to remove this remaining combined signing/transport wait.
The same hooks are available on standalone AppKeys/delegate/group options; legacy
`SessionManager` accepts them as the final optional constructor argument.
`createNostrPublisher` exposes the same boundary for custom integrations.

Adding a device still performs bounded discovery of the relay-visible AppKeys roster.
That authorization/roster check is separate from publication acknowledgment and prevents
an unconfirmed local roster from being treated as established multi-device state.
Runtime event consumers must return a Promise from `onEventsAvailable` for durable local
handoffs; void observers keep their existing notification-only behavior.

`initForOwner(...)` initializes the runtime for a specific owner/device identity. For owner-key
logins that should participate in multi-device fanout, call
`ensureCurrentDeviceRegistered(...)` or `registerCurrentDevice(...)` before treating private
messaging as fully ready.

`setupUser(peerPubkey)` is optional prewarm, not a hard prerequisite. Web consumers call it before
opening a chat when they want subscriptions and bootstrap to start early, but `sendEvent(...)`
already calls it internally and `sendMessage(...)` queues delivery if sessions are not ready yet.

For groups, initialize the runtime/session path before `createGroup(...)` or `sendGroupEvent(...)`.
If you want metadata fanout immediately instead of waiting for queue flush, prewarm peers with
`setupUser(...)`.

### Runtime Group API

If you want the high-level path, keep groups on `NdrRuntime` instead of building a parallel
group transport layer:

- `setupUser(...)`
- `sendEvent(...)`, `sendMessage(...)`
- `sendReceipt(...)`, `sendTyping(...)`
- `sendChatSettings(...)`, `setChatSettingsForPeer(...)`
- `getGroupManager()` / `waitForGroupManager(ownerPubkey?)`
- `onGroupEvent(...)`
- `upsertGroup(...)`, `removeGroup(...)`, `syncGroups(...)`
- `createGroup(...)`
- `sendGroupEvent(...)`, `sendGroupMessage(...)`

`GroupManager` is still available directly when you want to own more of the app wiring yourself.

Plain `Session` only encrypts/decrypts unsigned inner events. Use `messageBuilders` to create text,
reaction, receipt, typing, reply, and expiring inner rumors before calling `session.sendEvent(...)`.

## Reference Web Pattern

Reference web integrations do this:

1. Create one long-lived `NdrRuntime` per active identity with persistent storage.
2. Wrap `nostrSubscribe` with `RuntimeSubscriptionTracker` +
   `buildRuntimeBackfillFilters(...)` so newly added AppKeys authors, invite-response recipients,
   and direct-message authors trigger bounded relay backfill immediately.
3. Call `initForOwner(ownerPubkey)`, then `ensureCurrentDeviceRegistered(ownerPubkey)` or
   `registerCurrentDevice(...)` when owner-key logins should participate in multi-device fanout.
4. Attach `onSessionEvent(...)` / `onGroupEvent(...)` once for app lifetime.
5. Optionally call `setupUser(peerPubkey)` before opening a chat or creating a group to prewarm
   subscriptions and bootstrap.

## Mid-Level Setup (`SessionGroupRuntime`)

If your app already owns `SessionManager`, `SessionGroupRuntime` gives you the same group-focused
API shape that `NdrRuntime` uses internally:

```typescript
import { SessionGroupRuntime } from "nostr-double-ratchet";

const groups = new SessionGroupRuntime({
  sessionManager,
  ourOwnerPubkey: ownerPublicKey,
  ourDevicePubkey: currentDevicePublicKey,
  nostrSubscribe,
  nostrPublish,
  nostrFetch,
});

const created = await groups.createGroup("Friends", [recipientPubkey], {
  fanoutMetadata: false,
});
await groups.sendGroupMessage(created.group.id, "Hello group!");

groups.onGroupEvent((event) => {
  console.log(event.groupId, event.inner.content);
});
```

## Low-Level Setup (`SessionManager`)

If you want multi-device sessions without the runtime wrapper, the lower-level flow remains:

```typescript
import { AppKeysManager, DelegateManager } from "nostr-double-ratchet";

const delegate = new DelegateManager({ nostrSubscribe, nostrPublish, storage });
await delegate.init();

const appKeysManager = new AppKeysManager({ nostrPublish, storage });
await appKeysManager.init();
appKeysManager.addDevice(delegate.getRegistrationPayload());
await appKeysManager.publish();

await delegate.activate(ownerPublicKey);
const sessionManager = delegate.createSessionManager();
await sessionManager.init();
```

## Multi-Device Integration Contract

Use the exported helper functions for multi-device policy instead of duplicating the logic in app
code.

- `applyAppKeysSnapshot(...)`: order AppKeys by `created_at`, ignore stale snapshots, and merge
  same-second snapshots monotonically.
- `evaluateDeviceRegistrationState(...)`: decide whether the current device is registered and
  whether the app should consider private messaging ready.
- `shouldRequireRelayRegistrationConfirmation(...)`: distinguish first-device bootstrap from
  “add a new device to an existing owner timeline” before blocking on relay visibility.
- `resolveConversationCandidatePubkeys(...)`: derive the correct conversation owner/device
  candidates for self-sync and linked-device routing.
- `resolveInviteOwnerRouting(...)`: preserve inviter owner/device attribution during invite
  acceptance, including the link-bootstrap exception and device-identity fallback.
- `RuntimeSubscriptionTracker` + `buildRuntimeBackfillFilters(...)`: detect newly added AppKeys
  authors, invite-response recipients, and direct-message session authors and issue bounded
  replay/backfill right away.
- `resolveSessionPubkeyToOwner(...)` and `hasExistingSessionWithRecipient(...)`: normalize
  owner/device session bookkeeping instead of re-implementing user-record traversal.

Normal app behavior should treat AppKeys as an ordered authorization timeline. Reduced AppKeys
sets should only be published for explicit revocation or first-device bootstrap, not on ordinary
startup. Imported owner-key or `nsec` logins on a fresh device should either register the current
device or remain explicitly single-device. First-device bootstrap can proceed from locally
published AppKeys; public-invite fanout for an additional device should wait until relays echo the
updated AppKeys timeline.

## Tested References

Treat the README as onboarding and the tests as behavioral source of truth for exact call order
and edge cases.

- `tests/NdrRuntime.test.ts`: canonical runtime init, registration, direct-message, and group flow
- `tests/SessionGroupRuntime.test.ts`: group transport attached to an existing `SessionManager`
- `tests/SessionManager.acceptInvite.test.ts`: invite acceptance and owner/device routing rules
- `tests/directMessageSubscriptions.test.ts`: direct-message subscription/backfill helpers

## Runtime Catch-Up

The runtime/session manager decides which AppKeys authors, invite-response recipients, and message
authors should be live-subscribed. Wrap your `nostrSubscribe` implementation so newly discovered
targets trigger bounded relay backfill immediately:

```typescript
import {
  buildRuntimeBackfillFilters,
  RuntimeSubscriptionTracker,
} from "nostr-double-ratchet";

const tracker = new RuntimeSubscriptionTracker();

const trackedSubscribe = (filter, onEvent) => {
  const registered = tracker.registerFilter(filter);
  for (const backfill of buildRuntimeBackfillFilters(registered, 200)) {
    // Hand `backfill` to your relay fetch / short-lived subscription path.
  }

  const unsubscribe = nostrSubscribe(filter, onEvent);
  return () => {
    tracker.unregister(registered.token);
    unsubscribe();
  };
};
```

## Security Properties

### Confidentiality

- 1:1 payloads are encrypted with Double Ratchet over NIP-44.
- Group payloads are encrypted with per-sender sender-key chains.

### Forward Secrecy And Post-Compromise Recovery

- 1:1 sessions get forward secrecy from ratcheting key evolution.
- Future secrecy recovers after new ratchet steps if a transient compromise ends.

### Author And Device Verification

- Outer events are signature-verified.
- Sender owner/device attribution comes from authenticated session context and AppKeys mappings.
- Multi-device owner claims are verified against AppKeys (not accepted blindly).
- The latest AppKeys set is authoritative for device authorization; removing a device from AppKeys revokes it for future routing and owner-claim validation.
- Applications must not publish a reduced AppKeys set implicitly during startup/reopen. Publishing fewer devices should only happen for explicit device revocation or first-device bootstrap.
- Inner rumor `pubkey` should be treated as untrusted for identity decisions.

### Plausible Deniability

- Inner rumors are unsigned payloads carried in encrypted channels.
- You get channel authenticity, but not strong transferable non-repudiation of inner content.

## Groups

`Group` is transport-agnostic and implements efficient sender-key messaging:

- Membership is defined in owner pubkeys.
- Sender-key distributions are delivered pairwise over authenticated 1:1 sessions.
- Group messages are published once as one-to-many outer events (per sender device key).
- Receiver attribution for group payloads is derived from authenticated distribution/session context, not inner rumor `pubkey`.
- `createGroupData(...)` is a pure local constructor. `GroupManager.createGroup(...)` is the app-level helper that creates local group state and, by default, fans out metadata (kind 40) to members.
- `NdrRuntime` now exposes the same high-level group path as Rust/FFI: `createGroup(...)`,
  `sendGroupEvent(...)`, `sendGroupMessage(...)`, `syncGroups(...)`, and `onGroupEvent(...)`.

## Disappearing Messages (Expiration)

Include NIP-40-style `["expiration", "<unix seconds>"]` on the inner rumor, or use helpers:

```typescript
await sessionManager.sendMessage(recipientPubkey, "expires soon", {
  ttlSeconds: 60,
});
await sessionManager.setDefaultExpiration({ ttlSeconds: 60 });
await sessionManager.setExpirationForPeer(recipientPubkey, { ttlSeconds: 120 });
await sessionManager.setExpirationForGroup(groupId, { ttlSeconds: 30 });
await sessionManager.setExpirationForPeer(recipientPubkey, null);
await sessionManager.sendMessage(recipientPubkey, "persist", {
  expiration: null,
});
```

The library does not purge local storage for you. Clients should enforce retention/UI behavior.

## 1:1 Chat Settings Signaling

Encrypted settings rumor kind:

- `CHAT_SETTINGS_KIND = 10448`
- Content: `{ "type": "chat-settings", "v": 1, "messageTtlSeconds": <seconds|null> }`
- Settings events themselves do not expire

```ts
await sessionManager.setChatSettingsForPeer(recipientPubkey, 60);
await sessionManager.setChatSettingsForPeer(recipientPubkey, 0);
sessionManager.setAutoAdoptChatSettings(false);
```

## Event Kinds

| Kind  | Constant                                    | Purpose                                      |
| ----- | ------------------------------------------- | -------------------------------------------- |
| 1060  | `MESSAGE_EVENT_KIND`                        | Encrypted outer event                        |
| 30078 | `INVITE_EVENT_KIND` / `APP_KEYS_EVENT_KIND` | Device invite and AppKeys records            |
| 1059  | `INVITE_RESPONSE_KIND`                      | Encrypted invite response                    |
| 14    | `CHAT_MESSAGE_KIND`                         | Inner chat message rumor                     |
| 10448 | `CHAT_SETTINGS_KIND`                        | Inner chat-settings rumor                    |
| 40    | `GROUP_METADATA_KIND`                       | Group metadata rumor                         |
| 10445 | `GROUP_INVITE_RUMOR_KIND`                   | Group bootstrap invite rumor                 |
| 10446 | `GROUP_SENDER_KEY_DISTRIBUTION_KIND`        | Group sender-key distribution rumor          |
| 10447 | `GROUP_SENDER_KEY_REPAIR_REQUEST_KIND`      | Group sender-key repair request rumor        |
| 4     | `SHARED_CHANNEL_KIND`                       | Shared-channel transport event kind          |

## Scalability And Tradeoffs

- Group steady-state publish is O(1) per message (single outer event).
- Sender-key distribution and metadata fanout are O(members/devices), so membership changes are the expensive path.
- Multi-device support improves UX but increases session/subscription/state complexity.
- Relay-level metadata (timing, pubkeys, traffic patterns) remains visible.

## Development

```bash
pnpm -C ts test:once
pnpm -C ts bench:relay-churn
```

## Multi-Device Test Policy

- Keep exactly one explicit same-second AppKeys regression test in the library.
- Ordinary end-to-end tests should wait for a new `created_at` second before publishing AppKeys
  mutations so the normal path stays visible and trustworthy.
- Keep heterogeneous-client interop coverage because same-client tests are not enough.
