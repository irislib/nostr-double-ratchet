#!/usr/bin/env python3
"""Offline source/verification tests. No compiler, downloads or installation."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ci_build_inputs", Path(__file__).with_name("ci-build-inputs.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class BuildInputsTests(unittest.TestCase):
    def test_reviewed_pins_match_package_and_affected_workflows(self):
        pins = json.loads(ci.PINS.read_text())
        ci.check_pins(pins)
        ci.check_workflow(pins)

    def test_mutable_action_is_rejected(self):
        pins = json.loads(ci.PINS.read_text())
        pins["rustCacheAction"] = "Swatinem/rust-cache@v2"
        with self.assertRaises(AssertionError):
            ci.check_pins(pins)

    def test_bad_digest_rejects_archive_before_parsing(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive = root / "payload.tar.xz"
            archive.write_bytes(b"unverified payload")
            with patch.object(ci.tarfile, "open") as opened:
                with self.assertRaises(ValueError):
                    ci.unpack_verified(archive, {"sha256": "0" * 64, "root": "package"}, root)
                opened.assert_not_called()

    def test_both_publisher_digest_algorithms_accept_exact_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            archive = Path(name) / "payload"
            archive.write_bytes(b"synthetic reviewed payload")
            for algorithm in ("sha256", "sha512"):
                ci.verify_archive(archive, {algorithm: hashlib.new(algorithm, archive.read_bytes()).hexdigest()})

    def test_verified_archive_extraction_requires_expected_root(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            archive = root / "payload.tar"
            with tarfile.open(archive, "w") as output:
                member = tarfile.TarInfo("unexpected/payload")
                member.size = 1
                output.addfile(member, io.BytesIO(b"x"))
            pin = {"root": "package", "sha256": ci.digest(archive)}
            with self.assertRaises(AssertionError):
                ci.unpack_verified(archive, pin, root)
            self.assertFalse((root / "unexpected").exists())


if __name__ == "__main__":
    unittest.main()
