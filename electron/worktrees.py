"""Owned, restart-recoverable Git worktrees for isolated tasks."""

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

WORKTREE_ROOT = (Path.home() / ".cache" / "agent-hq" / "worktrees").resolve()
WORKTREE_ID = re.compile(r"^[a-f0-9]{32}$")
WORKTREE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


def worktree_file(operation_id):
    if not isinstance(operation_id, str) or not WORKTREE_ID.fullmatch(operation_id):
        raise ValueError("Invalid worktree operation ID")
    return WORKTREE_ROOT / "records" / (operation_id + ".json")


def worktree_save(record):
    path = worktree_file(record["operationId"])
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    path.parent.chmod(0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(record, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def worktree_load(operation_id):
    path = worktree_file(operation_id)
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError("Worktree ownership record is unsafe")
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("operationId") != operation_id:
        raise ValueError("Worktree ownership record changed")
    return record


def worktree_git(*args, timeout=15):
    result = run(["git", *args], timeout=timeout)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout).strip()[:500] or "Git operation failed")
    return result.stdout.strip()


def worktree_state(record, detailed=True):
    path = Path(record["path"])
    active = run(["tmux", "has-session", "-t", record["name"]], timeout=3).returncode == 0
    token = hashlib.sha256(record["operationId"].encode()).hexdigest()
    expected = WORKTREE_ROOT / "paths" / hashlib.sha256(record["repository"].encode()).hexdigest()[:16] / record["operationId"]
    if path != expected or record["name"] != "hq-" + token[:12] or not record["branch"].endswith("-" + token[:16]):
        return {"exists": path.exists(), "active": active, "owned": False, "dirty": None, "merged": None}
    if not path.exists():
        return {"exists": False, "active": active, "owned": False, "dirty": None, "merged": None}
    listed = worktree_git("-C", record["repository"], "worktree", "list", "--porcelain", timeout=10)
    owned = any(f"worktree {path}" in entry.splitlines() and f"branch refs/heads/{record['branch']}" in entry.splitlines() for entry in listed.split("\n\n"))
    if not owned or path.is_symlink() or path.resolve() != path:
        return {"exists": True, "active": active, "owned": False, "dirty": None, "merged": None}
    if not detailed:
        return {"exists": True, "active": active, "owned": True, "dirty": None, "merged": None}
    dirty = bool(worktree_git("-C", str(path), "status", "--porcelain=v1", "--untracked-files=all", timeout=10))
    merged = run(["git", "-C", record["repository"], "merge-base", "--is-ancestor", record["branch"], record["baseRef"]], timeout=10).returncode == 0
    return {"exists": True, "active": active, "owned": True, "dirty": dirty, "merged": merged}


def worktree_list(_payload=None):
    directory = WORKTREE_ROOT / "records"
    if not directory.exists():
        return []
    result = []
    for path in sorted(directory.glob("*.json"))[:200]:
        if not WORKTREE_ID.fullmatch(path.stem):
            continue
        try:
            record = worktree_load(path.stem)
            result.append({**record, "status": worktree_state(record)})
        except (OSError, ValueError, KeyError):
            result.append({"operationId": path.stem, "state": "unreadable", "status": {"owned": False}})
    return result


