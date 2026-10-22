"""Reviewed source evidence and target-base checks for worktree handoffs."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import time

SITREP_PATCH_LIMIT = 512_000
SITREP_OUTPUT_LIMIT = 8_000


def sitrep_git(directory, arguments, data=None, timeout=15, env=None):
    result = subprocess.run(["git", "-C", str(directory), *arguments], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env, check=False)
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", "replace")[:500] or "Git command failed")
    return result.stdout


def sitrep_test(directory, command):
    if not command:
        return None
    if not isinstance(command, str) or len(command) > 500 or "\0" in command:
        raise ValueError("Test command must be at most 500 characters")
    started = time.monotonic()
    ran_at = int(time.time() * 1000)
    process = subprocess.Popen(["/bin/bash", "-lc", command], cwd=directory, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    overflow = False
    timed_out = False
    with selectors.DefaultSelector() as reader:
        reader.register(process.stdout, selectors.EVENT_READ)
        try:
            while reader.get_map():
                remaining = 25 - (time.monotonic() - started)
                if remaining <= 0:
                    timed_out = True
                    break
                for event, _ in reader.select(remaining):
                    chunk = os.read(event.fd, 65536)
                    if not chunk:
                        reader.unregister(event.fileobj)
                        continue
                    output.extend(chunk)
                    if len(output) > SITREP_OUTPUT_LIMIT:
                        del output[:-SITREP_OUTPUT_LIMIT]
                        overflow = True
            if not timed_out:
                process.wait(timeout=2)
        finally:
            if timed_out or process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
            process.stdout.close()
    return {"command": command, "exitCode": None if timed_out else process.returncode,
            "timedOut": timed_out, "output": output.decode("utf-8", "replace"),
            "outputTruncated": overflow, "durationMs": int((time.monotonic() - started) * 1000), "ranAt": ran_at}


def sitrep_source_preview(payload):
    record = diff_unit(payload)
    root = Path(record["path"])
    base = record["baseCommit"]
    if not re.fullmatch(r"[a-f0-9]{40,64}", base):
        raise ValueError("Source worktree has no verified base commit")
    head = sitrep_git(root, ["rev-parse", "HEAD"]).decode().strip()
    untracked = diff_git(record, ["ls-files", "--others", "--exclude-standard", "-z"], limit=SITREP_PATCH_LIMIT).split(b"\0")
    untracked = [name.decode("utf-8", "backslashreplace") for name in untracked if name]
    warnings = []
    patch = b""
    try:
        patch = diff_git(record, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", base], limit=SITREP_PATCH_LIMIT)
    except ValueError as error:
        if "display limit" not in str(error):
            raise
        warnings.append("Patch exceeds 512 KB; reduce the source changes before transfer")
    if untracked:
        warnings.append("Untracked files are not included; add them to Git before transfer")
    if b"GIT binary patch" in patch or b"Binary files " in patch:
        warnings.append("Binary changes require a separate transfer; this SitRep cannot apply them")
    if b"version https://git-lfs.github.com/spec/v1" in patch:
        warnings.append("Git LFS pointer changes need separate object transfer and cannot be sent by this SitRep")
    test = sitrep_test(root, payload.get("testCommand"))
    if test:
        after_head = sitrep_git(root, ["rev-parse", "HEAD"]).decode().strip()
        after_untracked = [name.decode("utf-8", "backslashreplace") for name in diff_git(record, ["ls-files", "--others", "--exclude-standard", "-z"], limit=SITREP_PATCH_LIMIT).split(b"\0") if name]
        try:
            after_patch = diff_git(record, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", base], limit=SITREP_PATCH_LIMIT)
        except ValueError:
            after_patch = None
        if after_head != head or after_untracked != untracked or after_patch != patch:
            warnings.append("The test command changed the source; review the new diff and run preview again")
    revision = hashlib.sha256(json.dumps({"operationId": record["operationId"], "name": record["name"],
                                        "base": base, "head": head, "patch": hashlib.sha256(patch).hexdigest(),
                                        "untracked": untracked}, sort_keys=True).encode()).hexdigest()
    return {"version": 1, "source": {"operationId": record["operationId"], "name": record["name"], "repository": record["repository"],
                       "branch": record["branch"], "baseCommit": base, "headCommit": head, "path": record["path"]},
            "revision": revision, "patchBase64": base64.b64encode(patch).decode(),
            "patchPreview": patch[:12000].decode("utf-8", "replace"), "patchPreviewTruncated": len(patch) > 12000, "patchBytes": len(patch),
            "untracked": untracked[:100], "warnings": warnings, "test": test}


def sitrep_target_preview(payload):
    source = payload.get("source") or {}
    repository = payload.get("repository")
    base = source.get("baseCommit")
    if not isinstance(repository, str) or not repository.startswith("/") or len(repository) > 4096 or not re.fullmatch(r"[a-f0-9]{40,64}", base or ""):
        raise ValueError("Invalid SitRep target repository or base")
    root = Path(repository)
    if root.is_symlink() or not root.is_dir() or root.resolve() != root:
        raise ValueError("Target must be a real primary Git checkout")
    top = sitrep_git(root, ["rev-parse", "--show-toplevel"]).decode().strip()
    primary = sitrep_git(root, ["worktree", "list", "--porcelain"]).decode().splitlines()[0]
    if top != str(root) or primary != "worktree " + str(root):
        raise ValueError("Target must be the primary checkout root")
    result = subprocess.run(["git", "-C", str(root), "cat-file", "-e", f"{base}^{{commit}}"], capture_output=True, timeout=10)
    if result.returncode:
        return {"ready": False, "reason": "Target repository does not contain the source base commit", "repository": str(root)}
    patch = base64.b64decode(payload.get("patchBase64") or "", validate=True)
    if len(patch) > SITREP_PATCH_LIMIT:
        raise ValueError("SitRep patch exceeds 512 KB")
    if patch:
        with tempfile.TemporaryDirectory(prefix="agentc2-sitrep-index-") as temporary:
            env = {**os.environ, "GIT_INDEX_FILE": str(Path(temporary) / "index")}
            sitrep_git(root, ["read-tree", base], env=env)
            check = subprocess.run(["git", "-C", str(root), "apply", "--cached", "--check", "-"], input=patch,
                                   capture_output=True, timeout=15, env=env)
            if check.returncode:
                return {"ready": False, "reason": "Patch does not apply cleanly to the target base: " + check.stderr.decode("utf-8", "replace")[:400], "repository": str(root)}
    return {"ready": True, "reason": "", "repository": str(root)}
