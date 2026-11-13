#!/usr/bin/env bash
# Build the pinned MDK source and reproduce the campaign on the current machine.
set -euo pipefail
cd "$(dirname "$0")"
: "${MDK_REPO:?Set MDK_REPO to the absolute path of the MDK checkout}"
: "${BENCH_DIR:?Set BENCH_DIR to an absolute campaign directory}"
[[ "$BENCH_DIR" == /* ]] || { echo 'BENCH_DIR must be an absolute path' >&2; exit 2; }
mkdir -p "$BENCH_DIR"
python3 prepare.py mdk "$BENCH_DIR/src"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$BENCH_DIR/target}"
(
    cd "$BENCH_DIR/src/mdk"
    cargo build --release --locked -p cgka-conformance-simulator --bin sim_mdk
)
bin="$CARGO_TARGET_DIR/release/sim_mdk"
python3 run.py "$bin" "$BENCH_DIR/results" direct direct2 small small-edits static busy static2 seq seq2 race partition --seeds 1 2 3 4 5
python3 run.py "$bin" "$BENCH_DIR/results" large cap --seeds 1
