#!/usr/bin/env python3
"""Offline source/verification tests. No compiler, downloads or installation."""
import hashlib
import importlib.util
import io
import json
import os
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

    def test_ts_and_publisher_bind_the_verified_node_only_installer(self):
        for workflow, job in (("ci.yml", "test-ts"), ("publish-npm.yml", "publish")):
            text = (ci.ROOT / ".github/workflows" / workflow).read_text()
            block = text.split("\n  " + job + ":\n", 1)[1].split("\n  test-rust:\n")[0]
            self.assertIn("python3 rust/scripts/ci-build-inputs.py --install-node", block)
            self.assertNotIn("actions/setup-node", block)
            self.assertNotIn("pnpm/action-setup", block)

    def test_node_only_install_fetches_no_rust_and_exports_no_rust_overrides(self):
        pins = json.loads(ci.PINS.read_text())
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            env = dict(GITHUB_ACTIONS="true", GITHUB_SHA="a" * 40,
                       RUNNER_TEMP=name, GITHUB_PATH=str(root / "path"), GITHUB_ENV=str(root / "env"))
            actual_read = Path.read_text
            def read(path, *args, **kwargs):
                if str(path) == "/etc/os-release":
                    return 'ID=ubuntu\nVERSION_ID="24.04"\n'
                return actual_read(path, *args, **kwargs)
            def fetch(pin, work):
                extracted = work / pin["root"]
                extracted.mkdir()
                return extracted
            def version(command, **_kwargs):
                if command[-1] != "--version":
                    raise AssertionError(command)
                if command[0].endswith("/bin/node"):
                    return "v" + pins["node"]["version"] + "\n" if len(command) == 2 else "11.0.0\n"
                if command[0].endswith("/bin/pnpm"):
                    return pins["pnpm"]["version"] + "\n"
                raise AssertionError(command)
            with patch.dict(os.environ, env), patch.object(ci.platform, "system", return_value="Linux"), \
                 patch.object(ci.platform, "machine", return_value="x86_64"), \
                 patch.object(Path, "read_text", read), patch.object(ci, "fetch", side_effect=fetch) as fetched, \
                 patch.object(ci.subprocess, "run") as run, patch.object(ci.subprocess, "check_output", side_effect=version):
                ci.install(pins, node_only=True)
            self.assertEqual([call.args[0] for call in fetched.call_args_list], [pins["node"], pins["pnpm"]])
            run.assert_not_called()
            self.assertNotIn("/rust/", (root / "path").read_text())
            self.assertFalse((root / "env").exists())
            receipt = json.loads((root / "ndr-ci-tools/receipt.json").read_text())
            self.assertEqual(receipt["toolset"], "node")
            self.assertEqual(set(receipt["versions"]), {"node", "pnpm", "npm"})
            self.assertEqual(receipt["sourceCommit"], env["GITHUB_SHA"])

    def test_workflow_contract_rejects_mutable_runtime_or_changed_publishing_contract(self):
        pins = json.loads(ci.PINS.read_text())
        original = {name: (ci.ROOT / ".github/workflows" / name).read_text()
                    for name in ("ci.yml", "publish-npm.yml")}
        cases = [
            ("ci.yml", "--install-node", "--install"),
            ("ci.yml", "pnpm install --frozen-lockfile", "pnpm install"),
            ("publish-npm.yml", "--install-node", "--install"),
            ("publish-npm.yml", "id-token: write", "id-token: read"),
            ("publish-npm.yml", "NPM_CONFIG_REGISTRY:", "NODE_AUTH_TOKEN: token\n      NPM_CONFIG_REGISTRY:"),
            ("publish-npm.yml", "--ignore-scripts --provenance", "--ignore-scripts"),
            ("publish-npm.yml", "registry.npmjs.org", "example.invalid"),
            ("publish-npm.yml", "event=push&head_sha=$GITHUB_SHA&status=success", "status=success"),
        ]
        for workflow, old, new in cases:
            with self.subTest(workflow=workflow, mutation=old):
                changed = dict(original)
                self.assertIn(old, changed[workflow])
                changed[workflow] = changed[workflow].replace(old, new, 1)
                with self.assertRaises(AssertionError):
                    ci.check_workflow(pins, changed)

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
            for algorithm, length in (("sha256", 64), ("sha512", 128)):
                with self.subTest(algorithm=algorithm), patch.object(ci.tarfile, "open") as opened:
                    with self.assertRaises(ValueError):
                        ci.unpack_verified(archive, {algorithm: "0" * length, "root": "package"}, root)
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
