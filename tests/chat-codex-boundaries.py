"""Codex adapter failures through real journals and the pinned native schema."""
from concurrent.futures import TimeoutError
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "electron"))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))
import chat_codex as native
from chat_adapters import ProviderRejected
from chat_journal import Journal
from chat_protocol import CONTRACT
from codex_boundaries import process, thread_result, approval, question


class CodexBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentc2-codex-boundaries-")
        self.root = Path(self.temporary.name)
        self.journals = []

    def tearDown(self):
        for journal in self.journals:
            journal.close()
        self.temporary.cleanup()

    def adapter(self, profile="gated", **extra):
        journal = Journal(self.root / str(len(self.journals)))
        self.journals.append(journal)
        caps = dict(provider="codex", version="0.163.0", status="supported", reason=None, **{key: True for key in CONTRACT["capabilities"]})
        payload = {**dict(provider="codex", cwd=str(self.root), title="Native boundary fixture", roeProfile=profile, providerSessionId="native-thread"), **extra}
        receipt, _ = journal.accept(dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=payload), caps)
        journal.append(receipt["sessionId"], "session.updated", dict(state="idle", detail="Local native boundary fixture ready"))
        return native.CodexAdapter(journal.history(receipt["sessionId"])["session"], journal, binary="/fixture/codex", timeout=0.02)

    def page(self, adapter):
        return adapter.journal.history(adapter.session["id"])

    def test_write_request_failure_and_response_correlation_are_bounded(self):
        adapter = self.adapter()
        with self.assertRaisesRegex(EOFError, "no longer connected"):
            adapter.write(dict(fixture=True))
        adapter.process = process()
        adapter.write(dict(text="Unicode fixture Ω"))
        self.assertEqual(adapter.process.stdin.getvalue().decode(), '{"text":"Unicode fixture Ω"}\n')
        adapter.write = Mock()
        with self.assertRaises(TimeoutError):
            adapter.request("account/read", dict(refreshToken=False))
        self.assertEqual(adapter.pending, {}, "A timed-out request must release its correlation slot")
        with self.assertRaises(ValueError):
            adapter.request("account/read", dict(refreshToken="invalid"))
        for response, error in [(dict(error={}), ProviderRejected), (dict(result={}), ValueError)]:
            def deliver(message):
                adapter.pending[message["id"]].set_result(response)
            adapter.write = deliver
            with self.assertRaises(error):
                adapter.request("account/read", dict(refreshToken=False))
            self.assertEqual(adapter.pending, {})
        # Unknown/duplicate IDs and account metadata cannot overwrite a matched
        # result or become transcript content.
        adapter = self.adapter()
        result = dict(account=None, requiresOpenaiAuth=False)
        frames = [dict(id=999, result={}), dict(method="account/updated", params=dict(secret="PRIVATE_FIXTURE_MARKER")), dict(id=1, result=result), dict(id=1, result={})]
        adapter.process = process(b"".join((json.dumps(frame) + "\n").encode() for frame in frames))
        adapter.write = lambda _message: adapter.read()
        self.assertEqual(adapter.request("account/read", dict(refreshToken=False)), result)
        self.assertEqual(adapter.pending, {})
        self.assertNotIn("PRIVATE_FIXTURE_MARKER", json.dumps(self.page(adapter)))

    def test_invalid_provider_frames_fail_pending_requests_without_echoing_input(self):
        for wire in (b"[]\n", b"{invalid PRIVATE_FIXTURE_MARKER}\n", b"{}", b"x" * 4000001, b'{"id":[]}\n'):
            with self.subTest(length=len(wire)):
                adapter = self.adapter()
                adapter.process = process(wire)
                adapter.write = lambda _message: adapter.read()
                with self.assertRaisesRegex(EOFError, "Codex protocol connection failed"):
                    adapter.request("account/read", dict(refreshToken=False))
                page = self.page(adapter)
                self.assertEqual(page["session"]["state"], "unknown")
                self.assertEqual(page["events"][-1]["data"]["code"], "codex_connection_lost")
                self.assertNotIn("PRIVATE_FIXTURE_MARKER", json.dumps(page))
                self.assertEqual(adapter.pending, {})

    def test_startup_rejects_missing_paths_auth_roe_and_active_threads(self):
        adapter = self.adapter()
        adapter.binary = None
        with patch.object(native.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(ProviderRejected, "CLI or remote working directory"):
                adapter.start()
            spawn.assert_not_called()
        adapter = self.adapter(cwd=str(self.root / "missing"))
        with patch.object(native.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(ProviderRejected, "CLI or remote working directory"):
                adapter.start()
            spawn.assert_not_called()
        for kind in ("auth", "full", "gated", "active"):
            with self.subTest(kind=kind):
                adapter = self.adapter(profile="full" if kind == "full" else "gated")
                response = thread_result(self.root, active=kind == "active")
                if kind == "gated":
                    response.update(approvalPolicy="never", sandbox=dict(type="dangerFullAccess"))
                native.validate_native("v2/ThreadResumeResponse", response)
                adapter.request = Mock(side_effect=[{}, dict(account=None, requiresOpenaiAuth=kind == "auth"), response])
                adapter.stop = Mock()
                with patch.object(native.subprocess, "Popen", return_value=process()), patch.object(native.threading, "Thread"):
                    with self.assertRaisesRegex(ProviderRejected, "Sign in|full-permissions|gated profile|already has active work"):
                        adapter.start()
                adapter.stop.assert_called_once()

    def test_account_foreign_thread_unknown_events_and_item_metadata(self):
        adapter = self.adapter()
        before = len(self.page(adapter)["events"])
        adapter.notification("account/secret", dict(secret="PRIVATE_FIXTURE_MARKER"))
        self.assertEqual(len(self.page(adapter)["events"]), before)
        adapter.notification("fixture/event", dict(threadId="another-thread", evidence="Foreign protocol metadata"))
        self.assertEqual(self.page(adapter)["events"][-1]["type"], "provider.event")
        adapter.notification("error", dict(error={"message": "Reviewed provider notice"}, turnId="turn"))
        self.assertEqual(self.page(adapter)["events"][-1]["data"]["message"], "Reviewed provider notice")
        adapter.provider_event("fixture/large", dict(evidence="x" * 200001))
        self.assertTrue(self.page(adapter)["events"][-1]["data"]["payload"]["truncated"])
        items = [dict(id="compact", type="contextCompaction"), dict(id="reasoning", type="reasoning", summary=[], content=["x" * 200001]),
                 dict(id="answer", type="agentMessage", text="Exact final answer", phase="final_answer"),
                 dict(id="tool", type="commandExecution", command="fixture command", cwd=str(self.root), commandActions=[], status="completed", aggregatedOutput=None, exitCode=0)]
        for item in items:
            params = dict(threadId="native-thread", turnId="turn", item=item, completedAtMs=0)
            adapter.notification("item/completed", params)
        events = self.page(adapter)["events"]
        self.assertTrue(any(event["data"].get("method") == "item/agentMessage/metadata" for event in events))
        self.assertTrue(any(event["data"].get("payload", {}).get("truncated") for event in events if event["type"] == "provider.event"))
        self.assertTrue(any(event["type"] == "tool.completed" and event["data"]["output"] == "" for event in events))
        adapter.notification("item/completed", dict(threadId="native-thread", turnId="turn", item=items[2], completedAtMs=0))
        self.assertEqual(sum(event["type"] == "message.completed" for event in self.page(adapter)["events"]), 1)

    def test_interactive_rejection_deduplication_secret_and_review_limits(self):
        adapter = self.adapter()
        adapter.write = Mock()
        adapter.server_request(dict(id=1, method="future/operation", params={}))
        self.assertEqual(adapter.write.call_args.args[0]["error"]["code"], -32601)
        adapter.server_request(approval(thread="another-thread"))
        self.assertEqual(adapter.requests, {})
        native_request = approval(identifier=2)
        adapter.server_request(native_request)
        count = len(self.page(adapter)["events"])
        adapter.server_request(native_request)
        self.assertEqual(len(self.page(adapter)["events"]), count)
        changed = approval(identifier=2, command="Changed action")
        with self.assertRaisesRegex(ValueError, "reused an interactive request ID"):
            adapter.server_request(changed)
        other = self.adapter(); other.write = Mock()
        other.server_request(question(secret=True))
        self.assertEqual(other.requests, {})
        self.assertEqual(other.journal.pending_requests(other.session["id"]), [])
        self.assertEqual(other.write.call_args.args[0]["error"]["code"], -32602)
        large = self.adapter(); large.write = Mock()
        large.server_request(approval(command="x" * (CONTRACT["limits"]["text"] + 1)))
        self.assertEqual(large.requests, {})
        self.assertEqual(large.journal.pending_requests(large.session["id"]), [])
        self.assertEqual(large.write.call_args.args[0]["result"], dict(decision="decline"))
        self.assertEqual(self.page(large)["events"][-1]["data"]["code"], "approval_too_large")

    def test_response_identity_expiry_and_question_answers(self):
        adapter = self.adapter(); adapter.write = Mock()
        adapter.server_request(question())
        pending = adapter.journal.pending_requests(adapter.session["id"])[0]
        payload = dict(requestId=pending["requestId"], turnId=pending["turnId"], itemId=pending["itemId"], answers=[dict(questionId="choice", answers=["Written fixture answer"])])
        for field in ("requestId", "turnId", "itemId"):
            with self.assertRaisesRegex(ProviderRejected, "no longer active"):
                adapter.respond({**payload, field: "changed"})
        adapter.journal.accept(dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="respond", sessionId=adapter.session["id"], payload=payload))
        self.assertTrue(adapter.respond(payload)["responded"])
        self.assertEqual(adapter.write.call_args.args[0]["result"], dict(answers=dict(choice=dict(answers=["Written fixture answer"]))))
        stale = self.adapter(); stale.write = Mock(); stale.server_request(approval())
        pending = stale.journal.pending_requests(stale.session["id"])[0]
        stale.journal.append(stale.session["id"], "request.resolved", dict(requestId=pending["requestId"], state="expired", decision=None), "turn", "tool")
        with self.assertRaisesRegex(ProviderRejected, "completed before the response"):
            stale.respond(dict(requestId=pending["requestId"], turnId="turn", itemId="tool", decision="deny"))

    def test_history_failures_and_stop_during_import_cannot_report_ready(self):
        adapter = self.adapter()
        adapter.request = Mock(side_effect=[dict(data=[], nextCursor="same"), dict(data=[], nextCursor="same")])
        adapter.import_history()
        self.assertEqual(self.page(adapter)["session"]["state"], "unknown")
        self.assertEqual(self.page(adapter)["events"][-1]["data"]["code"], "history_import_failed")
        adapter = self.adapter(); adapter.stopping = True; adapter.request = Mock()
        before = len(self.page(adapter)["events"]); adapter.import_history()
        adapter.request.assert_not_called(); self.assertEqual(len(self.page(adapter)["events"]), before)
        adapter = self.adapter()
        def stopped(*_args):
            adapter.stopping = True
            raise RuntimeError("Late import error")
        adapter.request = stopped; before = len(self.page(adapter)["events"]); adapter.import_history()
        self.assertEqual(len(self.page(adapter)["events"]), before)

    def test_stop_reaps_the_owned_child_when_it_exits_between_poll_and_signal(self):
        for phase in ("term", "kill"):
            with self.subTest(phase=phase):
                adapter = self.adapter()
                adapter.process = process()
                if phase == "kill":
                    adapter.process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 5), 0]
                failures = ProcessLookupError("Owned process group already exited") if phase == "term" else [None, ProcessLookupError("Owned process group already exited")]
                with patch.object(native.os, "killpg", side_effect=failures):
                    self.assertEqual(adapter.stop(), {})
                self.assertEqual(adapter.process.wait.call_count, 1 if phase == "term" else 2, "A missing process group must still reap the owned child before confirming stop")
                self.assertTrue(adapter.process.stdin.closed)
                self.assertTrue(adapter.process.stdout.closed)

    def test_model_interrupt_and_forced_process_stop_fences(self):
        adapter = self.adapter()
        adapter.turn_id = "active-turn"
        with self.assertRaisesRegex(ProviderRejected, "current Codex turn"):
            adapter.set_model("next-model")
        adapter.turn_id = None
        with self.assertRaisesRegex(ProviderRejected, "No active Codex turn"):
            adapter.interrupt()
        adapter.process = process()
        adapter.process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 5), 0]
        adapter.reader = threading.current_thread()
        adapter.importer = Mock()
        with patch.object(native.os, "killpg") as kill:
            adapter.stop()
        self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])
        adapter.importer.join.assert_called_once_with(timeout=adapter.timeout + 1)
        self.assertTrue(adapter.process.stdin.closed); self.assertTrue(adapter.process.stdout.closed)

    def test_stop_does_not_confirm_permission_failures_or_an_unreaped_child(self):
        adapter = self.adapter(); adapter.process = process()
        with patch.object(native.os, "killpg", side_effect=PermissionError("Owned process signal refused")):
            with self.assertRaises(PermissionError):
                adapter.stop()
        adapter.process.wait.assert_not_called()
        adapter = self.adapter(); adapter.process = process()
        adapter.process.wait.side_effect = subprocess.TimeoutExpired("fixture", 5)
        with patch.object(native.os, "killpg", side_effect=ProcessLookupError("Process group unavailable")):
            with self.assertRaises(subprocess.TimeoutExpired):
                adapter.stop()
        self.assertEqual(adapter.process.wait.call_count, 2)


if __name__ == "__main__":
    unittest.main()
