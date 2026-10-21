"""Ephemeral SSH helper. Sent over stdin; nothing is installed on the host."""

import base64
import getpass
import hashlib
import fcntl
import json
import os
import pwd
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import socket
import subprocess
import sys
import stat
import tempfile
from contextlib import contextmanager
import time
import uuid


HOME = Path.home()
PROVIDERS = {"codex": "codex", "claude": "claude", "antigravity": "agy"}
SESSION_PROVIDERS = {*PROVIDERS, "terminal"}
PERMISSION_FLAGS = {
    "codex": "--dangerously-bypass-approvals-and-sandbox",
    "claude": "--dangerously-skip-permissions",
    "antigravity": "--dangerously-skip-permissions",
}
ID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,100}$")
TMUX_RE = re.compile(r"^hq-[a-f0-9]{12}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
HOOK_ROOT = HOME / ".cache" / "agent-hq"


@contextmanager
def cleanup_lock():
    descriptor = os.open(HOME / ".agentc2-history.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or info.st_nlink != 1 or not stat.S_ISREG(info.st_mode):
            raise ValueError("Shared cleanup lock is unsupported")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another AgentC2 launch or history operation is running; retry after it finishes")
        yield


def session_events(name):
    if not TMUX_RE.fullmatch(name):
        return []
    try:
        lines = (HOOK_ROOT / name / "events.jsonl").read_text().splitlines()[-128:]
        return [item for line in lines if isinstance((item := json.loads(line)), dict)]
    except (OSError, ValueError):
        return []


def hook_arguments(provider, name, payload):
    preset = payload.get("preset")
    enabled = preset.get("attentionHooks", False) if preset else True
    gated_claude = provider == "claude" and payload.get("roeProfile") == "gated" and not payload.get("agentId")
    if not enabled or provider not in ("codex", "claude") or payload.get("agentId") or not payload.get("hookSource"):
        return ["--settings", json.dumps({"permissions": {"ask": ["Bash", "Edit", "Write", "NotebookEdit"]}})] if gated_claude else []
    directory = HOOK_ROOT / name
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    script = directory / "hook.py"
    script.write_text(payload["hookSource"], encoding="utf-8")
    script.chmod(0o600)
    if provider == "codex":
        # An explicitly configured notify override wins over our adapter.
        if "notify=" in (preset or {}).get("args", "").replace(" ", ""):
            return []
        args = shlex.split((preset or {}).get("args", ""))
        profile = next((args[index + 1] for index, arg in enumerate(args[:-1]) if arg in ("-p", "--profile")), "")
        return ["-c", "notify=" + json.dumps(["python3", str(script), provider, "notify", "PROFILE=" + profile])]
    command = shlex.join(["python3", str(script), provider, "hook"])
    hooks = {event: [{"hooks": [{"type": "command", "command": command, "timeout": 310 if event == "PermissionRequest" else 5}]}] for event in ("Stop", "StopFailure", "PermissionRequest", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure")}
    hooks["Notification"] = [{"matcher": "permission_prompt|elicitation_dialog", "hooks": [{"type": "command", "command": command, "timeout": 5}]}]
    hooks["PreToolUse"] = [{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": command, "timeout": 5}]}]
    settings = {"hooks": hooks}
    if gated_claude:
        settings["permissions"] = {"ask": ["Bash", "Edit", "Write", "NotebookEdit"]}
    return ["--settings", json.dumps(settings)]


def run(args, timeout=15):
    try:
        return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError:
        return subprocess.CompletedProcess(args, 127, "", f"Command not found: {args[0]}")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"Command timed out: {args[0]}")


def iso_from_epoch(value):
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(value)))
    except (TypeError, ValueError, OverflowError):
        return None


def normalize_time(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return iso_from_epoch(value / 1000 if value > 100_000_000_000 else value)
    return None


def codex_sessions():
    db = HOME / ".codex" / "state_5.sqlite"
    if not db.exists():
        return []
    rows = []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, title, cwd, updated_at_ms, archived FROM threads "
            "ORDER BY updated_at_ms DESC"
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return []
    return [
        {
            "key": f"codex:{r['id']}",
            "provider": "codex",
            "id": r["id"],
            "title": (r["title"] or "Codex conversation")[:120],
            "cwd": r["cwd"] or "",
            "updatedAt": iso_from_epoch((r["updated_at_ms"] or 0) / 1000),
            "state": "archived" if r["archived"] else "saved",
            "kind": "conversation",
            "canResume": True,
        }
        for r in rows
    ]


def claude_title_and_cwd(path):
    title = None
    cwd = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as stream:
            for index, line in enumerate(stream):
                if index >= 250 or (title and cwd):
                    break
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cwd = cwd or item.get("cwd")
                if item.get("type") != "user" or title:
                    continue
                message = item.get("message") or {}
                content = message.get("content", "")
                if isinstance(content, list):
                    content = " ".join(
                        part.get("text", "") for part in content
                        if isinstance(part, dict) and part.get("type") == "text"
                    )
                if isinstance(content, str):
                    title = " ".join(content.split())[:120] or None
    except OSError:
        pass
    return title, cwd


def claude_sessions():
    root = HOME / ".claude" / "projects"
    result = {}
    if root.exists():
        for path in root.glob("**/*.jsonl"):
            session_id = path.stem
            if not ID_RE.fullmatch(session_id):
                continue
            try:
                modified = path.stat().st_mtime
            except OSError:
                continue
            title, cwd = claude_title_and_cwd(path)
            result[session_id] = {
                "key": f"claude:{session_id}",
                "provider": "claude",
                "id": session_id,
                "title": title or f"Claude conversation {session_id[:8]}",
                "cwd": cwd or "",
                "updatedAt": iso_from_epoch(modified),
                "state": "saved",
                "kind": "conversation",
                "canResume": True,
            }
    active = run(["claude", "agents", "--json"], timeout=12)
    if active.returncode == 0:
        try:
            agents = json.loads(active.stdout)
            for agent in agents:
                session_id = agent.get("sessionId") or agent.get("id")
                if not session_id or not ID_RE.fullmatch(session_id):
                    continue
                entry = result.get(session_id, {
                    "key": f"claude:{session_id}", "provider": "claude",
                    "id": session_id, "title": agent.get("name") or "Claude agent",
                    "cwd": agent.get("cwd") or "", "updatedAt": normalize_time(agent.get("startedAt")),
                    "kind": "background", "canResume": True,
                })
                entry["state"] = agent.get("state") or "live"
                entry["kind"] = agent.get("kind") or entry["kind"]
                entry["agentId"] = agent.get("id")
                result[session_id] = entry
        except (ValueError, TypeError):
            pass
    return list(result.values())


def antigravity_sessions():
    root = HOME / ".gemini" / "antigravity" / "conversations"
    result = []
    if not root.exists():
        return result
    for path in root.glob("*.pb"):
        session_id = path.stem
        if not ID_RE.fullmatch(session_id):
            continue
        try:
            modified = path.stat().st_mtime
        except OSError:
            continue
        result.append({
            "key": f"antigravity:{session_id}",
            "provider": "antigravity",
            "id": session_id,
            "title": f"Antigravity conversation {session_id[:8]}",
            "cwd": "",
            "updatedAt": iso_from_epoch(modified),
            "state": "saved",
            "kind": "conversation",
            "canResume": True,
        })
    return result


def tmux_option(name, option):
    value = run(["tmux", "show-options", "-qv", "-t", name, option], timeout=3)
    return value.stdout.strip() if value.returncode == 0 else ""


def tmux_sessions():
    result = []
    listed = run([
        "tmux", "list-sessions", "-F",
        "#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}\t#{pane_dead_status}\t#{session_activity}\t#{pane_pid}\t#{@hq_process_exit}",
    ], timeout=5)
    if listed.returncode != 0:
        return result
    for line in listed.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) < 5:
            continue
        name, created, attached, command, cwd = fields[:5]
        managed = bool(TMUX_RE.fullmatch(name)) and tmux_option(name, "@hq_provider") in SESSION_PROVIDERS
        provider = tmux_option(name, "@hq_provider") if managed else {
            "agy": "antigravity", "codex": "codex", "claude": "claude"
        }.get(command)
        if provider not in SESSION_PROVIDERS:
            continue
        title = tmux_option(name, "@hq_title") if managed else name
        dead = len(fields) > 5 and fields[5] == "1"
        exit_code = int(fields[6]) if dead and len(fields) > 6 and fields[6].isdigit() else None
        if dead and managed and exit_code is None and len(fields) > 9:
            # Some tmux builds can retain a dead pane without its wait status.
            # Our launch wrapper records the actual child result before exit.
            # Match the pane's process ID so a respawn cannot reuse old evidence.
            recorded = re.fullmatch(r"([0-9]+):([0-9]+)", fields[9])
            if recorded and recorded[1] == fields[8] and 0 <= int(recorded[2]) <= 255:
                exit_code = int(recorded[2])
        output = run(["tmux", "capture-pane", "-p", "-J", "-t", name, "-S", "-40"], timeout=3)
        events = session_events(name) if managed else []
        provider_session = next((event.get("session") for event in reversed(events)
                                 if event.get("source") == provider and isinstance(event.get("session"), str)), None)
        result.append({
            "key": f"tmux:{name}", "provider": provider, "id": name,
            "title": title or name,
            "cwd": tmux_option(name, "@hq_cwd") if managed else cwd,
            "updatedAt": iso_from_epoch(fields[7] if len(fields) > 7 else created),
            "state": "exited" if dead else "live", "kind": "managed" if managed else "external-tmux",
            "managed": managed, "attached": attached != "0", "canAttach": True,
            "canInterrupt": managed and not dead, "canStop": managed,
            "exitCode": exit_code, "outputTail": output.stdout[-12000:],
            "presetName": tmux_option(name, "@hq_preset") if managed else "",
            "presetId": tmux_option(name, "@hq_preset_id") if managed else "",
            "roeProfile": (tmux_option(name, "@hq_roe") or "unknown") if managed else "unknown",
            "worktreeOperation": tmux_option(name, "@hq_worktree") if managed else "",
            "events": events,
            "telemetry": provider_telemetry(provider, provider_session, HOME),
        })
    return result


def unmanaged_processes():
    listed = run(["ps", "-eo", "pid=,ppid=,comm=,tty="], timeout=5)
    if listed.returncode != 0:
        return []
    processes = {}
    for line in listed.stdout.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) == 4:
            try:
                processes[int(fields[0])] = (int(fields[1]), fields[2], fields[3])
            except ValueError:
                pass

    def inside_tmux(pid):
        seen = set()
        while pid in processes and pid not in seen:
            seen.add(pid)
            parent, command, _ = processes[pid]
            if command.startswith("tmux"):
                return True
            pid = parent
        return False

    result = []
    for pid, (_, command, tty) in processes.items():
        provider = {"codex": "codex", "claude": "claude", "agy": "antigravity"}.get(command)
        if not provider or inside_tmux(pid):
            continue
        result.append({
            "key": f"process:{pid}", "provider": provider, "id": str(pid),
            "title": f"{provider.title()} process {pid}",
            "cwd": "", "updatedAt": None, "state": "live",
            "kind": "unmanaged", "tty": tty, "canAttach": False,
            "canResume": False,
        })
    return result


def inventory():
    sessions = (
        tmux_sessions() + unmanaged_processes() + codex_sessions()
        + claude_sessions() + antigravity_sessions()
    )
    sessions.sort(key=lambda s: str(s.get("updatedAt") or ""), reverse=True)
    repositories = {}
    for session in sessions:
        if "telemetry" not in session:
            session["telemetry"] = provider_telemetry(session.get("provider"), None, HOME)
        if "roeProfile" not in session:
            session["roeProfile"] = "unknown"
        cwd = session.get("cwd")
        if not cwd or session.get("kind") == "conversation":
            continue
        if cwd not in repositories and len(repositories) < 16:
            info = run(["git", "-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "HEAD"], timeout=0.5)
            lines = info.stdout.strip().splitlines()
            repositories[cwd] = {"repository": lines[0], "branch": lines[1], "headCommit": lines[2]} if info.returncode == 0 and len(lines) == 3 else {"repository": None, "branch": None, "headCommit": None}
        session.update(repositories.get(cwd, {}))
    return {"host": socket.gethostname(), "user": getpass.getuser(), "sessions": sessions}


def health():
    # Return counters; the desktop computes CPU utilization between samples.
    # Guest ticks are already included in user/nice, so exclude them from total.
    cpu = [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.strip().split()[0]) * 1024
    total = memory["MemTotal"]
    available = memory.get("MemAvailable", memory.get("MemFree", 0) + memory.get("Buffers", 0) + memory.get("Cached", 0))
    paths = [Path("/")]
    if HOME.stat().st_dev != Path("/").stat().st_dev:
        paths.append(HOME)
    disks = []
    for directory in paths:
        usage = shutil.disk_usage(directory)
        disks.append({"path": str(directory), "total": usage.total, "used": usage.used, "free": usage.free})
    return {"cpuTotal": sum(cpu), "cpuIdle": cpu[3] + cpu[4], "memoryTotal": total, "memoryUsed": max(0, total - available), "disks": disks, "sampledAt": time.time() * 1000}


def agent_command(provider, conversation_id=None, agent_id=None, preset=None, instructions="", roe_profile=None):
    command = [PROVIDERS[provider]] if not preset else shlex.split(preset.get("args", ""))
    # Custom command prefixes are evaluated by the user's login shell; arguments
    # and conversation IDs are always shell quoted separately by create().
    if provider == "claude" and agent_id:
        # Attach opens an already-running agent; its launch settings belong to
        # that process. No new agent is started by this command.
        return command + ["attach", agent_id]
    mode = roe_profile or ("provider-default" if preset and preset.get("fullPermissions") is False else "full")
    if mode == "full":
        command.append(PERMISSION_FLAGS[provider])
    elif mode == "gated":
        if provider == "codex":
            command += ["--sandbox", "read-only", "--ask-for-approval", "on-request"]
        elif provider == "claude":
            command += ["--permission-mode", "default"]
        else:
            raise ValueError("Provider does not support a verified gated mode")
    elif mode != "provider-default":
        raise ValueError("Invalid Rules of Engagement profile")
    if conversation_id:
        if provider == "codex":
            command += ["resume", conversation_id]
        elif provider == "claude":
            command += ["--resume", conversation_id]
        else:
            command += ["--conversation", conversation_id]
    if instructions:
        command += ["--", instructions]
    return command


def create(payload):
    provider = payload.get("provider")
    if provider not in SESSION_PROVIDERS:
        raise ValueError("Unsupported provider")
    is_terminal = provider == "terminal"
    if is_terminal and any(payload.get(key) for key in ("preset", "conversationId", "agentId", "instructions")):
        raise ValueError("Terminal sessions do not accept agent launch options")
    cwd = Path(payload.get("cwd") or str(HOME)).expanduser().resolve()
    if not cwd.is_dir():
        raise ValueError("The working directory does not exist")
    conversation_id = payload.get("conversationId")
    if conversation_id and not ID_RE.fullmatch(conversation_id):
        raise ValueError("Invalid conversation ID")
    agent_id = payload.get("agentId")
    if agent_id and not ID_RE.fullmatch(agent_id):
        raise ValueError("Invalid background agent ID")
    preset = payload.get("preset")
    roe_profile = payload.get("roeProfile")
    if not is_terminal and roe_profile not in (None, "full", "gated", "provider-default"):
        raise ValueError("Invalid Rules of Engagement profile")
    if roe_profile == "gated" and (provider == "antigravity" or (preset and (preset.get("command") != provider or any(flag in preset.get("args", "") for flag in ("--dangerously", "--sandbox", "--ask-for-approval", "--permission-mode", "--settings", "--allowedTools", "--allowed-tools", "--config", "--profile")) or re.search(r"(^|\s)-c(\s|=)", preset.get("args", ""))))):
        raise ValueError("Gated mode requires a supported, unmodified provider command")
    title = " ".join(str(payload.get("title") or "").split())[:100]
    if not title:
        title = f"{provider.title()} session"
    name = payload.get("managedName") or "hq-" + uuid.uuid4().hex[:12]
    if not TMUX_RE.fullmatch(name):
        raise ValueError("Invalid managed session name")
    if is_terminal:
        shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/bash"
        launch = shlex.join([shell, "-l", "-i"])
    else:
        command = agent_command(provider, conversation_id, agent_id, preset, payload.get("instructions", ""), roe_profile)
        extra = hook_arguments(provider, name, payload)
        # Put provider options before the resume subcommand and positional prompt.
        command = extra + command if preset else command[:1] + extra + command[1:]
        launch = ("builtin command " + provider + " " + shlex.join(command if preset else command[1:])) if roe_profile == "gated" else (preset["command"] + " " + shlex.join(command)) if preset else shlex.join(command)
        # bash -lic supports aliases/functions such as the user's claude3.
        launch = shlex.join(["bash", "-lic", launch])
    launch = ('tmux set-window-option -t "$TMUX_PANE" remain-on-exit on; '
              'tmux set-option -pu -t "$TMUX_PANE" @hq_process_exit; '
              f'if {launch}; then hq_exit=0; else hq_exit=$?; fi; '
              'tmux set-option -p -t "$TMUX_PANE" @hq_process_exit "$$:$hq_exit" || :; '
              'exit "$hq_exit"')
    # Set the session history limit before creating the actual chat pane. tmux
    # applies this limit to new panes; changing it after launch is too late.
    launched = run(["tmux", "new-session", "-d", "-s", name, "-n", "setup", "-c", str(cwd)], timeout=10)
    if launched.returncode != 0:
        if (HOOK_ROOT / name).exists():
            shutil.rmtree(HOOK_ROOT / name)
        raise RuntimeError(launched.stderr.strip() or "Could not start tmux session")
    try:
        for key, value in (("provider", provider), ("title", title), ("cwd", str(cwd)), ("preset", preset.get("name", "") if preset else ""), ("preset_id", preset.get("id", "") if preset else ""), ("worktree", payload.get("worktreeOperation") or ""), ("roe", "unknown" if agent_id else roe_profile or ("provider-default" if preset and preset.get("fullPermissions") is False else "full"))):
            checked(["tmux", "set-option", "-t", name, f"@hq_{key}", value])
        configure_session({"name": name})
        checked(["tmux", "set-window-option", "-t", name, "remain-on-exit", "on"])
        checked(["tmux", "new-window", "-t", name, "-n", "terminal" if is_terminal else "chat", "-c", str(cwd), launch])
        checked(["tmux", "kill-window", "-t", f"{name}:setup"])
    except Exception:
        run(["tmux", "kill-session", "-t", name], timeout=3)
        if (HOOK_ROOT / name).exists():
            shutil.rmtree(HOOK_ROOT / name)
        raise
    return {"name": name}


def checked(args):
    result = run(args, timeout=5)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "tmux action failed")
    return result.stdout.strip()


def configure_session(payload):
    name = payload.get("name", "")
    if not TMUX_RE.fullmatch(name) or tmux_option(name, "@hq_provider") not in SESSION_PROVIDERS:
        raise ValueError("This is not an AgentC2 session")
    # Scrolling uses a control client, so normal terminal text selection remains
    # available even on Windows where SSH console mouse events are unreliable.
    checked(["tmux", "set-option", "-t", name, "mouse", "off"])
    checked(["tmux", "set-option", "-t", name, "history-limit", "50000"])
    return {"name": name}


def scroll_session(payload):
    name = payload.get("name", "")
    direction = payload.get("direction")
    if not SESSION_RE.fullmatch(name) or direction not in ("up", "down", "latest"):
        raise ValueError("Invalid history request")
    count = max(1, min(int(payload.get("lines", 15)), 300))
    state = checked(["tmux", "display-message", "-p", "-t", name,
                     "#{pane_id}|#{pane_in_mode}|#{alternate_on}|#{@hq_provider}|#{pane_height}"])
    pane, mode, alternate, provider, height = state.split("|")
    in_mode = mode == "1"
    if alternate == "1":
        if in_mode:
            checked(["tmux", "send-keys", "-t", pane, "-X", "cancel"])
        if direction == "latest":
            if provider in ("codex", "claude"):
                checked(["tmux", "send-keys", "-t", pane, "C-End"])
        else:
            pages = max(1, (count + max(1, int(height) - 2) - 1) // max(1, int(height) - 2))
            checked(["tmux", "send-keys", "-t", pane, "-N", str(pages),
                     "PPage" if direction == "up" else "NPage"])
        return {"name": name, "historyActive": False}
    if direction == "latest":
        if in_mode:
            checked(["tmux", "send-keys", "-t", pane, "-X", "cancel"])
    elif in_mode or direction == "up":
        if not in_mode:
            checked(["tmux", "copy-mode", "-e", "-t", pane])
        checked(["tmux", "send-keys", "-t", pane, "-X", "-N", str(count), "scroll-" + direction])
    return {"name": name, "historyActive": direction != "latest" and (in_mode or direction == "up")}


def history(payload):
    name = payload.get("name", "")
    if not SESSION_RE.fullmatch(name):
        raise ValueError("Invalid session name")
    output = checked(["tmux", "capture-pane", "-p", "-J", "-t", name, "-S", "-50000"])
    return {"text": output[-4000000:], "truncated": len(output) > 4000000}


def managed_action(payload, action):
    name = payload.get("name", "")
    if not TMUX_RE.fullmatch(name) or tmux_option(name, "@hq_provider") not in SESSION_PROVIDERS:
        raise ValueError("This action is only available for AgentC2 sessions")
    args = ["tmux", "send-keys", "-t", name, "C-c"] if action == "interrupt" else [
        "tmux", "kill-session", "-t", name
    ]
    result = run(args, timeout=5)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"Could not {action} session")
    if action == "stop" and (HOOK_ROOT / name).exists():
        shutil.rmtree(HOOK_ROOT / name)
    return {"name": name, "action": action}


def main():
    encoded = sys.argv[1] if len(sys.argv) > 1 else globals().get("AGENTC2_PAYLOAD_B64")
    if not encoded:
        raise ValueError("Missing remote request")
    payload = json.loads(base64.b64decode(encoded).decode("utf-8"))
    action = payload.get("action")
    if action == "inventory":
        result = inventory()
    elif action == "health":
        result = health()
    elif action == "create":
        with cleanup_lock():
            result = create(payload)
    elif action == "worktree_list":
        result = worktree_list(payload)
    elif action == "worktree_launch":
        with cleanup_lock():
            result = worktree_launch(payload)
    elif action == "worktree_archive":
        with cleanup_lock():
            result = worktree_archive(payload)
    elif action == "oporder_preview":
        result = oporder_preview(payload)
    elif action == "oporder_sync":
        with cleanup_lock():
            result = oporder_sync(payload)
    elif action == "sitrep_source_preview":
        result = sitrep_source_preview(payload)
    elif action == "sitrep_target_preview":
        result = sitrep_target_preview(payload)
    elif action == "exercise_base":
        result = exercise_base(payload)
    elif action == "exercise_capabilities":
        result = exercise_capabilities(payload)
    elif action == "exercise_inspect":
        result = exercise_inspect(payload)
    elif action == "exercise_target_preview":
        result = exercise_target(payload)
    elif action == "exercise_promote":
        with cleanup_lock():
            result = exercise_target(payload, True)
    elif action == "flash_list":
        result = flash_list(payload)
    elif action == "flash_decide":
        result = flash_decide(payload)
    elif action == "diff_files":
        result = diff_files(payload)
    elif action == "diff_detail":
        result = diff_detail(payload)
    elif action == "diff_hunk":
        with cleanup_lock():
            result = diff_hunk_action(payload)
    elif action == "cleanup_preview":
        result = cleanup_preview(payload)
    elif action == "cleanup_delete":
        result = cleanup_delete(payload)
    elif action == "configure":
        result = configure_session(payload)
    elif action == "scroll":
        result = scroll_session(payload)
    elif action == "history":
        result = history(payload)
    elif action == "preview":
        name = payload.get("name", "")
        if not SESSION_RE.fullmatch(name):
            raise ValueError("Invalid session name")
        captured = run(["tmux", "capture-pane", "-p", "-J", "-t", name], timeout=3)
        if captured.returncode != 0:
            raise ValueError("Terminal preview is unavailable")
        result = {"text": "\n".join(captured.stdout.splitlines()[-30:])[:16000]}
    elif action in ("interrupt", "stop"):
        result = managed_action(payload, action)
    else:
        raise ValueError("Unknown action")
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
