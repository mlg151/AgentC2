#!/usr/bin/env python3
"""No model calls: an ACP peer for streaming, replies, cancellation, and resume."""
import json
import sys

session = "ses_fixture123456"
prompt = None
waiting = None


def write(value):
    print(json.dumps(dict(jsonrpc="2.0", **value)), flush=True)


def update(value):
    write(dict(method="session/update", params=dict(sessionId=session, update=value)))


def complete(text="Fixture answer", reason="end_turn"):
    global prompt
    update(dict(sessionUpdate="agent_message_chunk", content=dict(type="text", text=text)))
    write(dict(id=prompt, result=dict(stopReason=reason)))
    prompt = None


for raw in sys.stdin:
    request = json.loads(raw)
    method, params = request.get("method"), request.get("params", {})
    if method == "initialize":
        write(dict(id=request["id"], result=dict(protocolVersion=1, agentCapabilities=dict(loadSession=True))))
    elif method in ("session/new", "session/load"):
        if method == "session/load":
            session = params["sessionId"]
            update(dict(sessionUpdate="user_message_chunk", content=dict(type="text", text="Previous native prompt")))
            update(dict(sessionUpdate="agent_message_chunk", content=dict(type="text", text="Previous native answer")))
        write(dict(id=request["id"], result=dict(sessionId=session)))
    elif method == "session/prompt":
        prompt = request["id"]
        text = params["prompt"][0]["text"]
        if text == "disconnect":
            sys.exit(0)
        elif text == "reject":
            write(dict(id=prompt, error=dict(code=-32000, message="Sign in with opencode auth login")))
        elif text == "slow":
            pass
        elif text == "permission":
            update(dict(sessionUpdate="tool_call", toolCallId="tool-one", title="Write fixture", status="pending", rawInput=dict(path="fixture.txt")))
            waiting = "permission"
            write(dict(id="native-permission", method="session/request_permission", params=dict(sessionId=session, toolCall=dict(toolCallId="tool-one", title="Write fixture"), options=[dict(optionId="once", kind="allow_once"), dict(optionId="reject", kind="reject_once")])))
        elif text == "question":
            waiting = "question"
            write(dict(id="native-question", method="elicitation/create", params=dict(sessionId=session, mode="form", message="Which package manager?", requestedSchema=dict(type="object", properties=dict(pm=dict(type="string", enum=["npm", "pnpm"])), required=["pm"]))))
        else:
            update(dict(sessionUpdate="agent_message_chunk", content=dict(type="text", text="Streamed ")))
            update(dict(sessionUpdate="usage_update", used=250, size=1000, cost=dict(currency="USD", amount=0.01)))
            complete("answer")
    elif method == "session/set_model":
        if params["modelId"] == "rejected-model":
            write(dict(id=request["id"], error=dict(code=-32602, message="Model unavailable")))
        else:
            write(dict(id=request["id"], result={}))
    elif method == "session/cancel":
        if prompt is not None:
            complete("Interrupted", "cancelled")
    elif request.get("id") == "native-permission":
        outcome = request["result"]["outcome"]
        allowed = outcome.get("optionId") == "once"
        update(dict(sessionUpdate="tool_call_update", toolCallId="tool-one", status="completed" if allowed else "failed", rawOutput="Allowed" if allowed else "Denied"))
        complete("Permission allowed" if allowed else "Permission denied")
        waiting = None
    elif request.get("id") == "native-question":
        complete("Selected " + request["result"].get("content", {}).get("pm", "cancelled"))
        waiting = None
