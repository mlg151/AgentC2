"""Picker and snapshot boundaries using temporary histories and a fake tmux.

No installed provider, account, real home, SSH host, or model is contacted.
"""
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from helpers.python_sources import exec_sources

ROOT = Path(__file__).resolve().parents[1]
ID = "12345678-1234-4234-8234-123456789012"


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentc2-agy-boundaries-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.scope = {"__name__": "antigravity_boundaries"}
        exec_sources(self.scope, *(ROOT / "electron" / name for name in ("antigravity-cleanup.py", "session-cleanup.py", "remote.py")))
        self.scope.update(HOME=self.home, run=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "1.4.4\n", ""))
        self.root = self.home / ".gemini" / "antigravity-cli"
        self.summary = self.root / "conversation_summaries.db"
        self.trajectory = self.root / "conversations" / (ID + ".db")

    def snapshot(self):
        return self.scope["antigravity_snapshot"](ID)

    def fixture(self):
        self.trajectory.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.trajectory)) as conn:
            for table in ("trajectory_meta", "steps", "parent_references", "battle_mode_infos"):
                conn.execute(f"CREATE TABLE {table}(value TEXT)")
            conn.commit()
        with closing(sqlite3.connect(self.summary)) as conn:
            conn.execute("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,step_count,workspace_uris,parent_conversation_id,nesting_depth,battle_id,winning_conversation_id,group_id,not_fully_idle)")
            conn.execute("INSERT INTO conversation_summaries VALUES(?,?,?, ?,NULL,0,NULL,NULL,NULL,0)", (ID, "Reviewed fixture", 2, json.dumps([self.home.as_uri()])))
            conn.commit()

    def update(self, column, value):
        with closing(sqlite3.connect(self.summary)) as conn:
            conn.execute(f"UPDATE conversation_summaries SET {column}=? WHERE conversation_id=?", (value, ID))
            conn.commit()

    def test_identity_version_legacy_missing_and_orphaned_history(self):
        with self.assertRaisesRegex(ValueError, "canonical UUID"):
            self.scope["antigravity_snapshot"](ID.replace("12345678", "ABCDEFAB"))
        for code, version in ((1, "1.4.4"), (0, "1.4.5")):
            with patch.dict(self.scope, run=lambda *_a, **_k: subprocess.CompletedProcess([], code, version, "")), self.assertRaisesRegex(ValueError, "1.4.4"):
                self.snapshot()
        self.assertEqual(self.snapshot(), ([], {}, None, []))
        self.trajectory.parent.mkdir(parents=True)
        self.trajectory.touch()
        with self.assertRaisesRegex(ValueError, "summary index is missing"):
            self.snapshot()
        self.trajectory.unlink()
        brain = self.root / "brain" / ID
        brain.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "summary index is missing"):
            self.snapshot()
        shutil.rmtree(brain)
        legacy = self.home / ".gemini" / "antigravity" / "conversations" / (ID + ".pb")
        legacy.parent.mkdir(parents=True)
        legacy.symlink_to(self.home / "missing")
        with self.assertRaisesRegex(ValueError, "Legacy or duplicate"):
            self.snapshot()
        legacy.unlink()
        self.summary.touch()
        with self.assertRaisesRegex(ValueError, "summary schema"):
            self.snapshot()
        self.summary.unlink()
        self.fixture()
        with closing(sqlite3.connect(self.summary)) as conn:
            conn.execute("DELETE FROM conversation_summaries")
            conn.commit()
        with self.assertRaisesRegex(ValueError, "without a picker summary"):
            self.snapshot()
        self.trajectory.unlink()
        self.assertEqual(self.snapshot(), ([], {}, None, []))

    def test_related_metadata_and_workspace_provenance_are_refused(self):
        self.fixture()
        for column in ("parent_conversation_id", "nesting_depth", "battle_id", "winning_conversation_id", "group_id", "not_fully_idle"):
            self.update(column, "related")
            with self.assertRaisesRegex(ValueError, "Related, grouped, or active"):
                self.snapshot()
            self.update(column, None)
        for column, value, restore in (("step_count", -1, 2), ("step_count", "unknown", 2), ("title", None, "Reviewed fixture")):
            self.update(column, value)
            with self.assertRaisesRegex(ValueError, "identity metadata"):
                self.snapshot()
            self.update(column, restore)
        for value in ("{bad", "{}", "[]", json.dumps([self.home.as_uri()] * 9), "[1]"):
            self.update("workspace_uris", value)
            with self.assertRaisesRegex(ValueError, "workspace references"):
                self.snapshot()
        for uri in ("https://example.invalid/work", "file://untrusted/work", self.home.as_uri() + "?query=1", self.home.as_uri() + "#fragment", "file:relative", (self.home / "missing").as_uri()):
            self.update("workspace_uris", json.dumps([uri]))
            with self.assertRaisesRegex(ValueError, "workspace location|internal worktree"):
                self.snapshot()
        internal = self.home / ".system_generated" / "work"
        internal.mkdir(parents=True)
        alias = self.home / "alias"
        alias.symlink_to(internal, target_is_directory=True)
        for workspace in (internal, alias):
            self.update("workspace_uris", json.dumps([workspace.as_uri()]))
            with self.assertRaisesRegex(ValueError, "internal worktree"):
                self.snapshot()
        self.update("workspace_uris", json.dumps([self.home.as_uri()]))
        for relative in (".system_generated/worktrees", ".gemini/.system_generated/worktrees"):
            marker = self.home / relative
            marker.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, "internal worktree"):
                self.snapshot()
            marker.rmdir()
        self.assertEqual(self.snapshot()[3][:3], [ID, "Reviewed fixture", 2])
        with closing(sqlite3.connect(self.summary)) as conn:
            conn.execute("INSERT INTO conversation_summaries(conversation_id,parent_conversation_id) VALUES('child',?)", (ID,))
            conn.commit()
        with self.assertRaisesRegex(ValueError, "Related, grouped, or active"):
            self.snapshot()

    def test_trajectory_schema_links_and_sidecars(self):
        self.fixture()
        self.trajectory.unlink()
        with self.assertRaisesRegex(ValueError, "missing or linked"):
            self.snapshot()
        self.trajectory.symlink_to(self.summary)
        with self.assertRaisesRegex(ValueError, "missing or linked"):
            self.snapshot()
        self.trajectory.unlink()
        self.trajectory.write_bytes(b"unsupported")
        with self.assertRaisesRegex(ValueError, "trajectory format"):
            self.snapshot()
        self.trajectory.unlink()
        with closing(sqlite3.connect(self.trajectory)) as conn:
            conn.execute("CREATE TABLE trajectory_meta(value)")
            conn.commit()
        with self.assertRaisesRegex(ValueError, "trajectory schema"):
            self.snapshot()
        with closing(sqlite3.connect(self.trajectory)) as conn:
            for table in ("steps", "parent_references", "battle_mode_infos"):
                conn.execute(f"CREATE TABLE {table}(value)")
            conn.commit()
        for table in ("parent_references", "battle_mode_infos"):
            with closing(sqlite3.connect(self.trajectory)) as conn:
                conn.execute(f"INSERT INTO {table} VALUES('related')")
                conn.commit()
            with self.assertRaisesRegex(ValueError, "Related Antigravity trajectory"):
                self.snapshot()
            with closing(sqlite3.connect(self.trajectory)) as conn:
                conn.execute(f"DELETE FROM {table}")
                conn.commit()
        sidecar = self.trajectory.with_name(self.trajectory.name + "-shm")
        sidecar.symlink_to(self.home / "missing")
        with self.assertRaisesRegex(ValueError, "Linked.*sidecar"):
            self.snapshot()
        sidecar.unlink()
        sidecar.mkdir()
        with self.assertRaisesRegex(ValueError, "Unowned.*sidecar"):
            self.snapshot()
        sidecar.rmdir()
        sidecar.touch()
        original_stat = Path.stat
        def foreign_stat(path, *args, **kwargs):
            if path == sidecar:
                return SimpleNamespace(st_uid=-1, st_mode=stat.S_IFREG)
            return original_stat(path, *args, **kwargs)
        with patch.object(Path, "stat", foreign_stat), self.assertRaisesRegex(ValueError, "Unowned.*sidecar"):
            self.snapshot()
        sidecar.unlink()
        brain = self.root / "brain" / ID
        brain.mkdir(parents=True)
        (brain / "notes").write_text("fixture")
        files, rewrites, trajectory, row = self.snapshot()
        self.assertEqual(set(files), {self.trajectory, brain / "notes"})
        self.assertEqual(rewrites, {})
        self.assertEqual(trajectory, self.trajectory)
        self.assertRegex(row[3], r"^[a-f0-9]{64}$")

    def test_absence_requires_sidecars_and_shared_index_to_agree(self):
        absent = lambda: self.scope["antigravity_absent"](ID)
        self.assertTrue(absent())
        self.fixture()
        self.assertFalse(absent())
        self.trajectory.unlink()
        self.assertFalse(absent(), "Picker summary still exists")
        with closing(sqlite3.connect(self.summary)) as conn:
            conn.execute("DELETE FROM conversation_summaries")
            conn.commit()
        self.assertTrue(absent())
        linked = self.trajectory.with_name(self.trajectory.name + "-wal")
        linked.symlink_to(self.home / "missing")
        self.assertFalse(absent(), "Broken links remain evidence of sidecars")


