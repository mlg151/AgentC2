"""Disposable SitRep source evidence and target compatibility fixtures."""
import base64
import os
from pathlib import Path
from helpers.python_sources import exec_sources
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
scope = {"__name__": "agentc2_sitrep_test"}
exec_sources(scope, (ROOT / "electron" / "worktree-diff.py"))
exec_sources(scope, (ROOT / "electron" / "sitrep.py"))


class SitRep(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="agentc2-sitrep-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.source.mkdir()
        self.git(self.source, "init", "-q")
        self.git(self.source, "config", "user.name", "AgentC2 QA")
        self.git(self.source, "config", "user.email", "qa@example.invalid")
        (self.source / "tracked.txt").write_text("one\ntwo\n")
        self.git(self.source, "add", "tracked.txt")
        self.git(self.source, "commit", "-qm", "base")
        self.base = self.git(self.source, "rev-parse", "HEAD").strip()
        subprocess.run(["git", "clone", "-q", str(self.source), str(self.target)], check=True)
        self.record = {"operationId": "a" * 32, "name": "hq-" + "a" * 12, "repository": str(self.source),
                       "branch": "task", "baseCommit": self.base, "path": str(self.source)}
        scope["diff_unit"] = lambda _payload: self.record

    def git(self, directory, *args):
        return subprocess.check_output(["git", "-C", str(directory), *args], text=True)

    def preview(self, command=""):
        return scope["sitrep_source_preview"]({"operationId": self.record["operationId"], "name": self.record["name"], "testCommand": command})

    def test_patch_and_real_test_evidence_apply_to_matching_base(self):
        (self.source / "tracked.txt").write_text("one\nchanged\n")
        evidence = self.preview("python3 -c 'print(\"SITREP_TEST_OK\")'")
        self.assertEqual(evidence["version"], 1)
        self.assertEqual(evidence["test"]["exitCode"], 0)
        self.assertGreater(evidence["test"]["ranAt"], 0)
        self.assertIn("SITREP_TEST_OK", evidence["test"]["output"])
        self.assertFalse(evidence["warnings"])
        target = scope["sitrep_target_preview"]({"repository": str(self.target), "source": evidence["source"], "patchBase64": evidence["patchBase64"]})
        self.assertTrue(target["ready"])
        self.assertEqual((self.target / "tracked.txt").read_text(), "one\ntwo\n", "Preview must not change target")
        self.assertIn(b"+changed", base64.b64decode(evidence["patchBase64"]))
        (self.source / "tracked.txt").write_text("one\nchanged again\n")
        self.assertNotEqual(self.preview()["revision"], evidence["revision"])

    def test_untracked_and_missing_base_are_explicit(self):
        (self.source / "untracked.txt").write_text("not in patch")
        evidence = self.preview()
        self.assertEqual(evidence["untracked"], ["untracked.txt"])
        self.assertTrue(any("Untracked" in warning for warning in evidence["warnings"]))
        missing = scope["sitrep_target_preview"]({"repository": str(self.target), "source": {"baseCommit": "f" * 40}, "patchBase64": ""})
        self.assertFalse(missing["ready"])
        self.assertIn("base commit", missing["reason"])

    def test_binary_warning_and_failed_test_are_not_misreported(self):
        (self.source / "tracked.txt").write_bytes(b"\x00\x01\x02")
        evidence = self.preview("python3 -c 'import sys; sys.exit(3)'")
        self.assertEqual(evidence["test"]["exitCode"], 3)
        self.assertTrue(any("Binary" in warning for warning in evidence["warnings"]))

    def test_test_mutation_and_incompatible_patch_are_reported(self):
        evidence = self.preview("python3 -c 'from pathlib import Path; Path(\"tracked.txt\").write_text(\"changed\\n\")'")
        self.assertTrue(any("test command changed" in warning for warning in evidence["warnings"]))
        incompatible = scope["sitrep_target_preview"]({"repository": str(self.target), "source": evidence["source"],
                                                        "patchBase64": base64.b64encode(b"not a git patch").decode()})
        self.assertFalse(incompatible["ready"])
        self.assertIn("does not apply", incompatible["reason"])

    def test_lfs_pointer_requires_separate_object_transfer(self):
        (self.source / "tracked.txt").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:" + "a" * 64 + "\nsize 42\n")
        evidence = self.preview()
        self.assertTrue(any("Git LFS" in warning for warning in evidence["warnings"]))

    def test_oversized_patch_blocks_transfer(self):
        (self.source / "tracked.txt").write_text("x" * 530000 + "\n")
        evidence = self.preview()
        self.assertEqual(evidence["patchBase64"], "")
        self.assertTrue(any("512 KB" in warning for warning in evidence["warnings"]))


if __name__ == "__main__":
    unittest.main()
