"""Worker admission, dispatch and socket failure boundaries with real journals."""
import builtins
import fcntl
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "electron"))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))
import chat_runtime
import chat_worker as runtime
from chat_adapters import ProviderRejected
from chat_journal import Journal
from worker_boundaries import Adapter, TranscriptSocket, capabilities


def command(operation, payload=None, session_id=None):
    value = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation=operation, payload=payload or {})
    if session_id is not None:
        value["sessionId"] = session_id
    return value


def request(action, **values):
    return dict(protocolVersion=1, action=action, **values)


class WorkerBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentc2-worker-boundaries-")
        self.directory = Path(self.temporary.name)
        self.workers = []

    def tearDown(self):
        for worker in self.workers:
            worker.close()
        self.temporary.cleanup()

    def worker(self, **options):
        worker = runtime.Worker(self.directory / str(len(self.workers)), "fixture-digest", adapter_factory=lambda session, journal: Adapter(session, journal, **options), probe=capabilities)
        self.workers.append(worker)
        return worker

    def create(self, worker, **extra):
        value = command("create", dict(provider="codex", cwd=str(self.directory), title="Local worker fixture", roeProfile="full", **extra))
        receipt, fresh = worker.journal.accept(value, capabilities("codex"))
        self.assertTrue(fresh)
        worker.dispatch(value, receipt["sessionId"])
        return receipt["sessionId"], value

    def test_admission_errors_and_failed_sdk_preparation_leave_balanced_ownership(self):
        worker = self.worker()
        for invalid in (None, [], {}, dict(protocolVersion=True, action="health"), request("missing"), request("capabilities", prepareProvider="missing")):
            with self.assertRaisesRegex(ValueError, "Unsupported chat protocol|Unknown chat operation|Invalid provider runtime"):
                worker.handle(invalid)
        with patch.object(chat_runtime, "ensure_sdk", side_effect=RuntimeError("Fixture SDK preparation failed")):
            with self.assertRaisesRegex(RuntimeError, "Fixture SDK preparation failed"):
                worker.handle(request("capabilities", prepareProvider="codex"))
        self.assertEqual(worker.preparations, 0)
        self.assertTrue(worker.handle(request("health"))["canRetire"])
        self.assertTrue(worker.handle(request("retire"))["retiring"])
        with self.assertRaisesRegex(ValueError, "retiring.*preparing an SDK"):
            worker.handle(request("capabilities", prepareProvider="codex"))
        value = command("create", dict(provider="codex", cwd=str(self.directory), title="Retiring fixture", roeProfile="full"))
        with self.assertRaisesRegex(ValueError, "retiring.*submitting a new command"):
            worker.handle(request("command", command=value))
        self.assertEqual(worker.journal.list_sessions(), [], "A retired worker must not accept new work")

    def test_initial_history_deadline_never_dispatches_the_instructions(self):
        worker = self.worker(state="starting")
        with patch.object(runtime.time, "monotonic", side_effect=[0, 1, 121]), patch.object(runtime.time, "sleep") as sleep:
            identifier, value = self.create(worker, instructions="Must not replay these instructions")
        sleep.assert_called_once_with(0.05)
        receipt = worker.journal.receipt(value["commandId"])
        self.assertEqual(receipt["state"], "unknown")
        self.assertIn("history is still loading", receipt["error"])
        self.assertEqual(worker.adapters[identifier].calls, [("start",)])
        self.assertEqual(worker.journal.db.execute("SELECT count(*) FROM commands").fetchone()[0], 1)

    def test_model_dispatch_rechecks_turn_requests_and_runtime_support(self):
        for changed in ("running", "request", "unsupported"):
            with self.subTest(changed=changed):
                worker = self.worker()
                identifier, _ = self.create(worker)
                value = command("model", dict(model="fixture-next"), identifier)
                worker.journal.accept(value)
                if changed == "running":
                    worker.journal.append(identifier, "session.updated", dict(state="running", detail="Another turn started"), "new-turn")
                elif changed == "request":
                    worker.journal.append(identifier, "approval.requested", dict(requestId="pending", action="Review", detail="Fixture"), "turn", "item")
                    # An idle notification must not make a retained request safe.
                    worker.journal.append(identifier, "session.updated", dict(state="idle", detail="Idle with unresolved request"))
                else:
                    worker.adapters[identifier].set_model = None
                worker.dispatch(value, identifier)
                receipt = worker.journal.receipt(value["commandId"])
                self.assertEqual(receipt["state"], "failed")
                self.assertRegex(receipt["error"], "current turn|does not support changing models")
                self.assertFalse(any(call[0] == "model" for call in worker.adapters[identifier].calls))
                self.assertNotEqual(worker.journal.history(identifier)["session"].get("model"), "fixture-next")

    def test_steering_uses_the_reviewed_active_turn(self):
        worker = self.worker()
        identifier, _ = self.create(worker)
        worker.journal.append(identifier, "session.updated", dict(state="running", detail="Fixture active"), "active-turn")
        value = command("steer", dict(text="Reviewed direction", expectedTurnId="active-turn"), identifier)
        worker.journal.accept(value)
        worker.dispatch(value, identifier)
        self.assertEqual(worker.journal.receipt(value["commandId"])["state"], "completed")
        self.assertIn(("steer", "Reviewed direction", "active-turn"), worker.adapters[identifier].calls)

    def test_create_rejection_has_failed_state_and_a_nonempty_provider_notice(self):
        worker = self.worker(start_error=ProviderRejected(""))
        identifier, value = self.create(worker)
        self.assertEqual(worker.journal.receipt(value["commandId"])["state"], "failed")
        page = worker.journal.history(identifier)
        self.assertEqual(page["session"]["state"], "failed")
        self.assertEqual(page["events"][-1]["data"]["message"], "Provider rejected the operation")

    def test_stop_only_kills_the_exact_owned_tmux_identity(self):
        for code, tag in ((1, ""), (0, "chat-" + "f" * 32), (0, None)):
            with self.subTest(code=code, tag=tag):
                worker = self.worker()
                name = "hq-" + uuid.uuid4().hex[:12]
                identifier, _ = self.create(worker, managedName=name)
                value = command("stop", session_id=identifier)
                worker.journal.accept(value)
                with patch.object(runtime.subprocess, "run", return_value=types.SimpleNamespace(returncode=code, stdout=(identifier if tag is None else tag) + "\n")) as execute:
                    worker.dispatch(value, identifier)
                self.assertEqual(execute.call_count, 2 if tag is None else 1)
                if tag is None:
                    self.assertEqual(execute.call_args.args[0], ["tmux", "kill-session", "-t", name])
                self.assertEqual(worker.journal.receipt(value["commandId"])["state"], "completed")
                self.assertEqual(worker.journal.history(identifier)["session"]["state"], "stopped")

    def test_close_failure_preserves_uncertainty_for_the_next_worker(self):
        worker = self.worker(stop_error=RuntimeError("Fixture stop unconfirmed"))
        identifier, _ = self.create(worker)
        worker.close()
        self.workers.remove(worker)
        replacement = runtime.Worker(worker.directory, "replacement", adapter_factory=Mock(side_effect=AssertionError("Must not relaunch")), probe=capabilities)
        self.workers.append(replacement)
        self.assertEqual(replacement.journal.history(identifier)["session"]["state"], "unknown")
        self.assertFalse(replacement.adapters)

    def test_socket_peer_rejection_loss_and_retirement(self):
        worker = self.worker()
        server = types.SimpleNamespace(worker=worker, shutdown=Mock())
        foreign = TranscriptSocket(b'{}\n', uid=os.getuid() + 1)
        runtime.Handler(foreign, None, server)
        self.assertEqual(foreign.sent, [], "Other UIDs cannot read worker responses")
        value = command("create", dict(provider="codex", cwd=str(self.directory), title="Lost socket fixture", roeProfile="full"))
        lost = TranscriptSocket((json.dumps(request("command", command=value)) + "\n").encode(), lost=True)
        runtime.Handler(lost, None, server)
        worker.pool.shutdown(wait=True)
        self.assertEqual(worker.journal.receipt(value["commandId"])["state"], "completed", "A disconnected client must not cancel or replay an accepted command")
        self.assertEqual(len(worker.adapters), 1)
        for adapter in worker.adapters.values():
            self.assertEqual(adapter.calls.count(("start",)), 1)
        empty = self.worker()
        server.worker = empty
        valid = TranscriptSocket((json.dumps(request("retire")) + "\n").encode())
        runtime.Handler(valid, None, server)
        self.assertTrue(json.loads(b"".join(valid.sent))["ok"])
        server.shutdown.assert_called_once()
        fallback = TranscriptSocket((json.dumps(request("health")) + "\n").encode())
        with patch.object(runtime, "hasattr", side_effect=lambda obj, key: False if obj is runtime.socket and key == "SO_PEERCRED" else builtins.hasattr(obj, key), create=True):
            runtime.Handler(fallback, None, server)
        self.assertEqual(fallback.credentials, 0)
        self.assertTrue(json.loads(b"".join(fallback.sent))["ok"])

    def test_socket_rejects_missing_newlines_and_oversized_frames_without_mutation(self):
        worker = self.worker()
        server = types.SimpleNamespace(worker=worker, shutdown=Mock())
        for incoming in (b"", b"{}", b"x" * (runtime.CONTRACT["limits"]["wireBytes"] + 1)):
            with self.subTest(length=len(incoming)):
                connection = TranscriptSocket(incoming)
                runtime.Handler(connection, None, server)
                response = json.loads(b"".join(connection.sent))
                self.assertFalse(response["ok"])
                self.assertIn("Invalid or oversized chat request", response["error"])
                self.assertEqual(worker.journal.list_sessions(), [])
        server.shutdown.assert_not_called()

    def test_serve_rejects_unsafe_lock_and_socket_before_provider_creation(self):
        for kind in ("hard-link-lock", "regular-socket", "symlink-socket", "held-lock"):
            with self.subTest(kind=kind):
                root = self.directory / kind
                root.mkdir(mode=0o700)
                factory = Mock(side_effect=AssertionError("Unsafe state must not create an adapter"))
                if kind == "hard-link-lock":
                    (root / "worker.lock").write_text("fixture")
                    os.link(root / "worker.lock", root / "second-link")
                    with patch.object(runtime, "Worker", side_effect=AssertionError("Unsafe lock reached worker construction")), self.assertRaisesRegex(ValueError, "Unsupported worker lock"):
                        runtime.serve(root, "fixture", adapter_factory=factory)
                elif kind == "held-lock":
                    with (root / "worker.lock").open("w") as held:
                        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        child = subprocess.run([sys.executable, "-c", "import sys; from pathlib import Path; sys.path.insert(0, sys.argv[2]); import chat_worker; from unittest.mock import patch;\nwith patch.object(chat_worker, 'Worker', side_effect=AssertionError('Held lock reached worker construction')): chat_worker.serve(Path(sys.argv[1]), 'fixture')", str(root), str(ROOT / "electron")], capture_output=True, text=True, timeout=10)
                        self.assertEqual(child.returncode, 0, child.stderr)
                        self.assertFalse((root / "worker.sock").exists())
                else:
                    target = root / "untouched"
                    target.write_text("Retain fixture data")
                    if kind == "regular-socket":
                        (root / "worker.sock").write_text("Not a socket")
                    else:
                        (root / "worker.sock").symlink_to(target)
                    with patch.object(runtime, "Worker", side_effect=AssertionError("Unsafe socket reached worker construction")), self.assertRaisesRegex(ValueError, "Unsupported worker socket"):
                        runtime.serve(root, "fixture", adapter_factory=factory)
                    self.assertEqual(target.read_text(), "Retain fixture data")
                factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
