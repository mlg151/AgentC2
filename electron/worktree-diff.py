"""Bounded, revision-checked Git diffs for owned managed worktrees."""

import hashlib
import os
import selectors
import stat
import subprocess
import time

DIFF_LIMIT = 512_000
DIFF_FILES_LIMIT = 100


def artifact_read(payload):
    record = worktree_load(payload.get("operationId"))
    if not record or not worktree_state(record, False)["owned"]:
        raise ValueError("Artifact inspection requires an owned managed worktree")
    relative = payload.get("path")
    if not isinstance(relative, str) or not relative or len(relative) > 4096 or relative.startswith("/") or "\\" in relative or "\0" in relative:
        raise ValueError("Artifact path must be relative to the owned worktree")
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Artifact path cannot traverse directories")
    if any(part.lower().startswith((".env", "id_rsa", "id_ed25519")) or part.lower() in (".git", ".ssh", ".aws", ".npmrc", ".netrc") or "credential" in part.lower() or "secret" in part.lower() for part in parts):
        raise ValueError("Credential and internal Git files are excluded from artifact inspection")
    descriptors = []
    try:
        directory = os.open(record["path"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for part in parts[:-1]:
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(directory)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        descriptors.append(fd)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 256000:
            raise ValueError("Artifact must be a regular text file at most 256000 bytes")
        data = bytearray()
        while len(data) <= 256000:
            chunk = os.read(fd, 16384)
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if len(data) > 256000 or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("Artifact changed while reading; refresh and retry")
        if b"\0" in data:
            raise ValueError("Binary artifacts are unsupported")
        revision = hashlib.sha256(data).hexdigest()
        if payload.get("revision") and payload["revision"] != revision:
            raise ValueError("Artifact revision changed; refresh before continuing")
        return {"path": relative, "revision": revision, "sizeBytes": len(data), "text": data.decode("utf-8", "strict")}
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def diff_git(record, args, data=None, limit=DIFF_LIMIT):
    command = ["git", "-C", record["path"], *args]
    process = subprocess.Popen(command, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if data is not None:
        try:
            process.stdin.write(data)
        except BrokenPipeError:
            pass
        finally:
            process.stdin.close()
    output, errors = bytearray(), bytearray()
    deadline = time.monotonic() + 15
    with selectors.DefaultSelector() as reader:
        reader.register(process.stdout, selectors.EVENT_READ, output)
        reader.register(process.stderr, selectors.EVENT_READ, errors)
        try:
            while reader.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("Git diff timed out")
                for event, _ in reader.select(remaining):
                    chunk = os.read(event.fd, 65536)
                    if not chunk:
                        reader.unregister(event.fileobj)
                        continue
                    event.data.extend(chunk)
                    if len(output) > limit:
                        raise ValueError("Diff exceeds the 512 KB display limit")
                    if len(errors) > 8192:
                        raise ValueError("Git diff error output exceeds 8 KB")
            if process.wait(timeout=max(0.1, deadline - time.monotonic())):
                raise ValueError(errors.decode("utf-8", "replace")[:500] or "Git diff failed")
            return bytes(output)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stdout.close()
            process.stderr.close()


def diff_unit(payload):
    record = worktree_load(payload.get("operationId"))
    if not record or record.get("state") != "launched" or record.get("name") != payload.get("name"):
        raise ValueError("This unit has no owned worktree")
    status = worktree_state(record, False)
    if not status["owned"] or not status["active"] or tmux_option(record["name"], "@hq_worktree") != record["operationId"] or tmux_option(record["name"], "@hq_cwd") != record["path"]:
        raise ValueError("Unit/worktree association is unavailable; refresh inventory")
    return record


def diff_paths(record):
    base = ["--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"]
    staged = set(diff_git(record, ["diff", "--cached", *base], limit=DIFF_LIMIT).split(b"\0")) - {b""}
    changed = set(diff_git(record, ["diff", *base], limit=DIFF_LIMIT).split(b"\0")) - {b""}
    untracked = set(diff_git(record, ["ls-files", "--others", "--exclude-standard", "-z"], limit=DIFF_LIMIT).split(b"\0")) - {b""}
    paths = sorted(staged | changed | untracked)
    if len(paths) > DIFF_FILES_LIMIT:
        raise ValueError("More than 100 changed files; narrow the task before opening its diff")
    return [{"id": hashlib.sha256(path).hexdigest(), "path": path.decode("utf-8", "backslashreplace"), "staged": path in staged, "unstaged": path in changed, "untracked": path in untracked, "raw": path} for path in paths]


def diff_files(payload):
    record = diff_unit(payload)
    return [{key: value for key, value in file.items() if key != "raw"} for file in diff_paths(record)]


def diff_file(record, file):
    if file["untracked"]:
        return {"revision": "", "staged": [], "unstaged": [], "summary": "Untracked file; add it with Git before hunk actions.", "binary": False, "large": False}
    option = ["--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", "--", file["raw"]]
    try:
        unstaged = diff_git(record, ["diff", *option]) if file["unstaged"] else b""
        staged = diff_git(record, ["diff", "--cached", *option]) if file["staged"] else b""
    except ValueError as error:
        if "display limit" in str(error):
            return {"revision": "", "staged": [], "unstaged": [], "summary": "Diff exceeds 512 KB; use Git to inspect this file.", "binary": False, "large": True}
        raise
    revision = hashlib.sha256(staged + b"\0" + unstaged).hexdigest()
    def parse(data):
        lines = data.splitlines(keepends=True)
        positions = [index for index, line in enumerate(lines) if line.startswith(b"@@ ")]
        header = b"".join(lines[:positions[0]]) if positions else data
        binary = b"Binary files " in data or b"GIT binary patch" in data
        mode = any(flag in header for flag in (b"old mode ", b"new mode ", b"new file mode ", b"deleted file mode ", b"rename from ", b"rename to "))
        hunks = []
        for number, start in enumerate(positions):
            end = positions[number + 1] if number + 1 < len(positions) else len(lines)
            raw = b"".join(lines[start:end])
            hunks.append({"id": hashlib.sha256(number.to_bytes(4, "big") + raw).hexdigest(), "text": raw.decode("utf-8", "replace"), "actionable": not mode and not binary})
        return header, hunks, binary, mode
    staged_header, staged_hunks, staged_binary, _ = parse(staged)
    unstaged_header, unstaged_hunks, unstaged_binary, mode = parse(unstaged)
    summary = (unstaged_header or staged_header).decode("utf-8", "replace")[:4000]
    return {"revision": revision, "staged": staged_hunks, "unstaged": unstaged_hunks, "summary": summary, "binary": staged_binary or unstaged_binary, "large": False, "header": unstaged_header, "mode": mode}


def diff_detail(payload):
    record = diff_unit(payload)
    file = next((item for item in diff_paths(record) if item["id"] == payload.get("fileId")), None)
    if not file:
        raise ValueError("Changed file is unavailable; refresh the diff")
    result = diff_file(record, file)
    return {key: value for key, value in result.items() if key not in ("header", "mode")}


def diff_hunk_action(payload):
    action = payload.get("operation")
    if action not in ("stage", "revert"):
        raise ValueError("Invalid hunk action")
    record = diff_unit(payload)
    file = next((item for item in diff_paths(record) if item["id"] == payload.get("fileId")), None)
    if not file or not file["unstaged"]:
        raise ValueError("Unstaged file is unavailable; refresh the diff")
    detail = diff_file(record, file)
    if detail["large"] or detail["binary"] or detail["revision"] != payload.get("revision"):
        raise ValueError("The diff changed; refresh before acting")
    selected = next((item for item in detail["unstaged"] if item["id"] == payload.get("hunkId")), None)
    if not selected or not selected["actionable"]:
        raise ValueError("This hunk cannot be changed here")
    # Recompute raw bytes instead of accepting a patch supplied by the renderer.
    option = ["--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", "--", file["raw"]]
    source = diff_git(record, ["diff", *option])
    lines = source.splitlines(keepends=True)
    positions = [index for index, line in enumerate(lines) if line.startswith(b"@@ ")]
    for number, start in enumerate(positions):
        end = positions[number + 1] if number + 1 < len(positions) else len(lines)
        raw = b"".join(lines[start:end])
        if hashlib.sha256(number.to_bytes(4, "big") + raw).hexdigest() == selected["id"]:
            patch = detail["header"] + raw
            break
    else:
        raise ValueError("Hunk changed; refresh before acting")
    if diff_file(record, file)["revision"] != payload["revision"]:
        raise ValueError("The diff changed; refresh before acting")
    args = ["apply", "--cached", "--check"] if action == "stage" else ["apply", "--reverse", "--check"]
    diff_git(record, args, patch, limit=10_000)
    args = ["apply", "--cached"] if action == "stage" else ["apply", "--reverse"]
    diff_git(record, args, patch, limit=10_000)
    return {"changed": True}
