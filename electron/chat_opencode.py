"""OpenCode 2.1.3 ACP adapter; credentials and execution stay on the host."""
from concurrent.futures import Future
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import uuid

from chat_adapters import ProviderRejected
from chat_format import display
from chat_protocol import identifier

SUPPORTED_VERSIONS = ("2.1.3",)


class OpenCodeAdapter:
    def __init__(self, session, journal, binary=None, timeout=30, env=None):
        self.session, self.journal = session, journal
        self.binary = binary or shutil.which("opencode")
        self.timeout, self.env = timeout, env
        self.process = None
        self.reader = None
        self.stopping = False
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.pending, self.requests, self.tools = {}, {}, {}
        self.counter = 0
        self.native_id = session.get("providerSessionId")
        self.turn_id = None
        self.text = ""
        self.loading = False
        self.prompt_future = None
        self.finisher = None

    def event(self, kind, data, turn_id=None, item_id=None):
        return self.journal.append(self.session["id"], kind, data, turn_id, item_id, self.loading)

    def write(self, value):
        body = (json.dumps(dict(jsonrpc="2.0", **value), ensure_ascii=False) + "\n").encode()
        with self.write_lock:
            if self.process is None or self.process.poll() is not None:
                raise EOFError("OpenCode connection is closed")
            self.process.stdin.write(body)
            self.process.stdin.flush()

    def request(self, method, params, wait=True):
        with self.lock:
            self.counter += 1
            key = self.counter
            future = Future()
            self.pending[key] = future
        try:
            self.write(dict(id=key, method=method, params=params))
        except BaseException:
            with self.lock:
                self.pending.pop(key, None)
            raise
        if not wait:
            return future
        result = future.result(timeout=self.timeout)
        if "error" in result:
            raise ProviderRejected(display(result["error"].get("message", "OpenCode rejected the operation"), 2000))
        return result["result"]

    def start(self):
        if not self.binary or not Path(self.session["cwd"]).is_dir():
            raise ProviderRejected("OpenCode CLI or working directory is unavailable")
        if self.session["roeProfile"] == "gated":
            raise ProviderRejected("OpenCode gated launch enforcement is not verified; choose full or provider defaults")
        try:
            self.process = subprocess.Popen([self.binary, "acp"], cwd=self.session["cwd"], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True, bufsize=0)
            self.reader = threading.Thread(target=self.read, daemon=True, name="opencode-acp")
            self.reader.start()
            initialized = self.request("initialize", dict(protocolVersion=1, clientCapabilities=dict(elicitation=dict(form=True)), clientInfo=dict(name="agentc2", version="0.4.1")))
            if initialized.get("protocolVersion") != 1:
                raise ProviderRejected("Unsupported OpenCode ACP protocol")
            params = dict(cwd=self.session["cwd"], mcpServers=[])
            resumed = self.native_id is not None
            if resumed:
                if not initialized.get("agentCapabilities", {}).get("loadSession"):
                    raise ProviderRejected("OpenCode does not support loading this session")
                params["sessionId"] = self.native_id
            self.loading = resumed
            result = self.request("session/load" if resumed else "session/new", params)
            self.loading = False
            self.native_id = identifier(params["sessionId"] if resumed else result["sessionId"])
            self.journal.set_provider_session(self.session["id"], self.native_id)
            if self.session.get("model"):
                self.set_model(self.session["model"])
            self.event("session.updated", dict(state="idle", detail="OpenCode session ready"))
            return dict(providerSessionId=self.native_id, pid=self.process.pid)
        except BaseException:
            self.stop()
            raise

    def read(self):
        failure = "OpenCode ACP connection closed"
        try:
            while True:
                line = self.process.stdout.readline(4000001)
                if not line:
                    break
                if len(line) > 4000000 or not line.endswith(b"\n"):
                    raise ValueError("Oversized ACP message")
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    raise ValueError("Invalid ACP message")
                if "method" in message:
                    self.receive(message)
                else:
                    with self.lock:
                        future = self.pending.pop(message.get("id"), None)
                    if future is not None:
                        future.set_result(message)
        except Exception as error:
            failure = "OpenCode ACP connection failed: " + type(error).__name__
        finally:
            with self.lock:
                pending = list(self.pending.values())
                self.pending.clear()
            for future in pending:
                if not future.done():
                    future.set_exception(EOFError(failure))
            if not self.stopping:
                self.event("session.updated", dict(state="unknown", detail=failure))
                self.event("error", dict(code="opencode_connection_lost", message=failure + "; inspect history before resuming", retryable=False))

    def receive(self, message):
        method, params = message["method"], message.get("params") or {}
        if self.native_id and params.get("sessionId") not in (None, self.native_id):
            raise ValueError("ACP session identity changed")
        if "id" in message:
            if method in ("session/request_permission", "elicitation/create"):
                self.permission_or_question(message)
            else:
                self.write(dict(id=message["id"], error=dict(code=-32601, message="Client method is unavailable")))
            return
        if method != "session/update":
            return
        update = params.get("update") or {}
        kind = update.get("sessionUpdate")
        if kind in ("agent_message_chunk", "user_message_chunk"):
            content = update.get("content") or {}
            if content.get("type") != "text":
                return
            text = display(content.get("text", ""))
            if self.loading:
                self.event("message.completed", dict(role="user" if kind == "user_message_chunk" else "assistant", text=text), item_id="history-" + uuid.uuid4().hex)
            elif kind == "agent_message_chunk" and self.turn_id:
                self.text = display(self.text + text)
                self.event("message.delta", dict(text=text), self.turn_id, "assistant-" + self.turn_id)
        elif kind in ("tool_call", "tool_call_update"):
            key = identifier(update["toolCallId"])
            previous = self.tools.get(key, {})
            tool = {**previous, **update}
            self.tools[key] = tool
            title = display(tool.get("title") or tool.get("kind") or "Tool", 200)
            if not previous:
                self.event("tool.started", dict(name=title, input=display(tool.get("rawInput") or {})), self.turn_id, key)
            if tool.get("status") in ("completed", "failed") and previous.get("status") not in ("completed", "failed"):
                self.event("tool.completed", dict(name=title, output=display(tool.get("content") or tool.get("rawOutput") or ""), isError=tool["status"] == "failed"), self.turn_id, key)
        elif kind == "usage_update":
            cost = update.get("cost") or {}
            self.event("usage.updated", dict(inputTokens=None, outputTokens=None, totalTokens=None, costUsd=cost.get("amount") if cost.get("currency") == "USD" else None, contextUsedTokens=update.get("used"), contextCapacityTokens=update.get("size")), self.turn_id)

    def permission_or_question(self, message):
        params = message["params"]
        tool = params.get("toolCall") or {}
        item_id = tool.get("toolCallId") or params.get("toolCallId")
        request_id = "opencode-" + uuid.uuid4().hex
        record = dict(nativeId=message["id"], turnId=self.turn_id, itemId=item_id, params=params, method=message["method"])
        if message["method"] == "session/request_permission":
            options = params.get("options") or []
            if self.session["roeProfile"] == "full":
                allowed = next((item for item in options if item.get("kind") == "allow_once"), None)
                self.write(dict(id=message["id"], result=dict(outcome=dict(outcome="selected", optionId=allowed["optionId"]) if allowed else dict(outcome="cancelled"))))
                return
            data = dict(requestId=request_id, action=display(tool.get("title") or "Tool permission", 200), detail=display(tool, 10000))
            kind = "approval.requested"
        else:
            properties = (params.get("requestedSchema") or {}).get("properties") or {}
            questions = []
            for key, schema in properties.items():
                if key.endswith("_custom"):
                    continue
                values = schema.get("items", {}) if schema.get("type") == "array" else schema
                choices = values.get("enum") or [item.get("const") for item in values.get("oneOf", [])]
                if schema.get("type") not in ("string", "array") or any(not isinstance(item, str) for item in choices):
                    self.write(dict(id=message["id"], result=dict(action="cancel")))
                    return
                questions.append(dict(id=identifier(key), question=display(schema.get("title") or params.get("message") or key, 1000), options=choices[:30], multiple=schema.get("type") == "array"))
            if not questions or len(questions) > 10:
                self.write(dict(id=message["id"], result=dict(action="cancel")))
                return
            record["questions"] = questions
            data, kind = dict(requestId=request_id, questions=questions), "question.requested"
        with self.lock:
            self.requests[request_id] = record
        self.event(kind, data, self.turn_id, item_id)

    def set_model(self, model):
        with self.lock:
            if self.turn_id is not None:
                raise ProviderRejected("Wait for the current OpenCode turn before changing the model")
        # Use the ACP operation; never silently pass an ignored prompt field.
        self.request("session/set_model", dict(sessionId=self.native_id, modelId=model))
        self.session["model"] = model
        return dict(model=model, providerSessionId=self.native_id)

    def send(self, text, command_id):
        with self.lock:
            if self.turn_id is not None:
                raise ProviderRejected("OpenCode already has an active turn")
            self.turn_id = "turn-" + command_id
            turn_id = self.turn_id
            self.text, self.tools = "", {}
        self.event("message.completed", dict(role="user", text=text), turn_id, "user-" + command_id)
        self.event("session.updated", dict(state="running", detail="OpenCode is working"), turn_id)
        try:
            future = self.request("session/prompt", dict(sessionId=self.native_id, prompt=[dict(type="text", text=text)]), wait=False)
        except BaseException:
            self.turn_id = None
            raise
        self.prompt_future = future
        # Do not block the worker's per-session command queue: replies and
        # interrupts must remain available while OpenCode is prompting.
        self.finisher = threading.Thread(target=self.finish, args=(future, turn_id), daemon=True, name="opencode-turn")
        self.finisher.start()
        return dict(turnId=turn_id)

    def finish(self, future, turn_id):
        try:
            response = future.result()
            if "error" in response:
                self.event("error", dict(code="opencode_prompt_rejected", message=display(response["error"].get("message", "OpenCode prompt failed"), 2000), retryable=False), turn_id)
            if self.text:
                self.event("message.completed", dict(role="assistant", text=self.text), turn_id, "assistant-" + turn_id)
            self.cancel_requests(turn_id)
            outcome = "failed" if "error" in response else "interrupted" if response.get("result", {}).get("stopReason") == "cancelled" else "completed"
            with self.lock:
                self.turn_id = None
            self.event("turn.completed", dict(outcome=outcome, detail=""), turn_id)
        except Exception:
            if not self.stopping:
                self.event("session.updated", dict(state="unknown", detail="OpenCode turn outcome is unknown"), turn_id)

    def respond(self, payload):
        with self.lock:
            record = self.requests.get(payload["requestId"])
            if not record or record["turnId"] != payload["turnId"] or record["itemId"] != payload["itemId"]:
                raise ProviderRejected("OpenCode request is stale or belongs to another turn")
            if record["method"] == "session/request_permission":
                choice = "allow_once" if payload.get("decision") == "allow" else "reject_once"
                option = next((item for item in record["params"]["options"] if item.get("kind") == choice), None)
                result = dict(outcome=dict(outcome="selected", optionId=option["optionId"]) if option else dict(outcome="cancelled"))
            else:
                answers = {item["questionId"]: item["answers"] for item in payload.get("answers", [])}
                content = {}
                for question in record["questions"]:
                    values = answers.get(question["id"], [])
                    if not values or (not question["multiple"] and len(values) != 1):
                        raise ProviderRejected("Answer each OpenCode question")
                    # Native forms with free-text alternatives use <key>_custom.
                    if question["options"] and any(value not in question["options"] for value in values):
                        if question["id"] + "_custom" not in record["params"]["requestedSchema"]["properties"]:
                            raise ProviderRejected("Choose an offered OpenCode answer")
                        content[question["id"] + "_custom"] = "\n".join(value for value in values if value not in question["options"])
                    offered = [value for value in values if not question["options"] or value in question["options"]]
                    if offered:
                        content[question["id"]] = offered if question["multiple"] else offered[0]
                result = dict(action="accept", content=content)
            self.write(dict(id=record["nativeId"], result=result))
            self.requests.pop(payload["requestId"])
            self.event("request.resolved", dict(requestId=payload["requestId"], state="resolved", decision=payload.get("decision", "answered")), record["turnId"], record["itemId"])
        return {}

    def cancel_requests(self, turn_id):
        with self.lock:
            for key, record in list(self.requests.items()):
                if record["turnId"] != turn_id:
                    continue
                result = dict(outcome=dict(outcome="cancelled")) if record["method"] == "session/request_permission" else dict(action="cancel")
                self.write(dict(id=record["nativeId"], result=result))
                self.requests.pop(key)
                self.event("request.resolved", dict(requestId=key, state="expired", decision=None), turn_id, record["itemId"])

    def interrupt(self):
        self.cancel_requests(self.turn_id)
        self.write(dict(method="session/cancel", params=dict(sessionId=self.native_id)))
        return {}

    def stop(self):
        self.stopping = True
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        if self.reader is not None and self.reader is not threading.current_thread():
            self.reader.join(timeout=5)
        if self.finisher is not None:
            self.finisher.join(timeout=5)
        if self.process:
            for stream in (self.process.stdin, self.process.stdout):
                stream.close()
        return {}
