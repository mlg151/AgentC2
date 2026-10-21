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
