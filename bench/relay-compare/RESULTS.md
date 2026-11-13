# MDK and NDR under relay failures

## Follow-up on linked-device control traffic

A sender-key distribution used to trigger two independent pairwise deliveries to a linked device. The device needed the newly learned sender key, while the accompanying roster was unchanged. Iris Chat Protocol 0.3.19 forwards only the key in that case. A real roster edit still forwards the updated roster, and duplicate key input produces no new forward. This change requires no new on-wire fields, group version, or device advertisement.

| Five accounts, two devices each | Previous KiB/send | New KiB/send | MDK KiB/send | Previous retained | New retained |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed membership | 5.06 | 3.74 | 1.15 | 9,000/9,000 | 9,000/9,000 |
| Two sequential membership edits | 39.95 | 32.43 | 1.30 | 8,254/8,570 | 8,256/8,570 |

Five seeds were repeated in each row with the same scorer and attribution. The fixed group submitted one 1.20 KiB signed data event per send across all runs. The rest of its new 3.74 KiB average consisted of 1.12 KiB triggered by receipt of remote sender keys, 0.90 KiB of other pairwise send-path traffic and 0.51 KiB of invite responses (rounded). Receive-triggered control publications fell from 1,106 to 552 across the 1,000 scheduled sends. With membership edits, the remote-key receive cost fell from 13.23 to 6.05 KiB/send. Retries still contributed 16.03 KiB/send; the initial edit itself is only part of the delivery cost. Both edit runs observed 13 reads after a scheduled removal while the sender still included that account, and zero while the sender excluded it. [Before](results/2026-11-13-linked-device-before.jsonl), [after](results/2026-11-13-linked-device-after.jsonl) and [matching MDK evidence](results/2026-11-13-mdk.jsonl).

Three additional seeds tested ten accounts with two devices each. With fixed membership, both versions delivered 11,400/11,400 copies and traffic fell from 19.80 to 12.67 KiB/send. With competing admin edits, mean traffic fell from 405.98 to 349.84 KiB/send, while retained delivery fell from 8,330 to 8,141 of 9,976. Reads outside the requested roster while the sender still listed the account rose from 283 to 745, concentrated in two seeds. Neither recorded a read with that account excluded by the sender. The three-seed stress result is a reason to investigate convergence before deploying to groups where competing admin edits are frequent. No benchmark demonstrates a general reliability win.

A single authenticated sender-key message could communicate an edit to devices that already have the key. Newly admitted devices still need authenticated bootstrap material. After removal, anyone holding the old chain can decrypt updates distributed under that chain, so fresh chain secrets must reach the remaining authorized devices through a channel the removed device cannot read. This benchmark retains the existing pairwise membership and key protocol. It measures the removal of a redundant forward.

## November 13 single-publication group upgrade

Each accepted group send produced exactly one signed shared data event in the upgraded Iris protocol engine. The simulator checks this at the send boundary and counts both the data and the private control traffic submitted to relays. All groups use the same path. Contacts, membership updates and sender-key distribution continue over private sessions. Older clients need an update to read newly published group messages. A closed browser can catch up on reopen; these messages do not wake it through the old per-device push path.

The benchmark below uses NDR `b062debb` and Iris Chat Protocol `a721434b`. MDK and the before measurements use the same raw reports as the November 13 baseline. Actual schedules, intended recipients and device outages must match for each seed. Simulation costs exclude relay query traffic, mobile energy, push and app migration. The Rust library production sources in this measurement match those in the 0.0.179 release commit `ecc81c4e`.

### Decision for everyday DMs and small groups

Keep NDR for this workload. Both engines delivered every direct message, and both delivered all 9,000 intended copies in a fixed five-person group with two devices per account. On the upgraded NDR run, five-person group traffic fell by 87% relative to the previous release. In a busy ten-person group with one device each, it fell by 94%, from 24.92 to 1.45 KiB per scheduled send. MDK still used less bandwidth in every successfully formed group. A full migration would have to justify its cost through another requirement, such as MLS interoperability or persistent membership churn.

