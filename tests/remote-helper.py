"""Exit evidence must stay authoritative when tmux lacks a wait status."""
from pathlib import Path
import json
import os
import sqlite3
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


scope = {"__name__": "agentc2_helper_test"}
exec((Path(__file__).resolve().parents[1] / "electron" / "provider_telemetry.py").read_text(), scope)
exec((Path(__file__).resolve().parents[1] / "electron" / "remote.py").read_text(), scope)


class ExitEvidence(unittest.TestCase):
    def session(self, status="", record="1234:7", pid="1234", dead="1", managed=True):
        name = "hq-123456abcdef" if managed else "external"
        row = "\t".join([name, "1000", "0", "codex", "/tmp", dead, status, "1001", pid, record])

        def run(args, **_):
            return subprocess.CompletedProcess(args, 0, row if args[1] == "list-sessions" else "", "")

        scope["run"] = run
        scope["tmux_option"] = lambda _name, option: "codex" if option == "@hq_provider" else ""
        return scope["tmux_sessions"]()[0]

    def test_recorded_child_failure_and_success(self):
        self.assertEqual(self.session()["exitCode"], 7)
        self.assertEqual(self.session()["roeProfile"], "unknown")
        self.assertEqual(self.session(record="1234:0")["exitCode"], 0)

    def test_native_wait_status_has_priority(self):
        self.assertEqual(self.session(status="9")["exitCode"], 9)

    def test_respawn_and_unknown_exits_do_not_infer_completion(self):
        for values in [{"pid": "5678"}, {"record": ""}, {"record": "bad"}, {"record": "1234:256"}, {"dead": "0"}, {"managed": False}]:
            with self.subTest(values=values):
                self.assertIsNone(self.session(**values)["exitCode"])


class HostHealth(unittest.TestCase):
    def test_optional_gpu_probe_and_unsupported_status(self):
        original_run = scope["run"]
        try:
            with patch.object(shutil, "which", return_value=None):
                unsupported = scope["health"]({"includeGpu": True})
            self.assertEqual(unsupported["gpu"]["status"], "unsupported")
            self.assertNotIn("gpu", scope["health"]({"includeGpu": False}))
            scope["run"] = lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "Fixture GPU, 8192, 1024\n", "")
            with patch.object(shutil, "which", return_value="/usr/bin/nvidia-smi"):
                reported = scope["health"]({"includeGpu": True})
            self.assertEqual(reported["gpu"]["devices"][0]["memoryUsed"], 1024 * 1024 * 1024)
            self.assertEqual(reported["gpu"]["status"], "reported")
        finally:
            scope["run"] = original_run


