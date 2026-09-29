# NDR and Marmot / MLS

Assessment date: 2026-09-29. NDR source reviewed at `7242103`; Marmot specification
reviewed at [`26fa6a6`](https://github.com/marmot-protocol/marmot/tree/26fa6a6972d7b4325cb3d105ffdd41a1ceda2bb0).

This compares protocol architecture and documented behavior. It is not a security
audit or a delivery/performance benchmark. Application features, local database
protection, and platform support require separate evaluation.

Nostr Double Ratchet (NDR) uses pairwise Double Ratchet sessions and, for groups,
per-sender keys distributed through those sessions. Marmot combines Nostr identity
with MLS group key agreement and specifies the surrounding authorization,
transport, and convergence rules. White Noise is an application using Marmot.
Marmot's additional rules should be distinguished from the underlying MLS standard.
See [NDR's group model](./README.md#group-messaging-model) and
[Marmot's MLS profile][marmot-mls].

## Architecture

| Dimension | NDR | Marmot / MLS |
| --- | --- | --- |
| Direct messages | Pairwise sessions with separate sending and receiving chains. | MLS group machinery also supports two participants. |
| Group messages | Each sending device has its own sender-key chain; recipients receive key material through pairwise sessions. | Members derive per-sender message keys from a shared group epoch. |
| Key-state changes | Sender-key rotations can proceed independently across senders. | Commits advance shared group state; competing commits require resolution. |
| Membership | Authenticated roster updates and sender-key distribution are coordinated around the message chains. | Membership changes are committed as part of the cryptographic group-state transition. |
| Decentralized delivery | Requires delivery and repair of sessions, roster updates, and key distributions. | Requires delivery of MLS dependencies and convergence on a canonical commit branch. |

Sources: [NDR group model](./README.md#group-messaging-model),
[MLS group evolution][mls-evolution], and [Marmot convergence][marmot-convergence].

## Does NDR require less consensus?

NDR has less shared encryption state to coordinate: there is no group-wide
encryption epoch that every sender-key rotation must advance. This is narrower
than saying that NDR needs no agreement or that MLS needs network-wide consensus.

For example, Alice and Bob can rotate their NDR sender keys independently.
Recipients need the corresponding distributions, but neither rotation competes
to define one next group epoch. If Alice and Bob instead create MLS commits from
the same epoch, clients need a rule for choosing the canonical successor and
handling the other proposed change. [RFC 9420 section 14][mls-sequencing] requires
applications to resolve these conflicts; it does not require a central sequencer.

Marmot supplies decentralized branch-selection and recovery rules for unordered
input. Its specified convergence depends on compatible policies, sufficient
retained state, and eventual acquisition of the relevant finite input set within
retention limits. A locally settled branch is not proof of global finality.
These are explicit conditions of the [Marmot convergence specification][marmot-convergence].

Both designs accommodate asynchronous participation. Both can process reordered
application messages subject to available state and retention/skip limits;
ordering every chat message is not the distinguishing requirement. See
[Double Ratchet section 2.6][double-ratchet] and [MLS section 15.3][mls-reordering].

The architectural implication is that independent NDR sender chains can avoid
some group-wide coordination dependencies. Marmot couples membership and key
changes into one authenticated state history. Neither observation establishes
which implementation delivers more reliably under relay failures or partitions.

## Membership and removal

NDR still needs agreement about authorized members and devices. Its
[roster handling](./rust/crates/nostr-double-ratchet/src/roster.rs) and
[device-authorization rules](./README.md#multi-device-integration-contract) are
part of that coordination. Independent sender chains do not settle conflicting
membership decisions.

After a removal, each sender must learn the authenticated change and replace any
sender key available to the removed member before sending protected future
messages. The reviewed [TypeScript send path](./ts/src/group/GroupSending.ts)
checks the current recipient set against previous distributions; the
[Rust sender-key path](./rust/crates/nostr-double-ratchet/src/group_manager/sender_keys.rs)
checks for removed recipients. These checks act on locally known membership.

In MLS, processing a removal commit changes both membership and epoch secrets.
Clients on the resulting branch encrypt subsequent messages using that state.
A sender that has not learned a removal can still use older state in either
design. Neither protocol makes revocation instantaneous across a network partition.
See [MLS application-message restrictions][mls-restrictions].

## Recovery and secret retention

For NDR direct messages, fresh Diffie-Hellman ratchet exchanges can restore future
secrecy after a temporary compromise, provided the attacker no longer controls
the endpoints and the required exchanges occur. A group sender's symmetric chain
does not provide that recovery by itself: it needs fresh sender-key material
distributed over secure sessions. The distinction follows from the
[Double Ratchet design][double-ratchet].

MLS provides group forward secrecy and post-compromise security through its key
schedule and appropriate member updates. Recovery depends on the affected keys,
fresh secret contributions, and processing the resulting group state; sending
ordinary application messages alone is insufficient. See the
[MLS security architecture][mls-architecture].

Retaining secrets for delayed delivery changes the protection of past messages in
both systems:

- NDR retains historical sender-chain material for authorized repair. This can
  recover missed key distributions, but later compromise of retained seeds can
  expose messages derived from them. See the
  [TypeScript repair storage](./ts/src/group/GroupSenderKeys.ts) and
  [documented retention tradeoff](./README.md#forward-secrecy-and-recovery).
- Marmot retains state for branch recovery and delayed application messages within
  bounded windows. Its reviewed policy allows five commits of rewind and
  application payloads up to five epochs behind the relevant tip. Older payloads
  can become undecryptable even if relays still store them. These are Marmot policy
  choices, not universal MLS limits. See [retained history][marmot-history] and
  [convergence policy][marmot-convergence].

## Scaling and evaluation

NDR publishes one ciphertext per steady-state group message, then relies on
transport fanout. Distributing a sender key requires pairwise deliveries to the
intended members/devices; rotating every active sender's key multiplies that work.
See [NDR's scaling model](./README.md#scalability-and-tradeoffs).

MLS also supports shared group ciphertexts. Tree-based key updates can reduce
rekeying work compared with distributing every sender's fresh key separately.
Costs depend on group size, tree state, operation, and implementation; they are
not uniformly logarithmic. In particular, Marmot requires the full ratchet tree
in each Welcome. See the [MLS architecture][mls-architecture] and
[Marmot joining rules][marmot-joining].

A comparative evaluation should hold group size, device count, membership churn,
relay behavior, and retention goals constant. Useful measurements include
delivery latency and failure rate under loss/reordering, removal propagation,
offline recovery, bandwidth, storage, and recovery after restart or state loss.
This assessment contains no such comparative measurements and assigns no overall
winner. The relevant tradeoff is independent session/sender state with separate
membership coordination versus shared group state with explicit commit convergence.

[double-ratchet]: https://signal.org/docs/specifications/doubleratchet/
[mls-evolution]: https://www.rfc-editor.org/rfc/rfc9420.html#section-12
[mls-sequencing]: https://www.rfc-editor.org/rfc/rfc9420.html#section-14
[mls-reordering]: https://www.rfc-editor.org/rfc/rfc9420.html#section-15.3
[mls-restrictions]: https://www.rfc-editor.org/rfc/rfc9420.html#section-15.2
[mls-architecture]: https://www.rfc-editor.org/rfc/rfc9750.html
[marmot-mls]: https://github.com/marmot-protocol/marmot/blob/26fa6a6972d7b4325cb3d105ffdd41a1ceda2bb0/foundation/mls-protocol.md
[marmot-convergence]: https://github.com/marmot-protocol/marmot/blob/26fa6a6972d7b4325cb3d105ffdd41a1ceda2bb0/protocol-core/convergence.md
[marmot-history]: https://github.com/marmot-protocol/marmot/blob/26fa6a6972d7b4325cb3d105ffdd41a1ceda2bb0/protocol-core/retained-history.md
[marmot-joining]: https://github.com/marmot-protocol/marmot/blob/26fa6a6972d7b4325cb3d105ffdd41a1ceda2bb0/protocol-core/joining.md
