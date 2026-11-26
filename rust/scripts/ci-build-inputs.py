#!/usr/bin/env python3
"""Check reviewed inputs, or install their verified archives on the hosted Linux job."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PINS = ROOT / "rust/ci/build-inputs.json"


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def check_pins(pins):
    assert pins["schema"] == 1 and pins["runner"] == "ubuntu-24.04"
    assert pins["architecture"] == "x86_64" and pins["target"] == "x86_64-unknown-linux-gnu"
    assert pins["rust"]["version"] == "1.99.0"
    assert re.fullmatch(r"Swatinem/rust-cache@[0-9a-f]{40}", pins["rustCacheAction"])
    assert {item["name"] for item in pins["rust"]["components"]} == {
        "rustc", "cargo", "rust-std", "rustfmt-preview", "clippy-preview"
    }
    archives = [*pins["rust"]["components"], pins["node"], pins["pnpm"]]
    for item in archives:
        url = urllib.parse.urlparse(item["url"])
        assert url.scheme == "https" and url.hostname in {
            "static.rust-lang.org", "nodejs.org", "registry.npmjs.org"
        }
        assert not url.username and not url.password and not url.query and not url.fragment
        algorithm = "sha512" if "sha512" in item else "sha256"
        assert re.fullmatch(r"[0-9a-f]{128}" if algorithm == "sha512" else r"[0-9a-f]{64}", item[algorithm])
        assert re.fullmatch(r"[A-Za-z0-9_.-]+", item["root"])
    package = json.loads((ROOT / "ts/package.json").read_text())
    assert package["packageManager"] == "pnpm@" + pins["pnpm"]["version"]
    assert (ROOT / "ts/pnpm-lock.yaml").is_file() and (ROOT / "rust/Cargo.lock").is_file()


def workflow_job(text, name):
    job = text.split("\n  " + name + ":\n", 1)[1]
    return re.split(r"\n  [a-z][a-z0-9-]*:\n", job, maxsplit=1)[0]


def check_workflow(pins, workflows=None):
    if workflows is None:
        workflows = {name: (ROOT / ".github/workflows" / name).read_text()
                     for name in ("ci.yml", "publish-npm.yml")}
    for workflow, name, node_only in (("ci.yml", "test-ts", True), ("ci.yml", "test-rust", False),
                                       ("ci.yml", "interop", False), ("publish-npm.yml", "publish", True)):
        job = workflow_job(workflows[workflow], name)
        assert "runs-on: " + pins["runner"] in job
        mode = "--install-node" if node_only else "--install"
        assert re.search(r"run: python3 rust/scripts/ci-build-inputs\.py " + mode + r"$", job, re.MULTILINE)
        assert "dtolnay/rust-toolchain" not in job and "actions/setup-node" not in job
        assert "pnpm/action-setup" not in job
        if name != "publish":
            assert "pnpm install --frozen-lockfile" in job
        if not node_only:
            assert "uses: " + pins["rustCacheAction"] in job
            assert "hashFiles('rust/ci/build-inputs.json')" in job
            assert "cargo test --locked" in job
        for action in re.findall(r"uses:\s+([^\s#]+)", job):
            assert re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}", action), action
    publisher = workflow_job(workflows["publish-npm.yml"], "publish")
    # Keep the established OIDC-only target and exact tested-artifact flow.
    assert "github.repository == 'irislib/nostr-double-ratchet' && github.ref == 'refs/heads/master'" in publisher
    assert "environment: npm" in publisher and "id-token: write" in publisher
    assert "NPM_CONFIG_REGISTRY: https://registry.npmjs.org" in publisher
    assert "NODE_AUTH_TOKEN" not in publisher and "NPM_TOKEN" not in publisher
    assert "event=push&head_sha=$GITHUB_SHA&status=success" in publisher
    assert 'npm publish "$NPM_TARBALL" --ignore-scripts --provenance --access public --tag latest' in publisher
    assert "npm pack" not in publisher and "pnpm build" not in publisher
    assert publisher.index("uses: actions/checkout@") < publisher.index("uses: actions/download-artifact@")
    assert "name: npm-package-${{ github.sha }}" in publisher
    assert "run-id: ${{ steps.ci.outputs.run_id }}" in publisher


def verify_archive(path, pin):
    algorithm = "sha512" if "sha512" in pin else "sha256"
    if digest(path, algorithm) != pin[algorithm]:
        raise ValueError("Downloaded archive does not match reviewed digest: " + path.name)


def unpack_verified(path, pin, destination):
    # Never parse or execute archive contents until the fixed source digest matches.
    verify_archive(path, pin)
    with tarfile.open(path) as archive:
        assert all(member.name.split("/", 1)[0] == pin["root"] for member in archive.getmembers())
        archive.extractall(destination, filter="data")
    result = destination / pin["root"]
    assert result.is_dir()
    return result


def fetch(pin, work):
    archive = work / pin["url"].rsplit("/", 1)[1]
    with urllib.request.urlopen(pin["url"], timeout=60) as response, archive.open("xb") as target:
        assert urllib.parse.urlparse(response.url).scheme == "https"
        shutil.copyfileobj(response, target)
    return unpack_verified(archive, pin, work)


def install(pins, node_only=False):
    assert os.environ.get("GITHUB_ACTIONS") == "true", "Installation is restricted to hosted CI"
    assert platform.system() == "Linux" and platform.machine() == pins["architecture"]
    assert sys.version_info >= (3, 12), "Ubuntu 24.04 Python 3.12 or newer is required"
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    assert release["ID"].strip('"') == "ubuntu" and release["VERSION_ID"].strip('"') == "24.04"
    destination = Path(os.environ["RUNNER_TEMP"]) / "ndr-ci-tools"
    destination.mkdir(mode=0o700, exist_ok=False)
    work = destination / "archives"
    work.mkdir()
    rust = destination / "rust"
    if not node_only:
        for pin in pins["rust"]["components"]:
            extracted = fetch(pin, work)
            subprocess.run([str(extracted / "install.sh"), "--prefix=" + str(rust), "--disable-ldconfig"], check=True)
    node = fetch(pins["node"], work)
    pnpm = fetch(pins["pnpm"], work)
    shim = destination / "bin"
    shim.mkdir()
    (shim / "pnpm").write_text('#!/bin/sh\nexec "' + str(node / "bin/node") + '" "' + str(pnpm / "bin/pnpm.cjs") + '" "$@"\n')
    (shim / "pnpm").chmod(0o755)
    paths = [str(node / "bin"), str(shim)]
    overrides = {}
    commands = {"node": [str(node / "bin/node"), "--version"],
                "pnpm": [str(shim / "pnpm"), "--version"],
                "npm": [str(node / "bin/node"), str(node / "lib/node_modules/npm/bin/npm-cli.js"), "--version"]}
    if not node_only:
        paths.insert(0, str(rust / "bin"))
        overrides = {"RUSTC": str(rust / "bin/rustc"), "RUSTDOC": str(rust / "bin/rustdoc")}
        commands.update({"rustc": [str(rust / "bin/rustc"), "-Vv"], "cargo": [str(rust / "bin/cargo"), "-V"],
                         "rustfmt": [str(rust / "bin/rustfmt"), "--version"],
                         "clippy": [str(rust / "bin/cargo-clippy"), "--version"],
                         "cc": ["cc", "--version"], "ld": ["ld", "--version"], "libc": ["ldd", "--version"]})
    env = dict(os.environ, PATH=":".join(paths) + ":" + os.environ["PATH"], **overrides)
    versions = {name: subprocess.check_output(command, env=env, text=True).strip() for name, command in commands.items()}
    if not node_only:
        assert re.search(r"^release: " + re.escape(pins["rust"]["version"]) + r"$", versions["rustc"], re.MULTILINE)
        assert re.search(r"^host: " + re.escape(pins["target"]) + r"$", versions["rustc"], re.MULTILINE)
    assert versions["node"] == "v" + pins["node"]["version"]
    assert versions["pnpm"] == pins["pnpm"]["version"]
    receipt = {"pinsSHA256": digest(PINS), "sourceCommit": os.environ["GITHUB_SHA"],
               "toolset": "node" if node_only else "rust-node",
               "runnerImage": {key: os.environ.get(key) for key in ("ImageOS", "ImageVersion")},
               "osRelease": release, "python": sys.version, "versions": versions,
               "lockfiles": {name: digest(ROOT / name) for name in ("rust/Cargo.lock", "ts/pnpm-lock.yaml")}}
    (destination / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    with open(os.environ["GITHUB_PATH"], "a") as stream:
        stream.write("\n".join(paths) + "\n")
    if overrides:
        with open(os.environ["GITHUB_ENV"], "a") as stream:
            for name, value in overrides.items():
                stream.write(name + "=" + value + "\n")
    print("Installed only digest-verified reviewed build inputs; hosted OS tools remain external inputs.")


def main():
    if not __debug__:
        raise RuntimeError("Input verification requires Python assertions enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--install-node", action="store_true", help="Install only verified Node.js (including npm) and pnpm")
    args = parser.parse_args()
    pins = json.loads(PINS.read_text())
    check_pins(pins)
    check_workflow(pins)
    if args.install or args.install_node:
        install(pins, node_only=args.install_node)
    else:
        print("Reviewed Rust/TS package, interop and npm publisher input bindings are consistent.")


if __name__ == "__main__":
    main()
