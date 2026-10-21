"""Disposable Git repository checks for owned worktree lifecycle."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock


class Worktrees(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentc2-worktrees-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repository"
        self.repo.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True).strip()
        self.git = git
        git("init", "-q")
        git("config", "user.name", "AgentC2 fixture")
        git("config", "user.email", "fixture@example.invalid")
        (self.repo / "README.md").write_text("fixture\n")
        git("add", "README.md")
        git("commit", "-qm", "Base")
        source = (Path(__file__).resolve().parents[1] / "electron")
        self.scope = {"__name__": "worktree_fixture"}
        exec((source / "worktrees.py").read_text() + "\n" + (source / "provider_telemetry.py").read_text() + "\n" + (source / "remote.py").read_text(), self.scope)
        self.scope["WORKTREE_ROOT"] = self.root / "owned"
        self.created = Mock(side_effect=lambda payload: {"name": payload["managedName"]})
        self.scope["create"] = self.created

    def payload(self, number, slug="task", ref="HEAD"):
        return {"operationId": f"{number:032x}", "repository": str(self.repo), "baseRef": ref, "slug": slug,
                "provider": "codex", "title": slug, "preset": None, "instructions": ""}

    def test_parallel_isolation_and_idempotent_retry(self):
        first = self.scope["worktree_launch"](self.payload(1))
        from_secondary = {**self.payload(7), "repository": first["worktree"]["path"]}
        with self.assertRaisesRegex(ValueError, "primary repository"):
            self.scope["worktree_launch"](from_secondary)
        second = self.scope["worktree_launch"](self.payload(2))
        self.assertNotEqual(first["worktree"]["path"], second["worktree"]["path"])
        self.assertNotEqual(first["worktree"]["branch"], second["worktree"]["branch"])
        self.assertEqual(self.git("status", "--porcelain"), "")
        with self.assertRaisesRegex(ValueError, "already launched"):
            self.scope["worktree_launch"](self.payload(1))
        self.assertEqual(self.created.call_count, 2)
        self.assertTrue(all(item["status"]["owned"] for item in self.scope["worktree_list"]()))

    def test_invalid_ref_launch_failure_and_recoverable_retry(self):
        with self.assertRaises(ValueError):
            self.scope["worktree_launch"](self.payload(3, ref="missing-ref"))
        self.assertEqual(self.scope["worktree_list"](), [])
        self.created.side_effect = RuntimeError("provider launch failed")
        with self.assertRaisesRegex(RuntimeError, "provider launch failed"):
            self.scope["worktree_launch"](self.payload(3))
        record = self.scope["worktree_list"]()[0]
        self.assertEqual(record["state"], "ready")
        self.assertTrue(record["status"]["owned"])
        self.created.side_effect = lambda payload: {"name": payload["managedName"]}
        self.scope["worktree_launch"](self.payload(3))
        self.assertEqual(self.scope["worktree_list"]()[0]["state"], "launched")
        with self.assertRaisesRegex(ValueError, "belongs"):
            self.scope["worktree_launch"](self.payload(3, slug="other"))

    def test_preexisting_branch_collision_is_left_untouched(self):
        import hashlib
        payload = self.payload(8)
        token = hashlib.sha256(payload["operationId"].encode()).hexdigest()
        branch = f"agentc2/task-{token[:16]}"
        self.git("branch", branch)
        before = self.git("rev-parse", branch)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.scope["worktree_launch"](payload)
        self.assertEqual(self.git("rev-parse", branch), before)
        self.assertEqual(self.scope["worktree_list"](), [])

    def test_ssh_loss_after_branch_creation_reuses_recorded_commit(self):
        payload = self.payload(5)
        operation_id = payload["operationId"]
        import hashlib
        token = hashlib.sha256(operation_id.encode()).hexdigest()
        branch = f"agentc2/task-{token[:16]}"
        path = self.scope["WORKTREE_ROOT"] / "paths" / hashlib.sha256(str(self.repo).encode()).hexdigest()[:16] / operation_id
        commit = self.git("rev-parse", "HEAD")
        request = {key: payload.get(key) for key in ("provider", "title", "preset", "instructions")}
        request.update({"repository": str(self.repo), "baseRef": "HEAD", "branch": branch, "path": str(path), "name": f"hq-{token[:12]}"})
        import json
        digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        record = {"operationId": operation_id, "requestDigest": digest, "repository": str(self.repo), "baseRef": "HEAD", "baseCommit": commit, "branch": branch, "path": str(path), "name": f"hq-{token[:12]}", "provider": "codex", "state": "provisioning"}
        self.scope["worktree_save"](record)
        self.git("branch", branch, commit)
        created = self.scope["worktree_launch"](payload)
        self.assertEqual(created["worktree"]["state"], "launched")
        self.assertTrue(path.is_dir())

    def test_archive_preserves_dirty_unmerged_and_unowned_files(self):
        record = self.scope["worktree_launch"](self.payload(4))["worktree"]
        path = Path(record["path"])
        unrelated = self.root / "unrelated.txt"
        unrelated.write_text("safe")
        (path / "dirty.txt").write_text("work")
        with self.assertRaisesRegex(ValueError, "clean"):
            self.scope["worktree_archive"]({"operationId": record["operationId"]})
        (path / "dirty.txt").unlink()
        subprocess.run(["git", "-C", str(path), "commit", "--allow-empty", "-qm", "Unmerged"], check=True)
        with self.assertRaisesRegex(ValueError, "merged"):
            self.scope["worktree_archive"]({"operationId": record["operationId"]})
        self.assertTrue(path.exists() and unrelated.exists())
        self.git("merge", "--ff-only", record["branch"])
        archived = self.scope["worktree_archive"]({"operationId": record["operationId"]})
        self.assertEqual(archived["state"], "archived")
        self.assertFalse(path.exists())
        self.assertTrue(unrelated.exists())

    def test_archive_rejects_record_redirected_to_unowned_worktree(self):
        record = self.scope["worktree_launch"](self.payload(6))["worktree"]
        outside = self.root / "outside-managed-root"
        self.git("worktree", "move", record["path"], str(outside))
        record["path"] = str(outside)
        self.scope["worktree_save"](record)
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.scope["worktree_archive"]({"operationId": record["operationId"]})
        self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
