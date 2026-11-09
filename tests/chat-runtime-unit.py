"""Pinned runtime provenance and failure boundaries using disposable files only."""
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
import chat_runtime as runtime


class RuntimeBoundaries(unittest.TestCase):
    def test_runtime_directories_reject_symlinks_and_other_owners(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-runtime-unit-") as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()
            link = root / "link"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "Unsupported SDK runtime directory"):
                runtime.private_directory(link)
            with patch.object(runtime.os, "getuid", return_value=os.getuid() + 1):
                with self.assertRaisesRegex(ValueError, "Unsupported SDK runtime directory"):
                    runtime.private_directory(target)
            runtime.private_directory(target)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)

    def test_download_metadata_and_payload_both_require_verified_provenance(self):
        wheel = b"Disposable pip wheel fixture"
        digest = hashlib.sha256(wheel).hexdigest()
        with tempfile.TemporaryDirectory(prefix="agentc2-runtime-unit-") as directory:
            root = Path(directory)
            for url, body, error in [
                ("https://untrusted.invalid/pip.whl", wheel, "Unsupported pip wheel source"),
                ("https://files.pythonhosted.org/fixture.whl", b"corrupted", "verification failed"),
            ]:
                requested = []
                metadata = {"urls": [{"filename": "pip-fixture-py3-none-any.whl", "url": url, "digests": {"sha256": digest}}]}
                def open_url(value, timeout):
                    requested.append((value, timeout))
                    return io.BytesIO(json.dumps(metadata).encode() if value.endswith("/json") else body)
                with patch.object(runtime.urllib.request, "urlopen", side_effect=open_url):
                    with self.assertRaisesRegex(ValueError, error):
                        runtime.pip_wheel(root)
                self.assertFalse((root / "pip-25.3.whl").exists(), "Unverified bytes must not become an executable wheel")
                self.assertEqual(len(requested), 1 if "untrusted" in url else 2)
            metadata["urls"][0]["url"] = "https://files.pythonhosted.org/fixture.whl"
            def trusted(value, timeout):
                return io.BytesIO(json.dumps(metadata).encode() if value.endswith("/json") else wheel)
            with patch.object(runtime.urllib.request, "urlopen", side_effect=trusted):
                cached = runtime.pip_wheel(root)
                self.assertEqual(cached.read_bytes(), wheel)
                self.assertEqual(cached.stat().st_mode & 0o777, 0o600)
            with patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(metadata).encode())) as request:
                self.assertEqual(runtime.pip_wheel(root), cached)
                request.assert_called_once()

    def test_metadata_and_system_environment_never_trigger_unverified_installation(self):
        with patch.object(runtime.importlib.metadata, "version", side_effect=importlib.metadata.PackageNotFoundError("fixture")):
            self.assertFalse(runtime.installed("fixture", "1.0.0"))
        with patch.object(runtime.importlib.metadata, "version", return_value="1.0.0"):
            self.assertTrue(runtime.installed("fixture", "1.0.0"))
            self.assertFalse(runtime.installed("fixture", "2.0.0"))
        with patch.object(runtime, "installed", return_value=True), patch.object(runtime, "pip_wheel") as download:
            runtime.ensure_sdk("codex")
            runtime.ensure_sdk("claude")
            download.assert_not_called()
        with patch.object(runtime, "installed", return_value=False), patch.object(runtime.sys, "prefix", sys.base_prefix):
            with self.assertRaisesRegex(ValueError, "Reconnect through the AgentC2 daemon"):
                runtime.ensure_sdk("claude")
        with tempfile.TemporaryDirectory(prefix="agentc2-runtime-unit-") as directory:
            root = Path(directory)
            with patch.object(runtime, "installed", return_value=False), patch.object(runtime.sys, "prefix", directory):
                with self.assertRaisesRegex(ValueError, "Reconnect through the AgentC2 daemon"):
                    runtime.ensure_sdk("antigravity")
            (root / "pyvenv.cfg").write_text("Disposable runtime fixture\n")
            with patch.object(runtime.sys, "prefix", directory), patch.object(runtime, "installed", side_effect=[False, True]), patch.object(runtime, "pip_wheel") as download:
                runtime.ensure_sdk("claude")
                # Reuse a concurrent successful installation after taking the lock.
                download.assert_not_called()

    def test_install_failure_does_not_echo_pip_diagnostics_and_success_checks_the_pin(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-runtime-unit-") as directory:
            root = Path(directory)
            (root / "pyvenv.cfg").write_text("Disposable runtime fixture\n")
            for returncode, installed in [(1, False), (0, False), (0, True)]:
                result = types.SimpleNamespace(returncode=returncode, stdout=b"PRIVATE_INDEX_FIXTURE", stderr=b"PRIVATE_INDEX_FIXTURE")
                with patch.object(runtime.sys, "prefix", directory), patch.object(runtime, "installed", side_effect=[False, False, installed]), patch.object(runtime, "pip_wheel", return_value=root / "verified.whl"), patch.object(runtime.subprocess, "run", return_value=result) as execute:
                    if returncode or not installed:
                        with self.assertRaisesRegex(ValueError, "Automatic claude-agent-sdk setup failed") as failure:
                            runtime.ensure_sdk("claude")
                        self.assertNotIn("PRIVATE_INDEX_FIXTURE", str(failure.exception))
                    else:
                        runtime.ensure_sdk("claude")
                    args = execute.call_args.args[0]
                    self.assertIn("--isolated", args)
                    self.assertIn("--only-binary=:all:", args)
                    self.assertEqual(args[-1], "claude-agent-sdk==" + runtime.SDK_PACKAGES["claude"][1])
                    self.assertEqual(execute.call_args.kwargs["timeout"], 240)


if __name__ == "__main__":
    unittest.main()
