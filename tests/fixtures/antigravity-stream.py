#!/usr/bin/env python3
"""Text-only bidirectional CLI fixture; no model or provider credentials."""
import json
import os
from pathlib import Path
import signal
import sys

if "--version" in sys.argv:
    print("1.4.4")
    sys.exit(0)

root = Path(os.environ["AGENTC2_AGY_FIXTURE_DIR"])
settings = json.loads((root / "settings.json").read_text())
native_id = sys.argv[sys.argv.index("--conversation") + 1] if "--conversation" in sys.argv else "native-agy-fixture"
initialized, turns = False, 0


def emit(value):
    print(json.dumps(value), flush=True)


def result(status, text="", error=None):
    emit(dict(event="result", result=dict(conversation_id=native_id, status=status, response=text, error=error, num_turns=turns, usage=dict(input_tokens=100 * turns, output_tokens=50 * turns, total_tokens=150 * turns))))


def interrupt(signum, frame):
    result("INTERRUPTED", "Interrupted fixture")


signal.signal(signal.SIGINT, interrupt)
for line in sys.stdin:
    value = json.loads(line)
    with (root / "sent.jsonl").open("a") as stream:
        stream.write(json.dumps(dict(argv=sys.argv[1:], message=value)) + "\n")
    if not initialized:
        emit(dict(event="init", conversation_id=native_id, init=dict(cwd=str(root), tools=["run_command"], permission_mode="always-proceed" if "--dangerously-skip-permissions" in sys.argv and not settings.get("wrongRoe") else "request-review")))
        initialized = True
    turns += 1
    text = value["message"]["content"]
    if text == "hold":
        continue
    if text in ("denied", "failure"):
        denied = text == "denied"
        error = dict(type="permission_denied" if denied else "process_failed", message="Tool permission denied" if denied else "Command exited 1")
        emit(dict(event="step_update", step_update=dict(conversation_id=native_id, step_index=turns * 3, step_type="tool", state="DONE", tool_name="run_command", tool_info=dict(name="run_command", parameters=dict(CommandLine="fixture"), error=error))))
        if denied:
            print("Tool run_command requires permission and was soft-denied", file=sys.stderr, flush=True)
        result("SUCCESS", "The requested command could not run")
    elif text == "unknown":
        result("WAITING", "No terminal outcome")
    elif text == "error":
        result("ERROR", error="Fixture provider failure")
    else:
        for index, delta in enumerate(["Streamed ", "answer"]):
            emit(dict(event="step_update", step_update=dict(conversation_id=native_id, step_index=turns * 3 + index, step_type="agent_response", state="DONE", text_delta=delta)))
        result("SUCCESS", "Streamed answer")
