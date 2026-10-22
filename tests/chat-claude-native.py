"""Installed Claude SDK/CLI boundary against a loopback model fixture only."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_claude import ClaudeAdapter, SUPPORTED_CLI_VERSION, SUPPORTED_SDK_VERSION
from chat_journal import Journal
from chat_protocol import CONTRACT


def installed():
    try:
        sdk = importlib.metadata.version("claude-agent-sdk")
    except importlib.metadata.PackageNotFoundError:
        return False
    from chat_claude import cli_binary
    binary = cli_binary()
    return sys.platform.startswith("linux") and sdk == SUPPORTED_SDK_VERSION and binary is not None and subprocess.run([binary, "--version"], capture_output=True, text=True, check=False).stdout.strip().startswith(SUPPORTED_CLI_VERSION + " ")


def sse(name, value):
    return "event: " + name + "\ndata: " + json.dumps(value) + "\n\n"


def response(model, count, question=False, parallel=False):
    tool = count == 1
    name = "AskUserQuestion" if question else "Bash"
    args = dict(questions=[dict(question="Which fixture option?", header="Choice", options=[dict(label="One", description="First"), dict(label="Two", description="Second")], multiSelect=False)]) if question else dict(command="printf fixture > witness.txt", description="Create disposable fixture witness")
    events = [sse("message_start", dict(type="message_start", message=dict(id="msg_sdk_fixture_" + str(count), type="message", role="assistant", model=model, content=[], stop_reason=None, stop_sequence=None, usage=dict(input_tokens=20, output_tokens=0))))]
    for index in range(2 if tool and parallel else 1):
        tool_args = dict(command="printf fixture > witness-" + str(index) + ".txt", description="Parallel disposable write " + str(index)) if parallel else args
        block = dict(type="tool_use", id="toolu_sdk_fixture_" + str(index), name=name, input={}) if tool else dict(type="text", text="")
        delta = dict(type="input_json_delta", partial_json=json.dumps(tool_args)) if tool else dict(type="text_delta", text="Fixture finished")
        events.extend([
            sse("content_block_start", dict(type="content_block_start", index=index, content_block=block)),
            sse("content_block_delta", dict(type="content_block_delta", index=index, delta=delta)),
            sse("content_block_stop", dict(type="content_block_stop", index=index)),
        ])
    events.extend([
        sse("message_delta", dict(type="message_delta", delta=dict(stop_reason="tool_use" if tool else "end_turn", stop_sequence=None), usage=dict(output_tokens=10))),
        sse("message_stop", dict(type="message_stop")),
    ])
    return "".join(events).encode()


@unittest.skipUnless(installed(), "Pinned Claude SDK and CLI must be installed; this test makes no live service requests")
class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="a2-claude-native-")
        self.root = Path(self.temp.name)
        (self.root / "CLAUDE.md").write_text("SDK_FIXTURE_INSTRUCTION: operate only in this disposable repository.\n")
        self.requests = []
        self.question = False
        self.parallel = False
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                size = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(size))
                if self.path.startswith("/v1/messages/count_tokens"):
                    output, kind = b'{"input_tokens":20}', "application/json"
                elif self.path.startswith("/v1/messages"):
                    fixture.requests.append(payload)
                    output, kind = response(payload["model"], len(fixture.requests), fixture.question, fixture.parallel), "text/event-stream"
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(output)))
                self.end_headers()
                self.wfile.write(output)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.journal = Journal(self.root / "journal")
        self.adapter = None

    def tearDown(self):
        if self.adapter is not None:
            self.adapter.stop()
        self.journal.close()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=5)
        self.temp.cleanup()

    def poll(self, predicate):
        deadline, page = time.monotonic() + 25, None
        while time.monotonic() < deadline:
            page = self.journal.history(self.identifier)
            if predicate(page):
                return page
            time.sleep(0.05)
        summary = dict(state=page["session"]["state"], events=[event["type"] for event in page["events"][-20:]], errors=[event["data"] for event in page["events"] if event["type"] == "error"])
        raise AssertionError("Native SDK flow did not reach its expected state: " + repr(summary))

    def start(self, profile="gated", resume=None, prompt="Perform the disposable fixture action"):
        caps = dict(provider="claude", version="native-fixture", status="supported", reason=None, **{name: name in ("streaming", "history", "resume", "interrupt", "approvals", "questions") for name in CONTRACT["capabilities"]})
        command = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=dict(provider="claude", cwd=str(self.root), title="Native SDK fixture", roeProfile=profile, **({"providerSessionId": resume} if resume else {})))
        receipt, _ = self.journal.accept(command, caps)
        self.identifier = receipt["sessionId"]
        environment = {key: value for key, value in os.environ.items() if key not in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")}
        environment.update(ANTHROPIC_API_KEY="agentc2-loopback-fixture", ANTHROPIC_BASE_URL="http://127.0.0.1:" + str(self.server.server_port), CLAUDE_CONFIG_DIR=str(self.root / "config"), DISABLE_TELEMETRY="1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
        self.adapter = ClaudeAdapter(self.journal.history(self.identifier)["session"], self.journal, env=environment, timeout=20)
        self.adapter.start()
        command_id = str(uuid.uuid4())
        self.adapter.send(prompt, command_id)
        return command_id

    def answer(self, **kwargs):
        page = self.poll(lambda page: page["session"]["state"] == "waiting")
        request = self.journal.pending_requests(self.identifier)[0]
        payload = dict(requestId=request["requestId"], turnId=request["turnId"], itemId=request["itemId"], **kwargs)
        self.journal.accept(dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="respond", sessionId=self.identifier, payload=payload))
        self.adapter.respond(payload)
        return self.poll(lambda page: page["session"]["state"] == "idle")

    def test_gated_allow_executes_the_exact_owned_fixture_write(self):
        self.start()
        self.answer(decision="allow")
        self.assertEqual((self.root / "witness.txt").read_text(), "fixture")
        self.assertGreaterEqual(len(self.requests), 2)
        self.assertTrue(any("SDK_FIXTURE_INSTRUCTION" in json.dumps(request) for request in self.requests))

    def test_gated_deny_prevents_the_fixture_write(self):
        self.start()
        page = self.answer(decision="deny")
        self.assertFalse((self.root / "witness.txt").exists())
        outcomes = [event for event in page["events"] if event["type"] == "turn.completed"]
        self.assertEqual(outcomes[-1]["data"]["outcome"], "denied")

    def test_full_permissions_questions_still_reach_the_controller(self):
        self.question = True
        self.start(profile="full")
        page = self.answer(answers=[dict(questionId="q0", answers=["Two"])])
        resolved = [event for event in page["events"] if event["type"] == "request.resolved"]
        self.assertEqual(resolved[-1]["data"]["decision"], "answered")
        self.assertIn("Two", json.dumps(self.requests[-1]["messages"]))


    def test_batched_tools_keep_independent_one_shot_decisions(self):
        self.parallel = True
        self.start()
        item_ids = set()
        # The native CLI may serialize Bash permission checks within one
        # multi-tool response. Correlation must hold in either scheduling order.
        for _ in range(2):
            self.poll(lambda page: bool(self.journal.pending_requests(self.identifier)))
            request = self.journal.pending_requests(self.identifier)[0]
            item_ids.add(request["itemId"])
            decision = "allow" if "witness-0.txt" in request["data"]["detail"] else "deny"
            payload = dict(requestId=request["requestId"], turnId=request["turnId"], itemId=request["itemId"], decision=decision)
            self.journal.accept(dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="respond", sessionId=self.identifier, payload=payload))
            self.adapter.respond(payload)
            with self.assertRaises(ValueError):
                self.adapter.respond(payload)
        self.assertEqual(len(item_ids), 2)
        self.poll(lambda page: page["session"]["state"] == "idle")
        self.assertTrue((self.root / "witness-0.txt").is_file())
        self.assertFalse((self.root / "witness-1.txt").exists())
        self.assertEqual(self.journal.pending_requests(self.identifier), [])

    def test_background_result_cannot_complete_a_foreground_permission_turn(self):
        self.start()
        self.poll(lambda page: page["session"]["state"] == "waiting")
        active = self.adapter.active
        import claude_agent_sdk as sdk
        async def background_result():
            self.adapter.consume(sdk.ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id=self.adapter.native_id, origin={"kind": "task-notification"}, total_cost_usd=999, model_usage={"fixture": {"inputTokens": 999, "outputTokens": 999}}))
        self.adapter.call(background_result())
        page = self.journal.history(self.identifier)
        self.assertEqual(self.adapter.active, active)
        self.assertEqual(page["session"]["state"], "waiting")
        self.assertFalse(any(event["type"] in ("turn.completed", "usage.updated") for event in page["events"]))
        self.assertEqual(len(self.journal.pending_requests(self.identifier)), 1)
        self.answer(decision="deny")

    def test_malformed_question_does_not_leak_a_pending_callback(self):
        self.start()
        self.poll(lambda page: page["session"]["state"] == "waiting")
        before = len(self.adapter.callbacks)
        with self.assertRaises(ValueError):
            self.adapter.call(self.adapter.await_request("question.requested", "AskUserQuestion", {"questions": [{"options": []}]}, "malformed-question"))
        self.assertEqual(len(self.adapter.callbacks), before)
        self.assertEqual(len(self.journal.pending_requests(self.identifier)), 1)
        self.answer(decision="deny")

    def test_resume_imports_native_history_and_continues_the_same_conversation(self):
        self.start()
        self.answer(decision="allow")
        native_id = self.journal.history(self.identifier)["session"]["providerSessionId"]
        self.adapter.stop()
        self.start(resume=native_id, prompt="RESUMED_NATIVE_CONTEXT_MARKER")
        page = self.poll(lambda page: page["session"]["state"] == "idle")
        self.assertEqual(page["session"]["providerSessionId"], native_id)
        imported = [event for event in page["events"] if str(event["turnId"]).startswith("history-")]
        self.assertTrue(any(event["type"] == "message.completed" and event["data"]["text"] == "Fixture finished" for event in imported))
        self.assertIn("Perform the disposable fixture action", json.dumps(self.requests[-1]["messages"]))
        self.assertIn("RESUMED_NATIVE_CONTEXT_MARKER", json.dumps(self.requests[-1]["messages"]))

    def test_interrupt_expires_pending_permission_and_allows_another_turn(self):
        self.start()
        self.poll(lambda page: page["session"]["state"] == "waiting")
        pending = self.journal.pending_requests(self.identifier)[0]
        self.adapter.interrupt()
        page = self.poll(lambda page: page["session"]["state"] == "idle")
        outcomes = [event for event in page["events"] if event["type"] == "turn.completed"]
        self.assertEqual(outcomes[-1]["data"]["outcome"], "interrupted")
        self.assertFalse((self.root / "witness.txt").exists())
        self.assertEqual(self.journal.pending_requests(self.identifier), [])
        with self.assertRaises(ValueError):
            self.adapter.respond(dict(requestId=pending["requestId"], turnId=pending["turnId"], itemId=pending["itemId"], decision="allow"))
        self.adapter.send("CONTINUE_AFTER_INTERRUPT", str(uuid.uuid4()))
        page = self.poll(lambda page: page["session"]["state"] == "idle")
        self.assertEqual([event for event in page["events"] if event["type"] == "turn.completed"][-1]["data"]["outcome"], "completed")
        self.assertIn("CONTINUE_AFTER_INTERRUPT", json.dumps(self.requests[-1]["messages"]))


if __name__ == "__main__":
    unittest.main()
