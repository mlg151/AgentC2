"""Admission, crash recovery, and ownership boundaries of disposable worktrees."""

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

import worktrees


class WorktreeBoundaries(unittest.TestCase):
    setUp = worktrees.Worktrees.setUp
    payload = worktrees.Worktrees.payload
    def call(self, name, *args):
        return self.scope[name](*args)

    def ready(self, number=100, **changes):
        payload = {**self.payload(number), **changes}
        self.created.side_effect = RuntimeError("fixture interrupted launch")
        with self.assertRaisesRegex(RuntimeError, "interrupted launch"):
            self.call("worktree_launch", payload)
        return payload, self.call("worktree_load", payload["operationId"])

    def assert_rejected(self, payload, message):
        before = self.created.call_count
        with self.assertRaisesRegex(ValueError, message):
            self.call("worktree_launch", payload)
        self.assertEqual(self.created.call_count, before, "Rejected admission must not dispatch")

    def transfer(self, number=110, content=b"fixture\nhandoff\n"):
        (self.repo / "README.md").write_bytes(content)
        diff = subprocess.check_output(["git", "-C", str(self.repo), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", "HEAD"])
        return {**self.payload(number), "sitrep": {"patchBase64": base64.b64encode(diff).decode(), "digest": hashlib.sha256(diff).hexdigest(), "source": {"hostId": "fixture", "operationId": "source"}}}, diff

    def test_invalid_identity_and_admission_fields(self):
        for operation_id in (None, 3, "../record", "A" * 32, "a" * 31):
            with self.subTest(operation_id=operation_id), self.assertRaisesRegex(ValueError, "operation ID"):
                self.call("worktree_file", operation_id)
        invalid = [({"slug": value}, "slug") for value in (None, 1, "-task", "UPPER", "a" * 41)]
        invalid += [({key: value}, "new agent") for key, value in (("provider", "terminal"), ("conversationId", "existing"), ("agentId", "existing"))]
        invalid += [({key: value}, "repository or base ref") for key, value in (("repository", None), ("repository", ""), ("baseRef", 1), ("baseRef", "-HEAD"), ("baseRef", "a" * 201))]
        for change, message in invalid:
            with self.subTest(change=change):
                self.assert_rejected({**self.payload(100), **change}, message)
        self.assertEqual(self.call("worktree_list"), [])

    def test_record_permissions_integrity_and_failed_atomic_publication(self):
        record = {"operationId": "1" * 32}
        self.call("worktree_save", record)
        target = self.call("worktree_file", record["operationId"])
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
        original = target.read_bytes()
        with patch.object(self.scope["os"], "replace", side_effect=OSError("fixture disk failure")):
            with self.assertRaisesRegex(OSError, "disk failure"):
                self.call("worktree_save", {**record, "state": "changed"})
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(list(target.parent.glob(".record-*")), [])
        target.write_text(json.dumps({"operationId": "2" * 32}))
        with self.assertRaisesRegex(ValueError, "record changed"):
            self.call("worktree_load", record["operationId"])
        target.unlink()
        other = self.root / "foreign.json"
        other.write_text(json.dumps(record))
        target.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "unsafe"):
            self.call("worktree_load", record["operationId"])
        target.unlink()
        self.call("worktree_save", record)
        with patch.object(self.scope["os"], "getuid", return_value=target.stat().st_uid + 1):
            with self.assertRaisesRegex(ValueError, "unsafe"):
                self.call("worktree_load", record["operationId"])
        target.write_text("{broken")
        (target.parent / "not-an-operation.json").write_text("{}")
        self.assertEqual(self.call("worktree_list"), [{"operationId": record["operationId"], "state": "unreadable", "status": {"owned": False}}])

    def test_unsafe_lock_directory_and_git_error_fallback(self):
        root = self.scope["WORKTREE_ROOT"]
        root.mkdir()
        outside = self.root / "external-locks"
        outside.mkdir()
        (root / "locks").symlink_to(outside, target_is_directory=True)
        self.assert_rejected(self.payload(100), "lock directory is unsafe")
        self.assertEqual(list(outside.iterdir()), [])
        original = self.scope["run"]
        try:
            for stderr, stdout, expected in (("", "", "Git operation failed"), ("", "failed output", "failed output"), ("x" * 600, "", "x" * 500)):
                self.scope["run"] = Mock(return_value=subprocess.CompletedProcess([], 1, stdout, stderr))
                with self.assertRaises(ValueError) as caught:
                    self.call("worktree_git", "status")
                self.assertEqual(str(caught.exception), expected)
        finally:
            self.scope["run"] = original

    def test_canonical_ownership_and_missing_checkout_archive_recovery(self):
        _payload, record = self.ready()
        self.assertEqual(self.call("worktree_state", record, False), {"exists": True, "active": False, "owned": True, "dirty": None, "merged": None})
        for change in ({"name": "unrelated"}, {"branch": "unrelated"}, {"path": str(self.root / "unowned")}):
            with self.subTest(change=change):
                self.assertFalse(self.call("worktree_state", {**record, **change})["owned"])
        self.git("worktree", "remove", record["path"])
        self.assert_rejected(self.payload(100), "worktree is missing")
        archived = self.call("worktree_archive", {"operationId": record["operationId"]})
        self.assertEqual(archived["state"], "archived")
        self.assertEqual(self.git("rev-parse", record["branch"]), record["baseCommit"], "Crash recovery preserves the branch")
        for identifier in (record["operationId"], "f" * 32):
            with self.assertRaisesRegex(ValueError, "unavailable"):
                self.call("worktree_archive", {"operationId": identifier})
        self.assert_rejected(self.payload(100), "archived task")

    def test_checkout_branch_mismatch_is_not_owned(self):
        payload, record = self.ready()
        subprocess.run(["git", "-C", record["path"], "checkout", "--detach", "-q"], check=True)
        self.assertFalse(self.call("worktree_state", record)["owned"])
        self.assert_rejected(payload, "ownership cannot be verified")
        with self.assertRaisesRegex(ValueError, "owned, inactive, clean, and merged"):
            self.call("worktree_archive", {"operationId": record["operationId"]})
        self.assertTrue(Path(record["path"]).exists())

    def test_base_commit_and_repository_replies_are_validated(self):
        original = self.scope["worktree_git"]
        try:
            for command, reply, message in (("--is-bare-repository", "true", "non-bare"), ("--porcelain", "unexpected record", "primary repository"), ("--end-of-options", "not-a-commit", "resolve to a commit")):
                self.scope["worktree_git"] = lambda *args, **kwargs: reply if command in args else original(*args, **kwargs)
                self.assert_rejected(self.payload(100), message)
        finally:
            self.scope["worktree_git"] = original
        for revision in (0, "bad", "a" * 64):
            self.assert_rejected({**self.payload(100), "expectedWorktreeRevision": revision}, "recovery revision")
        # Absent is an explicit reviewed creation, not a retry of a prior task.
        self.created.side_effect = lambda payload: {"name": payload["managedName"]}
        self.assertEqual(self.call("worktree_launch", {**self.payload(100), "expectedWorktreeRevision": "absent"})["worktree"]["state"], "launched")

    def test_live_retry_checks_tmux_identity_without_dispatching(self):
        payload, record = self.ready()
        original_state = self.scope["worktree_state"]
        self.scope["worktree_state"] = lambda item, detailed=True: {**original_state(item, detailed), "active": True}
        self.scope["tmux_option"] = lambda name, option: record["operationId"] if option == "@hq_worktree" else record["path"]
        before = self.created.call_count
        self.assertEqual(self.call("worktree_launch", payload)["worktree"]["state"], "launched")
        self.assertEqual(self.call("worktree_launch", payload)["worktree"]["state"], "launched")
        self.assertEqual(self.created.call_count, before)
        self.scope["tmux_option"] = lambda *_args: "other session"
        self.assert_rejected(payload, "already launched")
        record["state"] = "ready"
        self.call("worktree_save", record)
        self.assert_rejected(payload, "different session")
        self.scope["tmux_option"] = lambda _name, option: record["operationId"] if option == "@hq_worktree" else "wrong-directory"
        self.assert_rejected(payload, "different session")
        with self.assertRaisesRegex(ValueError, "inactive"):
            self.call("worktree_archive", {"operationId": record["operationId"]})

    def test_chat_retry_binds_model_and_transport(self):
        for index, model in enumerate((None, "fixture-model"), 120):
            extra = {"transport": "chat"}
            if model:
                extra["model"] = model
            payload, record = self.ready(index, **extra)
            self.assertEqual(record["transport"], "chat")
            self.assert_rejected({**payload, "transport": "terminal"}, "belongs")
            self.assert_rejected({**payload, "model": "changed-model"}, "belongs")

    def test_invalid_sitrep_never_creates_a_task(self):
        for transfer, message in (([], "Invalid SitRep transfer"), ({"digest": "bad"}, "Invalid SitRep transfer"), ({"digest": "a" * 64, "patchBase64": "%%%"}, "Invalid SitRep patch")):
            self.assert_rejected({**self.payload(100), "sitrep": transfer}, message)
        for data, digest in ((b"changed", "a" * 64), (b"GIT binary patch", None), (b"Binary files a and b differ", None), (b"x" * 512001, None)):
            self.assert_rejected({**self.payload(100), "sitrep": {"digest": digest or hashlib.sha256(data).hexdigest(), "patchBase64": base64.b64encode(data).decode()}}, "too large, binary, or changed")
        self.assertEqual(self.call("worktree_list"), [])

    def test_empty_sitrep_and_incomplete_ready_transfer(self):
        payload = {**self.payload(100), "sitrep": {"digest": hashlib.sha256(b"").hexdigest(), "patchBase64": "", "source": {"hostId": "fixture"}}}
        _payload, record = self.ready(100, sitrep=payload["sitrep"])
        self.assertEqual(record["sitrepApplied"], payload["sitrep"]["digest"])
        record.pop("sitrepApplied")
        self.call("worktree_save", record)
        self.assert_rejected({**self.payload(100), "recoverSitrep": True}, "transfer is incomplete")


    def test_recorded_provisioning_cannot_adopt_a_changed_branch(self):
        payload, record = self.ready()
        self.git("worktree", "remove", record["path"])
        record["state"] = "provisioning"
        self.call("worktree_save", record)
        self.git("commit", "--allow-empty", "-qm", "Advance fixture base")
        self.git("branch", "-f", record["branch"], "HEAD")
        before = self.git("rev-parse", record["branch"])
        self.assert_rejected(payload, "Existing task branch changed")
        self.assertEqual(self.git("rev-parse", record["branch"]), before)
        self.assertFalse(Path(record["path"]).exists())

    def test_sitrep_interruption_after_apply_verifies_reverse_patch(self):
        payload, diff = self.transfer()
        _payload, record = self.ready(110, sitrep=payload["sitrep"])
        # Simulate loss after Git applied the patch but before its digest was saved.
        record.pop("sitrepApplied")
        self.call("worktree_save", record)
        self.created.side_effect = lambda item: {"name": item["managedName"]}
        result = self.call("worktree_launch", payload)
        self.assertEqual(result["worktree"]["sitrepApplied"], hashlib.sha256(diff).hexdigest())
        self.assertEqual((Path(record["path"]) / "README.md").read_bytes(), b"fixture\nhandoff\n")
        record.pop("sitrepApplied", None)
        self.call("worktree_save", record)
        (Path(record["path"]) / "README.md").write_text("different unreviewed content\n")
        self.assert_rejected(payload, "changed during SitRep transfer")
        self.assertEqual((Path(record["path"]) / "README.md").read_text(), "different unreviewed content\n")

    def test_sitrep_apply_and_final_read_failures_never_launch(self):
        payload, _diff = self.transfer()
        _payload, record = self.ready(110, sitrep=payload["sitrep"])
        original_run = self.scope["subprocess"].run
        for stage, message in (("check", "does not apply"), ("apply", "patch failed"), ("readback", "no longer matches")):
            with self.subTest(stage=stage):
                record.pop("sitrepApplied", None)
                self.call("worktree_save", record)
                subprocess.run(["git", "-C", record["path"], "reset", "--hard", record["baseCommit"]], check=True, capture_output=True)
                def fail_selected(args, **kwargs):
                    command = args[3] if len(args) > 3 and args[:3] == ["git", "-C", record["path"]] else ""
                    if command == "apply" and ((stage == "check" and "--check" in args) or (stage == "apply" and "--check" not in args)):
                        return subprocess.CompletedProcess(args, 1, b"", b"fixture Git failure")
                    if command == "diff" and stage == "readback":
                        return subprocess.CompletedProcess(args, 0, b"changed since apply", b"")
                    return original_run(args, **kwargs)
                with patch.object(self.scope["subprocess"], "run", side_effect=fail_selected):
                    self.assert_rejected(payload, message)
        self.assertEqual(self.git("status", "--porcelain"), "M README.md", "The source checkout remains untouched")

if __name__ == "__main__":
    unittest.main()
