"""Disposable Git repository checks for owned worktree lifecycle."""

from pathlib import Path
from helpers.python_sources import exec_sources
import base64
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
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
        exec_sources(self.scope, *(source / name for name in ("worktrees.py", "provider_telemetry.py", "remote.py")))
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

    def test_reviewed_recovery_is_revision_bound_and_serialized(self):
        payload = self.payload(15)
        self.created.side_effect = RuntimeError("provider launch failed")
        with self.assertRaises(RuntimeError):
            self.scope["worktree_launch"](payload)
        record = self.scope["worktree_list"]()[0]
        revision = lambda item: hashlib.sha256(json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        reviewed = {**payload, "expectedWorktreeRevision": revision(record)}
        self.created.side_effect = lambda item: {"name": item["managedName"]}
        with self.assertRaisesRegex(ValueError, "appeared after admission"):
            self.scope["worktree_launch"]({**payload, "expectedWorktreeRevision": "absent"})
        dirty = Path(record["path"]) / "changed.txt"
        dirty.write_text("Unreviewed\n")
        with self.assertRaisesRegex(ValueError, "revision changed"):
            self.scope["worktree_launch"](reviewed)
        # Even a digest of a dirty snapshot cannot authorize this recovery path.
        with self.assertRaisesRegex(ValueError, "revision changed"):
            self.scope["worktree_launch"]({**payload, "expectedWorktreeRevision": revision(self.scope["worktree_list"]()[0])})
        dirty.unlink()
        original_state = self.scope["worktree_state"]
        self.scope["worktree_state"] = lambda item: {**original_state(item), "active": True}
        active = self.scope["worktree_list"]()[0]
        with self.assertRaisesRegex(ValueError, "revision changed"):
            self.scope["worktree_launch"]({**payload, "expectedWorktreeRevision": revision(active)})
        self.scope["worktree_state"] = original_state
        changed = {key: value for key, value in record.items() if key != "status"}
        changed["title"] = "Changed ownership record"
        self.scope["worktree_save"](changed)
        with self.assertRaisesRegex(ValueError, "revision changed"):
            self.scope["worktree_launch"](reviewed)
        self.scope["worktree_save"]({key: value for key, value in record.items() if key != "status"})
        def attempt(_index):
            try:
                self.scope["worktree_launch"](reviewed)
                return "launched"
            except ValueError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(results.count("launched"), 1)
        self.assertTrue(any("revision changed" in result for result in results))
        self.assertEqual(self.created.call_count, 2, "Only the failed initial attempt and one recovery may dispatch")

    def test_sitrep_patch_is_applied_once_before_retryable_launch(self):
        (self.repo / "README.md").write_text("fixture\nhandoff\n")
        patch = subprocess.check_output(["git", "-C", str(self.repo), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", "HEAD"])
        payload = self.payload(11)
        payload["sitrep"] = {"patchBase64": base64.b64encode(patch).decode(), "digest": hashlib.sha256(patch).hexdigest(), "source": {"hostId": "qa", "operationId": "source"}}
        self.created.side_effect = RuntimeError("provider launch failed")
        with self.assertRaisesRegex(RuntimeError, "provider launch failed"):
            self.scope["worktree_launch"](payload)
        record = self.scope["worktree_list"]()[0]
        self.assertEqual(record["sitrepApplied"], payload["sitrep"]["digest"])
        worktree = Path(record["path"])
        self.assertEqual((worktree / "README.md").read_text(), "fixture\nhandoff\n")
        self.created.side_effect = lambda command: {"name": command["managedName"]}
        self.scope["worktree_launch"](payload)
        self.assertEqual((worktree / "README.md").read_text(), "fixture\nhandoff\n")

    def test_ready_sitrep_can_recover_after_restart_without_reapplying(self):
        (self.repo / "README.md").write_text("fixture\nhandoff\n")
        patch = subprocess.check_output(["git", "-C", str(self.repo), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", "HEAD"])
        payload = self.payload(12)
        payload["sitrep"] = {"patchBase64": base64.b64encode(patch).decode(), "digest": hashlib.sha256(patch).hexdigest(), "source": {"hostId": "qa", "operationId": "source"}}
        self.created.side_effect = RuntimeError("launch disconnected")
        with self.assertRaisesRegex(RuntimeError, "launch disconnected"):
            self.scope["worktree_launch"](payload)
        record = self.scope["worktree_list"]()[0]
        worktree = Path(record["path"])
        recovery = {**self.payload(12), "instructions": "Re-entered objective", "recoverSitrep": True}
        (worktree / "README.md").write_text("unexpected change\n")
        with self.assertRaisesRegex(ValueError, "changed after transfer"):
            self.scope["worktree_launch"](recovery)
        (worktree / "README.md").write_text("fixture\nhandoff\n")
        self.created.side_effect = lambda command: {"name": command["managedName"]}
        result = self.scope["worktree_launch"](recovery)
        self.assertEqual(result["worktree"]["sitrepSource"]["operationId"], "source")
        self.assertEqual((worktree / "README.md").read_text(), "fixture\nhandoff\n")

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
        current = self.scope["worktree_list"]()[0]["status"]["headCommit"]
        with self.assertRaisesRegex(ValueError, "HEAD changed"):
            self.scope["worktree_archive"]({"operationId": record["operationId"], "expectedHeadCommit": "a" * 40})
        self.assertTrue(path.exists())
        archived = self.scope["worktree_archive"]({"operationId": record["operationId"], "expectedHeadCommit": current})
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
