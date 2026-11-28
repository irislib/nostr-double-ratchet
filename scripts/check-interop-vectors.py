#!/usr/bin/env python3
"""Fail the hosted interop lane if any generated direction would return early."""
import hashlib
import json
import sys
from pathlib import Path

directory = Path(__file__).resolve().parents[1] / "test-vectors"
families = ["generated", "app-keys-vectors", "shared-channel-vectors",
            "one-to-many-vectors", "invite-response-vectors",
            "group-roster-fact-vectors", "sender-key-repair-vectors"]
receipts = {}
for language in ["ts", "rust"]:
    for family in families:
        name = f"{language}-{family}.json"
        content = (directory / name).read_bytes()
        assert json.loads(content), f"Empty interop vector: {name}"
        receipts[name] = hashlib.sha256(content).hexdigest()
receipt = directory / "generated-inputs.sha256.json"
if "--verify" in sys.argv:
    assert json.loads(receipt.read_text()) == receipts, "Interop consumers changed their generated inputs"
else:
    receipt.write_text(json.dumps(receipts, indent=2) + "\n")
print(f"Required all {len(receipts)} generated interop inputs; none may return early.")
