"""Required, credential-free update continuity checks against a deployed v1 worker."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "electron"))
from chat_remote import CHAT_WORKER_FILES, chat_remote
from chat_protocol import CONTRACT


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load("worker_fixtures", ROOT / "tests" / "chat-worker.py")
request, command, rpc, poll = fixtures.request, fixtures.command, fixtures.rpc, fixtures.poll


class UpgradeAdapter(fixtures.FixtureAdapter):
    def send(self, text, command_id):
        if text == "pending-upgrade":
            self.event("approval.requested", dict(requestId="upgrade-approval", action="Write", detail="Fixture approval"), "upgrade-turn")
            poll(lambda: (self.journal.directory / "release-command").exists(), timeout=15)
            self.event("request.resolved", dict(requestId="upgrade-approval", state="resolved", decision="deny"), "upgrade-turn")
        return super().send(text, command_id)


class UpgradeTests(unittest.TestCase):
    create = fixtures.WorkerProcessTests.create
    wait_receipt = fixtures.WorkerProcessTests.wait_receipt

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="a2-upgrade-")
        self.root = Path(self.temp.name) / "worker"
        self.provider_pids = []
        self.log = open(Path(self.temp.name) / "worker.log", "w+")
        self.process = subprocess.Popen([sys.executable, __file__, "--serve-legacy", str(self.root)], stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        self.health = poll(lambda: rpc(self.root, request("health")))
        self.files = {name: (ROOT / "electron" / name).read_text() for name in CHAT_WORKER_FILES}
        self.digest = hashlib.sha256(json.dumps(self.files, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

    def tearDown(self):
        (self.root / "release-command").touch()
        (self.root / "release-sdk").touch()
        try:
            health = rpc(self.root, request("health"))
            os.kill(health["pid"], signal.SIGTERM)
            poll(lambda: not (self.root / "worker.sock").exists())
        finally:
            if self.process.poll() is None:
                self.process.terminate()
            self.process.wait(timeout=10)
            for pid in self.provider_pids:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            self.log.close()
            self.temp.cleanup()

    def updated(self, action, bundle=True, **values):
        return chat_remote(dict(sourceDigest=self.digest, allowUpgrade=True,
                                **({"chatFiles": self.files} if bundle else {}),
                                request=request(action, **values)), self.root)

    def test_update_preserves_idle_session_and_continued_commands(self):
        identifier, created = self.create()
        before = rpc(self.root, request("history", sessionId=identifier))
        self.assertFalse(rpc(self.root, request("health"))["canRetire"])
        with ThreadPoolExecutor(max_workers=8) as pool:
            connected = list(pool.map(lambda i: self.updated("health", bundle=i % 2 == 0), range(24)))
        self.assertEqual({item["bootId"] for item in connected}, {self.health["bootId"]})
        self.assertEqual(self.updated("history", bundle=False, sessionId=identifier), before)
        self.assertTrue(self.updated("list")[0]["canStop"])
        self.assertEqual(len(self.updated("capabilities")), len(CONTRACT["providers"]))
        os.kill(created["result"]["pid"], 0)
        value = command("send", dict(text="After the app update"), identifier)
        self.updated("command", bundle=False, command=value)
        completed = self.wait_receipt(value)
        self.assertEqual(completed["state"], "completed")
        self.assertEqual(self.updated("command", command=value), completed)
        self.assertEqual((self.root / "dispatched.txt").read_text().splitlines(), [value["commandId"]])
        page = poll(lambda: self.updated("history", bundle=False, sessionId=identifier), lambda p: p["session"]["state"] == "idle")
        self.assertEqual(page["session"]["providerSessionId"], before["session"]["providerSessionId"])
        self.assertTrue(any(event["type"] == "message.completed" and event["data"]["text"] == "Streamed answer" for event in page["events"]))

    def test_pending_command_and_approval_survive_update_then_safe_handoff(self):
        identifier, _ = self.create()
        value = command("send", dict(text="pending-upgrade"), identifier)
        rpc(self.root, request("command", command=value))
        before = poll(lambda: rpc(self.root, request("history", sessionId=identifier)), lambda p: bool(p["pendingRequests"]))
        self.assertEqual(before["session"]["state"], "waiting")
        self.assertEqual(self.updated("history", sessionId=identifier), before)
        self.assertEqual(self.updated("receipt", bundle=False, commandId=value["commandId"])["state"], "dispatching")
        self.assertEqual(self.updated("health")["bootId"], self.health["bootId"])
        (self.root / "release-command").touch()
        self.assertEqual(self.wait_receipt(value)["state"], "completed")
        poll(lambda: self.updated("history", sessionId=identifier), lambda p: p["session"]["state"] == "idle")
        stop = command("stop", identifier=identifier)
        # Stopping is an explicit fixture action, never an update side effect.
        self.updated("command", command=stop)
        stopped = self.wait_receipt(stop)
        self.assertEqual(stopped["state"], "completed")
        before = rpc(self.root, request("history", sessionId=identifier))
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.updated("health"), range(4)))
        self.assertEqual({item["sourceDigest"] for item in results}, {self.digest})
        self.assertEqual(len({item["bootId"] for item in results}), 1)
        self.assertNotEqual(results[0]["bootId"], self.health["bootId"])
        self.process.wait(timeout=5)
        after = self.updated("history", bundle=False, sessionId=identifier)
        self.assertEqual(after["session"]["providerSessionId"], before["session"]["providerSessionId"])
        self.assertEqual(after["events"][:len(before["events"])], before["events"])
        self.assertEqual(self.updated("receipt", commandId=stop["commandId"]), stopped)
        self.assertEqual(self.updated("command", command=value)["state"], "completed")
        self.assertEqual((self.root / "dispatched.txt").read_text().splitlines(), [value["commandId"]])

    def test_update_preserves_unknown_receipt_without_redispatch(self):
        identifier, _ = self.create()
        value = command("send", dict(text="uncertain"), identifier)
        rpc(self.root, request("command", command=value))
        receipt = self.wait_receipt(value)
        self.assertEqual(receipt["state"], "unknown")
        self.assertEqual(self.updated("receipt", commandId=value["commandId"]), receipt)
        self.assertEqual(self.updated("command", command=value), receipt)
        self.assertEqual(self.updated("health")["bootId"], self.health["bootId"])
        self.assertEqual((self.root / "dispatched.txt").read_text().splitlines(), [value["commandId"]])

    def test_sdk_preparation_does_not_block_other_updated_clients(self):
        identifier, _ = self.create()
        with ThreadPoolExecutor(max_workers=2) as pool:
            preparation = pool.submit(self.updated, "capabilities", prepareProvider="claude")
            try:
                poll(lambda: (self.root / "sdk-preparing").exists())
                health = pool.submit(self.updated, "health").result(timeout=3)
                self.assertEqual(health["bootId"], self.health["bootId"])
                self.assertFalse(health["canRetire"])
                self.assertEqual(pool.submit(self.updated, "list").result(timeout=3)[0]["id"], identifier)
            finally:
                (self.root / "release-sdk").touch()
            self.assertEqual(len(preparation.result(timeout=3)), len(CONTRACT["providers"]))

    def test_legacy_client_accepting_work_during_retire_check_keeps_ownership(self):
        test = self
        class RacingSocket(socket.socket):
            def sendall(self, body, *args, **kwargs):
                if json.loads(body).get("action") == "retire":
                    # A deployed old helper does not hold its bootstrap lock
                    # during dispatch. Make its command win the retirement race.
                    test.create()
                return super().sendall(body, *args, **kwargs)
        with patch("socket.socket", RacingSocket):
            health = self.updated("health")
        self.assertEqual(health["bootId"], self.health["bootId"])
        self.assertFalse(health["canRetire"])
        self.assertEqual(len(self.updated("list")), 1)

    def test_v1_contract_remains_compatible_with_deployed_workers(self):
        baseline = json.loads((ROOT / "tests" / "fixtures" / "chat-protocol-v1.json").read_text())
        for key in ("version", "providers", "operations", "eventTypes", "capabilities", "sessionStates", "commandStates", "limits"):
            self.assertEqual(CONTRACT[key], baseline[key], "Wire changes need an explicit seamless compatibility path and upgrade regression evidence: " + key)


if __name__ == "__main__":
    if "--serve-legacy" in sys.argv:
        import chat_runtime
        directory = Path(sys.argv[-1])
        def prepare_sdk(provider):
            (directory / "sdk-preparing").touch()
            poll(lambda: (directory / "release-sdk").exists(), timeout=15)
        chat_runtime.ensure_sdk = prepare_sdk
        legacy = load("legacy_worker", ROOT / "tests" / "fixtures" / "legacy-chat-worker.py")
        legacy.serve(sys.argv[-1], "a" * 64, UpgradeAdapter, fixtures.probe)
    else:
        unittest.main()
