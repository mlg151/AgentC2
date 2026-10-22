"""Antigravity CLI 1.4.4 bidirectional stream-json adapter."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading

from chat_adapters import ProviderRejected
from chat_format import display
from chat_protocol import identifier

SUPPORTED_VERSION = "1.4.4"


class AntigravityAdapter:
    def __init__(self, session, journal, binary=None, env=None):
        self.session, self.journal = session, journal
        self.binary = binary or shutil.which("agy")
        self.env = env
        self.process = None
        self.reader = None
        self.diagnostics = None
        self.stopping = False
        self.interrupt_requested = False
        self.lock = threading.RLock()
        self.active = None
        self.native_id = session["providerSessionId"]

    def event(self, kind, data, item_id=None):
        turn_id = self.active["id"] if self.active else None
        return self.journal.append(self.session["id"], kind, data, turn_id, item_id)

    def start(self):
        if self.session["roeProfile"] == "gated":
            raise ProviderRejected("Antigravity CLI stream cannot answer approval requests; choose provider-default or terminal mode")
        if not self.binary or not Path(self.session["cwd"]).is_dir():
            raise ProviderRejected("Provider CLI or remote working directory is unavailable")
        args = [self.binary, "--input-format", "stream-json", "--output-format", "stream-json"]
        if self.native_id:
            args += ["--conversation", self.native_id]
        if self.session["roeProfile"] == "full":
            args += ["--dangerously-skip-permissions"]
        self.process = subprocess.Popen(args, cwd=self.session["cwd"], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
        self.event("session.updated", dict(state="idle", detail="Antigravity CLI ready; earlier native messages cannot be imported through this stream"))
        self.reader = threading.Thread(target=self.read, daemon=True, name="antigravity-events")
        self.diagnostics = threading.Thread(target=self.read_diagnostics, daemon=True, name="antigravity-diagnostics")
        self.reader.start()
        self.diagnostics.start()
        return dict(providerSessionId=self.native_id, nativeHistoryAvailable=False)

    def send(self, text, command_id):
        with self.lock:
            if self.active is not None:
                raise ProviderRejected("Wait for the current Antigravity result before sending another prompt")
            if self.process is None or self.process.poll() is not None:
                raise ProviderRejected("Antigravity process exited; resume its saved conversation")
            self.active = dict(id=command_id, text="", denied=False, failed=False, steps=set())
            self.interrupt_requested = False
            self.event("session.updated", dict(state="running", detail="Awaiting Antigravity turn result"))
            self.event("message.completed", dict(role="user", text=text), "user-" + command_id)
            self.process.stdin.write((json.dumps(dict(event="user", message=dict(content=text)), ensure_ascii=False) + "\n").encode())
            self.process.stdin.flush()
            return dict(turnId=command_id, providerAcknowledged=False)

    def read(self):
        try:
            while not self.stopping:
                line = self.process.stdout.readline(4000001)
                if not line:
                    break
                if len(line) > 4000000 or not line.endswith(b"\n"):
                    raise ValueError("Oversized Antigravity protocol event")
                value = json.loads(line)
                if not isinstance(value, dict) or not isinstance(value.get("event"), str):
                    raise ValueError("Invalid Antigravity protocol event")
                with self.lock:
                    self.consume(value)
        except Exception as error:
            if not self.stopping:
                self.event("error", dict(code="antigravity_protocol_error", message="Antigravity stream failed: " + type(error).__name__, retryable=False))
        finally:
            if not self.stopping:
                with self.lock:
                    if self.active:
                        self.event("turn.completed", dict(outcome="interrupted" if self.interrupt_requested else "unknown", detail="Provider process ended before a final turn result"))
                        self.active = None
                    self.event("session.updated", dict(state="stopped" if self.interrupt_requested else "failed", detail="Antigravity CLI process exited; inspect native history before resuming"))

    def read_diagnostics(self):
        while not self.stopping:
            line = self.process.stderr.readline(4001)
            if not line:
                break
            # Diagnostics are visible even when a soft-denied tool is followed
            # by SUCCESS/exit 0. They are never interpreted as approval prompts.
            message = line.decode("utf-8", errors="replace").strip()
            if message:
                with self.lock:
                    if not self.stopping:
                        self.event("error", dict(code="antigravity_diagnostic", message=display(message, 2000), retryable=False))

    def consume(self, value):
        kind = value["event"]
        turn_id = self.active["id"] if self.active else None
        if kind == "init":
            native_id = value.get("conversation_id")
            identifier(native_id)
            if self.native_id is not None and self.native_id != native_id:
                raise ValueError("Antigravity resumed a different conversation")
            self.native_id = native_id
            self.journal.set_provider_session(self.session["id"], native_id)
            if self.session["roeProfile"] == "full" and value.get("init", {}).get("permission_mode") != "always-proceed":
                self.event("session.updated", dict(state="unknown", detail="Antigravity did not apply the full-permissions launch profile"))
                self.stopping = True
                os.killpg(self.process.pid, signal.SIGTERM)
                return
        elif kind == "step_update" and self.active is not None:
            step = value["step_update"]
            if step.get("conversation_id") not in (None, self.native_id):
                raise ValueError("Antigravity event belongs to another conversation")
            item_id = "step-" + str(step.get("step_index")) + "-" + self.active["id"]
            if step.get("step_type") == "agent_response" and step.get("text_delta"):
                self.active["text"] = display(self.active["text"] + step["text_delta"])
                self.event("message.delta", dict(text=display(step["text_delta"])), "assistant-" + self.active["id"])
            elif step.get("step_type") == "tool":
                info = step.get("tool_info") or {}
                name = info.get("name") or step.get("tool_name") or "tool"
                if item_id not in self.active["steps"]:
                    self.active["steps"].add(item_id)
                    self.event("tool.started", dict(name=name, input=display(info.get("parameters", {}))), item_id)
                if step.get("state") == "DONE" and item_id + ":done" not in self.active["steps"]:
                    self.active["steps"].add(item_id + ":done")
                    error = info.get("error")
                    if error:
                        self.active["failed"] = True
                        self.active["denied"] |= "permission" in str(error).lower() or "denied" in str(error).lower()
                    self.event("tool.completed", dict(name=name, output=display(error or info.get("output", "")), isError=bool(error)), item_id)
        elif kind == "result":
            result = value["result"]
            if result.get("error"):
                self.event("error", dict(code="antigravity_result_error", message=display(result["error"], 2000), retryable=False))
            if result.get("conversation_id") and self.native_id not in (None, result["conversation_id"]):
                raise ValueError("Antigravity result belongs to another conversation")
            if self.native_id is None and result.get("conversation_id"):
                self.native_id = identifier(result["conversation_id"])
                self.journal.set_provider_session(self.session["id"], self.native_id)
            if self.active is not None:
                self.event("message.completed", dict(role="assistant", text=display(result.get("response") or self.active["text"])), "assistant-" + self.active["id"])
                usage = result.get("usage") or {}
                def metric(name):
                    val = usage.get(name)
                    return val if type(val) is int and val >= 0 else None
                self.event("usage.updated", dict(inputTokens=metric("input_tokens"), outputTokens=metric("output_tokens"), totalTokens=metric("total_tokens"), costUsd=None, contextUsedTokens=None, contextCapacityTokens=None))
                status = result.get("status")
                outcome = "interrupted" if status in ("INTERRUPTED", "CANCELED") else "denied" if self.active["denied"] else "failed" if self.active["failed"] or status in ("ERROR", "INVALID") else "completed" if status == "SUCCESS" else "unknown"
                self.event("turn.completed", dict(outcome=outcome, detail=display(result.get("error") or "", 2000)))
                self.active = None
                if outcome == "unknown":
                    self.event("session.updated", dict(state="unknown", detail="Antigravity result did not establish a terminal outcome; inspect before sending"))
        payload = value if len(json.dumps(value).encode()) <= 200000 else dict(truncated=True, preview=display(value))
        self.journal.append(self.session["id"], "provider.event", dict(method="antigravity/" + kind, payload=payload), turn_id)

    def interrupt(self):
        with self.lock:
            if self.active is None or self.process is None or self.process.poll() is not None:
                raise ProviderRejected("No active Antigravity turn to interrupt")
            self.interrupt_requested = True
            os.killpg(self.process.pid, signal.SIGINT)
            return dict(interruptRequested=True)

    def stop(self):
        self.stopping = True
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        for thread in (self.reader, self.diagnostics):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=5)
        if self.process is not None:
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream is not None:
                    stream.close()
        return {}
