"""Revision-checked, single-hunk Git action tests in a disposable repository."""

import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest


class DiffActions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentc2-diff-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "base"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "changes.txt").write_text("".join(f"line {n}\n" for n in range(1, 31)))
        (self.repo / "space ü\nname.txt").write_text("original\n")
        (self.repo / "binary.bin").write_bytes(b"\0\1\2")
        (self.repo / "large.txt").write_text("small\n")
        self.git("add", ".")
        self.git("commit", "-qm", "Base")
        source = Path(__file__).resolve().parents[1] / "electron"
        self.scope = {"__name__": "diff_fixture"}
        exec("\n".join((source / name).read_text() for name in ("worktrees.py", "worktree-diff.py", "provider_telemetry.py", "remote.py")), self.scope)
        self.scope["WORKTREE_ROOT"] = self.root / "owned"
        self.scope["create"] = lambda payload: {"name": payload["managedName"]}
        self.operation = "a" * 32
        created = self.scope["worktree_launch"]({"operationId": self.operation, "repository": str(self.repo), "baseRef": "HEAD", "slug": "diff-qa", "provider": "codex", "title": "Fixture", "preset": None, "instructions": ""})
        self.record = created["worktree"]
        self.worktree = Path(self.record["path"])
        self.scope["worktree_state"] = lambda _record, _detailed=True: {"owned": True, "active": True}
        self.scope["tmux_option"] = lambda name, option: self.operation if option == "@hq_worktree" else str(self.worktree) if option == "@hq_cwd" else ""
        self.request = {"operationId": self.operation, "name": self.record["name"]}

    def git(self, *args, cwd=None):
        return subprocess.check_output(["git", "-C", str(cwd or self.repo), *args], text=True).strip()

    def file(self, name):
        return next(item for item in self.scope["diff_files"](self.request) if item["path"] == name)

    def detail(self, file):
        return self.scope["diff_detail"]({**self.request, "fileId": file["id"]})

    def act(self, file, detail, hunk, operation):
        return self.scope["diff_hunk_action"]({**self.request, "fileId": file["id"], "revision": detail["revision"], "hunkId": hunk["id"], "operation": operation})

    def test_readonly_artifact_revision_bounds_and_path_isolation(self):
        target = self.worktree / "verification.txt"
        target.write_text("PASS fixture checks\n")
        status = self.git("status", "--porcelain", cwd=self.worktree)
        request = {"operationId": self.operation, "path": "verification.txt"}
        artifact = self.scope["artifact_read"](request)
        self.assertEqual(artifact["text"], target.read_text())
        self.assertEqual(artifact["revision"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(self.git("status", "--porcelain", cwd=self.worktree), status)
        target.write_text("Changed result\n")
        with self.assertRaisesRegex(ValueError, "revision changed"):
            self.scope["artifact_read"]({**request, "revision": artifact["revision"]})
        (self.worktree / "outside-link").symlink_to(self.repo / "changes.txt")
        (self.worktree / "directory-link").symlink_to(self.repo, target_is_directory=True)
        for name in ("../changes.txt", "/etc/passwd", ".env", ".git/config", "outside-link", "directory-link/changes.txt", "binary.bin"):
            with self.subTest(name=name), self.assertRaises((ValueError, OSError)):
                self.scope["artifact_read"]({**request, "path": name})
        (self.worktree / "large.txt").write_text("x" * 256001)
        with self.assertRaisesRegex(ValueError, "256000"):
            self.scope["artifact_read"]({**request, "path": "large.txt"})
        with self.assertRaisesRegex(ValueError, "owned"):
            self.scope["artifact_read"]({**request, "operationId": "b" * 32})

    def test_stage_one_hunk_revert_another_and_reject_stale(self):
        path = self.worktree / "changes.txt"
        text = path.read_text().replace("line 2\n", "line TWO\n").replace("line 25\n", "line TWENTYFIVE\n")
        path.write_text(text)
        file = self.file("changes.txt")
        detail = self.detail(file)
        self.assertEqual(len(detail["unstaged"]), 2)
        self.act(file, detail, detail["unstaged"][0], "stage")
        staged = self.git("diff", "--cached", "--", "changes.txt", cwd=self.worktree)
        self.assertIn("line TWO", staged)
        self.assertNotIn("line TWENTYFIVE", staged)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.act(file, detail, detail["unstaged"][1], "revert")
        current = self.detail(file)
        self.assertEqual(len(current["unstaged"]), 1)
        self.act(file, current, current["unstaged"][0], "revert")
        self.assertIn("line 25\n", path.read_text())
        self.assertIn("line TWO\n", path.read_text())
        self.assertTrue(self.file("changes.txt")["staged"])

    def test_unusual_name_rename_binary_large_and_external_edit(self):
        with self.assertRaisesRegex(ValueError, "no owned worktree"):
            self.scope["diff_files"]({**self.request, "name": "hq-123456abcdef"})
        strange = self.worktree / "space ü\nname.txt"
        strange.write_text("updated\n")
        file = self.file(strange.name)
        detail = self.detail(file)
        self.assertEqual(len(detail["unstaged"]), 1)
        strange.write_text("another agent changed it\n")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.act(file, detail, detail["unstaged"][0], "stage")
        self.assertEqual(strange.read_text(), "another agent changed it\n")
        (self.worktree / "binary.bin").write_bytes(b"\0\3\4")
        self.assertTrue(self.detail(self.file("binary.bin"))["binary"])
        (self.worktree / "large.txt").write_text("x" * 600_000)
        self.assertTrue(self.detail(self.file("large.txt"))["large"])
        self.git("mv", "space ü\nname.txt", "renamed ü\nname.txt", cwd=self.worktree)
        paths = {item["path"] for item in self.scope["diff_files"](self.request)}
        self.assertIn("space ü\nname.txt", paths)
        self.assertIn("renamed ü\nname.txt", paths)


if __name__ == "__main__":
    unittest.main()
