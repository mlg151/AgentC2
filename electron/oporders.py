"""Project-scoped OpOrder preview and sync. Loaded into the ephemeral SSH helper."""
import difflib

OPORDER_BEGIN = "<!-- AgentC2 OpOrder: begin -->"
OPORDER_END = "<!-- AgentC2 OpOrder: end -->"
OPORDER_TOML_BEGIN = "# AgentC2 OpOrder: begin"
OPORDER_TOML_END = "# AgentC2 OpOrder: end"
OPORDER_PATHS = ("AGENTS.md", "CLAUDE.md", ".agents/rules/agentc2.md", ".codex/config.toml", ".mcp.json", ".agents/mcp_config.json")


def oporder_digest(value):
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def oporder_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def oporder_root(order):
    repository = order.get("repository")
    if not isinstance(repository, str) or not repository.startswith("/") or len(repository) > 4096:
        raise ValueError("Invalid OpOrder repository")
    root = Path(repository)
    if root.is_symlink() or not root.is_dir() or root.resolve() != root:
        raise ValueError("OpOrder repository must be a real directory")
    result = run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], timeout=5)
    if result.returncode != 0 or Path(result.stdout.strip()).resolve() != root:
        raise ValueError("OpOrder path must be the selected Git worktree root")
    return root


def oporder_state_dir(root, create=False):
    state = HOME / ".cache" / "agentc2" / "oporders" / oporder_digest(str(root))[:24]
    if state.is_symlink():
        raise ValueError("OpOrder state path is a symlink")
    if create:
        state.mkdir(parents=True, mode=0o700, exist_ok=True)
        state.chmod(0o700)
    return state


