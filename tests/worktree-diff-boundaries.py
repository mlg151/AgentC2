"""Read races, bounded Git processes, and exact reviewed-hunk admission."""

import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("diff_fixtures", Path(__file__).with_name("worktree-diff.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class DiffBoundaries(unittest.TestCase):
    setUp = fixtures.DiffActions.setUp
    git = fixtures.DiffActions.git
    file = fixtures.DiffActions.file
    detail = fixtures.DiffActions.detail
    act = fixtures.DiffActions.act

    def changed(self):
        target = self.worktree / "changes.txt"
        target.write_text(target.read_text().replace("line 2\n", "line TWO\n").replace("line 25\n", "line TWENTYFIVE\n"))
        file = self.file(target.name)
        return target, file, self.detail(file)

    def test_artifact_nested_path_read_races_and_descriptor_cleanup(self):
        target = self.worktree / "results" / "result.txt"
        target.parent.mkdir()
        target.write_text("reviewed result\n")
        request = {"operationId": self.operation, "path": "results/result.txt"}
        self.assertEqual(self.scope["artifact_read"](request)["text"], target.read_text())
        original_read = self.scope["os"].read
        original_close = self.scope["os"].close
        for extra in (b"changed", b"x" * 270000):
            with self.subTest(extra_bytes=len(extra)):
                target.write_text("reviewed result\n")
                first = True
                closed = []
                def race(fd, size):
                    nonlocal first
                    if first:
                        first = False
                        with target.open("ab") as stream:
                            stream.write(extra)
                    return original_read(fd, size)
                def close(fd):
                    closed.append(fd)
                    return original_close(fd)
                with patch.object(self.scope["os"], "read", side_effect=race), patch.object(self.scope["os"], "close", side_effect=close):
                    with self.assertRaisesRegex(ValueError, "changed while reading"):
                        self.scope["artifact_read"](request)
                self.assertEqual(len(closed), 3, "All root, nested directory and file descriptors close on a read race")
                for fd in closed:
                    with self.assertRaises(OSError):
                        self.scope["os"].fstat(fd)

    def test_unavailable_association_rejects_diff_reads(self):
        original_state = self.scope["worktree_state"]
        original_option = self.scope["tmux_option"]
        for state in ({"owned": False, "active": True}, {"owned": True, "active": False}):
            self.scope["worktree_state"] = lambda *_args: state
            with self.assertRaisesRegex(ValueError, "association is unavailable"):
                self.scope["diff_files"](self.request)
        self.scope["worktree_state"] = original_state
        for bad_option in ("@hq_worktree", "@hq_cwd"):
            self.scope["tmux_option"] = lambda name, option: "wrong" if option == bad_option else original_option(name, option)
            with self.assertRaisesRegex(ValueError, "association is unavailable"):
                self.scope["diff_files"](self.request)
        self.scope["tmux_option"] = original_option

    def test_untracked_file_and_bounded_file_list(self):
        target = self.worktree / "new.txt"
        target.write_text("untracked work must be retained\n")
        detail = self.detail(self.file(target.name))
        self.assertEqual(detail["revision"], "")
        self.assertEqual(detail["unstaged"], [])
        self.assertIn("Untracked file", detail["summary"])
        for index in range(100):
            (self.worktree / f"untracked-{index}.txt").write_text("fixture\n")
        with self.assertRaisesRegex(ValueError, "More than 100 changed files"):
            self.scope["diff_files"](self.request)
        self.assertEqual(target.read_text(), "untracked work must be retained\n")

    def test_missing_files_actions_and_hunks_preserve_index_and_worktree(self):
        target, file, detail = self.changed()
        before = target.read_bytes()
        with self.assertRaisesRegex(ValueError, "Changed file is unavailable"):
            self.scope["diff_detail"]({**self.request, "fileId": "missing"})
        with self.assertRaisesRegex(ValueError, "Invalid hunk action"):
            self.act(file, detail, detail["unstaged"][0], "delete")
        for identifier in ("missing", self.file("changes.txt")["id"]):
            request = {**self.request, "fileId": identifier, "revision": detail["revision"], "hunkId": "missing", "operation": "stage"}
            message = "Unstaged file is unavailable" if identifier == "missing" else "hunk cannot be changed"
            with self.assertRaisesRegex(ValueError, message):
                self.scope["diff_hunk_action"](request)
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(self.git("diff", "--cached", cwd=self.worktree), "")
        # Select the second hunk; the first must remain unstaged.
        self.act(file, detail, detail["unstaged"][1], "stage")
        staged = self.git("diff", "--cached", cwd=self.worktree)
        self.assertIn("line TWENTYFIVE", staged)
        self.assertNotIn("line TWO\n", staged)
        self.git("add", "changes.txt", cwd=self.worktree)
        with self.assertRaisesRegex(ValueError, "Unstaged file is unavailable"):
            self.act(file, self.detail(file), {"id": "anything"}, "revert")

    def test_mode_only_hunks_and_git_errors_are_not_actionable(self):
        target, file, detail = self.changed()
        target.chmod(0o755)
        current = self.detail(file)
        self.assertTrue(current["unstaged"])
        self.assertTrue(all(not hunk["actionable"] for hunk in current["unstaged"]))
        with self.assertRaisesRegex(ValueError, "hunk cannot be changed"):
            self.act(file, current, current["unstaged"][0], "revert")
        original = self.scope["diff_git"]
        self.scope["diff_git"] = Mock(side_effect=ValueError("fixture Git error"))
        try:
            with self.assertRaisesRegex(ValueError, "fixture Git error"):
                self.scope["diff_file"](self.record, {**file, "raw": b"changes.txt"})
        finally:
            self.scope["diff_git"] = original

    def test_hunk_and_revision_races_never_apply_a_patch(self):
        target, file, detail = self.changed()
        original = self.scope["diff_git"]
        before = target.read_bytes()
        for race_call, message in ((2, "Hunk changed"), (3, "diff changed")):
            calls = 0
            def race(record, args, *positional, **kwargs):
                nonlocal calls
                if args[0] == "diff" and "--name-only" not in args:
                    calls += 1
                    value = original(record, args, *positional, **kwargs)
                    return value.replace(b"line TWO", b"line CHANGED") if calls == race_call else value
                self.assertNotEqual(args[0], "apply", "A review race must never reach Git mutation")
                return original(record, args, *positional, **kwargs)
            self.scope["diff_git"] = race
            try:
                with self.assertRaisesRegex(ValueError, message):
                    self.act(file, detail, detail["unstaged"][0], "stage")
            finally:
                self.scope["diff_git"] = original
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(self.git("diff", "--cached", cwd=self.worktree), "")

    def test_git_errors_timeout_broken_pipe_and_process_cleanup(self):
        original_popen = self.scope["subprocess"].Popen
        processes = []
        def child(code, broken_pipe=False):
            def start(_command, **kwargs):
                process = original_popen([sys.executable, "-c", code], **kwargs)
                processes.append(process)
                if broken_pipe:
                    stream = process.stdin
                    process.stdin = Mock(write=Mock(side_effect=BrokenPipeError()), close=stream.close)
                return process
            return start
        for code, expected in (("import sys;sys.stderr.write('fixture failure');sys.exit(1)", "fixture failure"), ("raise SystemExit(1)", "Git diff failed"), ("import sys;sys.stderr.write('x'*10000)", "error output exceeds")):
            with patch.object(self.scope["subprocess"], "Popen", side_effect=child(code)):
                with self.assertRaisesRegex(ValueError, expected):
                    self.scope["diff_git"](self.record, ["diff"])
        with patch.object(self.scope["subprocess"], "Popen", side_effect=child("print('completed')", True)):
            self.assertEqual(self.scope["diff_git"](self.record, ["apply"], b"fixture patch"), b"completed\n")
        with patch.object(self.scope["subprocess"], "Popen", side_effect=child("import time;time.sleep(20)")), patch.object(self.scope["time"], "monotonic", side_effect=[0, 16]):
            with self.assertRaisesRegex(ValueError, "timed out"):
                self.scope["diff_git"](self.record, ["diff"])
        for process in processes:
            self.assertIsNotNone(process.poll(), "Every failed or expired Git child is reaped")
            self.assertTrue(process.stdout.closed and process.stderr.closed)


if __name__ == "__main__":
    unittest.main()
