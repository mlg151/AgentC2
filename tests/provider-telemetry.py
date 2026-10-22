"""Disposable provider metadata and hook fixtures; no CLI prompt is sent."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("provider_telemetry", ROOT / "electron" / "provider_telemetry.py")
telemetry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(telemetry)


def iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


class ProviderTelemetry(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentc2-provider-telemetry-")
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_codex_context_and_rate_require_reported_usage_and_capacity(self):
        session = str(uuid.uuid4())
        root = self.home / ".codex"
        rollout = root / "sessions" / "2026" / "10" / "21" / f"rollout-{session}.jsonl"
        rollout.parent.mkdir(parents=True)
        now = time.time()
        records = []
        for at, used, total in ((now - 30, 150000, 1000), (now, 180000, 2500)):
            records.append({"type": "event_msg", "timestamp": iso(at), "payload": {"type": "token_count", "info": {
                "model_context_window": 200000, "last_token_usage": {"input_tokens": used}, "total_token_usage": {"total_tokens": total}}}})
        rollout.write_text("\n".join(json.dumps(record) for record in records) + "\n")
        db = sqlite3.connect(root / "state_5.sqlite")
        db.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
        db.execute("INSERT INTO threads VALUES (?, ?)", (session, str(rollout)))
        db.commit(); db.close()
        result = telemetry.provider_telemetry("codex", session, self.home)
        self.assertEqual(result["status"], "reported")
        self.assertEqual(result["context"]["percent"], 90)
        self.assertEqual(result["context"]["capacityTokens"], 200000)
        self.assertAlmostEqual(result["tokensPerMinute"], 3000, delta=1)
        self.assertIsNone(result["costUsd"])
        records[-1]["payload"]["info"].pop("model_context_window")
        rollout.write_text("\n".join(json.dumps(record) for record in records) + "\n")
        self.assertIsNone(telemetry.provider_telemetry("codex", session, self.home)["context"])
        os.utime(rollout, (now - 3600, now - 3600))
        records[-1]["timestamp"] = iso(now - 3600)
        rollout.write_text("\n".join(json.dumps(record) for record in records) + "\n")
        self.assertEqual(telemetry.provider_telemetry("codex", session, self.home)["status"], "stale")

    def test_claude_cost_deduplication_and_unknown_cost(self):
        session = str(uuid.uuid4())
        transcript = self.home / ".claude" / "projects" / "fixture" / f"{session}.jsonl"
        transcript.parent.mkdir(parents=True)
        now = time.time()
        def assistant(message, at, tokens):
            return {"type": "assistant", "timestamp": iso(at), "message": {"id": message, "usage": {"input_tokens": tokens, "output_tokens": 10}}}
        rows = [assistant("one", now - 20, 100), assistant("one", now - 20, 100), assistant("two", now - 5, 200),
                {"type": "cost-state", "sessionId": session, "hasUnknownModelCost": False, "totalCostUSD": 1.25}]
        transcript.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        result = telemetry.provider_telemetry("claude", session, self.home)
        self.assertEqual(result["status"], "reported")
        self.assertEqual(result["costUsd"], 1.25)
        self.assertIsNone(result["context"])
        self.assertAlmostEqual(result["tokensPerMinute"], 1280, delta=2)
        rows.append(assistant("three", now - 1, 30))
        transcript.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        self.assertIsNone(telemetry.provider_telemetry("claude", session, self.home)["costUsd"])
        rows.append({"type": "cost-state", "sessionId": session, "hasUnknownModelCost": True, "totalCostUSD": 1.5})
        transcript.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        self.assertIsNone(telemetry.provider_telemetry("claude", session, self.home)["costUsd"])
        self.assertEqual(telemetry.provider_telemetry("antigravity", session, self.home)["status"], "unsupported")
        self.assertEqual(telemetry.provider_telemetry("codex", str(uuid.uuid4()), self.home)["status"], "unknown")

    def test_hook_events_are_minimal_and_deduplicated(self):
        script = self.home / "hook.py"
        shutil.copy2(ROOT / "electron" / "session-hook.py", script)
        session, prompt = str(uuid.uuid4()), str(uuid.uuid4())
        payload = {"session_id": session, "prompt_id": prompt, "hook_event_name": "Stop", "last_assistant_message": "private response text"}
        for _ in range(2):
            subprocess.run([sys.executable, str(script), "claude", "hook"], input=json.dumps(payload), text=True, check=True,
                           env={**os.environ, "HOME": str(self.home)})
        lines = (self.home / "events.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["session"], session)
        self.assertNotIn("private response text", lines[0])
        codex = {"type": "agent-turn-complete", "thread-id": session, "turn-id": prompt,
                 "input-messages": ["private prompt"], "last-assistant-message": "private answer"}
        for _ in range(2):
            subprocess.run([sys.executable, str(script), "codex", "notify", "PROFILE=", json.dumps(codex)], text=True, check=True,
                           env={**os.environ, "HOME": str(self.home), "CODEX_HOME": str(self.home / ".codex")})
        lines = (self.home / "events.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertNotIn("private prompt", "\n".join(lines))
        self.assertNotIn("private answer", "\n".join(lines))


if __name__ == "__main__":
    unittest.main()