| Scenario | Upgraded NDR retained/owed | MDK delivery | Previous NDR KiB/send | Upgraded NDR KiB/send | MDK KiB/send |
| --- | ---: | ---: | ---: | ---: | ---: |
| DM, one device each | 1,000/1,000 (100.00%) | 100.00% | 1.30 | 1.30 | 1.06 |
| DM, two devices each | 3,000/3,000 (100.00%) | 100.00% | 4.39 | 4.39 | 1.08 |
| 5 accounts × 2 devices, fixed | 9,000/9,000 (100.00%) | 100.00% | 39.75 | 5.09 | 1.15 |
| 5 × 2, two sequential edits | 8,266/8,570 (96.45%) | 97.76% | 50.30 | 38.79 | 1.30 |
| 10 × 1, fixed | 9,000/9,000 (100.00%) | 100.00% | 27.75 | 2.42 | 1.14 |
| 10 × 1, 1,000 sends | 45,000/45,000 (100.00%) | 100.00% | 24.92 | 1.45 | 1.07 |
| 10 × 2, fixed | 19,000/19,000 (100.00%) | 99.94% | 100.97 | 20.02 | 1.27 |
| 10 × 1, sequential edits, harsh | 7,584/8,275 (91.65%) | 85.51% | 43.94 | 35.43 | 1.35 |
| 10 × 2, sequential edits | 16,985/17,554 (96.76%) | 96.25% | 226.70 | 450.96 | 2.00 |
| 10 × 2, competing edits | 13,669/17,016 (80.33%) | 78.00% | 261.50 | 545.24 | 2.89 |
| 10 × 2, edits during partition | 11,478/14,906 (77.00%) | 66.11% | 161.53 | 374.45 | 1.98 |
| 100 × 1, unrestricted | 9,900/9,900 (100.00%) | 100.00% | 1,467.64 | 224.37 | 3.72 |
| 100 × 1, 64 KiB cap | 9,900/9,900 (100.00%) | 0.00% | 1,467.64 | 224.37 | 0.00 |

The group-send assertion passed on all 13,005 accepted ordinary group sends in the full upgraded matrix. One shared data event carried the payload. Setup, roster edits, key distribution and recovery added separate events. In the capped 100-person test, 100 shared data events totaled 123,200 bytes and the workload submitted 9,912 additional control, invite and repair events. The same MDK build delivered all 9,900 copies without the cap and zero with the cap. Its zero workload bytes in the capped row accompanied 100 refused sends. [Raw upgraded NDR runs](results/2026-11-13-ndr-broadcast.jsonl), [baseline NDR](results/2026-11-13-ndr.jsonl) and [MDK](results/2026-11-13-mdk.jsonl).

For release confirmation, four priority workloads were repeated on the 0.0.179/0.3.18 sources (Iris commit `6a989bb8`), five seeds each. Multi-device DMs retained 3,000/3,000 at 4.39 KiB/send. Fixed five-person groups retained 9,000/9,000 at 5.08 KiB/send. Two sequential membership edits retained 8,268/8,570 at 38.46 KiB/send. The busy ten-person group retained 45,000/45,000 at 1.45 KiB/send. Run-to-run variation is expected. [Raw release confirmation](results/2026-11-13-ndr-release.jsonl).

**Where the upgrade costs more.** In the ten-person, two-device simultaneous-edit stress test, pooled retained delivery fell from 81.99% to 80.33%, and traffic rose from 261.50 to 545.24 KiB/send. Control publications and retries dominated. Seed 5 alone submitted 53,060 events from the control path and 52,525 from the retry path for 200 scheduled messages. The paired partition workload also used more bandwidth. Treat these figures as an open issue when evaluating NDR for frequently changing groups. The measurement does not identify which engine callback should change.

Across the upgraded matrix, 3,445 distinct post-removal reads occurred while the sender still listed the account; none were observed when the sender excluded it. MDK recorded 1,534 and four, respectively. Users can still receive a message while a membership edit propagates. The test observes honest clients and omits physical devices, so these counts establish neither a cryptographic guarantee nor a battery ranking.

## November 13 paired baseline

The released NDR 0.0.178 engine and Iris Chat Protocol 0.3.17 used private per-device envelopes for ordinary group messages. MDK ran at `6f6d2017` on the November 13 development branch. Each pair used identical scheduled messages, intended recipients and outages, checked against a schedule fingerprint. The result is final retained copies over all copies owed to the requested roster. Each small scenario used seeds 1 through 5. The two 100-account cases used seed 1. The complete per-seed reports include latency, retries, withdrawals, setup cost and state convergence. [Raw NDR baseline](results/2026-11-13-ndr.jsonl) and [raw MDK runs](results/2026-11-13-mdk.jsonl).

