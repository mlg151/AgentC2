"""Owned, restart-recoverable Git worktrees for isolated tasks."""

import hashlib
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import fcntl

WORKTREE_ROOT = (Path.home() / ".cache" / "agent-hq" / "worktrees").resolve()
WORKTREE_ID = re.compile(r"^[a-f0-9]{32}$")
WORKTREE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
SITREP_PATCH_LIMIT = 512_000


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
    head = worktree_git("-C", str(path), "rev-parse", "HEAD", timeout=10).strip()
    return {"exists": True, "active": active, "owned": True, "dirty": dirty, "merged": merged, "headCommit": head}


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
    require_tmux(payload)
    operation_id = payload.get("operationId")
    worktree_file(operation_id)  # Validate before deriving the lock pathname.
    locks = WORKTREE_ROOT / "locks"
    locks.mkdir(parents=True, mode=0o700, exist_ok=True)
    if locks.is_symlink():
        raise ValueError("Worktree lock directory is unsafe")
    descriptor = os.open(locks / (operation_id + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return worktree_launch_locked(payload)
    finally:
        os.close(descriptor)


def worktree_launch_locked(payload):
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
    sitrep = payload.get("sitrep")
    patch = b""
    if sitrep is not None:
        if not isinstance(sitrep, dict) or not re.fullmatch(r"[a-f0-9]{64}", sitrep.get("digest") or ""):
            raise ValueError("Invalid SitRep transfer")
        try:
            patch = base64.b64decode(sitrep.get("patchBase64") or "", validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("Invalid SitRep patch") from error
        if len(patch) > SITREP_PATCH_LIMIT or hashlib.sha256(patch).hexdigest() != sitrep["digest"] or b"GIT binary patch" in patch or b"Binary files " in patch:
            raise ValueError("SitRep patch is too large, binary, or changed")
    request = {key: payload.get(key) for key in ("provider", "title", "preset", "instructions")}
    # Existing terminal operations predate the transport field. Keep their
    # fingerprint stable, while preventing a chat retry from changing modes.
    if payload.get("transport") == "chat":
        request["transport"] = "chat"
        if payload.get("model"):
            request["model"] = payload["model"]
    if sitrep:
        request["sitrepDigest"] = sitrep["digest"]
    request.update({"repository": str(root), "baseRef": base_ref, "branch": branch, "path": str(path), "name": name})
    digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    record = worktree_load(operation_id)
    expected_revision = payload.get("expectedWorktreeRevision")
    if expected_revision == "absent":
        if record:
            raise ValueError("Worktree appeared after admission; inspect and review again")
    elif expected_revision is not None:
        if not isinstance(expected_revision, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_revision) or not record:
            raise ValueError("Invalid worktree recovery revision")
        status = worktree_state(record)
        snapshot = {**record, "status": status}
        revision = hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if record.get("state") not in ("ready", "provisioning") or not status["owned"] or status["active"] or status["dirty"] is not False or revision != expected_revision:
            raise ValueError("Worktree recovery revision changed; review again")
    recovery = payload.get("recoverSitrep") is True and record and record.get("sitrepSource") and record.get("state") == "ready" and not sitrep
    if record:
        if (record.get("requestDigest") != digest and not recovery) or record.get("path") != str(path) or record.get("branch") != branch or record.get("name") != name or record["state"] == "archived":
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
        record = {"operationId": operation_id, "requestDigest": digest, "repository": str(root), "baseRef": base_ref, "baseCommit": commit, "branch": branch, "path": str(path), "name": name, "provider": payload["provider"], "transport": payload.get("transport") or "terminal", "slug": slug, "title": payload.get("title") or "", "presetName": (payload.get("preset") or {}).get("name") or "", "hasInstructions": bool(payload.get("instructions")), "state": "provisioning", "sitrepSource": sitrep.get("source") if sitrep else None}
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
    if record.get("sitrepSource") and record.get("state") == "ready" and not sitrep:
        if status["active"] or not re.fullmatch(r"[a-f0-9]{64}", record.get("sitrepApplied") or ""):
            raise ValueError("SitRep recipient is active or its transfer is incomplete")
        transferred = subprocess.run(["git", "-C", str(path), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", record["baseCommit"]], capture_output=True, timeout=15)
        untracked = subprocess.run(["git", "-C", str(path), "ls-files", "--others", "--exclude-standard", "-z"], capture_output=True, timeout=10)
        if transferred.returncode or untracked.returncode or untracked.stdout or hashlib.sha256(transferred.stdout).hexdigest() != record["sitrepApplied"]:
            raise ValueError("SitRep worktree changed after transfer; inspect before recovery")
    if recovery:
        record.update({"requestDigest": digest, "provider": payload["provider"], "title": payload.get("title") or "", "presetName": (payload.get("preset") or {}).get("name") or "", "hasInstructions": bool(payload.get("instructions"))})
        worktree_save(record)
    if status["active"]:
        if tmux_option(name, "@hq_worktree") != operation_id or tmux_option(name, "@hq_cwd") != str(path):
            raise ValueError("Tmux name belongs to a different session; inspect before retrying")
        record["state"] = "launched"
        worktree_save(record)
        return {"name": name, "worktree": record}
    if sitrep and record.get("sitrepApplied") != sitrep["digest"]:
        if patch:
            if status["dirty"]:
                reverse = subprocess.run(["git", "-C", str(path), "apply", "--index", "--reverse", "--check", "-"], input=patch, capture_output=True, timeout=15)
                if reverse.returncode:
                    raise ValueError("Target worktree changed during SitRep transfer; inspect before retrying")
            else:
                check = subprocess.run(["git", "-C", str(path), "apply", "--index", "--check", "-"], input=patch, capture_output=True, timeout=15)
                if check.returncode:
                    raise ValueError("SitRep patch does not apply to the target worktree")
                applied = subprocess.run(["git", "-C", str(path), "apply", "--index", "-"], input=patch, capture_output=True, timeout=15)
                if applied.returncode:
                    raise ValueError("SitRep patch failed; inspect the target worktree before retrying")
        record["sitrepApplied"] = sitrep["digest"]
        worktree_save(record)
    if sitrep and patch:
        transferred = subprocess.run(["git", "-C", str(path), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", record["baseCommit"]], capture_output=True, timeout=15)
        if transferred.returncode or transferred.stdout != patch:
            raise ValueError("Target worktree no longer matches the reviewed SitRep patch; inspect before launching")
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
    if payload.get("expectedHeadCommit") is not None and status.get("headCommit") != payload["expectedHeadCommit"]:
        raise ValueError("Reviewed worktree HEAD changed before archive")
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