def oporder_safe_path(root, relative):
    if relative not in OPORDER_PATHS:
        raise ValueError("Unsupported OpOrder path")
    path = root / relative
    for parent in (path, *path.parents):
        if parent == root.parent:
            break
        if parent.is_symlink():
            raise ValueError(f"OpOrder path is a symlink: {relative}")
        if parent.exists():
            info = parent.lstat()
            if info.st_uid != os.getuid() or (parent == path and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
                raise ValueError(f"OpOrder path is not owned safely: {relative}")
    return path


def oporder_read(path):
    if not path.exists():
        return None
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("OpOrder target exceeds 1 MB")
    return path.read_text(encoding="utf-8")


def oporder_render(order):
    shared = order.get("instructions", "").strip()
    overrides = order.get("overrides") or {}
    unsupported = []
    if overrides.get("codex", "").strip():
        unsupported.append("Codex-only instructions cannot be added without changing the meaning of existing AGENTS.md or model_instructions_file; remove this override")
    blocks = {
        "AGENTS.md": shared,
        "CLAUDE.md": "\n\n".join(part for part in (shared, overrides.get("claude", "").strip()) if part),
        ".agents/rules/agentc2.md": overrides.get("antigravity", "").strip(),
    }
    codex = []
    claude = {}
    antigravity = {}
    for server in order.get("mcp") or []:
        name = server["name"]
        selected = server.get("providers") or ["codex", "claude", "antigravity"]
        transport = server["transport"]
        env = server.get("env") or []
        headers = server.get("headers") or {}
        if "codex" in selected:
            lines = [f"[mcp_servers.{json.dumps(name)}]"]
            if transport == "stdio":
                lines += [f"command = {json.dumps(server['command'])}", f"args = {json.dumps(server.get('args') or [])}"]
                if env:
                    lines.append(f"env_vars = {json.dumps(env)}")
            else:
                lines.append(f"url = {json.dumps(server['url'])}")
                if headers:
                    pairs = ", ".join(f"{json.dumps(key)} = {json.dumps(value)}" for key, value in sorted(headers.items()))
                    lines.append(f"env_http_headers = {{ {pairs} }}")
            codex.append("\n".join(lines))
        if "claude" in selected:
            if transport == "stdio":
                entry = {"type": "stdio", "command": server["command"], "args": server.get("args") or []}
                if env:
                    entry["env"] = {name: "${" + name + "}" for name in env}
            else:
                entry = {"type": "http", "url": server["url"]}
                if headers:
                    entry["headers"] = {header: "${" + variable + "}" for header, variable in headers.items()}
            claude[name] = entry
        if "antigravity" in selected:
            if env or headers:
                unsupported.append(f"Antigravity MCP server {name} uses environment references whose workspace expansion is not verified; deselect Antigravity for this server")
            else:
                antigravity[name] = ({"command": server["command"], "args": server.get("args") or []} if transport == "stdio" else {"serverUrl": server["url"]})
    blocks[".codex/config.toml"] = "\n\n".join(codex)
    entries = {".mcp.json": claude, ".agents/mcp_config.json": antigravity}
    return blocks, entries, unsupported


def oporder_block(current, desired, previous, toml=False):
    begin, end = (OPORDER_TOML_BEGIN, OPORDER_TOML_END) if toml else (OPORDER_BEGIN, OPORDER_END)
    original = current or ""
    start = original.find(begin)
    stop = original.find(end)
    if (start < 0) != (stop < 0) or original.count(begin) > 1 or original.count(end) > 1 or (start >= 0 and stop < start):
        raise ValueError("Managed section markers changed")
    existing = original[start:stop + len(end)] if start >= 0 else None
    if existing is None and previous is None and not desired:
        return current, None
    if previous is None and existing is not None:
        raise ValueError("Managed section exists without AgentC2 ownership")
    if previous is not None and (existing is None or oporder_digest(existing) != previous):
        raise ValueError("Managed section changed remotely")
    if toml and desired:
        outside = original[:start] + original[stop + len(end):] if existing is not None else original
        for name in re.findall(r'^\[mcp_servers\."?([A-Za-z0-9_-]+)"?\]\s*$', desired, re.M):
            if re.search(r'^\[mcp_servers\."?' + re.escape(name) + r'"?\]\s*$', outside, re.M):
                raise ValueError(f"MCP server {name} already exists outside AgentC2's section")
    wanted = f"{begin}\n{desired.rstrip()}\n{end}" if desired else None
    if existing is not None:
        updated = original[:start] + (wanted or "") + original[stop + len(end):]
    elif wanted:
        updated = original.rstrip("\n") + ("\n\n" if original.strip() else "") + wanted + "\n"
    else:
        updated = original
    if wanted is None and existing is not None:
        updated = updated.strip("\n") + ("\n" if updated.strip() else "")
    return updated or None, oporder_digest(wanted) if wanted else None


def oporder_entries(current, desired, previous):
    if not desired and not previous:
        return current, {}
    if current is None:
        document = {}
    else:
        document = json.loads(current)
        if not isinstance(document, dict):
            raise ValueError("MCP configuration must be an object")
    servers = document.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise ValueError("MCP server map is not an object")
    servers = dict(servers)
    for name, digest in previous.items():
        if name not in servers or oporder_digest(oporder_json(servers[name])) != digest:
            raise ValueError(f"Managed MCP server {name} changed remotely")
        if name not in desired:
            del servers[name]
    for name, entry in desired.items():
        if name in servers and name not in previous:
            raise ValueError(f"MCP server {name} already exists outside AgentC2 ownership")
        servers[name] = entry
    if servers:
        document["mcpServers"] = servers
    else:
        document.pop("mcpServers", None)
    updated = json.dumps(document, indent=2, ensure_ascii=False) + "\n" if document else None
    hashes = {name: oporder_digest(oporder_json(entry)) for name, entry in desired.items()}
    return updated, hashes


def oporder_entry_diff(relative, before, after, previous, desired):
    """Preview managed entries only; unrelated MCP values may contain secrets."""
    old = json.loads(before or "{}").get("mcpServers", {})
    new = json.loads(after or "{}").get("mcpServers", {})
    names = sorted(set(previous) | set(desired))
    old_managed = {name: old[name] for name in names if name in old}
    new_managed = {name: new[name] for name in names if name in new}
    return "".join(difflib.unified_diff(
        (json.dumps(old_managed, indent=2, ensure_ascii=False) + "\n").splitlines(True),
        (json.dumps(new_managed, indent=2, ensure_ascii=False) + "\n").splitlines(True),
        fromfile=relative + " (managed servers)", tofile=relative + " (managed servers)"))[:12000]


def oporder_managed_diff(relative, before, after):
    begin, end = (OPORDER_TOML_BEGIN, OPORDER_TOML_END) if relative.endswith(".toml") else (OPORDER_BEGIN, OPORDER_END)
    def extract(value):
        if not value or begin not in value:
            return ""
        return value[value.index(begin):value.index(end) + len(end)] + "\n"
    return "".join(difflib.unified_diff(extract(before).splitlines(True), extract(after).splitlines(True), fromfile=relative + " (managed section)", tofile=relative + " (managed section)"))[:12000]


def oporder_plan(order):
    root = oporder_root(order)
    state = oporder_state_dir(root)
    manifest_path = state / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("OpOrder manifest is a symlink")
    manifest = json.loads(oporder_read(manifest_path) or "{}")
    if manifest and manifest.get("orderId") != order.get("id"):
        raise ValueError("Another OpOrder owns this project")
    previous = manifest.get("managed") or {}
    blocks, entries, unsupported = oporder_render(order)
    changes = []
    next_managed = {}
    existing = set(manifest.get("existing") or [])
    fingerprints = []
    for relative in OPORDER_PATHS:
        path = oporder_safe_path(root, relative)
        current = oporder_read(path)
        fingerprints.append((relative, oporder_digest(current or ""), current is not None))
        prior = previous.get(relative)
        if prior is None and current is not None:
            existing.add(relative)
        try:
            if relative in blocks:
                updated, hash_value = oporder_block(current, blocks[relative], prior, relative.endswith(".toml"))
                if hash_value:
                    next_managed[relative] = hash_value
            else:
                updated, hashes = oporder_entries(current, entries[relative], prior or {})
                if hashes:
                    next_managed[relative] = hashes
            if updated is None and relative in existing:
                updated = "{}\n" if relative in entries else ""
            status = "unchanged" if updated == current else "create" if current is None and updated is not None else "remove" if updated is None else "update"
            diff = "" if status == "unchanged" else (oporder_entry_diff(relative, current, updated, prior or {}, entries[relative]) if relative in entries else oporder_managed_diff(relative, current, updated))
            changes.append({"path": relative, "status": status, "diff": diff, "before": current, "after": updated})
        except (ValueError, TypeError, UnicodeError) as error:
            changes.append({"path": relative, "status": "conflict", "diff": "", "reason": str(error), "before": current, "after": current})
    revision = oporder_digest(oporder_json({"order": order, "manifest": manifest, "files": fingerprints}))
    return root, state, next_managed, sorted(existing), changes, unsupported, revision


def oporder_preview(payload):
    order = payload.get("order") or {}
    _, _, _, _, changes, unsupported, revision = oporder_plan(order)
    return {"repository": order.get("repository"), "revision": revision, "ready": not unsupported and not any(item["status"] == "conflict" for item in changes),
            "unsupported": unsupported, "changes": [{key: value for key, value in item.items() if key not in ("before", "after")} for item in changes]}


def oporder_sync(payload):
    order = payload.get("order") or {}
    root, state, managed, existing, changes, unsupported, revision = oporder_plan(order)
    if unsupported or any(item["status"] == "conflict" for item in changes):
        raise ValueError("OpOrder has unsupported conversions or remote conflicts; preview before syncing")
    if payload.get("revision") and payload["revision"] != revision:
        raise ValueError("OpOrder preview is stale; preview again")
    dirty = [item for item in changes if item["status"] != "unchanged"]
    if not dirty:
        return {"status": "unchanged", "revision": revision}
    state = oporder_state_dir(root, create=True)
    backup = state / "backups" / f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
    backup.mkdir(parents=True, mode=0o700)
    originals = []
    try:
        for item in dirty:
            path = oporder_safe_path(root, item["path"])
            before = item["before"]
            if before is not None:
                saved = backup / item["path"]
                saved.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                saved.write_text(before, encoding="utf-8")
                saved.chmod(0o600)
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
            originals.append((path, before, mode))
            if item["after"] is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temporary = tempfile.mkstemp(prefix=".agentc2-", dir=path.parent)
                try:
                    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                        stream.write(item["after"])
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.chmod(temporary, mode if mode is not None else 0o644)
                    os.replace(temporary, path)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
        manifest = {"version": 1, "orderId": order["id"], "managed": managed, "existing": existing, "lastBackup": str(backup), "appliedAt": time.time()}
        temporary = state / ("manifest-" + uuid.uuid4().hex + ".tmp")
        temporary.write_text(oporder_json(manifest), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, state / "manifest.json")
    except Exception:
        for path, before, mode in reversed(originals):
            if before is None:
                path.unlink(missing_ok=True)
            else:
                descriptor, temporary = tempfile.mkstemp(prefix=".agentc2-rollback-", dir=path.parent)
                try:
                    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                        stream.write(before)
                    os.chmod(temporary, mode)
                    os.replace(temporary, path)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
        raise
    return {"status": "applied", "revision": revision, "backup": str(backup), "changed": [item["path"] for item in dirty]}
