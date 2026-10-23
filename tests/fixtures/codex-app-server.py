#!/usr/bin/env python3
"""Disposable Codex protocol fixture; never contacts a model service."""
import json
import os
from pathlib import Path
import sys
import time

if "--version" in sys.argv:
    print("codex-cli 0.163.0")
    sys.exit(0)

root = Path(os.environ["AGENTC2_CODEX_FIXTURE_DIR"])
settings = json.loads((root / "settings.json").read_text())
thread_id = "native-thread"
thread_cwd = root
turn_id = None
turn_number = 0
interactive = {}


def write(value):
    print(json.dumps(value), flush=True)


def reply(message, result):
    write(dict(id=message["id"], result=result))


def notify(method, params):
    write(dict(method=method, params=params))


def turn(status="inProgress", items=None):
    return dict(id=turn_id, items=items or [], status=status)


def item_event(item, completed=False):
    params = dict(threadId=thread_id, turnId=turn_id, item=item)
    params["completedAtMs" if completed else "startedAtMs"] = 0
    notify("item/completed" if completed else "item/started", params)


def finish(status="completed", text="Fixture answer"):
    global turn_id
    item = dict(id="assistant-" + turn_id, type="agentMessage", text=text)
    notify("item/agentMessage/delta", dict(threadId=thread_id, turnId=turn_id, itemId=item["id"], delta="Fixture "))
    item_event(item, True)
    item_event(item, True)  # Repeated finals must reconcile exactly once.
    notify("thread/tokenUsage/updated", dict(threadId=thread_id, turnId=turn_id, tokenUsage=dict(total=dict(inputTokens=100, cachedInputTokens=0, outputTokens=50, reasoningOutputTokens=0, totalTokens=150), last=dict(inputTokens=100, cachedInputTokens=0, outputTokens=50, reasoningOutputTokens=0, totalTokens=150), modelContextWindow=10000)))
    notify("turn/completed", dict(threadId=thread_id, turn=turn(status)))
    turn_id = None


for line in sys.stdin:
    message = json.loads(line)
    with (root / "requests.jsonl").open("a") as log:
        log.write(json.dumps(message) + "\n")
    if "method" not in message:
        waiting = interactive.pop(message["id"])
        if waiting == "approval":
            approved = message.get("result", {}).get("decision") == "accept"
            if approved:
                (root / "approved.txt").write_text("Approved fixture write")
            item_event(dict(id="tool-" + turn_id, type="commandExecution", command="fixture write", cwd=str(root), commandActions=[], status="completed" if approved else "declined", aggregatedOutput="Wrote fixture" if approved else "Permission denied", exitCode=0 if approved else 1), True)
            finish(text="Fixture approved" if approved else "Fixture denied")
        else:
            (root / "answers.json").write_text(json.dumps(message["result"]))
            finish(text="Fixture answered")
        continue
    method, params = message["method"], message.get("params", {})
    if method == "initialize":
        reply(message, dict(codexHome=str(root), platformFamily="unix", platformOs="linux", userAgent="codex-cli/0.163.0"))
    elif method == "initialized":
        pass
    elif method == "account/read":
        reply(message, dict(account=None if settings.get("noAuth") else dict(type="apiKey"), requiresOpenaiAuth=True))
    elif method in ("thread/start", "thread/resume"):
        thread_id = params.get("threadId", "native-thread")
        thread_cwd = Path(params.get("cwd") or root)
        full = params.get("sandbox") == "danger-full-access" or settings.get("wrongRoe")
        metadata = dict(id=thread_id, sessionId="fixture-session", cliVersion="0.163.0", createdAt=0, updatedAt=0, cwd=str(root), ephemeral=False, modelProvider="fixture", preview="", projectId=None, source="appServer", status=dict(type="idle"), turns=[])
        reply(message, dict(thread=metadata, approvalPolicy="never" if full else params.get("approvalPolicy", "on-request"), approvalsReviewer="user", cwd=str(root), model="fixture", modelProvider="fixture", sandbox=dict(type="dangerFullAccess" if full else "readOnly")))
    elif method == "thread/turns/list":
        if params.get("cursor") is None:
            reply(message, dict(data=[dict(id="past-one", status="completed", items=[dict(id="past-user", type="userMessage", content=[dict(type="text", text="Earlier question")]), dict(id="past-answer", type="agentMessage", text="Earlier answer")])], nextCursor="next-page"))
        else:
            time.sleep(0.15)
            reply(message, dict(data=[dict(id="past-two", status="interrupted", items=[dict(id="later-answer", type="agentMessage", text="Later answer")])], nextCursor=None))
    elif method == "turn/start":
        text = params["input"][0]["text"]
        if text == "reject":
            write(dict(id=message["id"], error=dict(code=-32602, message="Fixture rejected the turn")))
            continue
        turn_number += 1
        turn_id = "turn-" + str(turn_number)
        reply(message, dict(turn=turn()))
        notify("turn/started", dict(threadId=thread_id, turn=turn()))
        item_event(dict(id="user-" + turn_id, type="userMessage", content=[dict(type="text", text=text)]), True)
        if settings.get("centcom") and text.startswith("<UNTRUSTED_FLEET_EVIDENCE>"):
            plan_file = root / "centcom-plan.json"
            responses = json.loads(plan_file.read_text()) if plan_file.exists() else []
            answer = responses.pop(0) if responses else "Fixture observed the correlated result."
            plan_file.write_text(json.dumps(responses))
            with (root / "centcom-prompts.jsonl").open("a") as log:
                log.write(json.dumps(text) + "\n")
            finish(text=answer)
        elif settings.get("centcom") and text == "write-reviewed-artifact":
            assert thread_cwd.resolve().is_relative_to(root.resolve())
            (thread_cwd / "evidence.txt").write_text("Reviewed bridge artifact\n")
            finish(text="Fixture wrote evidence.txt")
        elif text in ("approval", "question", "secret"):
            if text == "approval":
                item_event(dict(id="tool-" + turn_id, type="commandExecution", command="fixture write", cwd=str(root), commandActions=[], status="inProgress"))
                interactive[100 + turn_number * 2] = "approval"
                write(dict(id=100 + turn_number * 2, method="item/commandExecution/requestApproval", params=dict(threadId=thread_id, turnId=turn_id, itemId="tool-" + turn_id, command="fixture write", cwd=str(root), startedAtMs=0)))
            else:
                interactive[101 + turn_number * 2] = "question"
                question = dict(id="choice", header="Choice", question="Which option?", isSecret=text == "secret", options=[dict(label="One", description="First choice"), dict(label="Two", description="Second choice")])
                write(dict(id=101 + turn_number * 2, method="item/tool/requestUserInput", params=dict(threadId=thread_id, turnId=turn_id, itemId="question-" + turn_id, isBlocking=True, questions=[question])))
        elif text == "dev-server":
            finish(text="Development server " + settings["devUrl"] + "\n")
        elif text == "hold":
            pass
        else:
            finish()
    elif method == "turn/steer":
        if params["expectedTurnId"] != turn_id:
            write(dict(id=message["id"], error=dict(code=-32602, message="Turn changed")))
        else:
            reply(message, dict(turnId=turn_id))
            item_event(dict(id="steered-user", type="userMessage", content=params["input"]), True)
    elif method == "turn/interrupt":
        reply(message, {})
        finish("interrupted", text="Fixture interrupted")
    else:
        write(dict(id=message.get("id"), error=dict(code=-32601, message="Unsupported fixture method")))
