"""Codex 0.163.0 app-server adapter. No credentials leave the provider host."""

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
from chat_codex_schema import BUNDLE, validate_native
from chat_format import display
from chat_protocol import CONTRACT, identifier

METHODS = {
    "initialize": ("v1/InitializeParams", "v1/InitializeResponse"),
    "account/read": ("v2/GetAccountParams", "v2/GetAccountResponse"),
    "thread/start": ("v2/ThreadStartParams", "v2/ThreadStartResponse"),
    "thread/resume": ("v2/ThreadResumeParams", "v2/ThreadResumeResponse"),
    "thread/turns/list": ("v2/ThreadTurnsListParams", "v2/ThreadTurnsListResponse"),
    "turn/start": ("v2/TurnStartParams", "v2/TurnStartResponse"),
    "turn/steer": ("v2/TurnSteerParams", "v2/TurnSteerResponse"),
    "turn/interrupt": ("v2/TurnInterruptParams", "v2/TurnInterruptResponse"),
}
NOTIFICATIONS = {
    "turn/started": "v2/TurnStartedNotification", "turn/completed": "v2/TurnCompletedNotification",
    "item/started": "v2/ItemStartedNotification", "item/completed": "v2/ItemCompletedNotification",
    "item/agentMessage/delta": "v2/AgentMessageDeltaNotification",
    "thread/tokenUsage/updated": "v2/ThreadTokenUsageUpdatedNotification",
}
REQUESTS = {
    "item/commandExecution/requestApproval": ("CommandExecutionRequestApprovalParams", "CommandExecutionRequestApprovalResponse"),
    "item/fileChange/requestApproval": ("FileChangeRequestApprovalParams", "FileChangeRequestApprovalResponse"),
    "item/tool/requestUserInput": ("ToolRequestUserInputParams", "ToolRequestUserInputResponse"),
}


