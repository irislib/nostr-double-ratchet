"""Prepare isolated, pinned engine sources. Usage: prepare.py {ndr,mdk} EMPTY_DIRECTORY"""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess


HERE = Path(__file__).resolve().parent
BASELINE_NDR = "37c4733c73fa1c5104c1e9a01bff19a0bead5edf"
BASELINE_IRIS = "8fa4f1fb8fbb7e8efdb97d98d3572b72be629334"
NDR = "b062debb55502033fc59804dcc94025f49f82547"
IRIS = "a721434ba675ba0c1e3300afa0e75677c7167446"
RELEASE_NDR = "ecc81c4e1fe73fb84c520fbc1b7d31fd9fc90185"
RELEASE_IRIS = "6a989bb8010013ae85330a1f22f99698c44c196f"
MDK = "6f6d2017de1f2cc595cc10da9d575f3aa16cb21e"


def archive(repo, rev, dest, *paths):
    dest.mkdir()
    with subprocess.Popen(["git", "-C", repo, "archive", rev, *paths], stdout=subprocess.PIPE) as git:
        subprocess.run(["tar", "-x", "-C", dest], stdin=git.stdout, check=True)
        if git.wait():
            raise RuntimeError(f"git archive failed for {rev}")


def replace(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise ValueError(f"unexpected source in {path}")
    path.write_text(text.replace(old, new))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", choices=["mdk", "ndr"])
    parser.add_argument("output", type=Path)
    version = parser.add_mutually_exclusive_group()
    version.add_argument("--baseline", action="store_true", help="prepare the per-device NDR comparison build")
    version.add_argument("--release", action="store_true", help="use the pinned 0.0.179 / 0.3.18 sources")
    args = parser.parse_args()
    if (args.baseline or args.release) and args.engine != "ndr":
        parser.error("version selection applies only to NDR")
    dest = args.output.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.iterdir()):
        parser.error("select an empty build directory")
    shutil.copytree(HERE / "simnet", dest / "simnet", ignore=shutil.ignore_patterns("target"))
    if args.engine == "mdk":
        archive(os.getenv("MDK_REPO", HERE.parents[2] / "mdk"), MDK, dest / "mdk")
        crate = dest / "mdk/crates/cgka-conformance-simulator"
        shutil.copy(HERE / "mdk-adapter/ndr_compare.rs", crate / "src")
        (crate / "src/bin").mkdir(exist_ok=True)
        shutil.copy(HERE / "mdk-adapter/sim_mdk.rs", crate / "src/bin")
        replace(crate / "Cargo.toml", "[dependencies]", '[dependencies]\nsimnet = { path = "../../../simnet" }')
        with (crate / "src/lib.rs").open("a") as source:
            source.write("\npub mod ndr_compare;\n")
        subprocess.run(["git", "apply", str(HERE / "mdk-adapter/simnet-lock.patch")],
                       cwd=dest / "mdk", check=True)
        return
    ndr, iris = (BASELINE_NDR, BASELINE_IRIS) if args.baseline else (NDR, IRIS)
    if args.release:
        ndr, iris = RELEASE_NDR, RELEASE_IRIS
    archive(HERE.parents[1], ndr, dest / "ndr", "rust")
    archive(os.getenv("IRIS_REPO", HERE.parents[2] / "iris-chat-rs"), iris, dest / "iris", "chat-protocol")
    shutil.copytree(HERE / "ndr", dest / "sim-ndr")
    if args.release:
        # Both are local path dependencies. All registry and Git packages retain their pins.
        lock = dest / "sim-ndr/Cargo.lock"
        replace(lock, 'name = "iris-chat-protocol"\nversion = "0.3.17"',
                      'name = "iris-chat-protocol"\nversion = "0.3.18"')
        replace(lock, 'name = "nostr-double-ratchet"\nversion = "0.0.178"',
                      'name = "nostr-double-ratchet"\nversion = "0.0.179"')
    protocol = dest / "iris/chat-protocol"
    library = dest / "ndr/rust/crates/nostr-double-ratchet"
    for name in ["nostr-double-ratchet", "nostr-double-ratchet-pairwise-codec"]:
        manifest = protocol / "Cargo.toml"
        line = next(line for line in manifest.read_text().splitlines() if line.startswith(name + " = "))
        replace(manifest, line, f'{name} = {{ path = "../../ndr/rust/crates/{name}" }}')
    for root in [library, protocol]:
        for source in (root / "src").rglob("*.rs"):
            text = source.read_text()
            text = re.sub(r"(?:std::time::)?SystemTime::now\(\)", "crate::sim_clock::system_now()", text)
            if root == protocol:
                text = text.replace("std::time::Instant::now()", "crate::sim_clock::instant_now()")
            if "use std::time::{SystemTime, UNIX_EPOCH};" in text and text.count("SystemTime") == 1:
                text = text.replace("use std::time::{SystemTime, UNIX_EPOCH};", "use std::time::UNIX_EPOCH;")
            source.write_text(text)
    shutil.copy(HERE / "sim_clock.rs", library / "src")
    for root, declaration in [(library, "pub mod sim_clock;"), (protocol, "pub use nostr_double_ratchet::sim_clock;")]:
        with (root / "src/lib.rs").open("a") as source:
            source.write(f"\n{declaration}\n")


if __name__ == "__main__":
    main()
