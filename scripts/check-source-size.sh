#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUST_LIMIT=1000
TYPESCRIPT_LIMIT=500
violations=0
checked=0

cd "${REPOSITORY_DIR}"

while IFS= read -r -d '' file; do
    case "${file}" in
        *.rs)
            limit="${RUST_LIMIT}"
            language="Rust"
            ;;
        *.ts|*.tsx|*.mts|*.cts)
            limit="${TYPESCRIPT_LIMIT}"
            language="TypeScript"
            ;;
        *)
            continue
            ;;
    esac

    line_count="$(awk 'END { print NR }' "${file}")"
    checked=$((checked + 1))
    if (( line_count > limit )); then
        printf '%s: %s has %d physical lines (limit %d)\n' \
            "${language}" "${file}" "${line_count}" "${limit}" >&2
        violations=1
    fi
done < <(
    git ls-files -z -- \
        '*.rs' \
        '*.ts' \
        '*.tsx' \
        '*.mts' \
        '*.cts'
)

if (( violations != 0 )); then
    exit 1
fi

printf 'Source-size guard passed for %d files (Rust <= %d, TypeScript <= %d).\n' \
    "${checked}" "${RUST_LIMIT}" "${TYPESCRIPT_LIMIT}"
