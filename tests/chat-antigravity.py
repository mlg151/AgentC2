import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_adapters import ProviderRejected
from chat_antigravity import AntigravityAdapter
from chat_journal import Journal
from chat_protocol import CONTRACT


def poll(callback, predicate=lambda value: bool(value)):
    deadline, last = time.monotonic() + 5, None
    while time.monotonic() < deadline:
        last = callback()
        if predicate(last):
            return last
        time.sleep(0.01)
    raise AssertionError("Antigravity fixture timed out: " + repr(last))


@unittest.skipUnless(sys.platform.startswith("linux"), "Provider processes target remote Linux")
class AntigravityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="a2-agy-")
        self.root = Path(self.temp.name)
        (self.root / "settings.json").write_text("{}")
        self.binary = self.root / "agy"
        shutil.copyfile(Path(__file__).with_name("fixtures") / "antigravity-stream.py", self.binary)
        self.binary.chmod(0o700)
        self.journal = Journal(self.root / "journal")
        self.adapter = None

    def tearDown(self):
        if self.adapter is not None:
            self.adapter.stop()
        self.journal.close()
        self.temp.cleanup()

    def start(self, profile="provider-default", resume=False):
        caps = dict(provider="antigravity", version="1.4.4", status="supported", reason=None, **{name: name in ("streaming", "resume", "interrupt") for name in CONTRACT["capabilities"]})
        payload = dict(provider="antigravity", cwd=str(self.root), title="Antigravity fixture", roeProfile=profile)
        if resume:
            payload["providerSessionId"] = "saved-agy-native"
        command = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=payload)
        receipt, _ = self.journal.accept(command, caps)
        self.identifier = receipt["sessionId"]
        self.adapter = AntigravityAdapter(self.page()["session"], self.journal, binary=str(self.binary), env={**os.environ, "AGENTC2_AGY_FIXTURE_DIR": str(self.root)})
        return self.adapter.start()

    def page(self):
        return self.journal.history(self.identifier)

    def send(self, text):
        command_id = str(uuid.uuid4())
        self.adapter.send(text, command_id)
        return command_id

    def finished(self, command_id):
        return poll(self.page, lambda page: any(event["type"] == "turn.completed" and event["turnId"] == command_id for event in page["events"]))

    def test_streams_reconcile_result_and_cumulative_usage(self):
        self.start()
        first = self.send("plain")
        page = self.finished(first)
        self.assertEqual(page["session"]["providerSessionId"], "native-agy-fixture")
        delta = [event for event in page["events"] if event["type"] == "message.delta"]
        final = [event for event in page["events"] if event["type"] == "message.completed" and event["data"]["role"] == "assistant"]
        self.assertEqual({event["itemId"] for event in [*delta, *final]}, {"assistant-" + first})
        self.assertEqual(final[0]["data"]["text"], "Streamed answer")
        second = self.send("plain again")
        page = self.finished(second)
        usage = [event["data"] for event in page["events"] if event["type"] == "usage.updated"]
        self.assertEqual([item["totalTokens"] for item in usage], [150, 300])
        self.assertIsNone(usage[-1]["costUsd"])
        self.assertIsNone(usage[-1]["contextUsedTokens"])

    def test_soft_denial_stays_visible_despite_success_result(self):
        self.start()
        command_id = self.send("denied")
        page = self.finished(command_id)
        outcome = next(event for event in page["events"] if event["type"] == "turn.completed")
        self.assertEqual(outcome["data"]["outcome"], "denied")
        self.assertTrue(next(event for event in page["events"] if event["type"] == "tool.completed")["data"]["isError"])
        self.assertIsNone(self.adapter.process.poll(), "A SUCCESS turn result does not mean the process exits")
        poll(self.page, lambda page: any(event["type"] == "error" and event["data"]["code"] == "antigravity_diagnostic" for event in page["events"]))

    def test_tool_failure_stays_failed_even_with_success_result(self):
        self.start()
        page = self.finished(self.send("failure"))
        self.assertEqual(next(event for event in page["events"] if event["type"] == "turn.completed")["data"]["outcome"], "failed")

    def test_resume_uses_native_id_but_reports_missing_import(self):
        result = self.start(resume=True)
        self.assertFalse(result["nativeHistoryAvailable"])
        self.finished(self.send("plain"))
        sent = json.loads((self.root / "sent.jsonl").read_text().splitlines()[0])
        self.assertEqual(sent["argv"][sent["argv"].index("--conversation") + 1], "saved-agy-native")
        self.assertEqual(self.page()["session"]["providerSessionId"], "saved-agy-native")
        self.assertFalse(self.page()["session"]["capabilities"]["history"])

    def test_serialization_and_interrupt_wait_for_result(self):
        self.start()
        command_id = self.send("hold")
        poll(self.page, lambda page: page["session"]["providerSessionId"] is not None)
        with self.assertRaises(ProviderRejected):
            self.send("overlapping prompt")
        self.adapter.interrupt()
        page = self.finished(command_id)
        outcome = next(event for event in page["events"] if event["type"] == "turn.completed")
        self.assertEqual(outcome["data"]["outcome"], "interrupted")
        self.assertEqual(len((self.root / "sent.jsonl").read_text().splitlines()), 1)

    def test_gated_mode_is_rejected_and_full_flag_verified(self):
        with self.assertRaisesRegex(ProviderRejected, "cannot answer approval"):
            self.start(profile="gated")
        self.start(profile="full")
        self.finished(self.send("plain"))
        sent = json.loads((self.root / "sent.jsonl").read_text().splitlines()[0])
        self.assertIn("--dangerously-skip-permissions", sent["argv"])
        self.assertEqual(sent["message"], dict(event="user", message=dict(content="plain")))

    def test_nonterminal_result_is_unknown_and_blocks_future_send(self):
        self.start()
        self.finished(self.send("unknown"))
        poll(self.page, lambda page: page["session"]["state"] == "unknown")
        command = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="send", sessionId=self.identifier, payload=dict(text="Do not queue this"))
        with self.assertRaisesRegex(ValueError, "not ready"):
            self.journal.accept(command)

    def test_invalid_effective_full_mode_is_visible(self):
        (self.root / "settings.json").write_text(json.dumps(dict(wrongRoe=True)))
        self.start(profile="full")
        self.send("plain")
        page = poll(self.page, lambda page: page["session"]["state"] == "unknown")
        self.assertIn("full-permissions", next(event["data"]["detail"] for event in page["events"] if event["type"] == "session.updated" and event["data"]["state"] == "unknown"))


if __name__ == "__main__":
    unittest.main()