| Scenario | NDR retained/owed | MDK retained/owed | NDR published KiB/send | MDK published KiB/send |
| --- | ---: | ---: | ---: | ---: |
| DM, one device each | 1,000/1,000 (100.00%) | 1,000/1,000 (100.00%) | 1.30 | 1.06 |
| DM, two devices each | 3,000/3,000 (100.00%) | 3,000/3,000 (100.00%) | 4.39 | 1.08 |
| 5 accounts × 2 devices, fixed | 8,999/9,000 (99.99%) | 9,000/9,000 (100.00%) | 39.75 | 1.15 |
| 5 × 2, two sequential edits | 8,252/8,570 (96.29%) | 8,378/8,570 (97.76%) | 50.30 | 1.30 |
| 10 × 1, fixed | 9,000/9,000 (100.00%) | 9,000/9,000 (100.00%) | 27.75 | 1.14 |
| 10 × 1, fixed, 1,000 sends | 45,000/45,000 (100.00%) | 45,000/45,000 (100.00%) | 24.92 | 1.07 |
| 10 × 2, fixed | 18,997/19,000 (99.98%) | 18,988/19,000 (99.94%) | 100.97 | 1.27 |
| 10 × 1, six sequential edits, harsh | 7,561/8,275 (91.37%) | 7,076/8,275 (85.51%) | 43.94 | 1.35 |
| 10 × 2, six sequential edits | 16,946/17,554 (96.54%) | 16,896/17,554 (96.25%) | 226.70 | 2.00 |
| 10 × 2, competing edits | 13,952/17,016 (81.99%) | 13,273/17,016 (78.00%) | 261.50 | 2.89 |
| 10 × 2, competing edits during partition | 11,471/14,906 (76.96%) | 9,854/14,906 (66.11%) | 161.53 | 1.98 |
| 100 × 1, unrestricted | 9,900/9,900 (100.00%) | 9,900/9,900 (100.00%) | 1,467.64 | 3.72 |
| 100 × 1, 64 KiB event limit | 9,900/9,900 (100.00%) | 0/9,900 (0.00%) | 1,467.64 | 0.00 |

### Daily messages and small groups

Both engines delivered every direct message across five harsh-network workloads, including the sender’s other device in the two-device cases. In fixed five-person/two-device groups, NDR missed one of 9,000 copies. Both engines delivered 79% of copies owed to an online recipient within 60 seconds. With two sequential membership edits, MDK retained more copies in each of the five seeds. The pooled difference was 126 of 8,570 owed copies. Final members agreed on one state in all ten runs.

### Cost of private group delivery

