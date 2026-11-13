# MDK and NDR relay delivery benchmark

Two Rust adapters run real messaging engines against the same generated requests, relay outages and device outages. The workload includes direct conversations, five- and ten-account groups, offline devices, competing admin edits, partitions, and a 100-account event-size control. The benchmark records delivery to each intended device and the cost of serving the workload. [Measured results](RESULTS.md)

## Reproducing the experiment

Use Python 3, Git, tar, Cargo and checkouts of nostr-double-ratchet, iris-chat-rs and MDK. Run the commands from this directory. The default source checkouts are siblings. Override them with absolute paths in `IRIS_REPO` and `MDK_REPO`. Each source checkout must contain the full commit pinned in `prepare.py`. Preparation uses `git archive` into empty directories and leaves the checkouts untouched. Choose output paths on a volume with room for the build. The 100-account uncapped MDK run can take about an hour.

The per-device baseline used NDR 0.0.178 and Iris Chat Protocol 0.3.17 on aarch64 macOS with Rust 1.99.0. MDK used revision `6f6d2017de1f2cc595cc10da9d575f3aa16cb21e`, x86_64 Linux, Rust 1.97.1 and Odin dev-2026-10 at `84bc3fc2100b0f7880a3af37f71bccdcda41c6f9`. MDK's pinned `scripts/install-odin.sh` verifies the downloaded release archive. Set `ODIN` to the matching compiler if it is outside PATH. The MDK adapter adds one local crate to the upstream Cargo.lock. Both adapters use the same locked workload RNG. Process time is diagnostic and depends on the machine.

```sh
python3 prepare.py ndr /tmp/compare-ndr
cargo +1.99.0 build --locked --release --features group-broadcast --manifest-path /tmp/compare-ndr/sim-ndr/Cargo.toml
ndr=/tmp/compare-ndr/sim-ndr/target/release/sim-ndr
python3 run.py "$ndr" /tmp/ndr-results direct direct2 small small-edits static busy static2 seq seq2 race partition --seeds 1 2 3 4 5
python3 run.py "$ndr" /tmp/ndr-results large cap --seeds 1

MDK_REPO=/path/to/mdk BENCH_DIR=/tmp/compare-mdk bash rerun-mdk.sh
python3 compare.py /tmp/ndr-results /tmp/compare-mdk/results all
cargo +1.99.0 test --locked --manifest-path simnet/Cargo.toml
```

To repeat the linked-device control comparison, use `prepare.py ndr BEFORE --release` and `prepare.py ndr AFTER --control-fix`. Build each with `--features group-broadcast`, run `small small-edits --seeds 1 2 3 4 5` and `race static2 --seeds 1 2 3` on each binary, and compare with `compare.py AFTER_RESULTS BEFORE_RESULTS small-edits --previous-ndr`. The control-fix pin contains the implementation tested for Iris Chat Protocol 0.3.19. Both adapters label new publications by the input callback that emitted them, including a remote key distribution, real roster update, or repair request. The labels are simulator accounting only.

To reproduce the additional app-release check, run `prepare.py ndr OUTPUT --release`, use the same `--features group-broadcast` build command and run the `direct2 small small-edits busy` cases on seeds 1–5. This pairs NDR 0.0.179 with Iris Chat Protocol 0.3.18. The wider post-change matrix pins the two feature commits immediately before release preparation.

For the November 13 per-device baseline, prepare a separate directory with `prepare.py ndr OUTPUT --baseline` and omit the `--features group-broadcast` build option. Compare the upgraded NDR and baseline with `compare.py NEW_NDR OLD_NDR all --previous-ndr`. That command also shows unique shared data publications submitted per scheduled send. The baseline still creates one inner ciphertext per message, then sends it only inside pairwise envelopes.

`run.py` refuses to overwrite a completed result. `compare.py` accepts either directories or JSON Lines files. It checks the seed, engine, full scenario, fingerprint of the generated action and outage schedule, intended recipient count, online recipient count and accounting consistency. Cryptographic randomness, setup completion time, and per-publish network draws can still vary. Each engine experiences loss on the traffic it produces.

## What the simulator measures

- Each scheduled message is owed to every device in the requested membership at that instant, including the sender's other devices. Deferral, refusal, withdrawal or later removal cannot reduce the denominator. Final delivery counts unique copies that remain in the recipient's message history after the recovery period. A later redelivery can restore a withdrawn copy.
- Timeliness starts when the user scheduled the send. The online-within-60-seconds metric takes all copies owed to devices online at that time as its denominator. The sender can be offline. The raw reports also give per-run latency percentiles among delivered copies.
- A post-removal read counts a distinct plaintext/device pair once, even if it was later withdrawn. The requested roster comes from the action schedule. The sender's view is sampled immediately before the engine's actual send, after any offline deferral. The counter distinguishes a sender still listing the account, a sender excluding it, and unavailable evidence. A scheduled rejoin or a subsequent change of state during deferral can affect interpretation. This experiment observes ordinary clients; it does not simulate key extraction or establish cryptographic revocation.
- Published bytes cover serialized event payloads submitted during the workload and recovery, including control traffic. Relay-upload bytes also include fanout to reachable relays, retries and rejected attempts. Setup is recorded separately and includes key material. MDK's KeyPackage publication size is approximate. REQ, ACK, TLS, WebSocket framing, push, and client energy use are outside the measurement.
- The default run has three relays, 120-byte plaintext messages, a one-hour workload and 15 minutes for recovery. The two 100-account cases use 100 messages over 30 minutes followed by 10 minutes for recovery. Only the 64 KiB maximum event size changes between those cases. Setup uses an ideal network, including the configured event cap. Late maintenance can fall in the workload phase.
- NDR uses the Iris protocol engine, real author filters and backfill. The adapter rejects recipient tags on outgoing kind 1060. MDK uses its conformance client with per-device MLS state, commit acknowledgements, Welcome ordering and post-join maintenance. Both models make prepublished discovery material available. They simulate relay storage and matching in-process. Filter truncation, relay implementation limits, real push wakeups, app restarts and physical phone behavior need separate tests.
