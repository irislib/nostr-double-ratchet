#!/usr/bin/env python3
"""Measure final-source replay and actual LocalStorage IO with the same pinned tools."""
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
assert revision == "118b5dcc122e94a888249ddd3244af2605118e31"
subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", revision], check=True)
archive = subprocess.check_output(["git", "archive", revision, "ts/src", "ts/package.json", "ts/pnpm-lock.yaml"])
work = Path(os.environ["RUNNER_TEMP"]) / "recovery-profile"
work.mkdir(mode=0o700)
cpus = sorted(os.sched_getaffinity(0))[:2]
memory = '''import type { StorageAdapter } from "../StorageAdapter.js";
export class ConsumedGroupEvents {
  private readonly slots = new Map<string, string>();
  constructor(_storage: StorageAdapter, _prefix: string) {}
  async has(id: string): Promise<boolean> { return this.slots.get(id.slice(0, 2)) === id; }
  async remember(id: string): Promise<void> {
    if (/^[0-9a-f]{64}$/.test(id)) this.slots.set(id.slice(0, 2), id);
  }
  async clear(): Promise<void> { this.slots.clear(); }
}
'''
results = []
for label in ["persistent-disk", "memory-disk", "persistent-disk-repeat", "memory-disk-repeat", "replay", "replay-repeat"]:
    destination = work / label
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(destination, filter="data")
    ts = destination / "ts"
    assert (ts / "pnpm-lock.yaml").read_bytes() == (root / "ts/pnpm-lock.yaml").read_bytes()
    (ts / "node_modules").symlink_to(root / "ts/node_modules", target_is_directory=True)
    (ts / "tests").mkdir()
    (ts / "tests/helpers").symlink_to(root / "ts/tests/helpers", target_is_directory=True)
    (ts / "scripts").mkdir()
    if label.startswith("memory"):
        (ts / "src/group/ConsumedGroupEvents.ts").write_text(memory)
    disk = "disk" in label
    fixture = root / ("scripts/profile-local-storage.ts" if disk else "scripts/profile-group-recovery.ts")
    (ts / "scripts/profile.ts").write_bytes(fixture.read_bytes())
    storage_file = destination / "local-storage.sqlite"
    args = ["taskset", "-c", ",".join(map(str, cpus)), "node", "--max-old-space-size=2048"]
    if disk: args += ["--experimental-webstorage", "--localstorage-file=" + str(storage_file)]
    args += ["--import", "tsx", "scripts/profile.ts"]
    started = time.monotonic()
    with (work / (label + ".log")).open("w") as output:
        run = subprocess.run(args, cwd=ts, stdout=output, stderr=subprocess.STDOUT,
            env=dict(os.environ, STORAGE_FILE=str(storage_file)), timeout=600)
    assert run.returncode == 0, f"{label} failed; see retained log"
    lines = (work / (label + ".log")).read_text().splitlines()
    measured = json.loads(next(line for line in reversed(lines) if line.startswith("{")))
    results.append({"label": label, "source": revision, "exit": run.returncode,
        "wallSeconds": time.monotonic() - started,
        "fixtureSHA256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
        "cacheSHA256": hashlib.sha256((ts / "src/group/ConsumedGroupEvents.ts").read_bytes()).hexdigest(),
        "measured": measured})
    (work / "results.json").write_text(json.dumps({"cpus": cpus, "results": results}, indent=2) + "\n")
    print(json.dumps(results[-1]), flush=True)
