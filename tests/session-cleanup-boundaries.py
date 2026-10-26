"""Safety contracts for private history files and native deletion readback."""
from contextlib import closing
from types import SimpleNamespace
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

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


    def test_claude_ambiguous_missing_and_unknown_sidecars_are_preserved(self):
        first = self.write(f".claude/projects/first/{ID}.jsonl", json.dumps({"type": "user", "sessionId": ID}) + "\n")
        second = self.write(f".claude/projects/second/{ID}.jsonl", first.read_text())
        with self.assertRaisesRegex(ValueError, "multiple projects"):
            self.call("cleanup_claude", ID)
        second.unlink()
        first.unlink()
        sidecar = self.write(f".claude/file-history/{ID}/work", "preserve uncertain owner")
        with self.assertRaisesRegex(ValueError, "Transcript is missing"):
            self.call("cleanup_claude", ID)
        self.assertTrue(sidecar.exists())
        first.write_text(json.dumps({"type": "user", "sessionId": ID}) + "\n")
        unknown = self.write(f".claude/projects/first/{ID}/unrecognized/file")
        with self.assertRaisesRegex(ValueError, "session sidecars"):
            self.call("cleanup_claude", ID)
        unknown.unlink()
        unknown.parent.rmdir()
        debug = self.write(f".claude/debug/{ID}.txt", "session debug")
        files, _, _, _ = self.call("cleanup_claude", ID)
        self.assertIn(debug, files)
        self.assertTrue(first.exists() and sidecar.exists() and debug.exists())

    def test_claude_shared_history_limits_and_unrelated_rows(self):
        self.write(f".claude/projects/first/{ID}.jsonl", json.dumps({"type": "user"}) + "\n")
        index = self.write(".claude/projects/first/sessions-index.json", json.dumps({"version": 1, "entries": [{"sessionId": "other"}]}))
        history = self.write(".claude/history.jsonl", json.dumps({"sessionId": "other"}) + "\n")
        _, rewrites, _, _ = self.call("cleanup_claude", ID)
        self.assertEqual(rewrites, {}, "Unrelated index and prompt rows must not be rewritten")
        history.write_text("[]\n")
        with self.assertRaisesRegex(ValueError, "shared Claude history layout"):
            self.call("cleanup_claude", ID)
        history.unlink()
        with index.open("wb") as stream:
            stream.truncate(16 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "index exceeds"):
            self.call("cleanup_claude", ID)
        index.unlink()
        with history.open("wb") as stream:
            stream.truncate(16 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "prompt history exceeds"):
            self.call("cleanup_claude", ID)
        self.assertTrue(history.exists())

    def test_codex_identity_storage_native_support_and_config_admission(self):
        with self.assertRaisesRegex(ValueError, "canonical UUID"):
            self.call("cleanup_codex", "{" + ID + "}")
        with patch.dict(os.environ, CODEX_HOME="/fixture/foreign"):
            with self.assertRaisesRegex(ValueError, "Custom Codex storage"):
                self.call("cleanup_codex", ID)
        self.assertEqual(self.call("cleanup_codex", ID), ([], {}, None, []))
        db = self.codex()
        self.assertEqual(self.call("cleanup_codex", ID), ([], {}, None, []))
        with closing(sqlite3.connect(db)) as connection:
            connection.execute("INSERT INTO threads VALUES(?,?,?,0)", (ID, "relative.jsonl", 1000))
            connection.commit()
        with self.assertRaisesRegex(ValueError, "outside managed provider history"):
            self.call("cleanup_codex", ID)
        transcript = self.write(".codex/archived_sessions/reviewed.jsonl")
        with closing(sqlite3.connect(db)) as connection:
            connection.execute("UPDATE threads SET rollout_path=?", (str(transcript),))
            connection.commit()
        for response in (subprocess.CompletedProcess([], 1, "delete --force", ""), subprocess.CompletedProcess([], 0, "unsupported help", "")):
            with patch.dict(self.scope, run=lambda *_args, **_kwargs: response):
                with self.assertRaisesRegex(ValueError, "native delete --force"):
                    self.call("cleanup_codex", ID)
        config = self.write(".codex/config.toml", 'sqlite_home = "/foreign"')
        for text, message in (('sqlite_home = "/foreign"', "SQLite storage"), ('experimental_thread_store = "remote"', "thread stores"), ('profile = "custom"', "thread stores")):
            config.write_text(text)
            with self.assertRaisesRegex(ValueError, message):
                self.call("cleanup_codex", ID)
        config.write_text('experimental_thread_store = "local"')
        self.assertEqual(self.call("cleanup_codex", ID)[0], [transcript])
        self.assertTrue(transcript.exists())

    def opencode(self):
        database = self.home / "opencode.sqlite"
        self.scope["opencode_database"] = lambda: database
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript("CREATE TABLE session_v2(id TEXT,parent_id TEXT,fork_session_id TEXT,directory TEXT,time_updated INTEGER); CREATE TABLE session(id TEXT); CREATE TABLE session_pending(session_id TEXT); CREATE TABLE session_message(id INTEGER,session_id TEXT,data TEXT); CREATE TABLE event(id INTEGER,aggregate_id TEXT,data TEXT);")
            connection.commit()
        return database

    def test_opencode_legacy_related_pending_and_size_limits(self):
        database = self.opencode()
        identifier = "ses_fixture"
        def sql(statement, values=()):
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(statement, values)
                connection.commit()
        with self.assertRaisesRegex(ValueError, "exact session ID"):
            self.call("cleanup_opencode", "../outside")
        sql("DROP TABLE session_v2")
        with self.assertRaisesRegex(ValueError, "legacy OpenCode"):
            self.call("cleanup_opencode", identifier)
        sql("CREATE TABLE session_v2(id TEXT,parent_id TEXT,fork_session_id TEXT,directory TEXT,time_updated INTEGER)")
        self.assertEqual(self.call("cleanup_opencode", identifier), ([], {}, None, []))
        sql("INSERT INTO session VALUES(?)", (identifier,))
        with self.assertRaisesRegex(ValueError, "legacy OpenCode"):
            self.call("cleanup_opencode", identifier)
        sql("DELETE FROM session")
        sql("INSERT INTO session_v2 VALUES(?,?,?, ?,1000)", (identifier, "parent", None, str(self.home)))
        with self.assertRaisesRegex(ValueError, "Related OpenCode"):
            self.call("cleanup_opencode", identifier)
        sql("UPDATE session_v2 SET parent_id=NULL")
        sql("INSERT INTO session_pending VALUES(?)", (identifier,))
        with self.assertRaisesRegex(ValueError, "pending messages"):
            self.call("cleanup_opencode", identifier)
        sql("DELETE FROM session_pending")
        sql("INSERT INTO session_message VALUES(1,?,?)", (identifier, "x" * (16 * 1024 * 1024 + 1)))
        with self.assertRaisesRegex(ValueError, "exceeds cleanup limits"):
            self.call("cleanup_opencode", identifier)
        sql("DELETE FROM session_message")
        with closing(sqlite3.connect(database)) as connection:
            connection.executemany("INSERT INTO session_message VALUES(?,?,?)", ((i, identifier, "x") for i in range(10001)))
            connection.commit()
        with self.assertRaisesRegex(ValueError, "exceeds cleanup limits"):
            self.call("cleanup_opencode", identifier)
        sql("DELETE FROM session_message")
        for table, column in (("session_message", "session_id"), ("event", "aggregate_id")):
            sql(f"INSERT INTO {table} VALUES(1,?,?)", (identifier, "x" * (9 * 1024 * 1024)))
        with self.assertRaisesRegex(ValueError, "exceeds cleanup limits"):
            self.call("cleanup_opencode", identifier)
        self.assertTrue(database.exists())
        database.unlink()
        self.assertEqual(self.call("cleanup_opencode", identifier), ([], {}, None, []))

    def test_managed_chat_journal_blocks_unknown_active_history_and_closes_reads(self):
        journal = self.home / ".cache/agentc2/chat-v1/journal.sqlite3"
        journal.parent.mkdir(parents=True)
        with closing(sqlite3.connect(journal)) as connection:
            connection.execute("CREATE TABLE sessions(provider TEXT,provider_session_id TEXT,state TEXT)")
            connection.execute("INSERT INTO sessions VALUES('codex',?,'unknown')", (ID,))
            connection.commit()
        self.scope["cleanup_activity"] = lambda *_args: ""
        def inspect():
            result, plan = self.call("cleanup_plan", "codex", ID)
            self.assertFalse(result["eligible"])
            self.assertIn("active or uncertain managed chat", result["reason"])
            self.assertIsNone(plan)
        self.assert_connections_closed(inspect)
        with closing(sqlite3.connect(journal)) as connection:
            connection.execute("UPDATE sessions SET state='stopped'")
            connection.commit()
        self.assertTrue(self.call("cleanup_plan", "codex", ID)[0]["missing"])

    def test_shared_history_replacement_rechecks_and_removes_failed_temporary_files(self):
        path = self.write("history.jsonl", "reviewed history")
        expected = self.call("cleanup_file", path)
        path.write_text("changed first")
        with self.assertRaisesRegex(ValueError, "Shared history changed"):
            self.call("cleanup_replace", path, b"replacement", expected)
        expected = self.call("cleanup_file", path)
        original = self.scope["cleanup_file"]
        count = 0
        def race(file):
            nonlocal count
            result = original(file)
            count += 1
            if count == 1:
                path.write_text("changed during replacement")
            return result
        with patch.dict(self.scope, cleanup_file=race):
            with self.assertRaisesRegex(ValueError, "Shared history changed"):
                self.call("cleanup_replace", path, b"replacement", expected)
        self.assertEqual(path.read_text(), "changed during replacement")
        self.assertEqual(list(self.home.glob(".agentc2-cleanup-*")), [])

    def test_invalid_preview_delete_and_ineligible_single_delete_never_mutate(self):
        for payload in ({"provider": "invalid", "ids": []}, {"provider": "codex", "ids": None}, {"provider": "codex", "ids": [ID] * 51}):
            with self.assertRaisesRegex(ValueError, "at most 50"):
                self.call("cleanup_preview", payload)
        for payload in ({"provider": "invalid", "items": [{}]}, {"provider": "codex", "items": []}, {"provider": "codex", "items": None}, {"provider": "codex", "items": [{}] * 51}):
            with self.assertRaisesRegex(ValueError, "up to 50"):
                self.call("cleanup_delete", payload)
        result = self.call("cleanup_delete_one", {"provider": "invalid", "id": ID})
        self.assertEqual(result["status"], "excluded")


    def test_codex_native_readback_rejects_retained_rows_and_files(self):
        db = self.codex()
        transcript = self.write(".codex/sessions/reviewed.jsonl")
        with closing(sqlite3.connect(db)) as connection:
            connection.execute("INSERT INTO threads VALUES(?,?,1000,0)", (ID, str(transcript)))
            connection.commit()
        self.scope["cleanup_activity"] = lambda *_args: ""
        for remove_row in (False, True):
            def native(args, **_kwargs):
                if args == ["codex", "delete", "--help"]:
                    return subprocess.CompletedProcess(args, 0, "delete --force", "")
                self.assertEqual(args, ["codex", "delete", "--force", ID])
                if remove_row:
                    with closing(sqlite3.connect(db)) as connection:
                        connection.execute("DELETE FROM threads WHERE id=?", (ID,))
                        connection.commit()
                return subprocess.CompletedProcess(args, 0, "", "")
            plan, _ = self.call("cleanup_plan", "codex", ID)
            with patch.dict(self.scope, run=native):
                result = self.call("cleanup_delete_one", {"provider": "codex", "id": ID, "fingerprint": plan["fingerprint"], "deadline": self.scope["time"].monotonic() + 20})
            self.assertEqual(result["status"], "failed", "A successful CLI exit alone cannot prove deletion")
            self.assertTrue(transcript.exists())

    def test_opencode_timeout_failure_and_retained_row_are_not_success(self):
        database = self.opencode()
        identifier = "ses_fixture"
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("INSERT INTO session_v2 VALUES(?,NULL,NULL,?,1000)", (identifier, str(self.home)))
            connection.commit()
        self.scope["cleanup_activity"] = lambda *_args: ""
        plan, _ = self.call("cleanup_plan", "opencode", identifier)
        for outcome, expected in ((subprocess.TimeoutExpired("opencode", 1), "unknown"), (subprocess.CompletedProcess([], 1, "", ""), "failed"), (subprocess.CompletedProcess([], 0, "", ""), "failed")):
            def native(args, **kwargs):
                self.assertEqual(args, ["opencode", "session", "delete", "--standalone", identifier])
                self.assertEqual(kwargs["cwd"], str(self.home))
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            with patch.object(subprocess, "run", side_effect=native):
                result = self.call("cleanup_delete_one", {"provider": "opencode", "id": identifier, "fingerprint": plan["fingerprint"], "deadline": self.scope["time"].monotonic() + 20})
            self.assertEqual(result["status"], expected)
            with closing(sqlite3.connect(database)) as connection:
                self.assertIsNotNone(connection.execute("SELECT 1 FROM session_v2 WHERE id=?", (identifier,)).fetchone())

    def test_claude_deletion_rechecks_deadline_activity_and_reviewed_bytes(self):
        transcript = self.write(f".claude/projects/first/{ID}.jsonl", json.dumps({"type": "user"}) + "\n")
        history = self.write(".claude/history.jsonl", json.dumps({"sessionId": ID}) + "\n")
        self.scope["cleanup_activity"] = lambda *_args: ""
        for phase in ("rewrite-timeout", "rewrite-active", "owned-timeout", "owned-active", "owned-changed"):
            with self.subTest(phase=phase):
                original_plan = self.scope["cleanup_plan"]
                plan, _ = original_plan("claude", ID)
                def admission(*args):
                    value = original_plan(*args)
                    if phase == "owned-changed":
                        transcript.write_text(json.dumps({"type": "user", "changed": True}) + "\n")
                    return value
                count = 0
                def activity(*_args):
                    nonlocal count
                    count += 1
                    # Admission calls once; protect the first mutation at the selected phase.
                    selected = 2 if phase.startswith("rewrite") else 3
                    return "fixture provider started" if count == selected and phase.endswith("active") else ""
                def monotonic():
                    # Rewrites are checked first, then the owned transcript.
                    nonlocal ticks
                    ticks += 1
                    return 100 if ticks == (1 if phase.startswith("rewrite") else 2) else 0
                ticks = 0
                replacements = {"cleanup_activity": activity, "cleanup_plan": admission}
                with patch.dict(self.scope, replacements), patch.object(self.scope["time"], "monotonic", side_effect=monotonic if phase.endswith("timeout") else lambda: 0):
                    result = self.call("cleanup_delete_one", {"provider": "claude", "id": ID, "fingerprint": plan["fingerprint"], "deadline": 20})
                self.assertEqual(result["status"], "failed", phase)
                self.assertTrue(transcript.exists(), "A rejected deletion retains its inventory transcript")
                self.assertTrue(history.exists())
                # Restore reviewed content for the next independent refusal.
                transcript.write_text(json.dumps({"type": "user"}) + "\n")
                history.write_text(json.dumps({"sessionId": ID}) + "\n")

    def test_antigravity_missing_uncertain_and_failed_picker_outcomes(self):
        trajectory = self.write(".gemini/antigravity/conversations/reviewed.db")
        self.scope["cleanup_activity"] = lambda *_args: ""
        self.scope["antigravity_snapshot"] = lambda _identifier: ([trajectory], {}, trajectory, [ID, "reviewed title", "timestamp"])
        plan, _ = self.call("cleanup_plan", "antigravity", ID)
        request = {"provider": "antigravity", "id": ID, "fingerprint": plan["fingerprint"], "deadline": 20}
        self.assertEqual(self.call("cleanup_delete_one", request)["status"], "failed")
        for exception, expected in ((ValueError("picker rejected identity"), "failed"), (self.scope["AntigravityUncertain"]("confirmation receipt lost"), "unknown")):
            picker = SimpleNamespace(pid=1234, delete=Mock(side_effect=exception))
            result = self.call("cleanup_delete_one", request, picker)
            self.assertEqual(result["status"], expected)
            picker.delete.assert_called_once_with(ID, "reviewed title", "timestamp")
            self.assertTrue(trajectory.exists())

    def test_batch_picker_startup_failure_keeps_owned_and_missing_outcomes_distinct(self):
        trajectory = self.write(".gemini/antigravity/conversations/reviewed.db")
        missing = "32345678-1234-4234-8234-123456789012"
        self.scope["cleanup_activity"] = lambda *_args: ""
        self.scope["antigravity_snapshot"] = lambda identifier: ([trajectory], {}, trajectory, [ID, "title", "timestamp"]) if identifier == ID else ([], {}, None, [])
        reviewed = [self.call("cleanup_plan", "antigravity", identifier)[0] for identifier in (ID, missing)]
        picker = Mock(side_effect=ValueError("fixture picker unavailable"))
        with patch.dict(self.scope, AntigravityPicker=picker):
            result = self.call("cleanup_delete", {"provider": "antigravity", "items": reviewed})
        self.assertEqual([(item["id"], item["status"]) for item in result["items"]], [(ID, "failed"), (missing, "missing")])
        picker.assert_called_once()
        self.assertTrue(trajectory.exists())


    def test_activity_ignores_other_users_without_reading_their_process_metadata(self):
        folder = self.home / "proc" / "999999"
        folder.mkdir(parents=True)
        original = Path.iterdir
        actual_uid = os.getuid()
        def directories(path):
            return iter([folder]) if path == Path("/proc") else original(path)
        with patch.object(Path, "iterdir", directories), patch.object(os, "getuid", return_value=actual_uid + 1):
            self.assertEqual(self.call("cleanup_activity", "codex"), "")
        self.assertFalse((folder / "comm").exists(), "Other users' process contents were never needed")

    def test_total_reviewed_bytes_limit_protects_large_combined_sidecars(self):
        transcript = self.write(f".claude/projects/first/{ID}.jsonl", json.dumps({"type": "user"}) + "\n")
        for folder in ("file-history", "uploads"):
            path = self.write(f".claude/{folder}/{ID}/large.bin")
            with path.open("wb") as stream:
                stream.truncate(300 * 1024 * 1024)
        self.scope["cleanup_activity"] = lambda *_args: ""
        result, plan = self.call("cleanup_plan", "claude", ID)
        self.assertFalse(result["eligible"])
        self.assertIn("cleanup size limit", result["reason"])
        self.assertIsNone(plan)
        self.assertTrue(transcript.exists())

    def test_batch_revalidates_deadline_owned_files_and_shared_history(self):
        transcript = self.write(f".claude/projects/first/{ID}.jsonl", json.dumps({"type": "user"}) + "\n")
        history = self.write(".claude/history.jsonl", json.dumps({"sessionId": ID}) + "\n")
        self.scope["cleanup_activity"] = lambda *_args: ""
        for phase in ("deadline", "owned", "shared"):
            with self.subTest(phase=phase):
                reviewed, _ = self.call("cleanup_plan", "claude", ID)
                original = self.scope["cleanup_plan"]
                count = 0
                def admission(*args):
                    nonlocal count
                    count += 1
                    result = original(*args)
                    if phase == "owned" and count == 1:
                        transcript.write_text(json.dumps({"type": "user", "changed": True}) + "\n")
                    if phase == "shared" and count == 2:
                        history.write_text(json.dumps({"sessionId": ID, "changed": True}) + "\n")
                    return result
                ticks = 0
                def monotonic():
                    nonlocal ticks
                    ticks += 1
                    return 0 if ticks == 1 else 100
                with patch.dict(self.scope, cleanup_plan=admission), patch.object(self.scope["time"], "monotonic", side_effect=monotonic if phase == "deadline" else lambda: 0):
                    result = self.call("cleanup_delete", {"provider": "claude", "items": [reviewed]})
                self.assertEqual(result["items"][0]["status"], "changed")
                self.assertTrue(transcript.exists() and history.exists(), "A stale batch cannot delete the reviewed transcript or index")
                transcript.write_text(json.dumps({"type": "user"}) + "\n")
                history.write_text(json.dumps({"sessionId": ID}) + "\n")


if __name__ == "__main__":
    unittest.main()
