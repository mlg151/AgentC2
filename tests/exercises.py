"""Joint Exercise isolation, verification, promotion and retry fixtures."""

from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / "electron"
scope = {"__name__": "exercise_fixture"}
for name in ("worktrees.py", "worktree-diff.py", "sitrep.py", "exercises.py", "provider_telemetry.py", "remote.py"):
    exec((ROOT / name).read_text(), scope)


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


if __name__ == "__main__":
    unittest.main()
