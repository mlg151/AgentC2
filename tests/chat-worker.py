"""Detached worker and socket tests using disposable provider-process fixtures."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_adapters import ProviderRejected
from chat_protocol import CONTRACT, unavailable_capabilities
from chat_remote import CHAT_WORKER_FILES, chat_remote
from chat_worker import serve


def probe(provider):
    if provider != "codex":
        return unavailable_capabilities(provider)
    return dict(provider=provider, version="fixture-1", status="supported", reason=None, **{name: name in ("streaming", "history", "resume", "interrupt", "approvals", "questions") for name in CONTRACT["capabilities"]})


class FixtureAdapter:
    def __init__(self, session, journal):
        self.session, self.journal = session, journal
        self.process = None
        self.threads = []

    def event(self, kind, data, turn_id=None, item_id=None):
        return self.journal.append(self.session["id"], kind, data, turn_id, item_id)

    def start(self):
        self.process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.journal.set_provider_session(self.session["id"], "native-" + self.session["id"])
        self.event("session.updated", dict(state="idle", detail="Fixture ready"))
        return dict(pid=self.process.pid)

    def send(self, text, command_id):
        if text == "reject":
            raise ProviderRejected("Fixture rejected before executing")
        with (self.journal.directory / "dispatched.txt").open("a") as stream:
            stream.write(command_id + "\n")
        if text == "uncertain":
            raise TimeoutError("Fixture acknowledgement was lost")
        turn_id = "turn-" + command_id
        self.event("session.updated", dict(state="running", detail="Working"), turn_id)
        self.event("message.completed", dict(role="user", text=text), turn_id, "user-" + command_id)
        def finish():
            time.sleep(0.2)
            self.event("message.delta", dict(text="Streamed "), turn_id, "assistant-" + command_id)
            self.event("message.completed", dict(role="assistant", text="Streamed answer"), turn_id, "assistant-" + command_id)
            self.event("turn.completed", dict(outcome="completed", detail=""), turn_id)
        thread = threading.Thread(target=finish)
        self.threads.append(thread)
        thread.start()
        return dict(turnId=turn_id)

    def stop(self):
        for thread in self.threads:
            thread.join(timeout=3)
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        return {}

    def interrupt(self):
        return {}


def rpc(root, request, read=True):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(root / "worker.sock"))
        connection.sendall((json.dumps(request) + "\n").encode())
        if not read:
            return None
        with connection.makefile("rb") as stream:
            response = json.loads(stream.readline())
        if not response["ok"]:
            raise ValueError(response["error"])
        return response["result"]


def request(action, **kwargs):
    return dict(protocolVersion=1, action=action, **kwargs)


def command(operation, payload=None, identifier=None):
    value = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation=operation, payload=payload or {})
    if identifier is not None:
        value["sessionId"] = identifier
    return value


def poll(callback, predicate=lambda value: bool(value), timeout=8):
    deadline, last = time.monotonic() + timeout, None
    while time.monotonic() < deadline:
        try:
            last = callback()
            if predicate(last):
                return last
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        time.sleep(0.03)
    raise AssertionError("Worker fixture timed out: " + repr(last))


@unittest.skipUnless(sys.platform.startswith("linux"), "Persistent remote worker targets Linux")
class WorkerProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="a2-worker-")
        self.root = Path(self.temp.name) / "worker"
        self.provider_pids = []
        self.processes = []
        self.log = open(Path(self.temp.name) / "fixture.log", "w+")
        self.start_worker()

    def start_worker(self):
        process = subprocess.Popen([sys.executable, __file__, "--serve", str(self.root)], stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log, start_new_session=True)
        self.processes.append(process)
        health = poll(lambda: rpc(self.root, request("health")), lambda value: value["pid"] == process.pid)
        return health

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for pid in self.provider_pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.log.close()
        self.temp.cleanup()

    def create(self):
        value = command("create", dict(provider="codex", cwd=self.temp.name, title="Worker fixture", roeProfile="gated"))
        receipt = rpc(self.root, request("command", command=value))
        self.assertEqual(receipt["state"], "accepted")
        result = self.wait_receipt(value)
        self.assertEqual(result["state"], "completed")
        self.provider_pids.append(result["result"]["pid"])
        return receipt["sessionId"], result

    def wait_receipt(self, value):
        def receipt():
            try:
                return rpc(self.root, request("receipt", commandId=value["commandId"]))
            except ValueError as error:
                # A fire-and-forget command and this query use separate socket
                # handlers. The query can arrive before durable acceptance.
                if str(error) != "Command receipt is unavailable; do not automatically resubmit":
                    raise
                return None
        return poll(receipt, lambda value: value is not None and value["state"] in ("completed", "failed", "unknown"))

    def test_client_disconnect_does_not_kill_worker_or_owned_provider(self):
        identifier, created = self.create()
        os.kill(created["result"]["pid"], 0)
        value = command("send", dict(text="Continue after disconnect"), identifier)
        rpc(self.root, request("command", command=value), read=False)
        self.assertEqual(self.wait_receipt(value)["state"], "completed")
        page = poll(lambda: rpc(self.root, request("history", sessionId=identifier)), lambda page: page["session"]["state"] == "idle")
        self.assertEqual(page["events"][-1]["type"], "turn.completed")
        self.assertEqual(rpc(self.root, request("command", command=value))["state"], "completed")
        self.assertEqual((self.root / "dispatched.txt").read_text().splitlines(), [value["commandId"]])
        os.kill(created["result"]["pid"], 0)
        self.assertEqual(self.processes[0].poll(), None)

    def test_bootstrap_lock_keeps_one_worker_and_existing_session(self):
        identifier, _ = self.create()
        health = rpc(self.root, request("health"))
        duplicate = subprocess.Popen([sys.executable, __file__, "--serve", str(self.root)], stdout=self.log, stderr=self.log)
        self.assertEqual(duplicate.wait(timeout=5), 0)
        self.assertEqual(rpc(self.root, request("health")), health)
        self.assertEqual(rpc(self.root, request("list"))[0]["id"], identifier)

    def test_confirmed_stop_reaps_only_owned_fixture_process(self):
        identifier, created = self.create()
        neighbor = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], start_new_session=True)
        try:
            value = command("stop", identifier=identifier)
            rpc(self.root, request("command", command=value))
            self.assertEqual(self.wait_receipt(value)["state"], "completed")
            with self.assertRaises(ProcessLookupError):
                os.kill(created["result"]["pid"], 0)
            self.assertIsNone(neighbor.poll())
            self.assertEqual(rpc(self.root, request("history", sessionId=identifier))["session"]["state"], "stopped")
        finally:
            neighbor.terminate()
            neighbor.wait(timeout=5)

    def test_retirement_is_fenced_until_owned_work_and_commands_stop(self):
        identifier, _ = self.create()
        self.assertFalse(rpc(self.root, request("health"))["canRetire"])
        with self.assertRaisesRegex(ValueError, "Stop all managed"):
            rpc(self.root, request("retire"))
        value = command("stop", identifier=identifier)
        rpc(self.root, request("command", command=value))
        self.wait_receipt(value)
        self.assertTrue(rpc(self.root, request("health"))["canRetire"])
        self.assertTrue(rpc(self.root, request("retire"))["retiring"])
        self.assertEqual(self.processes[0].wait(timeout=5), 0)
        self.assertFalse((self.root / "worker.sock").exists())

    def test_provider_rejection_and_uncertain_acknowledgement_are_distinct(self):
        identifier, _ = self.create()
        rejected = command("send", dict(text="reject"), identifier)
        rpc(self.root, request("command", command=rejected))
        self.assertEqual(self.wait_receipt(rejected)["state"], "failed")
        self.assertEqual(rpc(self.root, request("history", sessionId=identifier))["session"]["state"], "idle")
        uncertain = command("send", dict(text="uncertain"), identifier)
        rpc(self.root, request("command", command=uncertain))
        self.assertEqual(self.wait_receipt(uncertain)["state"], "unknown")
        self.assertEqual(rpc(self.root, request("command", command=uncertain))["state"], "unknown")
        self.assertEqual(rpc(self.root, request("history", sessionId=identifier))["session"]["state"], "unknown")
        self.assertEqual((self.root / "dispatched.txt").read_text().splitlines(), [uncertain["commandId"]])

    def test_worker_restart_reports_unknown_and_does_not_relaunch_process(self):
        identifier, created = self.create()
        self.processes[0].kill()
        self.processes[0].wait(timeout=5)
        os.kill(created["result"]["pid"], 0)
        self.start_worker()
        page = rpc(self.root, request("history", sessionId=identifier))
        self.assertEqual(page["session"]["state"], "unknown")
        stopped = command("stop", identifier=identifier)
        rpc(self.root, request("command", command=stopped))
        self.assertEqual(self.wait_receipt(stopped)["state"], "failed")
        os.kill(created["result"]["pid"], 0)


@unittest.skipUnless(sys.platform.startswith("linux"), "Persistent remote worker targets Linux")
class PreparationTests(unittest.TestCase):
    def test_worker_cannot_retire_during_provider_installation(self):
        from unittest.mock import patch
        from chat_worker import Worker
        with tempfile.TemporaryDirectory(prefix="a2-prepare-") as directory:
            worker = Worker(directory, "fixture", adapter_factory=FixtureAdapter, probe=probe)
            entered, release = threading.Event(), threading.Event()
            def prepare(provider):
                entered.set()
                release.wait(timeout=5)
            try:
                with patch("chat_runtime.ensure_sdk", prepare), ThreadPoolExecutor(max_workers=1) as pool:
                    flight = pool.submit(worker.handle, request("capabilities", prepareProvider="claude"))
                    self.assertTrue(entered.wait(timeout=5))
                    self.assertFalse(worker.handle(request("health"))["canRetire"])
                    with self.assertRaises(ValueError):
                        worker.handle(request("retire"))
                    release.set()
                    flight.result(timeout=5)
                self.assertTrue(worker.handle(request("health"))["canRetire"])
            finally:
                release.set()
                worker.close()


class BootstrapTests(unittest.TestCase):
    def test_ephemeral_helper_exit_leaves_worker_running(self):
        with tempfile.TemporaryDirectory(prefix="a2-helper-") as temporary:
            source = Path(__file__).resolve().parents[1] / "electron"
            files = {name: (source / name).read_text() for name in CHAT_WORKER_FILES}
            helper = (source / "chat_remote.py").read_text() + "\n" + (source / "remote.py").read_text()
            def invoke(action):
                import base64
                payload = dict(action="chat", chatFiles=files, request=request(action))
                encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                script = "AGENTC2_PAYLOAD_B64 = '" + encoded + "'\n" + helper
                result = subprocess.run([sys.executable, "-"], input=script, capture_output=True, text=True, env={**os.environ, "HOME": temporary}, timeout=15, check=True)
                response = json.loads(result.stdout)
                self.assertTrue(response["ok"], response)
                return response["result"]
            health = None
            try:
                health = invoke("health")
                os.kill(health["pid"], 0)
                self.assertEqual(invoke("health"), health)
                self.assertEqual(invoke("list"), [])
            finally:
                if health is not None:
                    os.kill(health["pid"], signal.SIGTERM)
                    location = Path(temporary) / ".cache" / "agentc2" / "chat-v1" / "worker.sock"
                    poll(lambda: not location.exists())

    def test_detached_bootstrap_reconnect_and_version_conflict(self):
        with tempfile.TemporaryDirectory(prefix="a2-bootstrap-") as temporary:
            root = Path(temporary) / "worker"
            source = Path(__file__).resolve().parents[1] / "electron"
            names = CHAT_WORKER_FILES
            files = {name: (source / name).read_text() for name in names}
            payload = dict(chatFiles=files, request=request("health"))
            health = None
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", ResourceWarning)
                    with ThreadPoolExecutor(max_workers=4) as pool:
                        results = list(pool.map(lambda _: chat_remote(payload, root), range(4)))
                health = results[0]
                self.assertEqual(len({result["pid"] for result in results}), 1)
                self.assertEqual(len({result["bootId"] for result in results}), 1)
                self.assertEqual(chat_remote(payload, root), health)
                self.assertEqual(chat_remote(dict(sourceDigest=health["sourceDigest"], request=request("health")), root), health)
                self.assertEqual(chat_remote(dict(payload, request=request("list")), root), [])
                changed = dict(files)
                changed["chat_adapters.py"] += "\n# upgrade fixture\n"
                with self.assertRaisesRegex(ValueError, "different worker version"):
                    chat_remote(dict(payload, chatFiles=changed), root)
                self.assertEqual(chat_remote(payload, root), health)
                self.assertEqual(root.stat().st_mode & 0o777, 0o700)
                self.assertEqual((root / "worker.sock").stat().st_mode & 0o777, 0o600)
                upgraded = chat_remote(dict(payload, chatFiles=changed, allowUpgrade=True), root)
                self.assertNotEqual(upgraded["bootId"], health["bootId"])
                health = upgraded
            finally:
                if health is not None:
                    os.kill(health["pid"], signal.SIGTERM)
                    poll(lambda: not (root / "worker.sock").exists())
                    try:
                        os.waitpid(health["pid"], 0)
                    except ChildProcessError:
                        pass


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve(sys.argv[-1], "fixture-source", FixtureAdapter, probe)
    else:
        unittest.main()
