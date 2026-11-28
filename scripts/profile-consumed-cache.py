#!/usr/bin/env python3
"""Compare persistent and cold-after-restart memory caches, keeping the 90s gate."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

root = Path.cwd()
revision = os.environ["CANDIDATE_SHA"]
assert revision == "62c8f019bba8bd9aefcfb0203b938d5a7834e142"
subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", revision], check=True)
archive = subprocess.check_output(["git", "archive", revision, "ts/src", "ts/package.json",
                                   "ts/pnpm-lock.yaml", "ts/tests/GroupRecovery.test.ts"])
work = Path(os.environ["RUNNER_TEMP"]) / "recovery-profile"
work.mkdir(mode=0o700)
cpus = sorted(os.sched_getaffinity(0))[:2]
source = '''import type { StorageAdapter } from "../StorageAdapter.js";
// Measurement variant: one 256-slot cache per Group, empty after restart.
export class ConsumedGroupEvents {
  private readonly slots = new Map<string, string>();
  constructor(_storage: StorageAdapter, _prefix: string) {}
  async has(id: string): Promise<boolean> { return this.slots.get(id.slice(0, 2)) === id; }
  async remember(id: string): Promise<void> {
    if (/^[0-9a-f]{64}$/.test(id)) this.slots.set(id.slice(0, 2), id);
  }
}
'''
results = []
for label in ["persistent", "memory"]:
    destination = work / label
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(destination, filter="data")
    ts = destination / "ts"
    assert (ts / "pnpm-lock.yaml").read_bytes() == (root / "ts/pnpm-lock.yaml").read_bytes()
    (ts / "node_modules").symlink_to(root / "ts/node_modules", target_is_directory=True)
    (ts / "tests/helpers").symlink_to(root / "ts/tests/helpers", target_is_directory=True)
    if label == "memory": (ts / "src/group/ConsumedGroupEvents.ts").write_text(source)
    started = time.monotonic()
    with (work / (label + ".log")).open("w") as output:
        run = subprocess.run(["taskset", "-c", ",".join(map(str, cpus)), "node",
            str(root / "ts/node_modules/vitest/vitest.mjs"), "run", "tests/GroupRecovery.test.ts",
            "--maxWorkers=1", "--no-file-parallelism", "-t", "rotated sender burst", "--reporter=verbose"],
            cwd=ts, stdout=output, stderr=subprocess.STDOUT,
            env=dict(os.environ, NODE_OPTIONS="--max-old-space-size=2048"), timeout=600)
    results.append({"variant": label, "source": revision, "exit": run.returncode,
        "wallSeconds": time.monotonic() - started,
        "testSHA256": hashlib.sha256((ts / "tests/GroupRecovery.test.ts").read_bytes()).hexdigest(),
        "cacheSHA256": hashlib.sha256((ts / "src/group/ConsumedGroupEvents.ts").read_bytes()).hexdigest()})
    (work / (label + "-ConsumedGroupEvents.ts")).write_bytes((ts / "src/group/ConsumedGroupEvents.ts").read_bytes())
    (work / "results.json").write_text(json.dumps({"cpus": cpus, "unchangedTestLimitMs": 90000,
        "results": results}, indent=2) + "\n")
    print(json.dumps(results[-1]), flush=True)
raise SystemExit(1 if any(row["exit"] for row in results) else 0)
