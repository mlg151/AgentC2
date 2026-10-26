"""Bounded verification commands and strict read-only SitRep target admission."""

import base64
import subprocess
import unittest
from unittest.mock import patch

import sitrep as fixtures

scope = fixtures.scope


class SitRepBoundaries(unittest.TestCase):
    setUp = fixtures.SitRep.setUp
    git = fixtures.SitRep.git
    preview = fixtures.SitRep.preview

    def preview_target(self, **changes):
        return scope["sitrep_target_preview"]({"repository": str(self.target), "source": {"baseCommit": self.base}, "patchBase64": "", **changes})

    def test_verification_command_validation_and_bounded_tail(self):
        for command in (True, "x" * 501, "printf ok\0printf bad"):
            with self.subTest(command_type=type(command).__name__), self.assertRaisesRegex(ValueError, "at most 500"):
                scope["sitrep_test"](self.source, command)
        result = scope["sitrep_test"](self.source, "python3 -c 'print(\"x\" * 10000)'")
        self.assertEqual(result["exitCode"], 0)
        self.assertTrue(result["outputTruncated"])
        self.assertEqual(result["output"], "x" * 7999 + "\n")
        self.assertFalse(result["timedOut"])

    def test_verification_timeout_kills_and_reaps_only_its_process_group(self):
        original_popen = scope["subprocess"].Popen
        original_kill = scope["os"].killpg
        processes = []
        def start(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            processes.append(process)
            return process
        for vanished_after_kill in (False, True):
            killed = []
            def kill(pid, sig):
                self.assertEqual(pid, processes[-1].pid)
                killed.append(pid)
                original_kill(pid, sig)
                if vanished_after_kill:
                    raise ProcessLookupError("fixture exit raced with group cleanup")
            with patch.object(scope["subprocess"], "Popen", side_effect=start), patch.object(scope["os"], "killpg", side_effect=kill), patch.object(scope["time"], "monotonic", side_effect=[0, 26, 27]):
                result = scope["sitrep_test"](self.source, "sleep 20")
            self.assertTrue(result["timedOut"])
            self.assertIsNone(result["exitCode"], "A timeout must not be reported as a successful test")
            self.assertEqual(killed, [processes[-1].pid])
            self.assertIsNotNone(processes[-1].poll())
            self.assertTrue(processes[-1].stdout.closed)

    def test_git_errors_and_unverified_source_base_preserve_work(self):
        before = (self.source / "tracked.txt").read_bytes()
        with self.assertRaisesRegex(ValueError, "fixture Git failure"):
            with patch.object(scope["subprocess"], "run", return_value=subprocess.CompletedProcess([], 1, b"", b"fixture Git failure")):
                scope["sitrep_git"](self.source, ["status"])
        with patch.object(scope["subprocess"], "run", return_value=subprocess.CompletedProcess([], 1, b"", b"")):
            with self.assertRaisesRegex(ValueError, "Git command failed"):
                scope["sitrep_git"](self.source, ["status"])
        self.record["baseCommit"] = "not-a-commit"
        with self.assertRaisesRegex(ValueError, "verified base commit"):
            self.preview()
        self.record["baseCommit"] = self.base
        original = scope["diff_git"]
        def fail_patch(record, args, **kwargs):
            if args[0] == "diff":
                raise ValueError("fixture diff unavailable")
            return original(record, args, **kwargs)
        with patch.dict(scope, {"diff_git": fail_patch}):
            with self.assertRaisesRegex(ValueError, "fixture diff unavailable"):
                self.preview()
        self.assertEqual((self.source / "tracked.txt").read_bytes(), before)

    def test_verification_that_exceeds_diff_limit_invalidates_preview(self):
        result = self.preview("python3 -c 'from pathlib import Path; Path(\"tracked.txt\").write_text(\"x\" * 530000)'")
        self.assertEqual(result["test"]["exitCode"], 0)
        self.assertTrue(any("test command changed the source" in warning for warning in result["warnings"]))
        self.assertEqual(result["patchBytes"], 0, "Pre-test source evidence is not silently replaced with post-test changes")

    def test_target_requires_valid_canonical_primary_checkout_and_bounded_patch(self):
        before = (self.target / "tracked.txt").read_bytes()
        for value in (None, 1, "relative", "/" + "x" * 4097):
            with self.subTest(repository_type=type(value).__name__), self.assertRaisesRegex(ValueError, "Invalid SitRep target"):
                self.preview_target(repository=value)
        with self.assertRaisesRegex(ValueError, "Invalid SitRep target"):
            self.preview_target(source={"baseCommit": "bad"})
        alias = self.root / "alias"
        alias.symlink_to(self.target, target_is_directory=True)
        for path in (alias, self.root / "missing", self.target / "tracked.txt"):
            with self.assertRaisesRegex(ValueError, "real primary Git checkout"):
                self.preview_target(repository=str(path))
        child = self.target / "child"
        child.mkdir()
        with self.assertRaisesRegex(ValueError, "primary checkout root"):
            self.preview_target(repository=str(child))
        secondary = self.root / "secondary"
        self.git(self.target, "worktree", "add", "-q", "-b", "fixture-secondary", str(secondary))
        with self.assertRaisesRegex(ValueError, "primary checkout root"):
            self.preview_target(repository=str(secondary))
        with self.assertRaisesRegex(ValueError, "exceeds 512 KB"):
            self.preview_target(patchBase64=base64.b64encode(b"x" * 512001).decode())
        self.assertEqual(self.preview_target(), {"ready": True, "reason": "", "repository": str(self.target)})
        self.assertEqual((self.target / "tracked.txt").read_bytes(), before)
        self.assertEqual(self.git(self.target, "diff", "--cached"), "")


if __name__ == "__main__":
    unittest.main()
