"""Verified, one-shot Claude permission-hook decisions for managed units."""

import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time

FLASH_ID = re.compile(r"^[a-f0-9]{32}$")


def flash_path(name, request_id):
    if not isinstance(name, str) or not TMUX_RE.fullmatch(name) or not isinstance(request_id, str) or not FLASH_ID.fullmatch(request_id):
        raise ValueError("Invalid Flash Traffic request")
    directory = HOOK_ROOT / name / "flash"
    if (directory.is_symlink() or directory.parent.is_symlink() or not directory.is_dir()
            or directory.stat().st_uid != os.getuid() or directory.parent.stat().st_uid != os.getuid()):
        raise ValueError("Permission hook is unavailable")
    return directory / (request_id + ".json")


def flash_open(name, request_id):
    path = flash_path(name, request_id)
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(descriptor)
        raise ValueError("Unsafe permission request")
    stream = os.fdopen(descriptor, "r+", encoding="utf-8")
    try:
        fcntl.flock(stream, fcntl.LOCK_EX)
        value = json.load(stream)
        if value.get("id") != request_id or value.get("name") != name or value.get("provider") != "claude" or value.get("version") != 1:
            raise ValueError("Permission request identity changed")
        return stream, value
    except Exception:
        stream.close()
        raise


def flash_alive(value):
    pid = value.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def flash_unit(name):
    return (run(["tmux", "has-session", "-t", name], timeout=3).returncode == 0
            and tmux_option(name, "@hq_provider") == "claude"
            and (HOOK_ROOT / name / "hook.py").is_file())


def flash_save(stream, value):
    stream.seek(0)
    stream.truncate()
    json.dump(value, stream, ensure_ascii=False)
    stream.flush()
    os.fsync(stream.fileno())


def flash_status(value, name):
    expiry = value.get("expiresAt")
    if value.get("state") in ("pending", "submitted") and (not isinstance(expiry, (int, float)) or time.time() >= expiry or not flash_alive(value) or not flash_unit(name)):
        value["state"] = "expired"
    return value


def flash_list(_payload):
    if not HOOK_ROOT.exists():
        return []
    result = []
    branches = {}
    for directory in sorted(HOOK_ROOT.iterdir()):
        name = directory.name
        if not TMUX_RE.fullmatch(name) or not (directory / "flash").is_dir():
            continue
        for path in sorted((directory / "flash").glob("*.json"), reverse=True)[:100]:
            if not FLASH_ID.fullmatch(path.stem):
                continue
            try:
                if path.stat().st_mtime < time.time() - 86400:
                    continue
                stream, value = flash_open(name, path.stem)
                with stream:
                    before = value.get("state")
                    flash_status(value, name)
                    if value.get("state") != before:
                        flash_save(stream, value)
                if not isinstance(value.get("action"), str) or len(value["action"]) > 4000:
                    continue
                if name not in branches:
                    cwd = tmux_option(name, "@hq_cwd") if flash_unit(name) else ""
                    branch = run(["git", "-C", cwd, "branch", "--show-current"], timeout=1) if cwd else None
                    branches[name] = branch.stdout.strip()[:200] if branch and branch.returncode == 0 else ""
                item = {key: value.get(key) for key in ("id", "name", "provider", "tool", "action", "session", "turn", "createdAt", "expiresAt", "state", "decision", "resolvedAt")}
                item["branch"] = branches[name]
                result.append(item)
            except (OSError, ValueError, KeyError, TypeError):
                continue
    return sorted(result, key=lambda item: item.get("createdAt") or 0, reverse=True)[:200]


def flash_decide(payload):
    name = payload.get("name")
    request_id = payload.get("id")
    decision = payload.get("decision")
    if decision not in ("allow", "deny"):
        raise ValueError("Invalid permission decision")
    stream, value = flash_open(name, request_id)
    with stream:
        previous = value.get("state")
        flash_status(value, name)
        if value.get("state") != previous:
            flash_save(stream, value)
        if value.get("decision") is not None:
            if value["decision"] == decision:
                return {"id": request_id, "state": value["state"], "decision": decision, "duplicate": True}
            raise ValueError("Permission request already has a different decision")
        if value.get("state") != "pending" or not flash_unit(name):
            raise ValueError("Permission request expired or is no longer live")
        value["decision"] = decision
        value["state"] = "submitted"
        value["submittedAt"] = time.time()
        flash_save(stream, value)
        return {"id": request_id, "state": "submitted", "decision": decision, "duplicate": False}
