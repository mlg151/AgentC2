"""One-shot permission hook rendezvous and stale/duplicate rejection."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import types
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "electron"


class Flash(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="agentc2-flash-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.name = "hq-" + "a" * 12
        self.hook = self.root / self.name / "hook.py"
        self.hook.parent.mkdir(mode=0o700)
        shutil.copyfile(SOURCE / "session-hook.py", self.hook)
        self.scope = {"__name__": "flash_fixture", "TMUX_RE": re.compile(r"^hq-[a-f0-9]{12}$"), "HOOK_ROOT": self.root,
                      "run": lambda *_args, **_kwargs: types.SimpleNamespace(returncode=0, stdout=""), "tmux_option": lambda *_args: "claude"}
        exec((SOURCE / "flash.py").read_text(), self.scope)
        self.processes = []
        self.addCleanup(self.stop_processes)

    def stop_processes(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)

    def request(self, command="echo READY"):
        directory = self.hook.parent / "flash"
        before = {path.stem for path in directory.glob("*.json")} if directory.exists() else set()
        payload = {"hook_event_name": "PermissionRequest", "session_id": "session-qa", "prompt_id": "turn-qa",
                   "tool_name": "Bash", "tool_input": {"command": command}}
        process = subprocess.Popen(["python3", str(self.hook), "claude", "hook"], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.stdin.write(json.dumps(payload)); process.stdin.close(); process.stdin = None
        self.processes.append(process)
        for _ in range(100):
            files = {path.stem for path in directory.glob("*.json")} if directory.exists() else set()
            if files - before:
                return process, next(iter(files - before))
            time.sleep(0.05)
        raise AssertionError("Hook request was not recorded")

    def test_exact_action_one_shot_and_duplicate(self):
        process, request_id = self.request("echo APPROVE_ME")
        listed = self.scope["flash_list"]({})
        self.assertEqual(listed[0]["id"], request_id)
        self.assertEqual(json.loads(listed[0]["action"])["command"], "echo APPROVE_ME")
        events = self.hook.parent / "events.jsonl"
        before = len(events.read_text().splitlines())
        notification = {"hook_event_name": "Notification", "notification_type": "permission_prompt", "session_id": "session-qa"}
        subprocess.run(["python3", str(self.hook), "claude", "hook"], input=json.dumps(notification), text=True, capture_output=True, timeout=5, check=True)
        self.assertEqual(len(events.read_text().splitlines()), before, "Correlated notification must not duplicate the queue alert")
        first = self.scope["flash_decide"]({"name": self.name, "id": request_id, "decision": "allow"})
        self.assertEqual(first["state"], "submitted")
        output, errors = process.communicate(timeout=5)
        self.assertEqual(errors, "")
        self.assertEqual(json.loads(output)["hookSpecificOutput"]["decision"]["behavior"], "allow")
        self.assertEqual(self.scope["flash_list"]({})[0]["state"], "resolved")
        self.assertTrue(self.scope["flash_decide"]({"name": self.name, "id": request_id, "decision": "allow"})["duplicate"])
        with self.assertRaisesRegex(ValueError, "different decision"):
            self.scope["flash_decide"]({"name": self.name, "id": request_id, "decision": "deny"})

    def test_denial_and_expired_process_never_replay(self):
        first, first_id = self.request("touch forbidden")
        self.scope["flash_decide"]({"name": self.name, "id": first_id, "decision": "deny"})
        self.assertEqual(json.loads(first.communicate(timeout=5)[0])["hookSpecificOutput"]["decision"]["behavior"], "deny")
        second, second_id = self.request("echo later")
        second.kill(); second.communicate(timeout=3)
        expired = next(item for item in self.scope["flash_list"]({}) if item["id"] == second_id)
        self.assertEqual(expired["state"], "expired")
        with self.assertRaisesRegex(ValueError, "expired"):
            self.scope["flash_decide"]({"name": self.name, "id": second_id, "decision": "allow"})

    def test_tampered_identity_and_oversized_request(self):
        process, request_id = self.request("echo safe")
        path = self.hook.parent / "flash" / (request_id + ".json")
        data = json.loads(path.read_text()); data["name"] = "hq-" + "b" * 12; path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.scope["flash_decide"]({"name": self.name, "id": request_id, "decision": "allow"})
        process.kill(); process.communicate(timeout=3)
        payload = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "x" * 5000}}
        result = subprocess.run(["python3", str(self.hook), "claude", "hook"], input=json.dumps(payload), text=True, capture_output=True, timeout=5)
        self.assertEqual(result.stdout, "", "Oversized action must fall through to native prompt")


if __name__ == "__main__":
    unittest.main()
