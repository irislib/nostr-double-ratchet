#!/bin/bash
# Publish nostr-double-ratchet crates to crates.io in dependency order
#
# Usage:
#   ./scripts/publish.sh        # Publish all crates
#   ./scripts/publish.sh --dry-run  # Test without publishing

set -e

cd "$(dirname "$0")/.."

DRY_RUN=""
ALLOW_DIRTY="--allow-dirty"
FAILED=0

if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN="--dry-run"
    echo "=== DRY RUN MODE ==="
fi

# Wait time between publishes for crates.io indexing (seconds)
WAIT_TIME=30

publish_crate() {
    local crate=$1
    local extra_flags=${2:-""}
    local flags="$DRY_RUN $ALLOW_DIRTY $extra_flags"

    if [[ -n "$DRY_RUN" && "$flags" != *"--no-verify"* ]]; then
        flags="$flags --no-verify"
    fi

    echo ""
    echo "=========================================="
    echo "Publishing: $crate"
    echo "=========================================="

    if cargo publish -p "$crate" $flags; then
        echo "✓ $crate published successfully"

        if [[ -z "$DRY_RUN" ]]; then
            echo "Waiting ${WAIT_TIME}s for crates.io to index..."
            sleep $WAIT_TIME
        fi
    else
        echo "✗ Failed to publish $crate (continuing...)"
        FAILED=1
    fi
}

echo "Publishing nostr-double-ratchet crates to crates.io"
echo ""

# Check if logged in
if [[ -z "$DRY_RUN" ]]; then
    echo "Checking crates.io authentication..."
    if ! cargo login --help > /dev/null 2>&1; then
        echo "Please run 'cargo login' first"
        exit 1
    fi
fi

# Tier 1: Core library. Uses --no-verify because dev-dependencies on
# sibling workspace crates would otherwise fail to resolve until those
# siblings are themselves published.
publish_crate "nostr-double-ratchet" "--no-verify"

# Tier 2: leaf crates that only depend on the core library
publish_crate "nostr-double-ratchet-pairwise-codec"

# Tier 3: durable runtime, after both core and codec are indexed
publish_crate "nostr-double-ratchet-pairwise"

if [[ "$FAILED" -ne 0 ]]; then
    echo ""
    echo "One or more crates failed to publish." >&2
    exit 1
fi

echo ""
echo "=========================================="
echo "✓ All crates published successfully!"
echo "=========================================="
