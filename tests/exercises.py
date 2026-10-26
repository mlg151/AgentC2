"""Joint Exercise isolation, verification, promotion and retry fixtures."""

from pathlib import Path
from helpers.python_sources import exec_sources
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1] / "electron"
scope = {"__name__": "exercise_fixture"}
for name in ("worktrees.py", "worktree-diff.py", "sitrep.py", "exercises.py", "provider_telemetry.py", "remote.py"):
    exec_sources(scope, (ROOT / name))


class Exercises(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="agentc2-exercise-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        scope["WORKTREE_ROOT"] = self.root / "owned"
        self.git(self.repo, "init", "-q")
        self.git(self.repo, "config", "user.name", "AgentC2 QA")
        self.git(self.repo, "config", "user.email", "qa@example.invalid")
        (self.repo / "file.txt").write_text("base\n")
        self.git(self.repo, "add", "file.txt")
        self.git(self.repo, "commit", "-qm", "base")
        self.base = self.git(self.repo, "rev-parse", "HEAD")
        scope["create"] = lambda payload: {"name": payload["managedName"]}
        self.records = []
        for index in (1, 2):
            result = scope["worktree_launch"]({"operationId": f"{index:032x}", "repository": str(self.repo), "baseRef": self.base,
                                                 "slug": f"contestant-{index}", "provider": "codex", "title": "fixture", "preset": None, "instructions": "same prompt"})
            self.records.append(result["worktree"])

    def git(self, directory, *args):
        return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()

    def request(self, index, **changes):
        return {"operationId": self.records[index]["operationId"], "baseCommit": self.base, **changes}

    def test_common_base_and_isolated_indexes(self):
        first, second = (Path(item["path"]) for item in self.records)
        self.assertNotEqual(first, second)
        self.assertEqual(self.git(first, "rev-parse", "HEAD"), self.git(second, "rev-parse", "HEAD"))
        (first / "file.txt").write_text("first\n")
        self.git(first, "add", "file.txt")
        self.assertEqual((second / "file.txt").read_text(), "base\n")
        self.assertEqual(self.git(second, "status", "--porcelain"), "")

    def test_verification_and_safe_promotion_retry(self):
        first = Path(self.records[0]["path"])
        (first / "file.txt").write_text("winner\n")
        result = scope["exercise_inspect"](self.request(0, testCommand="python3 -c 'print(\"PASS\")'"))
        self.assertEqual(result["test"]["exitCode"], 0)
        self.assertIn("PASS", result["test"]["output"])
        preview = scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)))
        self.assertTrue(preview["ready"])
        self.assertEqual((self.repo / "file.txt").read_text(), "base\n")
        applied = scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
        self.assertTrue(applied["applied"])
        self.assertEqual((self.repo / "file.txt").read_text(), "winner\n")
        retry = scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
        self.assertTrue(retry["alreadyApplied"])

    def test_dirty_target_stale_winner_and_untracked_block(self):
        first = Path(self.records[0]["path"])
        (first / "file.txt").write_text("winner\n")
        result = scope["exercise_inspect"](self.request(0))
        (self.repo / "file.txt").write_text("unrelated\n")
        with self.assertRaisesRegex(ValueError, "dirty"):
            scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
        self.assertEqual((self.repo / "file.txt").read_text(), "unrelated\n")
        (self.repo / "file.txt").write_text("base\n")
        (first / "file.txt").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "Winner changed"):
            scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
        (first / "extra.txt").write_text("untracked")
        result = scope["exercise_inspect"](self.request(0))
        self.assertTrue(result["warnings"])
        with self.assertRaisesRegex(ValueError, "omitted"):
            scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)

    def test_divergent_target_and_failed_verification_are_reported(self):
        first = Path(self.records[0]["path"])
        (first / "file.txt").write_text("candidate\n")
        result = scope["exercise_inspect"](self.request(0, testCommand="python3 -c 'import sys;sys.exit(7)'"))
        self.assertEqual(result["test"]["exitCode"], 7)
        (self.repo / "another.txt").write_text("new base\n")
        self.git(self.repo, "add", "another.txt")
        self.git(self.repo, "commit", "-qm", "target moved")
        with self.assertRaisesRegex(ValueError, "Target HEAD differs"):
            scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
        self.assertEqual((self.repo / "file.txt").read_text(), "base\n")


    def test_capabilities_and_primary_base_admission(self):
        with patch.object(scope["shutil"], "which", side_effect=lambda name: "/fixture/" + name if name in ("codex", "agy") else None):
            self.assertEqual(scope["exercise_capabilities"]({}), {"codex": True, "claude": False, "antigravity": True, "opencode": False})
        self.assertEqual(scope["exercise_base"]({"repository": str(self.repo)}), {"repository": str(self.repo), "baseCommit": self.base})
        for changes in ({"repository": None}, {"repository": ""}, {"baseRef": True}, {"baseRef": "-HEAD"}, {"baseRef": "x" * 201}):
            with self.assertRaisesRegex(ValueError, "repository and base ref"):
                scope["exercise_base"]({"repository": str(self.repo), **changes})
        for directory in (Path(self.records[0]["path"]), self.repo / "subdirectory"):
            directory.mkdir(exist_ok=True)
            with self.assertRaisesRegex(ValueError, "primary repository checkout"):
                scope["exercise_base"]({"repository": str(directory)})
        original = scope["worktree_git"]
        with patch.dict(scope, {"worktree_git": lambda *args, **kwargs: "not-a-commit" if "--end-of-options" in args else original(*args, **kwargs)}):
            with self.assertRaisesRegex(ValueError, "resolve to a commit"):
                scope["exercise_base"]({"repository": str(self.repo)})

    def test_contestant_record_and_ownership_rejection(self):
        for record in (None, {**self.records[0], "state": "ready"}, {**self.records[0], "baseCommit": "f" * 40}):
            with patch.dict(scope, {"worktree_load": Mock(return_value=record)}):
                with self.assertRaisesRegex(ValueError, "owned launched worktree at this base"):
                    scope["exercise_inspect"](self.request(0))
        with patch.dict(scope, {"worktree_state": Mock(return_value={"owned": False, "active": False})}):
            with self.assertRaisesRegex(ValueError, "ownership changed"):
                scope["exercise_inspect"](self.request(0))

    def test_snapshot_limits_binary_lfs_and_git_errors_remain_visible(self):
        first = Path(self.records[0]["path"])
        for data, message in ((b"x" * 530000, "512 KB"), (b"\0binary", "Binary changes"), (b"version https://git-lfs.github.com/spec/v1\n", "Git LFS")):
            with self.subTest(message=message):
                (first / "file.txt").write_bytes(data)
                result = scope["exercise_inspect"](self.request(0))
                self.assertTrue(any(message in warning for warning in result["warnings"]))
        original = scope["diff_git"]
        def fail_patch(record, args, **kwargs):
            if args[0] == "diff":
                raise ValueError("fixture Git unavailable")
            return original(record, args, **kwargs)
        with patch.dict(scope, {"diff_git": fail_patch}):
            with self.assertRaisesRegex(ValueError, "fixture Git unavailable"):
                scope["exercise_inspect"](self.request(0))
        self.assertEqual((self.repo / "file.txt").read_text(), "base\n")

    def test_active_contestant_and_source_mutating_verification(self):
        with patch.dict(scope, {"worktree_state": Mock(return_value={"owned": True, "active": True})}):
            with self.assertRaisesRegex(ValueError, "Mark this active contestant complete"):
                scope["exercise_inspect"](self.request(0, testCommand="printf verified"))
            result = scope["exercise_inspect"](self.request(0, testCommand="printf verified", markedComplete=True))
            self.assertEqual(result["test"]["output"], "verified")
            self.assertTrue(result["active"])
        with self.assertRaisesRegex(ValueError, "Verification changed the contestant"):
            scope["exercise_inspect"](self.request(0, testCommand="printf changed > file.txt"))
        self.assertEqual((Path(self.records[0]["path"]) / "file.txt").read_text(), "changed")
        self.assertEqual((self.repo / "file.txt").read_text(), "base\n")

    def test_promotion_empty_or_foreign_target_and_apply_failures(self):
        result = scope["exercise_inspect"](self.request(0))
        with self.assertRaisesRegex(ValueError, "no tracked changes"):
            scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
        first = Path(self.records[0]["path"])
        (first / "file.txt").write_text("reviewed winner\n")
        result = scope["exercise_inspect"](self.request(0))
        for target in (first, self.repo / "child"):
            target.mkdir(exist_ok=True)
            with self.assertRaisesRegex(ValueError, "exercise's primary checkout"):
                scope["exercise_target"](self.request(0, revision=result["revision"], target=str(target)), True)
        (self.repo / "child").rmdir()
        original = scope["subprocess"].run
        for stage, message in (("check", "Patch conflicts with target"), ("apply", "Promotion failed")):
            def fail_selected(args, **kwargs):
                if len(args) > 3 and args[:4] == ["git", "-C", str(self.repo), "apply"] and ((stage == "check" and "--check" in args) or (stage == "apply" and "--check" not in args)):
                    return subprocess.CompletedProcess(args, 1, b"", b"fixture target error")
                return original(args, **kwargs)
            with patch.object(scope["subprocess"], "run", side_effect=fail_selected):
                with self.assertRaisesRegex(ValueError, message):
                    scope["exercise_target"](self.request(0, revision=result["revision"], target=str(self.repo)), True)
            self.assertEqual((self.repo / "file.txt").read_text(), "base\n")
            self.assertEqual(self.git(self.repo, "diff", "--cached"), "")


if __name__ == "__main__":
    unittest.main()
