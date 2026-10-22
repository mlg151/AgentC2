"""Versioned wire validation shared by the remote worker and journal."""

import json
import math
from pathlib import Path
import re
from datetime import datetime

CONTRACT = json.loads(Path(__file__).with_name("chat-protocol.json").read_text())
COMMAND_ID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
SESSION_ID = re.compile(r"^chat-[a-f0-9]{32}$")


def fields(value, keys, required=None):
    if not isinstance(value, dict) or set(value) - set(keys) or set(keys if required is None else required) - set(value):
        raise ValueError("Invalid chat object fields")


def text(value, maximum, empty=False):
    # JavaScript measures UTF-16 code units; use the same limit on both sides.
    if not isinstance(value, str) or (not empty and not value.strip()) or len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > maximum or "\0" in value:
        raise ValueError("Invalid chat text")
    value.encode("utf-8")
    return value


def choice(value, choices):
    if value not in choices:
        raise ValueError("Invalid chat value")


def identifier(value):
    return text(value, CONTRACT["limits"]["id"])


def optional_id(value):
    return None if value is None else identifier(value)


def session_id(value):
    if not isinstance(value, str) or not SESSION_ID.fullmatch(value):
        raise ValueError("Invalid chat session ID")
    return value


def wire_size(value):
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")) > CONTRACT["limits"]["wireBytes"]:
        raise ValueError("Chat message is too large")


def validate_command(value):
    fields(value, ["protocolVersion", "commandId", "operation", "sessionId", "payload"], ["protocolVersion", "commandId", "operation", "payload"])
    if type(value["protocolVersion"]) is not int or value["protocolVersion"] != CONTRACT["version"]:
        raise ValueError("Unsupported chat protocol version")
    if not isinstance(value["commandId"], str) or not COMMAND_ID.fullmatch(value["commandId"]):
        raise ValueError("Invalid chat command ID")
    operation, payload = value["operation"], value["payload"]
    choice(operation, CONTRACT["operations"])
    if operation == "create":
        if "sessionId" in value:
            raise ValueError("Create does not accept a session ID")
        fields(payload, ["provider", "cwd", "title", "roeProfile", "providerSessionId", "managedName", "instructions"], ["provider", "cwd", "title", "roeProfile"])
        if "managedName" in payload and (not isinstance(payload["managedName"], str) or not re.fullmatch(r"hq-[a-f0-9]{12}", payload["managedName"])):
            raise ValueError("Invalid managed chat name")
        if "instructions" in payload:
            text(payload["instructions"], 20000, True)
        choice(payload["provider"], CONTRACT["providers"])
        if not text(payload["cwd"], CONTRACT["limits"]["path"]).startswith("/"):
            raise ValueError("Chat working directory must be absolute")
        text(payload["title"], CONTRACT["limits"]["title"], True)
        choice(payload["roeProfile"], ["full", "gated", "provider-default"])
        if "providerSessionId" in payload:
            identifier(payload["providerSessionId"])
    else:
        session_id(value.get("sessionId"))
        if operation in ("send", "steer"):
            fields(payload, ["text", "expectedTurnId"] if operation == "steer" else ["text"])
            text(payload["text"], CONTRACT["limits"]["text"])
            if operation == "steer":
                identifier(payload["expectedTurnId"])
        elif operation == "respond":
            fields(payload, ["requestId", "turnId", "itemId", "decision", "answers"], ["requestId", "turnId", "itemId"])
            identifier(payload["requestId"])
            optional_id(payload["turnId"])
            optional_id(payload["itemId"])
            if ("decision" in payload) == ("answers" in payload):
                raise ValueError("Supply a decision or question answers")
            if "decision" in payload:
                choice(payload["decision"], ["allow", "deny"])
            if "answers" in payload:
                if not isinstance(payload["answers"], list) or not 1 <= len(payload["answers"]) <= 20:
                    raise ValueError("Invalid chat answers")
                for answer in payload["answers"]:
                    fields(answer, ["questionId", "answers"])
                    identifier(answer["questionId"])
                    if not isinstance(answer["answers"], list) or len(answer["answers"]) > 20:
                        raise ValueError("Invalid chat answers")
                    for item in answer["answers"]:
                        text(item, 10000, True)
        else:
            fields(payload, [])
    wire_size(value)
    return value


