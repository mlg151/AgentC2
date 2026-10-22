"""Scoped history adapters, prepended to remote.py by the desktop service.

No provider database is edited here. Codex owns its hard-delete operation;
Claude's adapter owns only documented session files and scoped index entries.
"""


def cleanup_file(path):
    path = Path(path).absolute()
    relative = path.relative_to(HOME)
    if ".." in relative.parts:
        raise ValueError("Provider storage path traversal is excluded")
    current = HOME
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Linked provider storage is unsupported")
    info = path.stat()
    if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Shared, linked, or unowned files are excluded")
    if info.st_size > 512 * 1024 * 1024:
        raise ValueError("File exceeds the cleanup size limit")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(relative), "size": info.st_size, "mtime": info.st_mtime_ns,
            "inode": info.st_ino, "device": info.st_dev, "hash": digest.hexdigest()}


def cleanup_activity(provider, ignore_pid=None):
    """Without a proven conversation ID, a live provider protects its histories."""
    names = {"codex": {"codex"}, "claude": {"claude", "claude3"}, "antigravity": {"agy", "antigravity"}, "opencode": {"opencode", "opencode.exe"}}[provider]
    try:
        processes = list(Path("/proc").iterdir())
    except OSError:
        return "Process activity cannot be verified"
    for process in processes:
        if not process.name.isdigit() or int(process.name) in (os.getpid(), ignore_pid):
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            command = (process / "comm").read_text().strip()
            args = (process / "cmdline").read_bytes().split(b"\0")[:4]
            executables = {Path(os.fsdecode(arg)).name for arg in args if arg}
            if command in names or names.intersection(executables) or (provider == "claude" and any("/claude-code/" in os.fsdecode(arg) for arg in args)):
                return "A live provider process cannot be safely correlated; stop it before cleanup"
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            return "Process activity is ambiguous"
    return ""


def cleanup_tree(path):
    if path.is_symlink():
        raise ValueError("Linked provider storage is unsupported")
    if not path.exists():
        return []
    if not path.is_dir():
        raise ValueError("Unrecognized session sidecar layout")
    files = []
    for directory, folders, names in os.walk(path, followlinks=False):
        if Path(directory).stat().st_uid != os.getuid() or ".git" in folders or ".git" in names or any((Path(directory) / name).is_symlink() for name in folders):
            raise ValueError("Repository or linked data in session storage is excluded")
        files.extend(Path(directory) / name for name in names)
        if len(files) > 10000:
            raise ValueError("Session exceeds the cleanup file limit")
    return files


def cleanup_claude(session_id):
    root = HOME / ".claude"
    transcripts = list((root / "projects").glob(f"*/{session_id}.jsonl"))
    if len(transcripts) > 1:
        raise ValueError("Conversation occurs in multiple projects; ownership is ambiguous")
    if not transcripts:
        sidecars = list((root / "projects").glob(f"*/{session_id}")) + [root / folder / session_id for folder in ("file-history", "image-cache", "uploads", "dev-mods")]
        if any(cleanup_tree(path) for path in sidecars) or (root / "debug" / (session_id + ".txt")).exists():
            raise ValueError("Transcript is missing but sidecars remain; ownership requires review")
        return [], {}, None, []
    transcript = transcripts[0]
    cleanup_file(transcript)
    with transcript.open() as stream:
        line = stream.readline(1024 * 1024)
    first = json.loads(line)
    if not isinstance(first, dict) or first.get("type") not in ("user", "assistant", "system", "summary", "file-history-snapshot", "queue-operation", "progress", "custom-title", "last-prompt") or first.get("sessionId", session_id) != session_id:
        raise ValueError("Unrecognized Claude transcript layout")
    project = transcript.parent
    files = [transcript]
    files += list(project.glob(f"{session_id}.orphaned-*.jsonl"))
    files += list(project.glob(f"{session_id}.jsonl.superseded-*"))
    session_dir = project / session_id
    if session_dir.exists():
        if any(child.name not in ("subagents", "tool-results", "images") for child in session_dir.iterdir()):
            raise ValueError("Unrecognized Claude session sidecars")
        files += cleanup_tree(session_dir)
    for folder in ("file-history", "image-cache", "uploads", "dev-mods"):
        files += cleanup_tree(root / folder / session_id)
    debug = root / "debug" / (session_id + ".txt")
    if debug.exists() or debug.is_symlink():
        files.append(debug)
    files += list((root / "todos").glob(f"{session_id}-agent-*.json"))
    rewrites = {}
    index = project / "sessions-index.json"
    if index.exists() or index.is_symlink():
        cleanup_file(index)
        if index.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("Claude index exceeds the supported size")
        data = json.loads(index.read_text())
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("entries"), list) or any(not isinstance(entry, dict) for entry in data["entries"]):
            raise ValueError("Unsupported Claude session index version")
        entries = [entry for entry in data["entries"] if entry.get("sessionId") != session_id]
        if entries != data["entries"]:
            rewrites[index] = json.dumps({**data, "entries": entries}, ensure_ascii=False).encode()
    history = root / "history.jsonl"
    if history.exists() or history.is_symlink():
        cleanup_file(history)
        if history.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("Shared Claude prompt history exceeds the supported size")
        lines = history.read_bytes().splitlines(keepends=True)
        kept = []
        for line in lines:
            item = json.loads(line)
            if not isinstance(item, dict):
                raise ValueError("Unrecognized shared Claude history layout")
            if item.get("sessionId") != session_id:
                kept.append(line)
        if kept != lines:
            rewrites[history] = b"".join(kept)
    return files, rewrites, transcript, []