class PickerTests(unittest.TestCase):
    def setUp(self):
        self.scope = {"__name__": "picker_boundary_fixture"}
        exec_sources(self.scope, *(ROOT / "electron" / name for name in ("antigravity-cleanup.py", "remote.py")))
        self.now = 0
        self.calls = []
        self.phase = "startup"
        self.startup = ["> ready"]
        self.selection = None
        self.fail_command = None
        self.fail_after_confirm = False
        self.late_confirmation = False
        self.after_confirm = False
        self.scope.update(time=SimpleNamespace(monotonic=lambda: self.now, sleep=self.sleep), run=self.run_tmux, antigravity_absent=lambda _: True)
        self.binary = patch.object(shutil, "which", return_value="/fixture/agy")
        self.binary.start()
        self.addCleanup(self.binary.stop)

    def sleep(self, seconds):
        self.now += seconds

    def run_tmux(self, args, **kwargs):
        self.assertLessEqual(kwargs["timeout"], 4)
        self.calls.append(args)
        command = args[3]
        if command == self.fail_command:
            raise OSError("Fixture transport failed")
        if command == "display-message":
            return subprocess.CompletedProcess(args, 0, "1234", "")
        if command == "capture-pane":
            if self.phase == "startup":
                screen = self.startup.pop(0) if len(self.startup) > 1 else self.startup[0]
            elif self.phase == "search":
                screen = "Type to search conversations\nf4 Delete"
            else:
                screen = self.selection or f"Search: {ID}\n> Reviewed fixture 2 steps\nf4 Delete"
                if self.phase == "confirm":
                    screen = screen.replace("2 steps", "2 steps [Delete? (y/n)]")
            return subprocess.CompletedProcess(args, 0, screen, "")
        if command == "send-keys":
            keys = args[6:]
            if keys == ["-l", "/resume"] or keys == ["Escape"]:
                self.phase = "search"
            elif keys == ["-l", ID]:
                self.phase = "selection"
            elif keys == ["F4"]:
                self.phase = "confirm"
                if self.late_confirmation:
                    self.now = 96
            elif keys == ["y"]:
                self.after_confirm = True
                if self.fail_after_confirm:
                    raise OSError("Confirmation acknowledgement lost")
        return subprocess.CompletedProcess(args, 0, "", "")

    def picker(self, deadline=100):
        picker = self.scope["AntigravityPicker"](deadline)
        self.addCleanup(picker.close)
        return picker

    def sent(self):
        return [args[6:] for args in self.calls if args[3] == "send-keys"]

    def test_startup_trust_prompt_and_owned_disposal(self):
        self.startup = ["Loading", "Do you trust the contents of this project?\nYes, I trust this folder", "> ready"]
        picker = self.picker()
        self.assertEqual(picker.pid, 1234)
        self.assertTrue(picker.usable)
        self.assertIn(["Enter"], self.sent())
        directory = picker.directory
        self.assertTrue(directory.is_dir())
        picker.close()
        self.assertFalse(directory.exists())
        self.assertTrue(all(args[:3] == ["tmux", "-L", picker.socket] for args in self.calls))

    def test_startup_failures_clean_up_without_provider_actions(self):
        for startup, error in [(["Do you trust the contents of this project?"], "Unrecognized.*trust"), (["Loading"], "did not reach")]:
            self.startup = startup
            with self.assertRaisesRegex(ValueError, error):
                self.scope["AntigravityPicker"](self.now + 20)
        with patch.object(shutil, "which", return_value=None), self.assertRaisesRegex(ValueError, "unavailable"):
            self.scope["AntigravityPicker"](100)
        original = self.scope["run"]
        self.scope["run"] = lambda *args, **kwargs: subprocess.CompletedProcess([], 1, "", "")
        with self.assertRaisesRegex(ValueError, "Could not start"):
            self.scope["AntigravityPicker"](100)
        self.scope["run"] = original

    def test_commands_wrap_transport_and_status_errors_and_waits_are_bounded(self):
        picker = self.picker()
        for failure in (OSError("failed"), subprocess.TimeoutExpired("fixture", 3)):
            with patch.dict(self.scope, run=lambda *_a, **_k: (_ for _ in ()).throw(failure)), self.assertRaisesRegex(ValueError, "became unavailable"):
                picker.command("display-message")
        with patch.dict(self.scope, run=lambda *_a, **_k: subprocess.CompletedProcess([], 1, "", "")), self.assertRaisesRegex(ValueError, "became unavailable"):
            picker.command("display-message")
        with self.assertRaisesRegex(ValueError, "Expected timeout"):
            picker.wait_for(lambda _: False, "Expected timeout", 1)
        for failure in (OSError("failed"), subprocess.TimeoutExpired("fixture", 3)):
            with patch.dict(self.scope, run=lambda *_a, **_k: (_ for _ in ()).throw(failure)):
                picker.close()
        self.assertFalse(picker.directory.exists())

    def test_exact_selection_and_confirmation_are_required_before_y(self):
        picker = self.picker()
        variants = ["Search: other\nf4 Delete", f"Search: {ID}\n> Reviewed fixture 2 steps", f"Search: {ID}\n> Reviewed fixture 2 steps\n> Other 2 steps\nf4 Delete", f"Search: {ID}\n> Reviewed fixture 3 steps\nf4 Delete", f"Search: {ID}\n> Different title 2 steps\nf4 Delete", f"Search: {ID}\n> Reviewed fixture 2 steps [Delete? (y/n)]\nf4 Delete"]
        for screen in variants:
            self.phase = "search"
            self.selection = screen
            with self.assertRaisesRegex(ValueError, "Exact Antigravity"):
                picker.delete(ID, "Reviewed fixture", 2)
            self.assertNotIn(["F4"], self.sent())
            self.assertNotIn(["y"], self.sent())
        self.selection = None
        self.phase = "search"
        picker.delete(ID, "", 2)
        self.assertTrue(picker.usable)
        self.assertEqual(self.sent()[-3:], [["F4"], ["y"], ["Escape"]])

    def test_confirmation_uncertainty_is_never_replayed(self):
        picker = self.picker()
        self.fail_after_confirm = True
        with self.assertRaisesRegex(self.scope["AntigravityUncertain"], "outcome is unknown"):
            picker.delete(ID, "Reviewed fixture", 2)
        self.assertFalse(picker.usable)
        sent = len(self.sent())
        with self.assertRaisesRegex(ValueError, "time limit is unavailable"):
            picker.delete(ID, "Reviewed fixture", 2)
        self.assertEqual(len(self.sent()), sent)

    def test_confirmation_timeouts_and_failed_search_reset(self):
        picker = self.picker()
        self.scope["antigravity_absent"] = lambda _: False
        with self.assertRaisesRegex(self.scope["AntigravityUncertain"], "did not confirm"):
            picker.delete(ID, "Reviewed fixture", 2)
        self.assertFalse(picker.usable)
        self.now = 0
        self.phase = "startup"
        picker = self.picker()
        attempts = []
        def absent(_):
            attempts.append(True)
            if len(attempts) == 1:
                raise sqlite3.OperationalError("Temporarily locked")
            return True
        self.scope["antigravity_absent"] = absent
        original_keys = picker.keys
        def keys(*args):
            if args == ("Escape",):
                raise ValueError("Reset failed after verified deletion")
            original_keys(*args)
        picker.keys = keys
        picker.delete(ID, "Reviewed fixture", 2)
        self.assertEqual(len(attempts), 2)
        self.assertFalse(picker.usable)

    def test_deadline_refuses_confirmation_and_expired_batches(self):
        picker = self.picker()
        self.late_confirmation = True
        with self.assertRaisesRegex(ValueError, "before confirmation"):
            picker.delete(ID, "Reviewed fixture", 2)
        self.assertNotIn(["y"], self.sent())
        with self.assertRaisesRegex(ValueError, "time limit is unavailable"):
            picker.delete(ID, "Reviewed fixture", 2)


if __name__ == "__main__":
    unittest.main()