def validate_capabilities(value):
    fields(value, ["provider", "version", "status", "reason", *CONTRACT["capabilities"]])
    choice(value["provider"], CONTRACT["providers"])
    optional_id(value["version"])
    choice(value["status"], ["supported", "unsupported", "unverified"])
    if value["reason"] is not None:
        text(value["reason"], 2000)
    if any(type(value[name]) is not bool for name in CONTRACT["capabilities"]):
        raise ValueError("Invalid chat capability")
    if value["status"] != "supported" and any(value[name] for name in CONTRACT["capabilities"]):
        raise ValueError("Unsupported provider cannot advertise actions")
    return value


def unavailable_capabilities(provider, version=None, reason="Provider integration has not been verified"):
    return validate_capabilities(dict(provider=provider, version=version, status="unverified", reason=reason, **{name: False for name in CONTRACT["capabilities"]}))


def validate_event(value):
    fields(value, ["protocolVersion", "sessionId", "sequence", "timestamp", "provider", "providerSessionId", "turnId", "itemId", "type", "data"])
    if type(value["protocolVersion"]) is not int or value["protocolVersion"] != CONTRACT["version"]:
        raise ValueError("Unsupported chat protocol version")
    session_id(value["sessionId"])
    if type(value["sequence"]) is not int or not 1 <= value["sequence"] <= 9007199254740991:
        raise ValueError("Invalid chat sequence")
    if not isinstance(value["timestamp"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value["timestamp"]):
        raise ValueError("Invalid chat timestamp")
    at = datetime.fromisoformat(value["timestamp"].replace("Z", "+00:00"))
    if at.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value["timestamp"]:
        raise ValueError("Invalid chat timestamp")
    choice(value["provider"], CONTRACT["providers"])
    for key in ("providerSessionId", "turnId", "itemId"):
        optional_id(value[key])
    kind, data = value["type"], value["data"]
    choice(kind, CONTRACT["eventTypes"])
    if kind == "session.updated":
        fields(data, ["state", "detail"])
        choice(data["state"], CONTRACT["sessionStates"])
        text(data["detail"], 2000, True)
    elif kind in ("message.delta", "message.completed"):
        fields(data, ["text"] if kind == "message.delta" else ["role", "text"])
        text(data["text"], CONTRACT["limits"]["text"], True)
        if kind == "message.completed":
            choice(data["role"], ["user", "assistant"])
    elif kind in ("tool.started", "tool.completed"):
        fields(data, ["name", "input"] if kind == "tool.started" else ["name", "output", "isError"])
        identifier(data["name"])
        text(data["input" if kind == "tool.started" else "output"], CONTRACT["limits"]["text"], True)
        if kind == "tool.completed" and type(data["isError"]) is not bool:
            raise ValueError("Invalid tool result")
    elif kind == "approval.requested":
        fields(data, ["requestId", "action", "detail"])
        identifier(data["requestId"])
        text(data["action"], 2000)
        text(data["detail"], CONTRACT["limits"]["text"], True)
    elif kind == "question.requested":
        fields(data, ["requestId", "questions"])
        identifier(data["requestId"])
        if not isinstance(data["questions"], list) or not 1 <= len(data["questions"]) <= 20:
            raise ValueError("Invalid questions")
        for question in data["questions"]:
            fields(question, ["id", "question", "options", "multiple"])
            identifier(question["id"])
            text(question["question"], 10000)
            if not isinstance(question["options"], list) or len(question["options"]) > 100 or type(question["multiple"]) is not bool:
                raise ValueError("Invalid question options")
            for option in question["options"]:
                text(option, 10000)
    elif kind == "request.resolved":
        fields(data, ["requestId", "state", "decision"])
        identifier(data["requestId"])
        choice(data["state"], ["resolved", "expired"])
        if data["decision"] is not None:
            choice(data["decision"], ["allow", "deny", "answered"])
    elif kind == "usage.updated":
        fields(data, ["inputTokens", "outputTokens", "totalTokens", "costUsd", "contextUsedTokens", "contextCapacityTokens"])
        for metric in data.values():
            if metric is not None and (type(metric) not in (int, float) or not math.isfinite(metric) or metric < 0):
                raise ValueError("Invalid usage metric")
    elif kind == "turn.completed":
        fields(data, ["outcome", "detail"])
        choice(data["outcome"], ["completed", "failed", "interrupted", "denied", "unknown"])
        text(data["detail"], 2000, True)
    elif kind == "error":
        fields(data, ["code", "message", "retryable"])
        identifier(data["code"])
        text(data["message"], 2000)
        if type(data["retryable"]) is not bool:
            raise ValueError("Invalid error state")
    else:
        fields(data, ["method", "payload"])
        identifier(data["method"])
        if not isinstance(data["payload"], dict):
            raise ValueError("Invalid provider payload")
    wire_size(value)
    return value