def cleanup_codex(session_id):
    if str(uuid.UUID(session_id)) != session_id:
        raise ValueError("Codex cleanup requires a canonical UUID")
    root = HOME / ".codex"
    if os.environ.get("CODEX_HOME", str(root)) != str(root) or os.environ.get("CODEX_SQLITE_HOME", str(root)) != str(root):
        raise ValueError("Custom Codex storage is unsupported by this inventory")
    db = root / "state_5.sqlite"
    if not db.exists():
        return [], {}, None, []
    cleanup_file(db)
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2) as conn:
        conn.row_factory = sqlite3.Row
        columns = {row[1] for row in conn.execute("PRAGMA table_info(threads)")}
        if not {"id", "rollout_path", "updated_at_ms"}.issubset(columns):
            raise ValueError("Unsupported Codex state schema")
        pinned = "is_pinned" if "is_pinned" in columns else "0 AS is_pinned"
        row = conn.execute(f"SELECT id, rollout_path, updated_at_ms, {pinned} FROM threads WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        return [], {}, None, []
    path = Path(row["rollout_path"])
    if not path.is_absolute() or not any(path.is_relative_to(root / folder) for folder in ("sessions", "archived_sessions")):
        raise ValueError("Codex rollout is outside managed provider history")
    files = [path] if path.exists() or path.is_symlink() else []
    # The native command owns reference graphs, sidecars, and database cleanup.
    # File sizes here are estimates, not a claim that all associated bytes are known.
    help_result = run(["codex", "delete", "--help"], timeout=5)
    if help_result.returncode != 0 or "--force" not in help_result.stdout:
        raise ValueError("Install a Codex CLI with native delete --force support")
    config = root / "config.toml"
    if config.exists():
        import tomllib
        cleanup_file(config)
        settings = tomllib.loads(config.read_text())
        if settings.get("sqlite_home", str(root)) != str(root):
            raise ValueError("Custom Codex SQLite storage is unsupported")
        if settings.get("experimental_thread_store", "local") != "local" or settings.get("profile"):
            raise ValueError("Custom Codex thread stores or default profiles require a verified adapter")
    return files, {}, path, [row["id"], row["rollout_path"], row["updated_at_ms"], bool(row["is_pinned"])]


def cleanup_opencode(session_id):
    if not re.fullmatch(r"ses_[A-Za-z0-9_-]{1,96}", session_id):
        raise ValueError("OpenCode cleanup requires an exact session ID")
    database = opencode_database()
    if not database.exists():
        return [], {}, None, []
    cleanup_file(database)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as connection:
        connection.row_factory = sqlite3.Row
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "session_v2" not in tables:
            raise ValueError("Resume this legacy OpenCode history in v2 before native cleanup")
        row = connection.execute("SELECT * FROM session_v2 WHERE id=?", (session_id,)).fetchone()
        if row is None:
            if "session" in tables and connection.execute("SELECT 1 FROM session WHERE id=?", (session_id,)).fetchone():
                raise ValueError("Resume this legacy OpenCode history in v2 before native cleanup")
            return [], {}, None, []
        if row["parent_id"] or row["fork_session_id"] or connection.execute("SELECT 1 FROM session_v2 WHERE parent_id=? OR fork_session_id=? LIMIT 1", (session_id, session_id)).fetchone():
            raise ValueError("Related OpenCode sessions are excluded; native delete also removes children")
        if connection.execute("SELECT 1 FROM session_pending WHERE session_id=? LIMIT 1", (session_id,)).fetchone():
            raise ValueError("OpenCode has pending messages; resolve them before cleanup")
        snapshot = {"session": dict(row)}
        for table, column in (("session_message", "session_id"), ("event", "aggregate_id")):
            size = connection.execute(f"SELECT SUM(length(data)) FROM {table} WHERE {column}=?", (session_id,)).fetchone()[0] or 0
            if size > 16 * 1024 * 1024:
                raise ValueError("OpenCode session exceeds cleanup limits")
            rows = connection.execute(f"SELECT * FROM {table} WHERE {column}=? ORDER BY id LIMIT 10001", (session_id,)).fetchall()
            if len(rows) > 10000:
                raise ValueError("OpenCode session exceeds cleanup limits")
            snapshot[table] = [dict(item) for item in rows]
        if len(json.dumps(snapshot, sort_keys=True)) > 16 * 1024 * 1024:
            raise ValueError("OpenCode session exceeds cleanup limits")
    return [], {}, database, snapshot


def cleanup_plan(provider, session_id, ignore_pid=None):
    result = {"id": session_id, "provider": provider, "eligible": False, "reason": "", "bytes": None,
              "updatedAt": None, "fingerprint": "", "files": [], "estimated": provider in ("codex", "antigravity")}
    try:
        if provider not in PROVIDERS or not isinstance(session_id, str) or not ID_RE.fullmatch(session_id):
            raise ValueError("Invalid conversation ID or provider")
        journal = HOME / ".cache" / "agentc2" / "chat-v1" / "journal.sqlite3"
        if journal.is_file():
            connection = sqlite3.connect(f"file:{journal}?mode=ro", uri=True, timeout=1)
            try:
                active = connection.execute("SELECT 1 FROM sessions WHERE provider=? AND provider_session_id=? AND state NOT IN ('stopped','failed') LIMIT 1", (provider, session_id)).fetchone()
            finally:
                connection.close()
            if active:
                raise ValueError("History belongs to an active or uncertain managed chat; inspect and stop it before cleanup")
        reason = cleanup_activity(provider, ignore_pid)
        if reason:
            raise ValueError(reason)
        if provider == "codex":
            files, rewrites, transcript, row = cleanup_codex(session_id)
        elif provider == "opencode":
            files, rewrites, transcript, row = cleanup_opencode(session_id)
        elif provider == "antigravity":
            files, rewrites, transcript, row = antigravity_snapshot(session_id)
        else:
            files, rewrites, transcript, row = cleanup_claude(session_id)
        owned = [cleanup_file(path) for path in sorted(set(files))]
        shared = [cleanup_file(path) for path in sorted(rewrites)]
        if len(owned) > 10000 or sum(item["size"] for item in owned) > 512 * 1024 * 1024:
            raise ValueError("Session exceeds the cleanup size limit")
        snapshot = {"owned": owned, "shared": shared, "row": row}
        fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        timestamps = [item["mtime"] / 1e9 for item in owned]
        if provider == "codex" and row and row[2]:
            timestamps.append(row[2] / 1000)
        if provider == "opencode" and row:
            timestamps.append(row["session"]["time_updated"] / 1000)
        result.update(eligible=True, bytes=sum(item["size"] for item in owned), files=[item["path"] for item in owned] + [item["path"] + " (matching entries only)" for item in shared],
                      updatedAt=iso_from_epoch(max(timestamps)) if timestamps else None, fingerprint=fingerprint,
                      missing=transcript is None, method={"codex": "Codex native delete", "claude": "Claude session files", "antigravity": "Antigravity CLI picker", "opencode": "OpenCode native delete"}[provider])
        result["providerPinned"] = bool(provider == "codex" and row and row[3])
        return result, (files, rewrites, transcript, snapshot)
    except (OSError, ValueError, sqlite3.Error, TypeError, subprocess.TimeoutExpired) as error:
        # Paths and transcript contents are not echoed in failure records.
        result["reason"] = str(error) if isinstance(error, ValueError) else "Provider storage is unreadable, locked, or unsupported"
        return result, None


def cleanup_preview(payload):
    provider, ids = payload.get("provider"), payload.get("ids")
    if provider not in PROVIDERS or not isinstance(ids, list) or len(ids) > 50:
        raise ValueError("Preview accepts at most 50 conversation IDs for one provider")
    with cleanup_lock():
        return {"items": [cleanup_plan(provider, session_id)[0] for session_id in ids]}


def cleanup_replace(path, content, expected):
    if cleanup_file(path) != expected:
        raise ValueError("Shared history changed; preview again")
    descriptor, temporary = tempfile.mkstemp(prefix=".agentc2-cleanup-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(path.stat().st_mode))
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if cleanup_file(path) != expected:
            raise ValueError("Shared history changed; preview again")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def cleanup_delete_one(payload, picker=None):
    provider, session_id = payload.get("provider"), payload.get("id")
    current, plan = cleanup_plan(provider, session_id, picker.pid if picker else None)
    if not current["eligible"]:
        return {"id": session_id, "status": "excluded", "detail": current["reason"]}
    if current["fingerprint"] != payload.get("fingerprint"):
        return {"id": session_id, "status": "changed", "detail": "History changed after preview; preview again"}
    files, rewrites, transcript, snapshot = plan
    removed_bytes = 0
    try:
        if current["missing"]:
            return {"id": session_id, "status": "missing", "detail": "Already absent", "bytes": 0}
        if provider == "antigravity":
            if picker is None:
                raise ValueError("Antigravity picker was not started")
            picker.delete(session_id, snapshot["row"][1], snapshot["row"][2])
            return {"id": session_id, "status": "deleted", "detail": "Antigravity confirmed picker deletion; reviewed bytes are an estimate", "bytes": current["bytes"], "estimated": True}
        if provider == "opencode":
            try:
                deleted = subprocess.run(["opencode", "session", "delete", "--standalone", session_id], cwd=snapshot["row"]["session"]["directory"], text=True, capture_output=True, timeout=max(1, min(10, int(payload["deadline"] - time.monotonic()))), check=False)
            except subprocess.TimeoutExpired:
                return {"id": session_id, "status": "unknown", "detail": "OpenCode deletion timed out; preview again before retrying"}
            if deleted.returncode:
                return {"id": session_id, "status": "failed", "detail": "OpenCode did not confirm deletion; preview again"}
            with closing(sqlite3.connect(transcript.as_uri() + "?mode=ro", uri=True, timeout=2)) as connection:
                if connection.execute("SELECT 1 FROM session_v2 WHERE id=?", (session_id,)).fetchone():
                    raise ValueError("Provider still lists the conversation")
            return {"id": session_id, "status": "deleted", "detail": "OpenCode confirmed native session deletion; shared database and project files were preserved", "bytes": 0, "estimated": True}
        if provider == "codex":
            deleted = run(["codex", "delete", "--force", session_id], timeout=max(1, min(10, int(payload["deadline"] - time.monotonic()))))
            if deleted.returncode != 0:
                return {"id": session_id, "status": "unknown" if deleted.returncode == 124 else "failed", "detail": "Codex did not confirm deletion. Preview again; it may retain live or referenced history"}
            with sqlite3.connect(f"file:{HOME / '.codex' / 'state_5.sqlite'}?mode=ro", uri=True, timeout=2) as conn:
                if conn.execute("SELECT 1 FROM threads WHERE id = ?", (session_id,)).fetchone():
                    raise ValueError("Provider still lists the conversation")
            if any(path.exists() for path in files):
                raise ValueError("Provider left reviewed transcript files; preview again")
            return {"id": session_id, "status": "deleted", "detail": "Codex confirmed native deletion; transcript byte count is an estimate", "bytes": current["bytes"], "estimated": True}
        shared = {item["path"]: item for item in snapshot["shared"]}
        for path, content in rewrites.items():
            if time.monotonic() > payload["deadline"]:
                raise ValueError("Cleanup time limit reached")
            reason = cleanup_activity(provider)
            if reason:
                raise ValueError(reason)
            cleanup_replace(path, content, shared[str(path.relative_to(HOME))])
        owned = {item["path"]: item for item in snapshot["owned"]}
        # Preserve the inventory record until every sidecar is removed. A
        # failed/interrupted pass can be previewed again from remaining data.
        for path in sorted(set(files), key=lambda item: item == transcript):
            if time.monotonic() > payload["deadline"]:
                raise ValueError("Cleanup time limit reached")
            reason = cleanup_activity(provider)
            if reason:
                raise ValueError(reason)
            expected = owned[str(path.relative_to(HOME))]
            if cleanup_file(path) != expected:
                raise ValueError("History changed during deletion; preview again")
            path.unlink()
            removed_bytes += expected["size"]
        return {"id": session_id, "status": "deleted", "detail": "Removed reviewed session files and matching index/history entries", "bytes": removed_bytes, "estimated": False}
    except AntigravityUncertain:
        return {"id": session_id, "status": "unknown", "detail": "Antigravity confirmation was sent but deletion was not verified. Refresh and preview before retrying", "bytes": removed_bytes}
    except (OSError, ValueError, sqlite3.Error):
        if provider == "antigravity":
            return {"id": session_id, "status": "failed", "detail": "The Antigravity picker did not verify this history; no deletion confirmation was sent", "bytes": 0}
        return {"id": session_id, "status": "failed", "detail": "Deletion was not fully confirmed. Some reviewed data may have been removed; preview remaining history before retrying", "bytes": removed_bytes}


def cleanup_delete(payload):
    items, provider = payload.get("items"), payload.get("provider")
    if provider not in PROVIDERS or not isinstance(items, list) or not items or len(items) > 50:
        raise ValueError("Delete accepts up to 50 reviewed conversation IDs")
    results, approved, shared = [], {}, {}
    deadline = time.monotonic() + (270 if provider == "antigravity" else 20)
    with cleanup_lock():
        # Validate the complete batch before the first mutation. Later entries
        # can share an index/history file that our earlier deletions rewrite.
        for item in items:
            current, plan = cleanup_plan(provider, item.get("id"))
            if not current["eligible"] or current["fingerprint"] != item.get("fingerprint"):
                results.append({"id": item.get("id"), "status": "changed", "detail": current["reason"] or "History changed after preview; preview again"})
            else:
                approved[item["id"]] = plan[3]
                shared.update({entry["path"]: entry for entry in plan[3]["shared"]})
        picker = None
        try:
            if provider == "antigravity" and any(item["owned"] for item in approved.values()):
                try:
                    picker = AntigravityPicker(deadline)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    results.extend({"id": session_id, "status": "missing" if not original["owned"] else "failed",
                                    "detail": "Already absent" if not original["owned"] else "The version-gated Antigravity picker could not be verified; no deletion was sent"}
                                   for session_id, original in approved.items())
                    return {"items": results}
            for session_id, original in approved.items():
                current, plan = cleanup_plan(provider, session_id, picker.pid if picker else None)
                try:
                    if time.monotonic() > deadline:
                        raise ValueError("Batch time limit reached; preview remaining history")
                    if not current["eligible"] or plan[3]["owned"] != original["owned"] or plan[3]["row"] != original["row"]:
                        raise ValueError("History changed after preview; preview again")
                    for item in original["shared"]:
                        if cleanup_file(HOME / item["path"]) != shared[item["path"]]:
                            raise ValueError("Shared history changed after preview; preview again")
                    result = cleanup_delete_one({"provider": provider, "id": session_id, "fingerprint": current["fingerprint"], "deadline": deadline}, picker)
                    for item in original["shared"]:
                        shared[item["path"]] = cleanup_file(HOME / item["path"])
                    results.append(result)
                except (OSError, ValueError):
                    results.append({"id": session_id, "status": "changed", "detail": "History changed or the batch time limit was reached; preview remaining history"})
        finally:
            if picker:
                picker.close()
    return {"items": results}
