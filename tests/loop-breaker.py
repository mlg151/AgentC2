"""Provider hook emits only structured, bounded failure evidence."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class LoopHook(unittest.TestCase):
    def test_failed_and_successful_tool_outcomes(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-loop-") as directory:
            root = Path(directory)
            hook = root / "hq-aaaaaaaaaaaa" / "hook.py"
            hook.parent.mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "electron" / "session-hook.py", hook)

            def invoke(event, tool_id, **extra):
                payload = {"hook_event_name": event, "session_id": "session-1", "prompt_id": "turn-1",
                           "tool_name": "Bash", "tool_use_id": tool_id, "tool_input": {"command": "private command"}, **extra}
                subprocess.run(["python3", str(hook), "claude", "hook"], input=json.dumps(payload),
                               text=True, capture_output=True, timeout=5, check=True)

            invoke("PostToolUseFailure", "tool-1", error="Exit code 1\nPRIVATE_ERROR")
            invoke("PostToolUseFailure", "tool-1", error="Exit code 1\nPRIVATE_ERROR")
            invoke("PostToolUseFailure", "tool-2", error="Exit code 1\nPRIVATE_ERROR")
            invoke("PostToolUseFailure", "tool-3", error="Exit code 2\nPRIVATE_ERROR")
            invoke("PostToolUseFailure", "tool-4", error="Could not start process")
            invoke("PostToolUseFailure", "tool-5", error="Exit code 1", is_interrupt=True)
            invoke("PostToolUse", "tool-6")
            lines = (hook.parent / "events.jsonl").read_text().splitlines()
            self.assertEqual(len(lines), 5, "Repeated hook ID and user interrupt must not duplicate failures")
            self.assertNotIn("private command", "".join(lines))
            self.assertNotIn("PRIVATE_ERROR", "".join(lines))
            events = [json.loads(line) for line in lines]
            self.assertEqual(events[0]["failureSignature"], events[1]["failureSignature"])
            self.assertNotEqual(events[0]["failureSignature"], events[2]["failureSignature"])
            self.assertNotIn("failureSignature", events[3], "Unstructured errors do not confirm a streak")
            self.assertEqual(events[4]["kind"], "tool_ok")


if __name__ == "__main__":
    unittest.main()
