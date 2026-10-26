"""Safety contracts for private history files and native deletion readback."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from helpers.python_sources import exec_sources

ROOT = Path(__file__).resolve().parents[1]
ID = "12345678-1234-4234-8234-123456789012"


class CleanupBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentc2-history-boundaries-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.scope = {"__name__": "history_boundary_fixture"}
        exec_sources(self.scope, *(ROOT / "electron" / name for name in ("antigravity-cleanup.py", "session-cleanup.py", "remote.py")))
        self.scope.update(HOME=self.home, run=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "delete --force", ""))
        environment = patch.dict(os.environ, {"CODEX_HOME": str(self.home / ".codex"), "CODEX_SQLITE_HOME": str(self.home / ".codex")})
        environment.start()
        self.addCleanup(environment.stop)

    def call(self, name, *args):
        return self.scope[name](*args)

    def write(self, relative, content="fixture"):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_files_and_trees_reject_linked_shared_oversized_and_repository_data(self):
        path = self.write("history/data")
        item = self.call("cleanup_file", path)
        self.assertEqual(item["path"], "history/data")
        self.assertEqual(item["size"], 7)
        with self.assertRaises(ValueError):
            self.call("cleanup_file", self.home / ".." / "outside")
        link = self.home / "linked"
        link.symlink_to(path)
        with self.assertRaisesRegex(ValueError, "Linked"):
            self.call("cleanup_file", link)
        os.link(path, self.home / "hardlink")
        with self.assertRaisesRegex(ValueError, "Shared"):
            self.call("cleanup_file", path)
        (self.home / "hardlink").unlink()
        with self.assertRaisesRegex(ValueError, "Shared"):
            self.call("cleanup_file", path.parent)
        with path.open("wb") as stream:
            stream.truncate(513 * 1024 * 1024)
        with self.assertRaisesRegex(ValueError, "size limit"):
            self.call("cleanup_file", path)
        with self.assertRaisesRegex(ValueError, "Linked"):
            self.call("cleanup_tree", link)
        self.assertEqual(self.call("cleanup_tree", self.home / "missing"), [])
        with self.assertRaisesRegex(ValueError, "sidecar layout"):
            self.call("cleanup_tree", path)
        path.write_text("fixture")
        for marker in (".git", "linked-folder"):
            location = path.parent / marker
            if marker == ".git":
                location.touch()
            else:
                location.symlink_to(self.home, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "Repository or linked"):
                self.call("cleanup_tree", path.parent)
            location.unlink()
        with patch.object(os, "walk", return_value=[(str(path.parent), [], [str(i) for i in range(10001)])]), self.assertRaisesRegex(ValueError, "file limit"):
            self.call("cleanup_tree", path.parent)
        self.assertEqual(self.call("cleanup_tree", path.parent), [path])

    def test_activity_checks_are_bounded_and_fail_closed_on_ambiguous_processes(self):
        proc = self.home / "proc"
        proc.mkdir()
        def process(pid, command="sh", args=b"/bin/sh\0"):
            folder = proc / str(pid)
            folder.mkdir(exist_ok=True)
            (folder / "comm").write_text(command)
            (folder / "cmdline").write_bytes(args)
            return folder
        own = process(os.getpid(), "codex")
        ignored = process(111111, "codex")
        ordinary = process(222222)
        (proc / "not-a-pid").mkdir()
        original = Path.iterdir
        def directories(path):
            if path == Path("/proc"):
                return proc.iterdir()
            return original(path)
        with patch.object(Path, "iterdir", directories):
            self.assertEqual(self.call("cleanup_activity", "codex", 111111), "")
            self.assertIn("live provider", self.call("cleanup_activity", "codex"))
            (ignored / "comm").write_text("sh")
            (ordinary / "cmdline").write_bytes(b"node\0/fixture/claude-code/cli.js\0")
            self.assertIn("live provider", self.call("cleanup_activity", "claude"))
            (ordinary / "cmdline").write_bytes(b"/fixture/opencode.exe\0")
            self.assertIn("live provider", self.call("cleanup_activity", "opencode"))
            (ordinary / "cmdline").unlink()
            self.assertEqual(self.call("cleanup_activity", "codex"), "", "Disappearing processes are ignored")
            read_text = Path.read_text
            def unreadable(path, *args, **kwargs):
                if path == ordinary / "comm":
                    raise PermissionError("Process metadata unavailable")
                return read_text(path, *args, **kwargs)
            with patch.object(Path, "read_text", unreadable):
                self.assertEqual(self.call("cleanup_activity", "codex"), "Process activity is ambiguous")
        with patch.object(Path, "iterdir", side_effect=PermissionError("No proc access")):
            self.assertEqual(self.call("cleanup_activity", "codex"), "Process activity cannot be verified")
        self.assertTrue(own.exists())

    def codex(self, schema="id TEXT, rollout_path TEXT, updated_at_ms INTEGER, is_pinned INTEGER"):
        db = self.home / ".codex" / "state_5.sqlite"
        db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(db)) as connection:
            connection.execute(f"CREATE TABLE threads({schema})")
            connection.commit()
        return db

    def assert_connections_closed(self, action):
        connections = []
        connect = sqlite3.connect
        class Tracked(sqlite3.Connection):
            closed = False
            def close(self):
                self.closed = True
                super().close()
        def tracked(*args, **kwargs):
            connection = connect(*args, **kwargs, factory=Tracked)
            connections.append(connection)
            return connection
        try:
            with patch.object(sqlite3, "connect", tracked):
                action()
            self.assertTrue(connections)
            self.assertTrue(all(connection.closed for connection in connections), "Every read-only cleanup connection must close")
        finally:
            for connection in connections:
                connection.close()

    def test_codex_schema_failures_close_read_only_connections(self):
        self.codex("id TEXT")
        def inspect():
            with self.assertRaisesRegex(ValueError, "state schema"):
                self.call("cleanup_codex", ID)
        self.assert_connections_closed(inspect)

    def test_codex_native_delete_readback_closes_connections_and_preserves_unrelated_files(self):
        db = self.codex()
        transcript = self.write(".codex/sessions/session.jsonl", "Reviewed transcript")
        unrelated = self.write(".codex/sessions/other.jsonl", "Keep unrelated history")
        with closing(sqlite3.connect(db)) as connection:
            connection.execute("INSERT INTO threads VALUES(?,?,?,0)", (ID, str(transcript), 1000))
            connection.commit()
        self.scope["cleanup_activity"] = lambda *_: ""
        plan, _ = self.call("cleanup_plan", "codex", ID)
        self.assertTrue(plan["eligible"])
        def native(args, **kwargs):
            if args == ["codex", "delete", "--help"]:
                return subprocess.CompletedProcess(args, 0, "delete --force", "")
            self.assertEqual(args, ["codex", "delete", "--force", ID])
            self.assertLessEqual(kwargs["timeout"], 10)
            # This connection belongs to the fixture's simulated provider.
            with closing(sqlite3.connect(db)) as connection:
                connection.execute("DELETE FROM threads WHERE id=?", (ID,))
                connection.commit()
            transcript.unlink()
            return subprocess.CompletedProcess(args, 0, "", "")
        def delete():
            with patch.dict(self.scope, run=native):
                result = self.call("cleanup_delete_one", {"provider": "codex", "id": ID, "fingerprint": plan["fingerprint"], "deadline": self.scope["time"].monotonic() + 20})
            self.assertEqual(result["status"], "deleted", result)
        self.assert_connections_closed(delete)
        self.assertEqual(unrelated.read_text(), "Keep unrelated history")


if __name__ == "__main__":
    unittest.main()
