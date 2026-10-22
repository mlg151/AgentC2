"""Pinned Antigravity SDK adapter, owned by the persistent host worker."""

import asyncio
from concurrent.futures import Future
import importlib
import json
import os
from pathlib import Path
import threading
import uuid

from chat_adapters import ProviderRejected
from chat_format import display
from chat_journal import private_directory
from chat_protocol import identifier

SUPPORTED_SDK_VERSION = "0.1.22"


def auth_available(environment):
    return bool(environment.get("GEMINI_API_KEY", "").strip() or environment.get("AGENTC2_ANTIGRAVITY_BASE_URL", "").strip()) or environment.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("true", "1")


class AntigravityAdapter:
    def __init__(self, session, journal, sdk=None, env=None, timeout=30):
        self.session, self.journal = session, journal
        self.sdk, self.env, self.timeout = sdk, env if env is not None else os.environ, timeout
        self.native_id = session["providerSessionId"]
        self.loop = self.agent = self.stop_event = self.thread = self.task = None
        self.active = self.response = None
        self.started = Future()
        self.callbacks = {}
        self.closing = self.interrupt_requested = self.denied = self.tool_failed = False
        self.storage = private_directory(journal.directory / "antigravity-sdk")
        self.saved = private_directory(self.storage / "conversations")
        self.data = private_directory(self.storage / "data")

    def event(self, kind, data, item_id=None, historical=False, turn_id=None):
        return self.journal.append(self.session["id"], kind, data, turn_id or self.active, item_id, historical)

    def config(self):
        from google.antigravity.hooks import hooks, policy
        # SDK config copying must retain callbacks without deep-copying this
        # adapter's journal locks and running asyncio objects.
        async def question(spec):
            return await self.question(spec)
        async def approve(tool_call, reason=""):
            return await self.approve(tool_call, reason)
        options = dict(workspaces=[self.session["cwd"]], save_dir=str(self.saved), app_data_dir=str(self.data), env=dict(self.env), hooks=[hooks.on_interaction(question)])
        if self.native_id:
            identifier(self.native_id)
            if not (self.saved / (self.native_id + ".db")).is_file():
                raise ProviderRejected("This is not a saved AgentC2 SDK conversation. Use Terminal to resume existing Antigravity CLI history.")
            options.update(conversation_id=self.native_id, session_continuation_mode=self.sdk.types.SessionContinuationMode.RESUME)
        if self.session["roeProfile"] == "full":
            options["policies"] = [policy.allow_all()]
        elif self.session["roeProfile"] == "gated":
            options["policies"] = policy.safe_defaults(handler=approve)
        # Provider defaults retain the SDK's default command-denial policy.
        base_url = self.env.get("AGENTC2_ANTIGRAVITY_BASE_URL")
        if self.session.get("model"):
            options["model"] = self.session["model"]
        if base_url:
            options.update(base_url=base_url, model=self.session.get("model") or self.env.get("AGENTC2_ANTIGRAVITY_MODEL"))
            return self.sdk.LocalOpenAIAgentConfig(**options)
        if self.env.get("AGENTC2_ANTIGRAVITY_MODEL") and not self.session.get("model"):
            options["model"] = self.env["AGENTC2_ANTIGRAVITY_MODEL"]
        return self.sdk.LocalAgentConfig(**options)

    def start(self):
        if not Path(self.session["cwd"]).is_dir():
            raise ProviderRejected("Remote working directory is unavailable")
        if not auth_available(self.env):
            raise ProviderRejected("Configure Gemini API or Vertex authentication on the execution host for the Antigravity SDK")
        self.sdk = self.sdk or importlib.import_module("google.antigravity")
        config = self.config()
        self.thread = threading.Thread(target=lambda: asyncio.run(self.run(config)), daemon=True, name="antigravity-sdk")
        self.thread.start()
        try:
            self.started.result(timeout=self.timeout)
        except Exception:
            self.stop()
            raise
        return dict(providerSessionId=self.native_id, nativeHistoryAvailable=True)

    async def run(self, config):
        self.loop = asyncio.get_running_loop()
        self.stop_event = asyncio.Event()
        try:
            async with self.sdk.Agent(config) as agent:
                self.agent = agent
                self.bind_native()
                if self.session["providerSessionId"]:
                    for index, step in enumerate(agent.conversation.history):
                        role = "user" if getattr(step.source, "value", step.source) == "USER" else "assistant"
                        if step.content and getattr(step.source, "value", step.source) in ("USER", "MODEL"):
                            self.event("message.completed", dict(role=role, text=display(step.content)), "sdk-history-" + str(index), historical=True, turn_id="sdk-history")
                self.event("session.updated", dict(state="idle", detail="Antigravity SDK ready"))
                self.started.set_result(True)
                await self.stop_event.wait()
                await self.cancel_requests()
                if self.task and not self.task.done():
                    self.task.cancel()
                    await asyncio.gather(self.task, return_exceptions=True)
        except Exception as error:
            if not self.started.done():
                self.started.set_exception(error)
            elif not self.closing:
                self.event("error", dict(code="antigravity_sdk_error", message=display(str(error), 2000), retryable=False))
                self.event("session.updated", dict(state="unknown", detail="Antigravity SDK disconnected; inspect saved history"))
        finally:
            self.agent = None

    def bind_native(self):
        native = self.agent.conversation_id
        if native:
            identifier(native)
            if self.native_id and self.native_id != native:
                raise ValueError("Antigravity SDK resumed a different conversation")
            self.native_id = native
            self.journal.set_provider_session(self.session["id"], native)

    def call(self, coroutine):
        if self.loop is None or self.agent is None or self.closing:
            coroutine.close()
            raise ProviderRejected("Antigravity SDK is disconnected")
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout=self.timeout)

    def send(self, text, command_id):
        async def submit():
            if self.active is not None:
                raise ProviderRejected("Wait for the current Antigravity turn before sending another prompt")
            self.active = command_id
            self.denied = self.tool_failed = self.interrupt_requested = False
            self.event("session.updated", dict(state="running", detail="Antigravity SDK is working"))
            self.event("message.completed", dict(role="user", text=text), "user-" + command_id)
            self.task = asyncio.create_task(self.turn(text))
            return dict(turnId=command_id)
        return self.call(submit())

    async def turn(self, text):
        message_id = "assistant-" + self.active
        output = ""
        outcome, detail = "completed", ""
        try:
            self.response = await self.agent.chat(text)
            self.bind_native()
            async for chunk in self.response.chunks:
                if isinstance(chunk, self.sdk.types.Text):
                    output = display(output + chunk.text)
                    self.event("message.delta", dict(text=display(chunk.text)), message_id)
                elif isinstance(chunk, self.sdk.types.ToolCall):
                    name = getattr(chunk.name, "value", chunk.name)
                    self.event("tool.started", dict(name=name, input=display(chunk.args)), chunk.id or chunk.step_id)
                elif isinstance(chunk, self.sdk.types.ToolResult):
                    self.tool_failed |= bool(chunk.error)
                    self.event("tool.completed", dict(name=getattr(chunk.name, "value", chunk.name), output=display(chunk.error or chunk.result), isError=bool(chunk.error)), chunk.id or chunk.step_id)
            self.bind_native()
            self.event("message.completed", dict(role="assistant", text=output), message_id)
            usage = self.agent.conversation.total_usage
            inputs, outputs, thoughts = usage.prompt_token_count, usage.candidates_token_count, usage.thoughts_token_count
            self.event("usage.updated", dict(inputTokens=inputs, outputTokens=outputs + thoughts if outputs is not None and thoughts is not None else outputs, totalTokens=usage.total_token_count, costUsd=None, contextUsedTokens=None, contextCapacityTokens=None))
            reason = str(getattr(self.response.stop_reason, "value", self.response.stop_reason)).lower()
            outcome = "interrupted" if self.interrupt_requested else "denied" if self.denied else "failed" if self.tool_failed or reason not in ("unspecified", "") else "completed"
        except asyncio.CancelledError:
            outcome, detail = "interrupted", "Antigravity SDK turn cancelled"
        except Exception as error:
            outcome, detail = "failed", display(str(error), 2000)
            self.event("error", dict(code="antigravity_turn_error", message=detail or type(error).__name__, retryable=False))
        finally:
            await self.cancel_requests()
            self.event("turn.completed", dict(outcome=outcome, detail=detail))
            self.active = self.response = None

    async def request(self, kind, data, item_id):
        if self.active is None or self.closing:
            raise ProviderRejected("Interactive request has no active Antigravity turn")
        request_id = "antigravity-" + uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        record = dict(future=future, turnId=self.active, itemId=item_id)
        self.callbacks[request_id] = record
        try:
            self.event(kind, dict(requestId=request_id, **data), item_id)
            result = await asyncio.wait_for(future, timeout=3500)
            return result
        except (asyncio.CancelledError, asyncio.TimeoutError):
            return dict(decision="deny", cancelled=True)
        finally:
            self.callbacks.pop(request_id, None)
            if any(item["requestId"] == request_id for item in self.journal.pending_requests(self.session["id"])):
                self.event("request.resolved", dict(requestId=request_id, state="expired", decision=None), item_id)

    async def approve(self, tool_call, reason=""):
        name = getattr(tool_call.name, "value", tool_call.name)
        detail = json.dumps(dict(input=tool_call.args, reason=reason), ensure_ascii=False, indent=2)
        if len(detail.encode("utf-16-le")) // 2 > 200000:
            self.denied = True
            return False
        result = await self.request("approval.requested", dict(action=name, detail=detail), tool_call.id or tool_call.step_id or "approval-" + uuid.uuid4().hex)
        allowed = result.get("decision") == "allow" and not result.get("cancelled")
        self.denied |= not allowed
        return allowed

    async def question(self, spec):
        questions = [dict(id="q" + str(index), question=question.question, options=[option.text for option in question.options], multiple=question.is_multi_select) for index, question in enumerate(spec.questions)]
        result = await self.request("question.requested", dict(questions=questions), "question-" + uuid.uuid4().hex)
        if "answers" not in result:
            return self.sdk.types.QuestionHookResult(responses=[], cancelled=True)
        answers = {answer["questionId"]: answer["answers"] for answer in result["answers"]}
        responses = []
        for index, question in enumerate(spec.questions):
            selected = answers.get("q" + str(index), [])
            labels = {option.text: option.id for option in question.options}
            responses.append(self.sdk.types.QuestionResponse(selected_option_ids=[labels[text] for text in selected if text in labels], freeform_response=", ".join(text for text in selected if text not in labels)))
        return self.sdk.types.QuestionHookResult(responses=responses)

    def respond(self, payload):
        async def resolve():
            record = self.callbacks.get(payload["requestId"])
            if record is None or record["future"].done() or record["turnId"] != payload["turnId"] or record["itemId"] != payload["itemId"] or self.active != record["turnId"]:
                raise ProviderRejected("Antigravity request is no longer active")
            if not any(item["requestId"] == payload["requestId"] for item in self.journal.pending_requests(self.session["id"])):
                raise ProviderRejected("Antigravity request expired before dispatch")
            record["future"].set_result(payload)
            self.event("request.resolved", dict(requestId=payload["requestId"], state="resolved", decision=payload.get("decision", "answered")), payload["itemId"])
            return dict(responded=True)
        return self.call(resolve())

    async def cancel_requests(self):
        for record in list(self.callbacks.values()):
            if not record["future"].done():
                record["future"].cancel()
        await asyncio.sleep(0)

    def interrupt(self):
        async def cancel():
            if self.active is None:
                raise ProviderRejected("No active Antigravity turn to interrupt")
            self.interrupt_requested = True
            await self.cancel_requests()
            if self.response is not None:
                await self.response.cancel()
            if self.task and not self.task.done():
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            return dict(interruptRequested=True)
        return self.call(cancel())

    def stop(self):
        self.closing = True
        if self.loop and not self.loop.is_closed() and self.stop_event:
            self.loop.call_soon_threadsafe(self.stop_event.set)
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=self.timeout + 5)
            if self.thread.is_alive():
                raise TimeoutError("Antigravity SDK did not acknowledge shutdown")
        return {}