class AntigravityInventory(unittest.TestCase):
    def test_current_sqlite_layout_and_legacy_fallback(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-agy-inventory-") as directory:
            home = Path(directory)
            current = home / ".gemini" / "antigravity-cli" / "conversations"
            legacy = home / ".gemini" / "antigravity" / "conversations"
            current.mkdir(parents=True)
            legacy.mkdir(parents=True)
            modern_id = "12345678-1234-4234-8234-123456789012"
            old_id = "87654321-1234-4234-8234-123456789012"
            modern = current / f"{modern_id}.db"
            with sqlite3.connect(modern) as connection:
                connection.execute("CREATE TABLE trajectory_meta (trajectory_id TEXT)")
            os.utime(modern, (1000, 1000))
            (legacy / f"{modern_id}.pb").write_bytes(b"old duplicate")
            (legacy / f"{old_id}.pb").write_bytes(b"old history")
            (current / "bad-layout.db").write_bytes(b"not SQLite")
            (current / "linked-history.db").symlink_to(modern)
            with patch.dict(scope, {"HOME": home}):
                sessions = scope["antigravity_sessions"]()
            self.assertEqual({session["id"] for session in sessions}, {modern_id, old_id})
            self.assertEqual(next(session for session in sessions if session["id"] == modern_id)["updatedAt"], scope["iso_from_epoch"](1000))


class RulesOfEngagement(unittest.TestCase):
    def test_provider_flags_and_resume_order(self):
        command = scope["agent_command"]("codex", "12345678-1234-4234-8234-123456789012", roe_profile="gated")
        self.assertEqual(command[:5], ["codex", "--sandbox", "read-only", "--ask-for-approval", "on-request"])
        self.assertEqual(command[-2:], ["resume", "12345678-1234-4234-8234-123456789012"])
        claude = scope["agent_command"]("claude", preset={"args": "--model sonnet"}, roe_profile="gated")
        self.assertEqual(claude, ["--model", "sonnet", "--permission-mode", "default"])
        settings = scope["hook_arguments"]("claude", "hq-123456abcdef", {"preset": {"attentionHooks": False}, "roeProfile": "gated"})
        self.assertEqual(json.loads(settings[1])["permissions"]["ask"], ["Bash", "Edit", "Write", "NotebookEdit"])
        self.assertIn(scope["PERMISSION_FLAGS"]["codex"], scope["agent_command"]("codex"))
        self.assertNotIn(scope["PERMISSION_FLAGS"]["claude"], scope["agent_command"]("claude", preset={"args": "", "fullPermissions": False}))
        with self.assertRaisesRegex(ValueError, "verified gated mode"):
            scope["agent_command"]("antigravity", roe_profile="gated")


class Cleanup(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentc2-cleanup-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.helper = {"__name__": "cleanup_test"}
        root = Path(__file__).resolve().parents[1] / "electron"
        exec((root / "session-cleanup.py").read_text() + "\n" + (root / "provider_telemetry.py").read_text() + "\n" + (root / "remote.py").read_text(), self.helper)
        self.helper["HOME"] = self.home
        environment = patch.dict(os.environ, {"CODEX_HOME": str(self.home / '.codex'), "CODEX_SQLITE_HOME": str(self.home / '.codex')})
        environment.start()
        self.addCleanup(environment.stop)
        self.helper["cleanup_activity"] = lambda provider: ""
        self.one = "12345678-1234-4234-8234-123456789012"
        self.two = "12345678-1234-4234-8234-123456789013"

    def write(self, relative, content):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        old = time.time() - 90 * 86400
        os.utime(path, (old, old))
        return path

    def claude(self, session_id):
        return self.write(f".claude/projects/project/{session_id}.jsonl", json.dumps({"type": "user", "sessionId": session_id, "message": {"content": "Fixture"}}) + "\n")

    def preview(self, provider="claude", ids=None):
        return self.helper["cleanup_preview"]({"provider": provider, "ids": ids or [self.one]})["items"]

    def delete(self, items, provider="claude"):
        return self.helper["cleanup_delete"]({"provider": provider, "items": [{"id": item["id"], "fingerprint": item["fingerprint"]} for item in items]})["items"]

    def test_claude_bulk_scoped_files_shared_indexes_and_retry(self):
        first, second = self.claude(self.one), self.claude(self.two)
        child = self.write(f".claude/projects/project/{self.one}/subagents/agent-fixture.jsonl", '{}\n')
        snapshot = self.write(f".claude/file-history/{self.one}/snapshot@v1", 'before edit')
        other = self.claude("unrelated-session")
        credential = self.write('.claude/settings.json', '{"keep":true}')
        index = self.write('.claude/projects/project/sessions-index.json', json.dumps({"version": 1, "entries": [{"sessionId": value} for value in [self.one, self.two, 'unrelated-session']]}))
        history = self.write('.claude/history.jsonl', ''.join(json.dumps({"sessionId": value, "display": "Fixture"}) + '\n' for value in [self.one, self.two, 'unrelated-session']))
        items = self.preview(ids=[self.one, self.two])
        self.assertTrue(all(item['eligible'] for item in items))
        outcomes = self.delete(items)
        self.assertEqual([item['status'] for item in outcomes], ['deleted', 'deleted'])
        self.assertFalse(any(path.exists() for path in [first, second, child, snapshot]))
        self.assertTrue(other.exists() and credential.exists())
        self.assertEqual(json.loads(index.read_text())['entries'], [{"sessionId": 'unrelated-session'}])
        self.assertEqual(json.loads(history.read_text())['sessionId'], 'unrelated-session')
        self.assertEqual(self.delete(self.preview())[0]['status'], 'missing')

    def test_preview_changes_and_live_activity_prevent_deletion(self):
        transcript = self.claude(self.one)
        items = self.preview()
        transcript.write_text(transcript.read_text() + '{}\n')
        self.assertEqual(self.delete(items)[0]['status'], 'changed')
        self.helper['cleanup_activity'] = lambda provider: 'Live provider fixture'
        self.assertFalse(self.preview()[0]['eligible'])
        self.assertTrue(transcript.exists())

    def test_links_traversal_unknown_provider_and_unknown_index_are_excluded(self):
        self.claude(self.one)
        secret = self.write('outside.txt', 'keep')
        linked = self.home / f'.claude/projects/project/{self.one}/subagents/linked.jsonl'
        linked.parent.mkdir(parents=True)
        linked.symlink_to(secret)
        self.assertFalse(self.preview()[0]['eligible'])
        linked.unlink()
        os.link(secret, linked)
        self.assertFalse(self.preview()[0]['eligible'])
        linked.unlink()
        self.write('.claude/projects/project/sessions-index.json', '{"version": 999, "entries": []}')
        self.assertFalse(self.preview()[0]['eligible'])
        self.assertFalse(self.preview(provider='antigravity')[0]['eligible'])
        self.assertFalse(self.preview(ids=['../../escape'])[0]['eligible'])
        self.assertEqual(secret.read_text(), 'keep')

    def test_partial_failure_keeps_transcript_and_can_be_repreviewed(self):
        transcript = self.claude(self.one)
        sidecar = self.write(f'.claude/file-history/{self.one}/snapshot', 'snapshot')
        original = Path.unlink
        def fail_sidecar(path, *args, **kwargs):
            if path == sidecar:
                raise PermissionError('Fixture failure')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail_sidecar):
            self.assertEqual(self.delete(self.preview())[0]['status'], 'failed')
        self.assertTrue(transcript.exists())
        self.assertEqual(self.delete(self.preview())[0]['status'], 'deleted')

    def test_unknown_transcript_or_repository_sidecar_is_not_removed(self):
        transcript = self.claude(self.one)
        transcript.write_text('{"unexpected":"future format"}\n')
        self.assertFalse(self.preview()[0]['eligible'])
        self.claude(self.one)
        marker = self.write(f'.claude/file-history/{self.one}/.git', 'gitdir: /some/repository')
        self.assertFalse(self.preview()[0]['eligible'])
        self.assertTrue(marker.exists() and transcript.exists())

    def codex(self):
        transcript = self.write(f'.codex/sessions/2026/01/01/rollout-{self.one}.jsonl', '{}\n')
        db = self.home / '.codex/state_5.sqlite'
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER, is_pinned INTEGER)')
            conn.execute('INSERT INTO threads VALUES (?, ?, ?, 0)', (self.one, str(transcript), int((time.time() - 90 * 86400) * 1000)))
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args == ['codex', 'delete', '--help']:
                return subprocess.CompletedProcess(args, 0, '--force', '')
            if args == ['codex', 'delete', '--force', self.one]:
                transcript.unlink()
                with sqlite3.connect(db) as conn:
                    conn.execute('DELETE FROM threads WHERE id = ?', (self.one,))
                return subprocess.CompletedProcess(args, 0, '', '')
            raise AssertionError(args)
        self.helper['run'] = run
        return db, transcript, calls

    def test_codex_uses_native_delete_and_preserves_credentials(self):
        db, transcript, calls = self.codex()
        auth = self.write('.codex/auth.json', '{"keep":true}')
        items = self.preview(provider='codex')
        self.assertTrue(items[0]['eligible'])
        self.assertEqual(self.delete(items, provider='codex')[0]['status'], 'deleted')
        self.assertIn(['codex', 'delete', '--force', self.one], calls)
        self.assertFalse(transcript.exists())
        self.assertTrue(db.exists() and auth.exists())

    def test_codex_locked_db_unknown_schema_and_native_failure(self):
        db, transcript, _ = self.codex()
        with sqlite3.connect(db) as connection:
            connection.execute('BEGIN EXCLUSIVE')
            self.assertFalse(self.preview(provider='codex')[0]['eligible'])
            connection.rollback()
        items = self.preview(provider='codex')
        self.helper['run'] = lambda args, **kwargs: subprocess.CompletedProcess(args, 0 if args[-1] == '--help' else 1, '--force', '')
        self.assertEqual(self.delete(items, provider='codex')[0]['status'], 'failed')
        self.assertTrue(transcript.exists())
        with sqlite3.connect(db) as connection:
            connection.execute('DROP TABLE threads')
            connection.execute('CREATE TABLE threads (id TEXT)')
        self.assertFalse(self.preview(provider='codex')[0]['eligible'])

    @unittest.skipUnless(os.environ.get('AGENTC2_TEST_NATIVE_CLEANUP') == '1' and shutil.which('codex'), 'Opt in to disposable native Codex deletion with AGENTC2_TEST_NATIVE_CLEANUP=1')
    def test_installed_codex_native_contract_in_disposable_home(self):
        root = self.home / '.codex'
        root.mkdir()
        # Bootstrap the CLI's own current schema; delete a nonexistent fixture
        # UUID to initialize local state without sending any model prompt.
        subprocess.run(['codex', 'delete', '--force', self.two], cwd=self.home, capture_output=True, timeout=25)
        db = root / 'state_5.sqlite'
        self.assertTrue(db.exists())
        transcript = self.write(f'.codex/sessions/2020/01/01/rollout-2020-01-01T00-00-00-{self.one}.jsonl', json.dumps({
            'timestamp': '2020-01-01T00:00:00Z', 'type': 'session_meta', 'payload': {'id': self.one, 'timestamp': '2020-01-01T00:00:00Z', 'cwd': str(self.home), 'originator': 'agentc2-test', 'cli_version': '0.162.1', 'source': 'cli', 'model_provider': 'openai'}}) + '\n')
        with sqlite3.connect(db) as connection:
            connection.execute('INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                               (self.one, str(transcript), 1577836800, 1577836800, 'cli', 'openai', str(self.home), 'Disposable fixture', '{"type":"read-only"}', 'never', 1577836800000))
        credential = self.write('.codex/auth.json', '{"fixture":"keep"}')
        outcome = self.delete(self.preview(provider='codex'), provider='codex')[0]
        self.assertEqual(outcome['status'], 'deleted', outcome)
        self.assertFalse(transcript.exists())
        self.assertTrue(credential.exists())
        with sqlite3.connect(db) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM threads WHERE id=?', (self.one,)).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
