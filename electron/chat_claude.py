"""Claude Agent SDK adapter with a dedicated, persistent async client task."""

import asyncio
from concurrent.futures import Future
from dataclasses import asdict, is_dataclass
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from types import SimpleNamespace
import uuid

from chat_adapters import ProviderRejected
from chat_format import display

SUPPORTED_SDK_VERSION = "0.2.172"
SUPPORTED_CLI_VERSION = "2.1.308"
SUPPORTED_CLI_VERSIONS = ("2.1.306", SUPPORTED_CLI_VERSION)


def cli_binary():
    # The platform wheel includes the matching CLI; prefer it to an unrelated
    # system installation, including when no `claude` command is installed.
    spec = importlib.util.find_spec("claude_agent_sdk")
    if spec is not None and spec.origin:
        bundled = Path(spec.origin).parent / "_bundled" / "claude"
        if bundled.is_file():
            return str(bundled)
    return shutil.which("claude")


def auth_available(environment):
    return bool(environment.get("ANTHROPIC_API_KEY", "").strip()) or any(environment.get(key, "").lower() in ("1", "true") for key in ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"))


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


class ClaudeAdapter:
    def __init__(self, session, journal, sdk=None, env=None, timeout=30):
        self.session, self.journal = session, journal
        self.sdk = sdk
        self.env = env
        self.timeout = timeout
        self.loop = None
        self.stop_event = None
        self.client = None
        self.thread = None
        self.started = Future()
        self.active = None
        self.callbacks = {}
        self.stream_ids = {}
        self.tools = {}
        self.last_model = None
        self.last_context = None
        self.interrupt_requested = False
        self.closing = False
        self.native_id = session["providerSessionId"] or str(uuid.UUID(session["id"].removeprefix("chat-")))

    def event(self, kind, data, item_id=None, historical=False, turn_id=None):
        turn_id = turn_id if turn_id is not None else self.active
        return self.journal.append(self.session["id"], kind, data, turn_id, item_id, historical)

    def start(self):
        import os
        environment = self.env if self.env is not None else os.environ
        if not auth_available(environment):
            raise ProviderRejected("Claude SDK requires API or supported cloud-provider authentication on the selected host; CLI subscription sign-in is not used")
        if not Path(self.session["cwd"]).is_dir():
            raise ProviderRejected("Remote working directory is unavailable")
        try:
            self.sdk = self.sdk or importlib.import_module("claude_agent_sdk")
        except ImportError as error:
            raise ProviderRejected("Install the pinned Claude Agent SDK and its dependencies on the selected host") from error
        try:
            valid_id = str(uuid.UUID(self.native_id)) == self.native_id
        except ValueError:
            valid_id = False
        if not valid_id:
            raise ProviderRejected("Claude session ID must be a native UUID")
        self.journal.set_provider_session(self.session["id"], self.native_id)
        self.thread = threading.Thread(target=lambda: asyncio.run(self.run()), daemon=True, name="claude-sdk")
        self.thread.start()
        try:
            self.started.result(timeout=self.timeout)
        except Exception:
            self.stop()
            raise
        return dict(providerSessionId=self.native_id)

    def options(self):
        profile = self.session["roeProfile"]
        hooks = {"PreToolUse": [self.sdk.HookMatcher(matcher="AskUserQuestion", hooks=[self.question_hook], timeout=3600)]}
        settings = None
        if profile == "gated":
            settings = json.dumps(dict(permissions=dict(ask=["Bash", "Edit", "Write", "NotebookEdit"])))
        environment = dict(self.env or {})
        environment["CLAUDE_CODE_OAUTH_TOKEN"] = ""
        environment["CLAUDE_AGENT_SDK_CLIENT_APP"] = "agentc2/0.4.1"
        return self.sdk.ClaudeAgentOptions(
            cwd=self.session["cwd"], cli_path=cli_binary(), model=self.session.get("model"),
            system_prompt=dict(type="preset", preset="claude_code"),
            setting_sources=["user", "project", "local"],
            include_partial_messages=True, permission_mode="bypassPermissions" if profile == "full" else "default" if profile == "gated" else None,
            settings=settings, hooks=hooks,
            can_use_tool=self.can_use_tool if profile != "full" else None,
            permission_prompt_tool_name="stdio" if profile == "full" else None,
            resume=self.native_id if self.session["providerSessionId"] else None,
            session_id=None if self.session["providerSessionId"] else self.native_id,
            env=environment,
        )

    def native_history(self):
        config = (self.env or {}).get("CLAUDE_CONFIG_DIR")
        if not config or config == os.environ.get("CLAUDE_CONFIG_DIR"):
            info = self.sdk.get_session_info(self.native_id, directory=self.session["cwd"])
            return None if info is None else self.sdk.get_session_messages(self.native_id, directory=self.session["cwd"])
        # The pinned public history helpers resolve CLAUDE_CONFIG_DIR from the
        # process environment, unlike ClaudeAgentOptions.env. Read in a short
        # subprocess so concurrent profiles never mutate the worker's globals.
        source = """import json,sys
from claude_agent_sdk import get_session_info,get_session_messages
identifier,directory=sys.argv[1:]
info=get_session_info(identifier,directory=directory)
print(json.dumps(None if info is None else [dict(uuid=m.uuid,type=m.type,message=m.message) for m in get_session_messages(identifier,directory=directory)]))
"""
        result = subprocess.run([sys.executable, "-c", source, self.native_id, self.session["cwd"]], env={**os.environ, **self.env}, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=self.timeout, check=True)
        messages = json.loads(result.stdout)
        return None if messages is None else [SimpleNamespace(**message) for message in messages]

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.stop_event = asyncio.Event()
        receiver = None
        try:
            if self.session["providerSessionId"]:
                history = await asyncio.to_thread(self.native_history)
                if history is None:
                    raise ProviderRejected("Saved Claude conversation is unavailable on this host")
                for message in history:
                    self.historical(message)
            # AnyIO cancellation scopes created by connect/disconnect must stay
            # in this one task. Sends and permission futures use the same loop.
            async with self.sdk.ClaudeSDKClient(options=self.options()) as client:
                self.client = client
                self.event("session.updated", dict(state="idle", detail="Claude Agent SDK ready"))
                self.started.set_result(True)
                receiver = asyncio.create_task(self.receive())
                await self.stop_event.wait()
                await self.cancel_requests()
                receiver.cancel()
                try:
                    await receiver
                except asyncio.CancelledError:
                    pass
        except Exception as error:
            if not self.started.done():
                self.started.set_exception(error)
            elif not self.closing:
                self.event("session.updated", dict(state="unknown", detail="Claude SDK connection ended; inspect history before resuming"))
                self.event("error", dict(code="claude_connection_lost", message=display(str(error) or type(error).__name__, 2000), retryable=False))
        finally:
            if receiver is not None and not receiver.done():
                receiver.cancel()
            self.client = None

    async def receive(self):
        try:
            async for message in self.client.receive_messages():
                self.consume(message)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.closing:
                self.event("session.updated", dict(state="unknown", detail="Claude SDK stream failed; inspect history before resuming"))
                self.event("error", dict(code="claude_stream_error", message=display(str(error) or type(error).__name__, 2000), retryable=False))
        finally:
            if not self.closing:
                self.stop_event.set()

    def call(self, operation):
        if self.loop is None or self.client is None or self.closing:
            operation.close()
            raise ProviderRejected("Claude SDK client is disconnected")
        return asyncio.run_coroutine_threadsafe(operation, self.loop).result(timeout=self.timeout)

    def send(self, text, command_id):
        async def submit():
            if self.active is not None:
                raise ProviderRejected("Wait for the active Claude turn before sending another prompt")
            self.active = command_id
            self.interrupt_requested = False
            self.stream_ids.clear()
            self.event("session.updated", dict(state="running", detail="Claude is working"))
            self.event("message.completed", dict(role="user", text=text), "user-" + command_id)
            async def prompt():
                yield dict(type="user", uuid=command_id, session_id=self.native_id, parent_tool_use_id=None, message=dict(role="user", content=text))
            await self.client.query(prompt(), session_id=self.native_id)
            return dict(turnId=command_id)
        return self.call(submit())

    async def await_request(self, kind, tool_name, tool_input, tool_use_id):
        if self.active is None or not tool_use_id or not isinstance(tool_input, dict):
            raise ProviderRejected("Interactive request is not associated with an active managed turn")
        request_id = "claude-" + uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        record = dict(future=future, turnId=self.active, itemId=tool_use_id, kind=kind)
        self.callbacks[request_id] = record
        try:
            if kind == "approval.requested":
                detail = json.dumps(dict(tool=tool_name, input=tool_input), ensure_ascii=False, indent=2)
                if len(detail.encode("utf-16-le")) // 2 > 200000:
                    raise ProviderRejected("Tool input exceeded the approval review limit and was denied")
                data = dict(requestId=request_id, action=display(tool_name, 2000), detail=detail)
            else:
                questions = tool_input.get("questions", [])
                if not isinstance(questions, list) or not questions or len({question["question"] for question in questions}) != len(questions):
                    raise ProviderRejected("Provider questions were invalid or ambiguous")
                normalized = [dict(id="q" + str(index), question=question["question"], options=[option["label"] for option in question.get("options", [])], multiple=bool(question.get("multiSelect", False))) for index, question in enumerate(questions)]
                data = dict(requestId=request_id, questions=normalized)
            self.event(kind, data, tool_use_id)
            self.event("provider.event", dict(method="claude/interactiveRequest", payload=dict(requestId=request_id, tool=tool_name, input=tool_input)), tool_use_id)
        except (ValueError, TypeError, KeyError) as error:
            self.callbacks.pop(request_id, None)
            raise ProviderRejected("Provider interactive request exceeded the supported review format") from error
        try:
            return await asyncio.wait_for(future, timeout=3500)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self.event("request.resolved", dict(requestId=request_id, state="expired", decision=None), tool_use_id, turn_id=record["turnId"])
            return dict(decision="deny", cancelled=True)
        finally:
            self.callbacks.pop(request_id, None)

    async def can_use_tool(self, tool_name, tool_input, context):
        try:
            response = await self.await_request("approval.requested", tool_name, tool_input, context.tool_use_id)
            if response.get("decision") == "allow":
                return self.sdk.PermissionResultAllow(updated_input=tool_input)
            return self.sdk.PermissionResultDeny(message="Denied by AgentC2 controller", interrupt=bool(response.get("cancelled")))
        except ProviderRejected as error:
            self.event("error", dict(code="claude_request_rejected", message=display(str(error), 2000), retryable=False))
            return self.sdk.PermissionResultDeny(message=str(error))

    async def question_hook(self, hook_input, tool_use_id, context):
        tool_input = hook_input["tool_input"]
        try:
            response = await self.await_request("question.requested", "AskUserQuestion", tool_input, tool_use_id)
            if "answers" not in response:
                return dict(hookSpecificOutput=dict(hookEventName="PreToolUse", permissionDecision="deny", permissionDecisionReason="Question cancelled or expired"))
            answers = {question["question"]: ", ".join(next(answer["answers"] for answer in response["answers"] if answer["questionId"] == "q" + str(index))) for index, question in enumerate(tool_input["questions"])}
            return dict(hookSpecificOutput=dict(hookEventName="PreToolUse", permissionDecision="allow", updatedInput={**tool_input, "answers": answers}))
        except ProviderRejected as error:
            self.event("error", dict(code="claude_question_rejected", message=display(str(error), 2000), retryable=False))
            return dict(hookSpecificOutput=dict(hookEventName="PreToolUse", permissionDecision="deny", permissionDecisionReason=str(error)))

    def respond(self, payload):
        async def resolve():
            record = self.callbacks.get(payload["requestId"])
            if record is None or record["future"].done() or record["turnId"] != payload["turnId"] or record["itemId"] != payload["itemId"] or self.active != record["turnId"]:
                raise ProviderRejected("Claude interactive request is no longer active")
            if not any(item["requestId"] == payload["requestId"] for item in self.journal.pending_requests(self.session["id"])):
                raise ProviderRejected("Claude request expired before the response was dispatched")
            record["future"].set_result(payload)
            self.event("request.resolved", dict(requestId=payload["requestId"], state="resolved", decision=payload.get("decision", "answered")), payload["itemId"])
            return dict(responded=True)
        return self.call(resolve())

    async def cancel_requests(self):
        for record in list(self.callbacks.values()):
            if not record["future"].done():
                record["future"].set_result(dict(decision="deny", cancelled=True))
        await asyncio.sleep(0)

    def interrupt(self):
        async def interrupt():
            if self.active is None:
                raise ProviderRejected("No active Claude turn to interrupt")
            self.interrupt_requested = True
            await self.cancel_requests()
            await self.client.interrupt()
            return dict(interruptRequested=True)
        return self.call(interrupt())

    def consume(self, message):
        event_turn = self.active
        native_session = getattr(message, "session_id", None)
        if native_session is not None and native_session != self.native_id:
            raise ValueError("Claude message belongs to another native session")
        if isinstance(message, self.sdk.SystemMessage) and message.subtype == "init":
            mode = message.data.get("permissionMode")
            expected = {"full": "bypassPermissions", "gated": "default"}.get(self.session["roeProfile"])
            if expected is not None and mode != expected:
                raise ValueError("Claude did not apply the requested permission mode")
        if isinstance(message, self.sdk.StreamEvent) and self.active is not None:
            event = message.event
            parent = message.parent_tool_use_id or "main"
            if event["type"] == "message_start":
                self.stream_ids[parent] = event["message"]["id"]
            elif event["type"] == "content_block_delta" and event.get("delta", {}).get("type") == "text_delta":
                message_id = self.stream_ids.get(parent)
                if message_id:
                    self.event("message.delta", dict(text=display(event["delta"]["text"])), message_id + ":" + str(event["index"]))
        elif isinstance(message, self.sdk.AssistantMessage) and self.active is not None:
            message_id = message.message_id or message.uuid or "assistant-" + self.active
            for index, block in enumerate(message.content):
                if isinstance(block, self.sdk.TextBlock):
                    self.event("message.completed", dict(role="assistant", text=display(block.text)), message_id + ":" + str(index))
                elif isinstance(block, self.sdk.ToolUseBlock):
                    self.tools[block.id] = block.name
                    self.event("tool.started", dict(name=block.name, input=display(block.input)), block.id)
            if not message.parent_tool_use_id:
                self.last_model = message.model
                usage = message.usage or {}
                values = [number(usage.get(key)) for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
                self.last_context = sum(values) if all(value is not None for value in values) else None
            if message.error:
                self.event("error", dict(code="claude_assistant_error", message=display(str(message.error), 2000), retryable=False))
        elif isinstance(message, self.sdk.UserMessage) and isinstance(message.content, list):
            for block in message.content:
                if isinstance(block, self.sdk.ToolResultBlock):
                    self.event("tool.completed", dict(name=self.tools.get(block.tool_use_id, "tool"), output=display(block.content or ""), isError=bool(block.is_error)), block.tool_use_id)
        elif isinstance(message, self.sdk.ResultMessage):
            origin = message.origin or {}
            if self.active is not None and origin.get("kind", "human") == "human":
                models = message.model_usage or {}
                def summed(keys):
                    values = [number(model.get(key)) for model in models.values() for key in keys]
                    return sum(values) if values and all(value is not None for value in values) else None
                inputs = summed(["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"])
                outputs = summed(["outputTokens"])
                cost = number(message.total_cost_usd) if models and all(model.get("costBasis") != "unknown" for model in models.values()) else None
                capacity = number(models.get(self.last_model, {}).get("contextWindow"))
                self.event("usage.updated", dict(inputTokens=inputs, outputTokens=outputs, totalTokens=inputs + outputs if inputs is not None and outputs is not None else None, costUsd=cost, contextUsedTokens=self.last_context, contextCapacityTokens=capacity))
                outcome = "interrupted" if self.interrupt_requested or message.terminal_reason in ("aborted_streaming", "aborted_tools") else "denied" if message.permission_denials else "failed" if message.is_error or message.subtype != "success" else "completed"
                detail = display("\n".join(message.errors or []) or (message.result if message.is_error else "") or "", 2000)
                if message.is_error:
                    self.event("error", dict(code="claude_turn_error", message=detail or "Claude reported an unsuccessful turn", retryable=False))
                self.event("turn.completed", dict(outcome=outcome, detail=detail))
                self.active = None
        self.provider_event(message, event_turn)

    def provider_event(self, message, turn_id=None):
        payload = asdict(message) if is_dataclass(message) else dict(type=type(message).__name__)
        if len(json.dumps(payload, default=str).encode()) > 200000:
            payload = dict(truncated=True, preview=display(json.dumps(payload, default=str)))
        self.event("provider.event", dict(method="claude/" + type(message).__name__, payload=payload), turn_id=turn_id)

    def historical(self, message):
        content = message.message.get("content", [])
        if isinstance(content, str):
            content = [dict(type="text", text=content)]
        for index, block in enumerate(content):
            item_id = message.uuid + ":" + str(index)
            if block.get("type") == "text":
                self.event("message.completed", dict(role=message.type, text=display(block["text"])), item_id, historical=True, turn_id="history-" + message.uuid)
            elif block.get("type") == "tool_use":
                self.tools[block["id"]] = block["name"]
                self.event("tool.started", dict(name=block["name"], input=display(block.get("input", {}))), block["id"], historical=True, turn_id="history-" + message.uuid)
            elif block.get("type") == "tool_result":
                self.event("tool.completed", dict(name=self.tools.get(block["tool_use_id"], "tool"), output=display(block.get("content", "")), isError=bool(block.get("is_error"))), block["tool_use_id"], historical=True, turn_id="history-" + message.uuid)

    def stop(self):
        self.closing = True
        if self.loop is not None and not self.loop.is_closed() and self.stop_event is not None:
            self.loop.call_soon_threadsafe(self.stop_event.set)
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(timeout=self.timeout + 5)
            if self.thread.is_alive():
                raise TimeoutError("Claude SDK did not acknowledge shutdown; inspect the managed process")
        return {}
