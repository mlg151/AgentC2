"""Read-only OpenCode inventory, scoped native deletion, and MCP conversions."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
scope = {"__name__": "agentc2_opencode_test"}
for name in ("antigravity-cleanup.py", "session-cleanup.py", "oporders.py", "provider_telemetry.py", "remote.py"):
    exec((root / "electron" / name).read_text(), scope)


class OpenCodeHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentc2-opencode-history-")
        self.home = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {"XDG_DATA_HOME": str(self.home / ".local/share")})
        self.environment.start()
        self.patched = patch.dict(scope, {"HOME": self.home, "cleanup_activity": lambda *_: ""})
        self.patched.start()
        self.database = scope["opencode_database"]()
        self.database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.executescript("CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, title TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE session_message(id TEXT, session_id TEXT, data TEXT); CREATE TABLE session_pending(id TEXT, session_id TEXT); CREATE TABLE event(id TEXT, aggregate_id TEXT, data TEXT);")
            connection.execute("INSERT INTO session_v2 VALUES(?,NULL,NULL,?,?,?)", ("ses_fixture123", "Native title", self.temp.name, 1000000000000))
            connection.execute("INSERT INTO session_message VALUES('message1','ses_fixture123','fixture transcript')")
            connection.commit()

    def tearDown(self):
        self.patched.stop()
        self.environment.stop()
        self.temp.cleanup()

    def test_inventory_and_launch_arguments(self):
        session = scope["opencode_sessions"]()[0]
        self.assertEqual(session["title"], "Native title")
        self.assertTrue(session["canResume"])
        self.assertEqual(scope["agent_command"]("opencode", "ses_fixture123", instructions="task with spaces", roe_profile="full"), ["opencode", "--auto", "--session", "ses_fixture123", "--prompt", "task with spaces"])
        self.assertEqual(scope["agent_command"]("opencode", roe_profile="provider-default"), ["opencode"])
        with self.assertRaisesRegex(ValueError, "gated"):
            scope["agent_command"]("opencode", roe_profile="gated")

    def test_legacy_inventory_and_migrated_id_precedence(self):
        with closing(sqlite3.connect(self.database)) as connection:
            connection.executescript("CREATE TABLE session(id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER);")
            connection.execute("INSERT INTO session VALUES('ses_fixture123',NULL,'Old title',?,1000000000000)", (self.temp.name,))
            connection.execute("INSERT INTO session VALUES('ses_legacy123',NULL,'Legacy only',?,1000000000000)", (self.temp.name,))
            connection.commit()
        sessions = scope["opencode_sessions"]()
        self.assertEqual(len(sessions), 2)
        self.assertEqual(next(row["title"] for row in sessions if row["id"] == "ses_fixture123"), "Native title")
        planned, _ = scope["cleanup_plan"]("opencode", "ses_legacy123")
        self.assertFalse(planned["eligible"])
        self.assertIn("legacy", planned["reason"])

    def test_native_deletion_preserves_other_sessions_and_project_files(self):
        sentinel = self.home / "project.txt"
        sentinel.write_text("Keep project work")
        def native(args, **kwargs):
            self.assertEqual(args, ["opencode", "session", "delete", "--standalone", "ses_fixture123"])
            self.assertEqual(kwargs["cwd"], self.temp.name)
            with closing(sqlite3.connect(self.database)) as connection:
                connection.execute("DELETE FROM session_v2 WHERE id=?", (args[-1],))
                connection.commit()
            return subprocess.CompletedProcess(args, 0, "", "")
        planned, _ = scope["cleanup_plan"]("opencode", "ses_fixture123")
        self.assertTrue(planned["eligible"], planned["reason"])
        with patch.object(subprocess, "run", side_effect=native):
            result = scope["cleanup_delete_one"](dict(provider="opencode", id="ses_fixture123", fingerprint=planned["fingerprint"], deadline=time.monotonic() + 15))
        self.assertEqual(result["status"], "deleted")
        self.assertEqual(sentinel.read_text(), "Keep project work")
        self.assertTrue(self.database.exists())
        self.assertEqual(scope["opencode_sessions"](), [])

    def test_changed_and_related_histories_are_excluded(self):
        planned, _ = scope["cleanup_plan"]("opencode", "ses_fixture123")
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE session_message SET data='changed'")
            connection.commit()
        result = scope["cleanup_delete_one"](dict(provider="opencode", id="ses_fixture123", fingerprint=planned["fingerprint"], deadline=time.monotonic() + 15))
        self.assertEqual(result["status"], "changed")
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("INSERT INTO session_v2 VALUES('ses_child123','ses_fixture123',NULL,'Child',?,1)", (self.temp.name,))
            connection.commit()
        planned, _ = scope["cleanup_plan"]("opencode", "ses_fixture123")
        self.assertFalse(planned["eligible"])
        self.assertIn("children", planned["reason"])

    def test_v2_mcp_schema_and_environment_references(self):
        order = dict(instructions="Shared", mcp=[dict(name="docs", providers=["opencode"], transport="http", url="https://example.com/mcp", headers={"Authorization": "DOCS_TOKEN"}), dict(name="local", providers=["opencode"], transport="stdio", command="node", args=["server.js"], env=["KEY"])])
        blocks, entries, unsupported = scope["oporder_render"](order)
        self.assertFalse(unsupported)
        self.assertEqual(blocks["AGENTS.md"], "Shared")
        existing = json.dumps(dict(model="existing/model", mcp=dict(timeout=dict(startup=30000), servers=dict(existing=dict(type="remote", url="https://existing.example/mcp")))))
        updated, hashes = scope["oporder_entries"](existing, entries["opencode.json"], {}, True)
        data = json.loads(updated)
        self.assertEqual(data["model"], "existing/model")
        self.assertIn("existing", data["mcp"]["servers"])
        self.assertEqual(data["mcp"]["servers"]["local"]["environment"]["KEY"], "{env:KEY}")
        self.assertEqual(data["mcp"]["servers"]["docs"]["headers"]["Authorization"], "{env:DOCS_TOKEN}")
        restored, _ = scope["oporder_entries"](updated, {}, hashes, True)
        self.assertEqual(json.loads(restored), json.loads(existing))


if __name__ == "__main__":
    unittest.main()