def worktree_launch(payload):
    operation_id = payload.get("operationId")
    worktree_file(operation_id)
    slug = payload.get("slug")
    if not isinstance(slug, str) or not WORKTREE_SLUG.fullmatch(slug):
        raise ValueError("Use a lowercase task slug with letters, digits, and hyphens")
    if payload.get("conversationId") or payload.get("agentId") or payload.get("provider") not in PROVIDERS:
        raise ValueError("Isolated tasks require a new agent")
    source = payload.get("repository")
    base_ref = payload.get("baseRef") or "HEAD"
    if not isinstance(source, str) or not source or not isinstance(base_ref, str) or not base_ref or len(base_ref) > 200 or base_ref.startswith("-"):
        raise ValueError("Invalid repository or base ref")
    repository = Path(source).expanduser().resolve(strict=True)
    root = Path(worktree_git("-C", str(repository), "rev-parse", "--show-toplevel")).resolve(strict=True)
    if worktree_git("-C", str(root), "rev-parse", "--is-bare-repository") != "false":
        raise ValueError("Choose a non-bare repository")
    primary = worktree_git("-C", str(root), "worktree", "list", "--porcelain").splitlines()[0]
    if not primary.startswith("worktree ") or Path(primary[9:]).resolve() != root:
        raise ValueError("Choose the primary repository checkout as the task base")
    token = hashlib.sha256(operation_id.encode()).hexdigest()
    branch = f"agentc2/{slug}-{token[:16]}"
    path = WORKTREE_ROOT / "paths" / hashlib.sha256(str(root).encode()).hexdigest()[:16] / operation_id
    name = "hq-" + token[:12]
    request = {key: payload.get(key) for key in ("provider", "title", "preset", "instructions")}
    request.update({"repository": str(root), "baseRef": base_ref, "branch": branch, "path": str(path), "name": name})
    digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    record = worktree_load(operation_id)
    if record:
        if record.get("requestDigest") != digest or record.get("path") != str(path) or record.get("branch") != branch or record.get("name") != name or record["state"] == "archived":
            raise ValueError("Operation ID belongs to another or archived task")
        if record["state"] == "launched":
            status = worktree_state(record)
            if status["owned"] and status["active"] and tmux_option(name, "@hq_worktree") == operation_id and tmux_option(name, "@hq_cwd") == str(path):
                return {"name": name, "worktree": record}
            raise ValueError("Task already launched; inspect its saved session instead of relaunching")
    else:
        commit = worktree_git("-C", str(root), "rev-parse", "--verify", "--end-of-options", f"{base_ref}^{{commit}}")
        if not re.fullmatch(r"[a-f0-9]{40,64}", commit):
            raise ValueError("Base ref did not resolve to a commit")
        if path.exists() or run(["git", "-C", str(root), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], timeout=5).returncode == 0:
            raise ValueError("Worktree path or branch already exists; no unowned files were changed")
        record = {"operationId": operation_id, "requestDigest": digest, "repository": str(root), "baseRef": base_ref, "baseCommit": commit, "branch": branch, "path": str(path), "name": name, "provider": payload["provider"], "slug": slug, "title": payload.get("title") or "", "presetName": (payload.get("preset") or {}).get("name") or "", "hasInstructions": bool(payload.get("instructions")), "state": "provisioning"}
        worktree_save(record)
    status = worktree_state(record)
    if not status["exists"]:
        if record["state"] != "provisioning":
            raise ValueError("Owned worktree is missing; inspect before retrying")
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        existing = run(["git", "-C", str(root), "rev-parse", "--verify", f"refs/heads/{branch}"], timeout=5)
        if existing.returncode == 0:
            if existing.stdout.strip() != record["baseCommit"]:
                raise ValueError("Existing task branch changed; inspect before retrying")
            # Git may have created the branch before SSH dropped. Reuse only
            # the exact recorded commit; Git itself rejects a checked-out branch.
            worktree_git("-C", str(root), "worktree", "add", str(path), branch, timeout=30)
        else:
            worktree_git("-C", str(root), "worktree", "add", "--no-track", "-b", branch, str(path), record["baseCommit"], timeout=30)
        status = worktree_state(record)
    if not status["owned"]:
        raise ValueError("Worktree ownership cannot be verified; inspect before retrying")
    if status["active"]:
        if tmux_option(name, "@hq_worktree") != operation_id or tmux_option(name, "@hq_cwd") != str(path):
            raise ValueError("Tmux name belongs to a different session; inspect before retrying")
        record["state"] = "launched"
        worktree_save(record)
        return {"name": name, "worktree": record}
    record["state"] = "ready"
    worktree_save(record)
    created = create({**payload, "cwd": str(path), "managedName": name, "worktreeOperation": operation_id})
    record["state"] = "launched"
    worktree_save(record)
    return {**created, "worktree": record}


def worktree_archive(payload):
    record = worktree_load(payload.get("operationId"))
    if not record or record["state"] == "archived":
        raise ValueError("Owned worktree is unavailable")
    expected = WORKTREE_ROOT / "paths" / hashlib.sha256(record["repository"].encode()).hexdigest()[:16] / record["operationId"]
    if Path(record["path"]) != expected:
        raise ValueError("Worktree ownership path changed")
    status = worktree_state(record)
    if not status["exists"] and not status["active"]:
        record["state"] = "archived"
        worktree_save(record)
        return record
    if not status["owned"] or status["active"] or status["dirty"] or not status["merged"]:
        raise ValueError("Worktree must be owned, inactive, clean, and merged before archive")
    worktree_git("-C", record["repository"], "worktree", "remove", record["path"], timeout=30)
    record["state"] = "archived"
    worktree_save(record)
    return record
