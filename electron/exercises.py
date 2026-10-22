"""Review and promote results from owned Joint Exercise worktrees."""

import hashlib
from pathlib import Path
import re
import shutil
import subprocess

EXERCISE_COMMIT = re.compile(r"^[a-f0-9]{40,64}$")


def exercise_capabilities(_payload):
    return {"codex": bool(shutil.which("codex")), "claude": bool(shutil.which("claude")), "antigravity": bool(shutil.which("agy")), "opencode": bool(shutil.which("opencode"))}


def exercise_base(payload):
    source = payload.get("repository")
    ref = payload.get("baseRef") or "HEAD"
    if not isinstance(source, str) or not source or not isinstance(ref, str) or not ref or len(ref) > 200 or ref.startswith("-"):
        raise ValueError("Choose a repository and base ref")
    root = Path(source).expanduser().resolve(strict=True)
    top = Path(worktree_git("-C", str(root), "rev-parse", "--show-toplevel")).resolve(strict=True)
    first = worktree_git("-C", str(top), "worktree", "list", "--porcelain").splitlines()[0]
    if first != "worktree " + str(top) or root != top:
        raise ValueError("Choose the primary repository checkout")
    commit = worktree_git("-C", str(root), "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")
    if not EXERCISE_COMMIT.fullmatch(commit):
        raise ValueError("Base ref did not resolve to a commit")
    return {"repository": str(root), "baseCommit": commit}


def exercise_record(payload):
    record = worktree_load(payload.get("operationId"))
    if not record or record.get("state") != "launched" or record.get("baseCommit") != payload.get("baseCommit"):
        raise ValueError("Contestant is not an owned launched worktree at this base")
    status = worktree_state(record, False)
    if not status["owned"]:
        raise ValueError("Contestant worktree ownership changed")
    return record, status


def exercise_snapshot(payload):
    record, status = exercise_record(payload)
    root = Path(record["path"])
    base = record["baseCommit"]
    head = sitrep_git(root, ["rev-parse", "HEAD"]).decode().strip()
    untracked = [value.decode("utf-8", "backslashreplace") for value in diff_git(record, ["ls-files", "--others", "--exclude-standard", "-z"]).split(b"\0") if value]
    warnings = []
    try:
        patch = diff_git(record, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", base])
    except ValueError as error:
        if "display limit" not in str(error):
            raise
        warnings.append("Patch exceeds 512 KB")
        patch = b""
    if untracked:
        warnings.append("Untracked files are omitted; add them to Git before promotion")
    if b"GIT binary patch" in patch or b"Binary files " in patch:
        warnings.append("Binary changes cannot be promoted here")
    if b"version https://git-lfs.github.com/spec/v1" in patch:
        warnings.append("Git LFS pointers require separate object transfer")
    revision = hashlib.sha256(base.encode() + b"\0" + head.encode() + b"\0" + patch + b"\0" + b"\0".join(name.encode() for name in untracked)).hexdigest()
    return record, status, {"revision": revision, "headCommit": head, "patch": patch, "untracked": untracked, "warnings": warnings}


def exercise_inspect(payload):
    record, status, snap = exercise_snapshot(payload)
    test = None
    command = payload.get("testCommand") or ""
    if command:
        if status["active"] and not payload.get("markedComplete"):
            raise ValueError("Mark this active contestant complete before running verification")
        test = sitrep_test(Path(record["path"]), command)
        _, _, after = exercise_snapshot(payload)
        if after["revision"] != snap["revision"]:
            raise ValueError("Verification changed the contestant; inspect again before comparing")
    return {"operationId": record["operationId"], "baseCommit": record["baseCommit"], "branch": record["branch"], "path": record["path"], "active": status["active"], "headCommit": snap["headCommit"], "revision": snap["revision"], "patchBytes": len(snap["patch"]), "patch": snap["patch"].decode("utf-8", "replace")[:16000], "patchTruncated": len(snap["patch"]) > 16000, "untracked": snap["untracked"][:100], "warnings": snap["warnings"], "test": test}


def exercise_target(payload, apply=False):
    record, _, snap = exercise_snapshot(payload)
    if snap["revision"] != payload.get("revision") or snap["warnings"]:
        raise ValueError("Winner changed or has omitted content; review again")
    target = Path(payload.get("target") or "").expanduser().resolve(strict=True)
    top = Path(worktree_git("-C", str(target), "rev-parse", "--show-toplevel")).resolve(strict=True)
    if target != top or target != Path(record["repository"]):
        raise ValueError("Promotion target must be this exercise's primary checkout")
    head = worktree_git("-C", str(target), "rev-parse", "HEAD")
    if head != record["baseCommit"]:
        raise ValueError("Target HEAD differs from the reviewed base commit")
    branch = worktree_git("-C", str(target), "symbolic-ref", "--short", "HEAD")
    if not snap["patch"]:
        raise ValueError("Winner has no tracked changes to promote")
    if worktree_git("-C", str(target), "status", "--porcelain=v1", "--untracked-files=all"):
        # A dropped SSH response after a successful apply can be retried only
        # when both the target index and worktree still match this exact patch.
        staged = sitrep_git(target, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", head])
        unstaged = sitrep_git(target, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index"])
        untracked = sitrep_git(target, ["ls-files", "--others", "--exclude-standard", "-z"])
        if staged == snap["patch"] and not unstaged and not untracked:
            return {"target": str(target), "branch": branch, "headCommit": head, "revision": snap["revision"], "patchBytes": len(snap["patch"]), "paths": len(re.findall(rb"(?m)^diff --git ", snap["patch"])), "ready": True, "applied": True, "alreadyApplied": True}
        raise ValueError("Promotion target is dirty; commit or clear it first")
    check = subprocess.run(["git", "-C", str(target), "apply", "--index", "--check", "-"], input=snap["patch"], capture_output=True, timeout=15)
    if check.returncode:
        raise ValueError("Patch conflicts with target: " + check.stderr.decode("utf-8", "replace")[:400])
    result = {"target": str(target), "branch": branch, "headCommit": head, "revision": snap["revision"], "patchBytes": len(snap["patch"]), "paths": len(re.findall(rb"(?m)^diff --git ", snap["patch"])), "ready": True}
    if apply:
        applied = subprocess.run(["git", "-C", str(target), "apply", "--index", "-"], input=snap["patch"], capture_output=True, timeout=15)
        if applied.returncode:
            raise ValueError("Promotion failed; inspect target: " + applied.stderr.decode("utf-8", "replace")[:400])
        result["applied"] = True
    return result
