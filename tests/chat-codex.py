"""Pinned native schema, app-server adapter, and installed CLI auth boundary."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_adapters import ProviderRejected
from chat_codex import CodexAdapter, display
from chat_codex_schema import validate_native
from chat_journal import Journal
from chat_protocol import CONTRACT
from chat_remote import CHAT_WORKER_FILES, chat_remote


def poll(callback, predicate=lambda value: bool(value)):
    deadline = time.monotonic() + 8
    last = None
    while time.monotonic() < deadline:
        last = callback()
        if predicate(last):
            return last
        time.sleep(0.01)
    raise AssertionError("Codex fixture timed out: " + repr(last))


@unittest.skipUnless(sys.platform.startswith("linux"), "Provider execution targets remote Linux")
class CodexTests(unittest.TestCase):
    protocol_version = "0.163.0"
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="a2-codex-")
        self.root = Path(self.temp.name)
        self.settings = self.root / "settings.json"
        self.settings.write_text("{}")
        self.old_env = os.environ.get("AGENTC2_CODEX_FIXTURE_DIR")
        os.environ["AGENTC2_CODEX_FIXTURE_DIR"] = str(self.root)
        self.binary = self.root / "codex"
        shutil.copyfile(Path(__file__).with_name("fixtures") / "codex-app-server.py", self.binary)
        self.binary.chmod(0o700)
        self.journal = Journal(self.root / "journal")
        self.adapter = None

    def tearDown(self):
        if self.adapter is not None:
            self.adapter.stop()
        self.journal.close()
        if self.old_env is None:
            os.environ.pop("AGENTC2_CODEX_FIXTURE_DIR", None)
        else:
            os.environ["AGENTC2_CODEX_FIXTURE_DIR"] = self.old_env
        self.temp.cleanup()

    def start(self, resume=False, profile="gated", model=None):
        caps = dict(provider="codex", version=self.protocol_version, status="supported", reason=None, **{name: name not in ("attachments", "forks") for name in CONTRACT["capabilities"]})
        payload = dict(provider="codex", cwd=str(self.root), title="Codex protocol fixture", roeProfile=profile)
        if model:
            payload["model"] = model
        if resume:
            payload["providerSessionId"] = "saved-native-thread"
        command = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=payload)
        receipt, _ = self.journal.accept(command, caps)
        self.identifier = receipt["sessionId"]
        session = self.journal.history(self.identifier)["session"]
        self.adapter = CodexAdapter(session, self.journal, binary=str(self.binary), timeout=3)
        return self.adapter.start()

    def page(self):
        return self.journal.history(self.identifier)

    def send(self, text):
        command_id = str(uuid.uuid4())
        result = self.adapter.send(text, command_id)
        return result, command_id

    def pending(self):
        return self.journal.pending_requests(self.identifier)

    def respond(self, **kwargs):
        request = self.pending()[0]
        payload = dict(requestId=request["requestId"], turnId=request["turnId"], itemId=request["itemId"], **kwargs)
        command = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="respond", sessionId=self.identifier, payload=payload)
        self.journal.accept(command)
        return self.adapter.respond(payload)

    def test_configured_model_reaches_provider_and_survives_journal_reopen(self):
        self.start(model="fixture-model")
        requests = [json.loads(line) for line in (self.root / "requests.jsonl").read_text().splitlines()]
        self.assertEqual(next(item for item in requests if item.get("method") == "thread/start")["params"]["model"], "fixture-model")
        reopened = Journal(self.root / "journal")
        try:
            self.assertEqual(reopened.history(self.identifier)["session"]["model"], "fixture-model")
        finally:
            reopened.close()

    def test_model_change_reaches_next_turn_in_same_thread(self):
        self.start(model="fixture-first")
        first_turn, _ = self.send("plain")
        # The journal can still show its initial idle state after the provider
        # acknowledges turn/start but before turn/started reaches the reader.
        poll(self.page, lambda value: value["session"]["state"] == "idle" and any(
            event["type"] == "turn.completed" and event["turnId"] == first_turn["turnId"]
            for event in value["events"]
        ))
        native = self.adapter.thread_id
        self.adapter.set_model("fixture-second")
        self.send("plain")
        poll(self.page, lambda value: sum(event["type"] == "turn.completed" for event in value["events"]) == 2)
        requests = [json.loads(line) for line in (self.root / "requests.jsonl").read_text().splitlines()]
        turns = [item["params"] for item in requests if item.get("method") == "turn/start"]
        self.assertEqual([item["model"] for item in turns], ["fixture-first", "fixture-second"])
        self.assertTrue(all(item["threadId"] == native for item in turns))

    def test_streamed_text_final_and_cumulative_usage(self):
        self.start()
        result, command_id = self.send("plain")
        page = poll(self.page, lambda value: any(event["type"] == "turn.completed" for event in value["events"]))
        completed = [event for event in page["events"] if event["type"] == "message.completed" and event["data"]["role"] == "assistant"]
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]["data"]["text"], "Fixture answer")
        self.assertEqual(completed[0]["turnId"], result["turnId"])
        usage = next(event["data"] for event in page["events"] if event["type"] == "usage.updated")
        self.assertEqual(usage["totalTokens"], 150)
        self.assertIsNone(usage["costUsd"])
        requests = [json.loads(line) for line in (self.root / "requests.jsonl").read_text().splitlines()]
        self.assertEqual(next(item for item in requests if item.get("method") == "turn/start")["params"]["clientUserMessageId"], command_id)

    def test_approval_only_runs_reviewed_fixture_on_allow(self):
        self.start()
        self.send("approval")
        poll(self.pending)
        request = self.pending()[0]
        self.assertEqual(request["data"]["action"], "fixture write")
        self.assertIn("command", request["data"]["detail"])
        self.assertFalse((self.root / "approved.txt").exists())
        self.respond(decision="allow")
        poll(lambda: (self.root / "approved.txt").exists())
        poll(self.page, lambda page: page["session"]["state"] == "idle")
        self.assertEqual(self.pending(), [])

    def test_denial_leaves_no_write_and_tool_failure_visible(self):
        self.start()
        self.send("approval")
        poll(self.pending)
        self.respond(decision="deny")
        page = poll(self.page, lambda page: page["session"]["state"] == "idle")
        self.assertFalse((self.root / "approved.txt").exists())
        tool = next(event for event in page["events"] if event["type"] == "tool.completed")
        self.assertTrue(tool["data"]["isError"])
        self.assertEqual(tool["data"]["output"], "Permission denied")

    def test_question_answer_is_correlated_and_not_a_prompt(self):
        self.start()
        self.send("question")
        poll(self.pending)
        self.respond(answers=[dict(questionId="choice", answers=["Two"])])
        answers = poll(lambda: json.loads((self.root / "answers.json").read_text()) if (self.root / "answers.json").exists() else None)
        self.assertEqual(answers, dict(answers=dict(choice=dict(answers=["Two"]))))

    def test_steering_and_interruption_target_expected_turn(self):
        self.start()
        result, _ = self.send("hold")
        poll(self.page, lambda page: page["session"]["activeTurnId"] == result["turnId"])
        self.assertEqual(self.adapter.steer("More details", result["turnId"])["turnId"], result["turnId"])
        with self.assertRaises(ProviderRejected):
            self.adapter.steer("Stale details", "old-turn")
        self.adapter.interrupt()
        page = poll(self.page, lambda page: page["session"]["state"] == "idle")
        self.assertEqual(page["events"][-1]["data"]["outcome"], "interrupted")

    def test_resume_imports_pages_without_making_partial_history_sendable(self):
        result = self.start(resume=True)
        self.assertTrue(result["importingHistory"])
        page = poll(self.page, lambda page: any(event["itemId"] == "past-answer" for event in page["events"]))
        self.assertEqual(page["session"]["state"], "starting")
        page = poll(self.page, lambda page: page["session"]["state"] == "idle")
        text = [event["data"]["text"] for event in page["events"] if event["type"] == "message.completed"]
        self.assertEqual(text, ["Earlier question", "Earlier answer", "Later answer"])
        self.assertEqual(page["session"]["providerSessionId"], "saved-native-thread")

    def test_authentication_failure_and_wrong_roe_stop_owned_process(self):
        for settings, message in [(dict(noAuth=True), "Sign in"), (dict(wrongRoe=True), "gated profile")]:
            self.settings.write_text(json.dumps(settings))
            with self.assertRaisesRegex(ProviderRejected, message):
                self.start()
            self.assertIsNotNone(self.adapter.process.poll())

    def test_full_profile_is_sent_and_verified(self):
        self.start(profile="full")
        requests = [json.loads(line) for line in (self.root / "requests.jsonl").read_text().splitlines()]
        params = next(item for item in requests if item.get("method") == "thread/start")["params"]
        self.assertEqual(params["approvalPolicy"], "never")
        self.assertEqual(params["sandbox"], "danger-full-access")

    def test_schema_rejects_incompatible_notifications_and_bounds_output(self):
        with self.assertRaises(ValueError):
            validate_native("v2/AgentMessageDeltaNotification", dict(delta="text"))
        clipped = display("👋" * 300000)
        self.assertLessEqual(len(clipped.encode("utf-16-le")) // 2, CONTRACT["limits"]["text"])
        self.assertIn("truncated", clipped)

    def test_remote_worker_bundle_dispatches_codex_requests_and_receipts(self):
        source = Path(__file__).resolve().parents[1] / "electron"
        files = {name: (source / name).read_text() for name in CHAT_WORKER_FILES}
        root = self.root / "worker"
        health = None
        old_path = os.environ["PATH"]
        os.environ["PATH"] = str(self.root) + os.pathsep + old_path
        try:
            health = chat_remote(dict(chatFiles=files, request=dict(protocolVersion=1, action="health")), root)
            def rpc(action, **kwargs):
                return chat_remote(dict(sourceDigest=health["sourceDigest"], request=dict(protocolVersion=1, action=action, **kwargs)), root)
            create = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=dict(provider="codex", cwd=str(self.root), title="Bundled protocol fixture", roeProfile="gated"))
            receipt = rpc("command", command=create)
            identifier = receipt["sessionId"]
            poll(lambda: rpc("receipt", commandId=create["commandId"]), lambda item: item["state"] == "completed")
            sent = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="send", sessionId=identifier, payload=dict(text="approval"))
            rpc("command", command=sent)
            page = poll(lambda: rpc("history", sessionId=identifier), lambda item: bool(item["pendingRequests"]))
            pending = page["pendingRequests"][0]
            answer = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="respond", sessionId=identifier, payload=dict(requestId=pending["requestId"], turnId=pending["turnId"], itemId=pending["itemId"], decision="allow"))
            rpc("command", command=answer)
            poll(lambda: rpc("history", sessionId=identifier), lambda item: item["session"]["state"] == "idle")
            self.assertTrue((self.root / "approved.txt").exists())
            self.assertEqual(rpc("command", command=sent)["state"], "completed", "Replayed command must return its durable receipt")
            stopped = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="stop", sessionId=identifier, payload={})
            rpc("command", command=stopped)
            poll(lambda: rpc("receipt", commandId=stopped["commandId"]), lambda item: item["state"] == "completed")
        finally:
            os.environ["PATH"] = old_path
            if health is not None:
                os.kill(health["pid"], signal.SIGTERM)
                poll(lambda: not (root / "worker.sock").exists())
                try:
                    os.waitpid(health["pid"], 0)
                except ChildProcessError:
                    pass

    def test_installed_cli_unauthenticated_handshake_without_model_call(self):
        binary = shutil.which("codex")
        if binary is None or subprocess.run([binary, "--version"], capture_output=True, text=True, check=False).stdout.strip() != "codex-cli " + self.protocol_version:
            self.skipTest("Pinned native Codex CLI is not installed")
        self.start()
        self.adapter.stop()
        native_home = self.root / "isolated-codex-home"
        native_home.mkdir()
        environment = {key: value for key, value in os.environ.items() if key not in ("OPENAI_API_KEY", "CODEX_API_KEY", "AGENTC2_CODEX_FIXTURE_DIR")}
        environment["CODEX_HOME"] = str(native_home)
        self.adapter = CodexAdapter(self.page()["session"], self.journal, binary=binary, timeout=10, env=environment)
        with self.assertRaisesRegex(ProviderRejected, "Sign in with codex login"):
            self.adapter.start()
        self.assertIsNotNone(self.adapter.process.poll())


class Codex164Tests(CodexTests):
    protocol_version = "0.164.0"


class Codex165Tests(CodexTests):
    protocol_version = "0.165.0"


if __name__ == "__main__":
    unittest.main()
