# nostr-double-ratchet-pairwise

Durable single-device pairwise messaging for apps that need forward-secure asynchronous direct
messages without AppKeys, linked-device synchronization, or groups.

`PairwiseManager` owns invite bootstrap, ratchet sessions, separate inner/outer replay tracking,
skipped message keys, expiring-message filtering, encrypted persistence, and pending actions.
Every state transition and its actions are committed atomically. Hosts read `pending_actions()`,
perform each transport or delivery action, then call `ack_actions()`; unacknowledged work survives
restart.

Relay publication actions contain only kind `1060` events. Invite kind `30078` events and kind
`1059` responses are returned as structurally separate out-of-band actions for the host's chosen
pairing channel.

For iOS and Android, use the sibling `ndr-pairwise-ffi` crate. Use
[`iris-chat-rs`](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-chat-rs)
instead when an app needs AppKeys, multiple devices, sibling sync, or groups.
