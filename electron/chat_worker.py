"""Per-user persistent chat worker, reachable only over a private Unix socket."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time
import uuid

from chat_adapters import ProviderRejected, create_adapter, probe_capabilities
from chat_journal import Journal, encoded, private_directory
from chat_protocol import CONTRACT, fields, validate_command


class Worker:
    def __init__(self, directory, source_digest, adapter_factory=create_adapter, probe=probe_capabilities):
        self.journal = Journal(directory)
        self.journal.recover_worker_loss()
        self.directory = Path(directory)
        self.source_digest = source_digest
        self.boot_id = str(uuid.uuid4())
        self.adapter_factory = adapter_factory
        self.probe = probe
        self.adapters = {}
        self.retiring = False
        self.preparations = 0
        self.locks = {}
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="chat-command")

    def handle(self, request):
        if not isinstance(request, dict) or type(request.get("protocolVersion")) is not int or request.get("protocolVersion") != CONTRACT["version"]:
            raise ValueError("Unsupported chat protocol version")
        action = request.get("action")
        if action == "health":
            fields(request, ["protocolVersion", "action"])
            return dict(protocolVersion=CONTRACT["version"], pid=os.getpid(), bootId=self.boot_id, sourceDigest=self.source_digest, canRetire=not self.preparations and self.journal.can_retire())
        if action == "retire":
            fields(request, ["protocolVersion", "action"])
            with self.lock:
                if self.preparations or not self.journal.can_retire():
                    raise ValueError("Stop all managed chat sessions and settle pending commands before upgrading the worker")
                self.retiring = True
                return dict(retiring=True)
        if action == "capabilities":
            fields(request, ["protocolVersion", "action", "prepareProvider"], ["protocolVersion", "action"])
            provider = request.get("prepareProvider")
            if provider is not None:
                if provider not in CONTRACT["providers"]:
                    raise ValueError("Invalid provider runtime")
                from chat_runtime import ensure_sdk
                with self.lock:
                    if self.retiring:
                        raise ValueError("Worker is retiring; reconnect before preparing an SDK")
                    self.preparations += 1
                try:
                    ensure_sdk(provider)
                finally:
                    with self.lock:
                        self.preparations -= 1
            return [self.probe(provider) for provider in CONTRACT["providers"]]
        if action == "list":
            fields(request, ["protocolVersion", "action"])
            return [dict(session, canStop=session["id"] in self.adapters) for session in self.journal.list_sessions()]
        if action == "history":
            fields(request, ["protocolVersion", "action", "sessionId", "after", "limit"], ["protocolVersion", "action", "sessionId"])
            result = self.journal.history(request["sessionId"], request.get("after", 0), request.get("limit", 200))
            result["pendingRequests"] = self.journal.pending_requests(request["sessionId"])
            result["session"]["canStop"] = request["sessionId"] in self.adapters
            return result
        if action == "receipt":
            fields(request, ["protocolVersion", "action", "commandId"])
            return self.journal.receipt(request["commandId"])
        if action == "prune":
            fields(request, ["protocolVersion", "action", "sessionId"])
            self.journal.prune_transcript(request["sessionId"])
            return dict(pruned=True)
        if action != "command":
            raise ValueError("Unknown chat operation")
        fields(request, ["protocolVersion", "action", "command"])
        command = validate_command(request["command"])
        capabilities = None
        if command["operation"] == "create":
            try:
                self.journal.receipt(command["commandId"])
            except ValueError:
                capabilities = self.probe(command["payload"]["provider"])
        with self.lock:
            if self.retiring:
                raise ValueError("Worker is retiring; reconnect before submitting a new command")
            receipt, fresh = self.journal.accept(command, capabilities)
            if fresh:
                # Acceptance is durable before asynchronous dispatch. The executor may
                # disappear after this point, which recovery reports as unknown.
                self.pool.submit(self.dispatch, command, receipt["sessionId"])
        return receipt

    def dispatch(self, command, identifier):
        with self.lock:
            lock = self.locks.setdefault(identifier, threading.RLock())
        with lock:
            try:
                self.journal.command_state(command["commandId"], "dispatching")
                operation = command["operation"]
                session = self.journal.history(identifier, limit=1)["session"]
                if operation == "create":
                    adapter = self.adapter_factory(session, self.journal)
                    with self.lock:
                        self.adapters[identifier] = adapter
                    result = adapter.start()
                    if command["payload"].get("instructions"):
                        deadline = time.monotonic() + 120
                        while self.journal.history(identifier, limit=1)["session"]["state"] == "starting":
                            if time.monotonic() >= deadline:
                                raise TimeoutError("Initial instructions were not sent because provider history is still loading")
                            time.sleep(0.05)
                        # A separate durable, deterministic command protects the initial
                        # prompt from duplicate creates and exposes uncertain dispatch.
                        self.handle(dict(protocolVersion=1, action="command", command=dict(protocolVersion=1, commandId=str(uuid.uuid5(uuid.UUID(command["commandId"]), "initial-instructions")), operation="send", sessionId=identifier, payload=dict(text=command["payload"]["instructions"]))))
                else:
                    with self.lock:
                        adapter = self.adapters.get(identifier)
                    if adapter is None:
                        raise ProviderRejected("This worker no longer owns a live provider process; inspect history before resuming")
                    if operation == "stop":
                        result = adapter.stop()
                        name = session.get("managedName")
                        if name:
                            tagged = subprocess.run(["tmux", "show-options", "-qv", "-t", name, "@hq_chat_session_id"], capture_output=True, text=True, timeout=5)
                            if tagged.returncode == 0 and tagged.stdout.strip() == identifier:
                                subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True, timeout=5, check=True)
                        self.journal.append(identifier, "session.updated", dict(state="stopped", detail="Managed provider stopped"))
                    elif operation == "send":
                        result = adapter.send(command["payload"]["text"], command["commandId"])
                    elif operation == "steer":
                        result = adapter.steer(command["payload"]["text"], command["payload"]["expectedTurnId"])
                    elif operation == "interrupt":
                        result = adapter.interrupt()
                    else:
                        result = adapter.respond(command["payload"])
                self.journal.command_state(command["commandId"], "completed", result or {})
            except ProviderRejected as error:
                self.journal.command_state(command["commandId"], "failed", error=str(error))
                if command["operation"] == "send":
                    self.journal.append(identifier, "turn.completed", dict(outcome="failed", detail=str(error)[:2000]))
                elif command["operation"] == "create":
                    self.journal.append(identifier, "session.updated", dict(state="failed", detail=str(error)[:2000]))
                self.journal.append(identifier, "error", dict(code="provider_rejected", message=str(error)[:2000] or "Provider rejected the operation", retryable=False))
            except Exception as error:
                self.journal.command_state(command["commandId"], "unknown", error=str(error))
                self.journal.append(identifier, "session.updated", dict(state="unknown", detail="Provider acknowledgement was not recorded; inspect history before resuming"))
                self.journal.append(identifier, "error", dict(code="uncertain_submission", message=str(error)[:2000] or "Provider outcome is unknown", retryable=False))

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=False)
        with self.lock:
            adapters = list(self.adapters.items())
        for identifier, adapter in adapters:
            try:
                adapter.stop()
                self.journal.append(identifier, "session.updated", dict(state="stopped", detail="Worker shut down"))
            except Exception:
                # A future worker startup marks unresolved process state unknown.
                pass
        self.journal.close()


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(15)
        if hasattr(socket, "SO_PEERCRED"):
            credentials = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            if struct.unpack("3i", credentials)[1] != os.getuid():
                return
        try:
            line = self.rfile.readline(CONTRACT["limits"]["wireBytes"] + 1)
            if len(line) > CONTRACT["limits"]["wireBytes"] or not line.endswith(b"\n"):
                raise ValueError("Invalid or oversized chat request")
            request = json.loads(line)
            result = self.server.worker.handle(request)
            response = dict(ok=True, result=result)
        except Exception as error:
            response = dict(ok=False, error=str(error)[:2000])
        try:
            self.wfile.write((encoded(response) + "\n").encode())
        except (OSError, TimeoutError):
            # A lost client does not cancel an accepted provider command.
            pass
        if response.get("ok") and request.get("action") == "retire":
            self.server.shutdown()


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = False
    block_on_close = True
    request_queue_size = 32


def serve(directory, source_digest, adapter_factory=create_adapter, probe=probe_capabilities):
    os.umask(0o077)
    root = private_directory(directory)
    lock_file = root / "worker.lock"
    descriptor = os.open(lock_file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError("Unsupported worker lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        location = root / "worker.sock"
        if location.is_symlink() or (location.exists() and not stat.S_ISSOCK(location.lstat().st_mode)):
            raise ValueError("Unsupported worker socket")
        location.unlink(missing_ok=True)
        worker = Worker(root, source_digest, adapter_factory, probe)
        try:
            with Server(str(location), Handler) as server:
                server.worker = worker
                location.chmod(0o600)
                def shutdown(signum, frame):
                    threading.Thread(target=server.shutdown, daemon=True).start()
                signal.signal(signal.SIGTERM, shutdown)
                signal.signal(signal.SIGINT, shutdown)
                try:
                    server.serve_forever(poll_interval=0.1)
                finally:
                    server.shutdown()
        finally:
            worker.close()
            location.unlink(missing_ok=True)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--source-digest", required=True)
    args = parser.parse_args()
    serve(args.directory, args.source_digest)