class CodexAdapter:
    def __init__(self, session, journal, binary=None, timeout=30, env=None):
        self.session, self.journal = session, journal
        self.binary = binary or shutil.which("codex")
        self.timeout = timeout
        self.env = env
        self.process = None
        self.reader = None
        self.importer = None
        self.stopping = False
        self.write_lock = threading.Lock()
        self.lock = threading.RLock()
        self.pending = {}
        self.requests = {}
        self.seen_requests = {}
        self.completed_items = set()
        self.items = {}
        self.counter = 0
        self.thread_id = session["providerSessionId"]
        self.turn_id = None

    def event(self, kind, data, turn_id=None, item_id=None, historical=False):
        return self.journal.append(self.session["id"], kind, data, turn_id, item_id, historical)

    def write(self, message):
        body = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        with self.write_lock:
            if self.process is None or self.process.poll() is not None:
                raise EOFError("Codex process is no longer connected")
            self.process.stdin.write(body)
            self.process.stdin.flush()

    def request(self, method, params):
        validate_native(METHODS[method][0], params)
        with self.lock:
            self.counter += 1
            native_id = self.counter
            future = Future()
            self.pending[native_id] = future
        try:
            self.write(dict(id=native_id, method=method, params=params))
            response = future.result(timeout=self.timeout)
            if "error" in response:
                raise ProviderRejected(str(response["error"].get("message", "Codex rejected the operation"))[:2000])
            return validate_native(METHODS[method][1], response["result"])
        finally:
            with self.lock:
                self.pending.pop(native_id, None)

    def start(self):
        if not self.binary or not Path(self.session["cwd"]).is_dir():
            raise ProviderRejected("Provider CLI or remote working directory is unavailable")
        try:
            self.process = subprocess.Popen([self.binary, "app-server", "--listen", "stdio://"], cwd=self.session["cwd"], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True, bufsize=0)
            self.reader = threading.Thread(target=self.read, daemon=True, name="codex-events")
            self.reader.start()
            self.request("initialize", dict(clientInfo=dict(name="agentc2", title="AgentC2", version="0.4.1"), capabilities=dict(experimentalApi=False)))
            self.write(dict(method="initialized", params={}))
            account = self.request("account/read", dict(refreshToken=False))
            if account["requiresOpenaiAuth"] and account["account"] is None:
                raise ProviderRejected("Sign in with codex login on the selected host, then create or resume this conversation again")
            params = dict(cwd=self.session["cwd"])
            if self.session.get("model"):
                params["model"] = self.session["model"]
            profile = self.session["roeProfile"]
            if profile == "full":
                params.update(approvalPolicy="never", sandbox="danger-full-access")
            elif profile == "gated":
                params.update(approvalPolicy="on-request", sandbox="read-only", approvalsReviewer="user")
            resumed = self.thread_id is not None
            if resumed:
                params.update(threadId=self.thread_id, excludeTurns=True)
            result = self.request("thread/resume" if resumed else "thread/start", params)
            self.thread_id = identifier(result["thread"]["id"])
            self.journal.set_provider_session(self.session["id"], self.thread_id)
            if profile == "full" and (result["approvalPolicy"] != "never" or result["sandbox"].get("type") != "dangerFullAccess"):
                raise ProviderRejected("Codex did not apply the requested full-permissions profile")
            if profile == "gated" and (result["approvalPolicy"] != "on-request" or result["sandbox"].get("type") != "readOnly" or result["approvalsReviewer"] != "user"):
                raise ProviderRejected("Codex did not apply the requested gated profile")
            if result["thread"].get("status", {}).get("type") == "active":
                raise ProviderRejected("Conversation already has active work; attach to its existing managed session")
            if resumed:
                self.importer = threading.Thread(target=self.import_history, daemon=True, name="codex-history")
                self.importer.start()
            else:
                self.event("session.updated", dict(state="idle", detail="Codex ready"))
            return dict(providerSessionId=self.thread_id, importingHistory=resumed)
        except Exception:
            self.stop()
            raise

    def read(self):
        failure = "Codex protocol connection ended unexpectedly"
        try:
            while not self.stopping:
                line = self.process.stdout.readline(4000001)
                if not line:
                    break
                if len(line) > 4000000 or not line.endswith(b"\n"):
                    raise ValueError("Oversized provider protocol message")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("Invalid provider protocol message")
                if "method" in message:
                    if "id" in message:
                        self.server_request(message)
                    else:
                        self.notification(message["method"], message.get("params", {}))
                elif "id" in message:
                    with self.lock:
                        pending = self.pending.get(message["id"])
                    if pending is not None and not pending.done():
                        pending.set_result(message)
        except Exception as error:
            failure = "Codex protocol connection failed: " + type(error).__name__
        finally:
            with self.lock:
                pending = list(self.pending.values())
            for future in pending:
                if not future.done():
                    future.set_exception(EOFError(failure))
            if not self.stopping:
                self.event("session.updated", dict(state="unknown", detail=failure))
                self.event("error", dict(code="codex_connection_lost", message=failure + "; inspect history before resuming", retryable=False))

    def notification(self, method, params):
        if method.startswith("account/"):
            return  # Authentication metadata and secrets never enter transcripts.
        if params.get("threadId") not in (None, self.thread_id):
            self.provider_event(method, params)
            return
        if method in NOTIFICATIONS:
            validate_native(NOTIFICATIONS[method], params)
        turn_id = params.get("turnId")
        if method == "turn/started":
            self.turn_id = params["turn"]["id"]
            self.event("session.updated", dict(state="running", detail="Codex is working"), self.turn_id)
        elif method == "turn/completed":
            turn = params["turn"]
            self.turn_id = None
            with self.lock:
                self.requests = {key: value for key, value in self.requests.items() if value["params"].get("turnId") != turn["id"]}
            outcome = turn["status"] if turn["status"] in ("completed", "failed", "interrupted") else "unknown"
            self.event("turn.completed", dict(outcome=outcome, detail=display((turn.get("error") or {}).get("message", ""), 2000)), turn["id"])
        elif method == "item/agentMessage/delta":
            self.event("message.delta", dict(text=display(params["delta"])), turn_id, params["itemId"])
        elif method in ("item/started", "item/completed"):
            self.item(params["item"], turn_id, method == "item/completed")
        elif method == "thread/tokenUsage/updated":
            usage = params["tokenUsage"]
            total, last = usage["total"], usage["last"]
            self.event("usage.updated", dict(inputTokens=total.get("inputTokens"), outputTokens=total.get("outputTokens"), totalTokens=total.get("totalTokens"), costUsd=None, contextUsedTokens=last.get("totalTokens"), contextCapacityTokens=usage.get("modelContextWindow")), turn_id)
        elif method == "error":
            self.event("error", dict(code="codex_error", message=display(params.get("error", {}).get("message", "Codex reported an error"), 2000), retryable=False), turn_id)
        else:
            self.provider_event(method, params)

    def provider_event(self, method, params):
        if len(json.dumps(params).encode()) > 200000:
            params = dict(truncated=True, preview=display(params))
        self.event("provider.event", dict(method=method, payload=params))

    def item(self, item, turn_id, completed, historical=False):
        item_id, kind = item["id"], item["type"]
        key = (turn_id, item_id)
        if completed and key in self.completed_items:
            return
        if completed:
            self.completed_items.add(key)
        if not completed and kind in ("commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"):
            self.items[item_id] = item
        if completed:
            self.items.pop(item_id, None)
        if kind == "agentMessage" and completed:
            self.event("message.completed", dict(role="assistant", text=display(item["text"])), turn_id, item_id, historical)
        elif kind == "userMessage" and completed:
            content = "\n".join(block.get("text", "[Attachment]") for block in item["content"])
            self.event("message.completed", dict(role="user", text=display(content)), turn_id, item_id, historical)
        elif kind in ("commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"):
            name = item.get("tool", kind)
            if completed:
                output = item.get("aggregatedOutput") if kind == "commandExecution" else item.get("result", item.get("changes", item))
                failed = item.get("status") in ("failed", "declined") or item.get("error") is not None or item.get("exitCode") not in (None, 0)
                self.event("tool.completed", dict(name=name, output=display(output if output is not None else ""), isError=failed), turn_id, item_id, historical)
            else:
                self.event("tool.started", dict(name=name, input=display(item.get("command", item.get("arguments", item)))), turn_id, item_id, historical)
        elif completed:
            payload = item if len(json.dumps(item).encode()) <= 200000 else dict(truncated=True, preview=display(item))
            self.event("provider.event", dict(method="item/completed", payload=payload), turn_id, item_id, historical)
        if completed and kind in ("commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"):
            payload = item if len(json.dumps(item).encode()) <= 200000 else dict(truncated=True, preview=display(item))
            self.event("provider.event", dict(method="item/completed", payload=payload), turn_id, item_id, historical)
        elif completed and kind == "agentMessage":
            metadata = {key: value for key, value in item.items() if key not in ("id", "type", "text") and value is not None}
            if metadata:
                self.event("provider.event", dict(method="item/agentMessage/metadata", payload=metadata), turn_id, item_id, historical)

    def server_request(self, message):
        method, params, native_id = message["method"], message.get("params", {}), message["id"]
        if method not in REQUESTS or params.get("threadId") != self.thread_id:
            self.write(dict(id=native_id, error=dict(code=-32601, message="Unsupported AgentC2 provider request")))
            self.event("error", dict(code="unsupported_request", message="Provider requested an unsupported interactive operation: " + method[:200], retryable=False))
            return
        validate_native(REQUESTS[method][0], params)
        signature = json.dumps(native_id)
        with self.lock:
            if signature in self.seen_requests:
                if self.seen_requests[signature] != params:
                    raise ValueError("Provider reused an interactive request ID")
                return
            self.seen_requests[signature] = params
            request_id = "codex-" + uuid.uuid4().hex
            self.requests[request_id] = dict(id=native_id, method=method, params=params)
        if method == "item/tool/requestUserInput":
            if any(question.get("isSecret") for question in params["questions"]):
                self.write(dict(id=native_id, error=dict(code=-32602, message="Secrets must be configured directly on the provider host")))
                with self.lock:
                    self.requests.pop(request_id, None)
                self.event("error", dict(code="secret_input_unsupported", message="A provider requested secret input; configure it directly on the selected host", retryable=False))
                return
            questions = [dict(id=question["id"], question=question["question"], options=[option["label"] for option in question.get("options") or []], multiple=False) for question in params["questions"]]
            self.event("question.requested", dict(requestId=request_id, questions=questions), params["turnId"], params["itemId"])
            self.event("provider.event", dict(method=method, payload=dict(requestId=request_id, **params)), params["turnId"], params["itemId"])
        else:
            detail = json.dumps(dict(request=params, item=self.items.get(params["itemId"])), ensure_ascii=False, indent=2)
            if len(detail.encode("utf-16-le")) > CONTRACT["limits"]["text"] * 2:
                self.write(dict(id=native_id, result=dict(decision="decline")))
                with self.lock:
                    self.requests.pop(request_id, None)
                self.event("error", dict(code="approval_too_large", message="Provider action exceeded the review limit and was denied; inspect it on the host", retryable=False))
                return
            self.event("approval.requested", dict(requestId=request_id, action=display(params.get("command") or "Review file changes", 2000), detail=detail), params["turnId"], params["itemId"])

    def send(self, text, command_id):
        result = self.request("turn/start", dict(threadId=self.thread_id, input=[dict(type="text", text=text)], clientUserMessageId=command_id))
        return dict(turnId=result["turn"]["id"])

    def steer(self, text, expected_turn_id):
        return self.request("turn/steer", dict(threadId=self.thread_id, expectedTurnId=expected_turn_id, input=[dict(type="text", text=text)]))

    def interrupt(self):
        if self.turn_id is None:
            raise ProviderRejected("No active Codex turn to interrupt")
        return self.request("turn/interrupt", dict(threadId=self.thread_id, turnId=self.turn_id))

    def respond(self, payload):
        with self.lock:
            request = self.requests.get(payload["requestId"])
            if request is None or request["params"]["turnId"] != payload["turnId"] or request["params"]["itemId"] != payload["itemId"]:
                raise ProviderRejected("Codex interactive request is no longer active")
            if not any(item["requestId"] == payload["requestId"] for item in self.journal.pending_requests(self.session["id"])):
                raise ProviderRejected("Codex turn completed before the response was dispatched")
            if "decision" in payload:
                result = dict(decision="accept" if payload["decision"] == "allow" else "decline")
            else:
                result = dict(answers={item["questionId"]: dict(answers=item["answers"]) for item in payload["answers"]})
            validate_native(REQUESTS[request["method"]][1], result)
            self.write(dict(id=request["id"], result=result))
            self.requests.pop(payload["requestId"])
            self.event("request.resolved", dict(requestId=payload["requestId"], state="resolved", decision=payload.get("decision", "answered")), payload["turnId"], payload["itemId"])
        return dict(responded=True)

    def import_history(self):
        try:
            cursor = None
            while not self.stopping:
                page = self.request("thread/turns/list", dict(threadId=self.thread_id, cursor=cursor, limit=50, sortDirection="asc", itemsView="full"))
                for turn in page["data"]:
                    for item in turn["items"]:
                        self.item(item, turn["id"], True, historical=True)
                    outcome = turn["status"] if turn["status"] in ("completed", "failed", "interrupted") else "unknown"
                    self.event("turn.completed", dict(outcome=outcome, detail="Imported provider history"), turn["id"], historical=True)
                following = page.get("nextCursor")
                if following is None:
                    break
                if following == cursor:
                    raise ValueError("Provider history cursor did not advance")
                cursor = following
            if not self.stopping:
                self.event("session.updated", dict(state="idle", detail="Codex conversation resumed"))
        except Exception:
            if not self.stopping:
                self.event("session.updated", dict(state="unknown", detail="Provider history import failed; inspect before sending"))
                self.event("error", dict(code="history_import_failed", message="Codex history could not be fully imported; the native history remains on the host", retryable=False))

    def stop(self):
        self.stopping = True
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        for thread in (self.reader, self.importer):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=self.timeout + 1)
        if self.process is not None:
            for stream in (self.process.stdin, self.process.stdout):
                if stream is not None:
                    stream.close()
        return {}