The deployed Iris engine created one group ciphertext, then wrapped it separately for each recipient device. The inner ciphertext stayed off the relay. For the first ten-person fixed-group seed, 200 sends produced 1,881 events attributed to the group send path, 249 recovery events and 36 invite responses. Group send effects alone accounted for 25.0 KiB per send. All three classes together accounted for 27.8 KiB. On the 1,000-message version, NDR still averaged 24.92 KiB per send across the five seeds. MDK used one opaque group route and averaged 1.07 KiB per send. This counts payload bytes submitted before relay fanout. See the [NDR baseline implementation](https://github.com/irislib/iris-chat-rs/blob/8fa4f1fb8fbb7e8efdb97d98d3572b72be629334/chat-protocol/src/protocol_engine/engine_sends.rs#L531) and [MDK Nostr event implementation](https://github.com/marmot-protocol/mdk/blob/6f6d2017de1f2cc595cc10da9d575f3aa16cb21e/crates/transport-nostr-peeler/src/event.rs).

### Membership and removal

Under competing edits, results varied widely by seed. The five-run delivery range was 69.9–96.8% for NDR and 69.1–86.5% for MDK. Both lost intended deliveries even after the 15-minute recovery period. A running workload and eventual roster convergence measure different outcomes.

In the five-person runs with edits, NDR recorded 9 distinct reads by devices outside the requested roster and MDK recorded 26. In all 35 cases the sender still included the account when it processed the send. In ten-person groups with simultaneous edits, those counts rose to 1,327 and 499, again all with the account present in the sender’s view. Across this baseline matrix NDR recorded zero reads with the account excluded from the sender’s view. MDK recorded four in ten-person/two-device sequential-edit runs. The observations include delayed sends and subsequent roster changes. Establishing the cause of those four reads requires tracing actual encryption epochs and rejoin timing.

### Relay event cap

With the 64 KiB limit, the MDK creator stayed alone, 99 invitations never completed, and the engine refused all 100 sends. Its zero workload bytes are the cost of *no successful sends*. MDK consumed about 14.7 MiB during setup. NDR delivered all 9,900 copies and used 143.3 MiB after setup. With the same request and no cap, MDK retained 9,900/9,900 copies. This single seed exercises one group-formation strategy with prepublished key material. It cannot estimate the failure rate of an entire deployment.

The paired runs measure virtual delivery and serialized payloads. App CPU, battery, real relay policy, total on-device network usage, push and migration effort were outside the experiment. [Build instructions and exact metric definitions](README.md)

## November 11 historical results

Measured November 11, 2026. Claude’s simulator exposed real delayed-message and roster bugs. Its delivery score dropped refused sends and later-removed recipients from the denominator, credited subsequently withdrawn deliveries, and returned 100% for zero expected deliveries. Its NDR transport subscribed by recipient device. Those choices make a general reliability ranking unsupported.

### Rerun with author-based NDR delivery

Three workload seeds per row, 200 scheduled sends per seed. Percentages pool unique message/device pairs. The range shows the three individual percentages. Costs are serialized event payload totals per scheduled send during workload and recovery. Separate setup costs and class breakdowns are in the [raw NDR runs](results/ndr-runs.jsonl).

| Scenario | Retained / owed | Delivery | Seed range | Published KiB/send | Relay upload KiB/send | Reads after intended removal |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1:1, harsh network | 600 / 600 | 100.0% | 100.0–100.0% | 1.3 | 3.5 | 0 |
| 10 accounts, fixed membership, flaky network | 5,400 / 5,400 | 100.0% | 100.0–100.0% | 28.7 | 81.0 | 0 |
| 10 accounts, sequential edits, harsh network | 4,537 / 5,062 | 89.6% | 80.9–95.9% | 48.4 | 118.7 | 66 |
| 10 accounts × 2 devices, simultaneous edits, flaky network | 7,393 / 9,976 | 74.1% | 69.6–81.8% | 252.8 | 712.6 | 823 |

The sequential runs scheduled 600 sends. The host skipped 22 after offline deferral because the sending account was no longer a settled member. None of the 578 sends attempted by the host was refused by the engine. The recipients' final membership views converged in all three runs. Convergence did not recover every owed delivery.

The simultaneous-edit stress test attempts a second admin edit at every churn opportunity. The original matrix used a 50% probability. Reads by a device after its scheduled removal are counted even if the removal was deferred or the sender had not learned it. These counts warrant inspecting lost admin edits and removal acknowledgements. They do not establish that a receiver bypassed an applied removal.

### What the original MDK runs establish

- **100 accounts, 64 KiB relay cap, static membership, seed 1.** The original MDK log records 99 Welcomes that gave up, one device in group, 100 attempted sends, 100 refusals and zero delivered copies. Its summary printed 100%. Scored against 100 scheduled sends × 99 other devices, the result is **0 / 9,900**. Claude’s prose correctly identified the group-formation failure.
- **Same capped workload, NDR.** The author-routed NDR pilot delivered **9,900 / 9,900** with 100 group members in one roster view. Its 46,908 workload events totalled 212,254,388 serialized bytes, including 171,177,412 bytes classified by the adapter as recovery traffic. This number includes first-session and repair overhead. One seed cannot predict long-running marginal cost. The pilot preceded the overlap and invalidation-order fixes. This workload had no outages or withdrawals. Its historical build label reads `ndr+wip`; it uses the pinned Iris engine with context recovery enabled. [Pilot output](results/ndr-cap-pilot.json)
- **10 accounts, static membership, flaky network.** MDK's archived three-seed mean was 99.11% with zero refusals or withdrawals and about 1.2 KiB published per send. NDR's new runs used roughly 29 KiB per send. The traffic gap is substantial. The small delivery difference across these runs does not establish a winner.
- **10 accounts, sequential changes, harsh network.** MDK's archived 97.58% excludes refused sends (4.3 per run on average) and devices that did not remain members. Counts for all scheduled recipient pairs are unavailable for this cell. Comparing that number directly to the new NDR percentage would repeat the denominator error. [Archived MDK evidence](results/historical-mdk.json)

### Reproducibility and limits

NDR used commit `38aaba9`, Iris Chat Protocol 0.3.16 at `e06f50a` with the simulation-only consumer adaptation, and a release build on arm64 macOS with Rust 1.99.0. The MDK evidence comes from the November 11 run of `d276681b`. The revised MDK adapter was unavailable for that assessment. The November 13 campaign above supersedes the older churn comparison.

The shared scorer fixes recipients from the requested workload before any engine gets to accept or reject it, and records reads outside that requested roster separately. Fresh runs retire expired subscriptions and merge overlapping offline periods. Engine callbacks use virtual clocks, and both adapters bypass discovery for prepublished key material. The old “CPU” figures timed callbacks with a wall clock. They cannot support a production CPU comparison.

See [build instructions and metric definitions](README.md).
