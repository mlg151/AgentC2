"""Per-session event adapter. No message, tool input, or credentials are logged."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

FLASH_TTL = 300


def flash_request(payload):
    if payload.get("hook_event_name") != "PermissionRequest":
        return None
    tool = payload.get("tool_name")
    value = payload.get("tool_input")
    if not isinstance(tool, str) or not tool or len(tool) > 100 or not isinstance(value, dict):
        return None
    action = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(action.encode("utf-8")) > 4000:
        return None
    directory = Path(__file__).with_name("flash")
    if directory.is_symlink():
        return None
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    request_id = uuid.uuid4().hex
    request = {"version": 1, "id": request_id, "name": Path(__file__).parent.name,
               "provider": "claude", "tool": tool, "action": action,
               "session": str(payload.get("session_id") or "")[:100],
               "turn": str(payload.get("prompt_id") or "")[:100],
               "createdAt": time.time(), "expiresAt": time.time() + FLASH_TTL,
               "pid": os.getpid(), "state": "pending", "decision": None}
    descriptor = os.open(directory / (request_id + ".json"), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(request, stream, ensure_ascii=False)
    return request_id


def flash_wait(request_id):
    path = Path(__file__).with_name("flash") / (request_id + ".json")
    while True:
        try:
            with path.open("r+", encoding="utf-8") as stream:
                fcntl.flock(stream, fcntl.LOCK_EX)
                request = json.load(stream)
                if request.get("id") != request_id:
                    return
                now = time.time()
                if request.get("decision") in ("allow", "deny") and now < request["expiresAt"]:
                    request["state"] = "resolved"
                    request["resolvedAt"] = now
                    stream.seek(0); stream.truncate(); json.dump(request, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
                    output = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": request["decision"]}}}
                    if request["decision"] == "deny":
                        output["hookSpecificOutput"]["decision"]["message"] = "Denied from AgentC2 Flash Traffic."
                    print(json.dumps(output))
                    return
                if now >= request["expiresAt"]:
                    request["state"] = "expired"
                    stream.seek(0); stream.truncate(); json.dump(request, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
                    return
        except (OSError, ValueError, KeyError):
            return
        time.sleep(0.2)


def flash_has_pending(session_id):
    if not isinstance(session_id, str) or not session_id:
        return False
    directory = Path(__file__).with_name("flash")
    if not directory.is_dir() or directory.is_symlink():
        return False
    for path in list(directory.glob("*.json"))[-50:]:
        try:
            request = json.loads(path.read_text(encoding="utf-8"))
            if request.get("session") == session_id and request.get("state") in ("pending", "submitted") and time.time() < request.get("expiresAt", 0):
                try:
                    os.kill(request.get("pid"), 0)
                    return True
                except (OSError, TypeError):
                    pass
        except (OSError, ValueError, TypeError):
            pass
    return False


def main():
    provider = sys.argv[1]
    mode = sys.argv[2]
    payload = {}
    try:
        payload = json.loads(sys.argv[-1] if mode == "notify" else sys.stdin.read(1000000))
    except (ValueError, IndexError):
        pass
    # Subagent hooks are not completion of the parent session's turn.
    if payload.get("agent_id"):
        return
    if provider == "claude" and payload.get("hook_event_name") == "Notification" and payload.get("notification_type") == "permission_prompt" and flash_has_pending(payload.get("session_id")):
        return
    request_id = flash_request(payload) if provider == "claude" and mode == "hook" else None
    if mode == "notify":
        kind = "completed" if payload.get("type") == "agent-turn-complete" else None
    else:
        kind = {"Stop": "completed", "StopFailure": "failed", "PermissionRequest": "input", "UserPromptSubmit": "working"}.get(payload.get("hook_event_name"))
        if payload.get("hook_event_name") == "Notification" and payload.get("notification_type") in ("permission_prompt", "elicitation_dialog"):
            kind = "input"
        if payload.get("hook_event_name") == "PreToolUse" and payload.get("tool_name") == "AskUserQuestion":
            kind = "input"
    if kind:
        session_id = payload.get("thread-id") if provider == "codex" else payload.get("session_id")
        turn_id = payload.get("turn-id") if provider == "codex" else payload.get("prompt_id")
        stable = isinstance(session_id, str) and isinstance(turn_id, str) and (kind != "input" or isinstance(payload.get("tool_use_id"), str))
        identity = f"{provider}:{session_id}:{turn_id}:{kind}:{payload.get('tool_use_id', '')}"
        event = {"id": hashlib.sha256(identity.encode()).hexdigest()[:32] if stable else uuid.uuid4().hex,
                 "kind": kind, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": provider,
                 "session": session_id if isinstance(session_id, str) and len(session_id) <= 100 else None,
                 "turn": turn_id if isinstance(turn_id, str) and len(turn_id) <= 100 else None}
        if request_id:
            event["requestId"] = request_id
            event["tool"] = payload.get("tool_name")
        log = Path(__file__).with_name("events.jsonl")
        with log.open("a+", encoding="utf-8") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            stream.seek(0)
            recent = stream.readlines()[-127:]
            seen = set()
            for line in recent:
                try:
                    seen.add(json.loads(line).get("id"))
                except ValueError:
                    pass
            if event["id"] not in seen:
                stream.seek(0)
                stream.truncate()
                stream.writelines(recent)
                stream.write(json.dumps(event) + "\n")
    if request_id:
        flash_wait(request_id)
    if mode == "notify":
        # Preserve the user's normal notify command when adding this session's
        # adapter. Never expose configuration values to the renderer or log.
        try:
            import tomllib
            root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
            config = tomllib.loads((root / "config.toml").read_text())
            following = config.get("notify")
            profile = sys.argv[3].removeprefix("PROFILE=") if len(sys.argv) > 4 and sys.argv[3].startswith("PROFILE=") else ""
            if profile:
                profile_config = config.get("profiles", {}).get(profile, {})
                profile_file = root / (profile + ".config.toml")
                if profile_file.is_file():
                    profile_config = tomllib.loads(profile_file.read_text())
                following = profile_config.get("notify", following)
            if isinstance(following, list) and following and all(isinstance(arg, str) for arg in following) and str(Path(__file__)) not in following:
                subprocess.run(following + [sys.argv[-1]], timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Reporting must never approve, reject, block, or fail an agent action.
        pass
