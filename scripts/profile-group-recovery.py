#!/usr/bin/env python3
"""Bounded, sequential hosted comparison of immutable source revisions."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

root = Path.cwd()
work = Path(os.environ["RUNNER_TEMP"]) / "recovery-profile"
work.mkdir(mode=0o700)
revisions = [
    ("0.0.187", "ad72a801d6279693af9d22998e54978f6fc3e6d6"),
    ("0.0.188", "503b3b4d3a4a6e13aea644a47032e9cfe09a9130"),
    ("corrected", os.environ["CANDIDATE_SHA"]),
]
fixture = (root / "scripts/profile-group-recovery.ts").read_bytes()
results = []
cpus = sorted(os.sched_getaffinity(0))[:2]
for label, revision in revisions:
    assert len(revision) == 40 and all(c in "0123456789abcdef" for c in revision)
    subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", revision], check=True)
    destination = work / label
    destination.mkdir()
    archive = subprocess.check_output(["git", "archive", revision, "ts/src", "ts/package.json", "ts/pnpm-lock.yaml"])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(destination, filter="data")
    ts = destination / "ts"
    manifest = json.loads((ts / "package.json").read_text())
    if label != "corrected":
        assert manifest["version"] == label
    assert (ts / "pnpm-lock.yaml").read_bytes() == (root / "ts/pnpm-lock.yaml").read_bytes()
    (ts / "node_modules").symlink_to(root / "ts/node_modules", target_is_directory=True)
    (ts / "tests").mkdir()
    (ts / "tests/helpers").symlink_to(root / "ts/tests/helpers", target_is_directory=True)
    (ts / "profile").mkdir()
    (ts / "profile/run.ts").write_bytes(fixture)
    started = time.monotonic()
    with (work / (label + ".log")).open("w") as log:
        run = subprocess.run(["taskset", "-c", ",".join(map(str, cpus)), "node",
                              str(root / "ts/node_modules/tsx/dist/cli.mjs"), "profile/run.ts"],
                             cwd=ts, stdout=log, stderr=subprocess.STDOUT,
                             env=dict(os.environ, NODE_OPTIONS="--max-old-space-size=2048"), timeout=600)
    lines = (work / (label + ".log")).read_text().splitlines()
    measurements = next(json.loads(line) for line in reversed(lines) if line.startswith('{"phases":'))
    result = {"label": label, "source": revision, "version": manifest["version"], "exit": run.returncode,
              "wallSeconds": time.monotonic() - started, **measurements}
    assert run.returncode == 0, result
    results.append(result)
    (work / "results.json").write_text(json.dumps({"cpus": cpus,
        "fixtureSHA256": hashlib.sha256(fixture).hexdigest(), "results": results}, indent=2) + "\n")
    print(json.dumps(result), flush=True)
