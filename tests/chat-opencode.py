"""ACP process integration without model calls or credentials."""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_journal import Journal
from chat_opencode import OpenCodeAdapter
from chat_protocol import CONTRACT


class OpenCodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentc2-opencode-")
        self.journal = Journal(Path(self.temp.name) / "journal")
        self.adapter = None

    def tearDown(self):
        if self.adapter:
            self.adapter.stop()
        self.journal.close()
        self.temp.cleanup()

    def create(self, profile="provider-default", resume=None):
        capabilities = dict(provider="opencode", version="2.1.3", status="supported", reason=None, **{key: key in ("streaming", "history", "resume", "interrupt", "approvals", "questions") for key in CONTRACT["capabilities"]})
        payload = dict(provider="opencode", cwd=self.temp.name, title="OpenCode fixture", roeProfile=profile, managedName="hq-123456abcdef")
        if resume:
            payload["providerSessionId"] = resume
        receipt, _ = self.journal.accept(dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=payload), capabilities)
        self.identifier = receipt["sessionId"]
        session = self.journal.history(self.identifier)["session"]
        binary = str(Path(__file__).parent / "fixtures" / "opencode-acp.py")
        self.adapter = OpenCodeAdapter(session, self.journal, binary=binary, timeout=3)
        self.adapter.start()

    def events(self):
        return self.journal.history(self.identifier, limit=500)["events"]

    def wait(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            events = self.events()
            if predicate(events):
                return events
            time.sleep(0.01)
        self.fail("ACP fixture did not reach expected state")

    def test_model_change_preserves_native_session_and_rejection(self):
        self.create()
        native = self.adapter.native_id
        self.assertEqual(self.adapter.set_model("fixture/second")["model"], "fixture/second")
        from chat_adapters import ProviderRejected
        with self.assertRaisesRegex(ProviderRejected, "Model unavailable"):
            self.adapter.set_model("rejected-model")
        self.assertEqual(self.adapter.session["model"], "fixture/second")
        self.adapter.send("hello", str(uuid.uuid4()))
        self.wait(lambda items: items[-1]["type"] == "turn.completed")
        self.assertEqual(self.adapter.native_id, native)

    def test_streaming_usage_and_native_resume(self):
        self.create(resume="ses_saved123456")
        self.assertEqual(self.journal.history(self.identifier)["session"]["providerSessionId"], "ses_saved123456")
        self.assertEqual([item["data"]["text"] for item in self.events() if item["type"] == "message.completed"], ["Previous native prompt", "Previous native answer"])
        self.adapter.send("hello", str(uuid.uuid4()))
        events = self.wait(lambda items: items[-1]["type"] == "turn.completed")
        self.assertEqual([item["data"]["text"] for item in events if item["type"] == "message.completed"][-1], "Streamed answer")
        self.assertEqual(next(item["data"] for item in events if item["type"] == "usage.updated")["costUsd"], 0.01)

    def test_permission_reply_correlates_native_request_and_rejects_replay(self):
        self.create()
        self.adapter.send("permission", str(uuid.uuid4()))
        events = self.wait(lambda items: any(item["type"] == "approval.requested" for item in items))
        event = next(item for item in events if item["type"] == "approval.requested")
        payload = dict(requestId=event["data"]["requestId"], turnId=event["turnId"], itemId=event["itemId"], decision="deny")
        with self.assertRaisesRegex(ValueError, "stale"):
            self.adapter.respond({**payload, "turnId": "wrong"})
        self.adapter.respond(payload)
        events = self.wait(lambda items: items[-1]["type"] == "turn.completed")
        self.assertTrue(any(item["type"] == "tool.completed" and item["data"]["isError"] for item in events))
        with self.assertRaisesRegex(ValueError, "stale"):
            self.adapter.respond(payload)

    def test_full_permissions_and_question_response(self):
        self.create("full")
        self.adapter.send("permission", str(uuid.uuid4()))
        events = self.wait(lambda items: items[-1]["type"] == "turn.completed")
        self.assertFalse(any(item["type"] == "approval.requested" for item in events))
        self.assertTrue(any(item["type"] == "tool.completed" and not item["data"]["isError"] for item in events))
        self.adapter.send("question", str(uuid.uuid4()))
        events = self.wait(lambda items: any(item["type"] == "question.requested" for item in items))
        event = next(item for item in events if item["type"] == "question.requested")
        self.adapter.respond(dict(requestId=event["data"]["requestId"], turnId=event["turnId"], itemId=event["itemId"], answers=[dict(questionId="pm", answers=["pnpm"])]))
        events = self.wait(lambda items: items[-1]["type"] == "turn.completed" and any(item["data"].get("text") == "Selected pnpm" for item in items))
        self.assertEqual(self.journal.pending_requests(self.identifier), [])

    def test_interrupt_and_owned_process_stop(self):
        self.create()
        pid = self.adapter.process.pid
        self.adapter.send("slow", str(uuid.uuid4()))
        self.adapter.interrupt()
        events = self.wait(lambda items: items[-1]["type"] == "turn.completed")
        self.assertEqual(events[-1]["data"]["outcome"], "interrupted")
        self.adapter.stop()
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_disconnect_does_not_infer_completion(self):
        self.create()
        self.adapter.send("disconnect", str(uuid.uuid4()))
        self.wait(lambda items: any(item["type"] == "error" for item in items))
        self.assertEqual(self.journal.history(self.identifier)["session"]["state"], "unknown")
        self.assertFalse(any(item["type"] == "turn.completed" for item in self.events()))

    def test_gated_profile_is_rejected_before_launch(self):
        with self.assertRaisesRegex(ValueError, "not verified"):
            self.create("gated")
        self.assertIsNone(self.adapter.process)


if __name__ == "__main__":
    unittest.main()
