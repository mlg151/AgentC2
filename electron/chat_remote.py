"""Ephemeral helper entrypoint for the detached worker's private Unix socket."""

CHAT_WORKER_FILES = ("chat_worker.py", "chat_runtime.py", "chat_protocol.py", "chat_journal.py", "chat_adapters.py", "chat-protocol.json", "chat_format.py", "chat_codex.py", "chat_codex_schema.py", "chat-codex-schema.json", "chat_antigravity.py", "chat_antigravity_cli.py", "chat_claude.py", "chat_claude_history.py", "chat_launcher.py", "chat_opencode.py")


def chat_remote(payload, directory=None):
    import fcntl
    import hashlib
    import json
    import os
    from pathlib import Path
    import socket
    import stat
    import subprocess
    import sys
    import time
    import uuid
    import re

    allowed = set(CHAT_WORKER_FILES)
    files = payload.get("chatFiles")
    if files is not None:
        if not isinstance(files, dict) or set(files) != allowed or any(not isinstance(value, str) or len(value.encode()) > 500000 for value in files.values()):
            raise ValueError("Invalid remote chat worker bundle")
        digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if payload.get("sourceDigest") is not None and payload["sourceDigest"] != digest:
            raise ValueError("Remote chat worker digest mismatch")
    else:
        digest = payload.get("sourceDigest")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid remote chat worker digest")
    request = payload.get("request")
    if not isinstance(request, dict):
        raise ValueError("Invalid chat request")
    root = Path(directory) if directory is not None else Path.home() / ".cache" / "agentc2" / "chat-v1"

    def owned_directory(location):
        location.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = location.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Unsupported worker directory")
        location.chmod(0o700)

    owned_directory(root)
    location = root / "worker.sock"

    def rpc(request):
        info = location.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Unsupported worker socket")
        body = (json.dumps(request, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
        if len(body) > 1048576:
            raise ValueError("Chat request is too large")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(300 if request.get("action") == "capabilities" and request.get("prepareProvider") else 15)
            connection.connect(str(location))
            connection.sendall(body)
            with connection.makefile("rb") as reader:
                line = reader.readline(4000001)
            if len(line) > 4000000 or not line.endswith(b"\n"):
                raise ValueError("Invalid worker response")
            result = json.loads(line)
            if not result.get("ok"):
                raise ValueError(result.get("error") or "Worker operation failed")
            return result["result"]

    health_request = dict(protocolVersion=1, action="health")

    def read_health():
        try:
            result = rpc(health_request)
        except (FileNotFoundError, ConnectionRefusedError):
            return None
        if result.get("protocolVersion") != 1:
            raise ValueError("Unsupported chat worker protocol; active sessions have been preserved")
        return result

    def can_upgrade(health):
        return (health is not None and health.get("sourceDigest") != digest
                and payload.get("allowUpgrade") is True and files is not None
                and health.get("canRetire") is True)

    # A source digest identifies code, not wire compatibility. Keep serving
    # existing sessions on their owning worker until it can retire safely.
    # Shared locks allow concurrent RPCs (including long SDK preparations),
    # while an exclusive lock fences the entire retirement/bootstrap handoff.
    bootstrap_descriptor = os.open(root / "bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(bootstrap_descriptor, "w") as bootstrap_lock:
        info = os.fstat(bootstrap_lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError("Unsupported worker bootstrap lock")
        fcntl.flock(bootstrap_lock, fcntl.LOCK_SH)
        health = read_health()
        if health is not None and not can_upgrade(health):
            return health if request == health_request else rpc(request)
        fcntl.flock(bootstrap_lock, fcntl.LOCK_EX)
        # Another helper may have launched/upgraded or accepted work while we
        # changed locks. Never act on the earlier health snapshot.
        health = read_health()
        if can_upgrade(health):
            try:
                rpc(dict(protocolVersion=1, action="retire"))
            except ValueError:
                # Older helpers only lock their health check. A command or SDK
                # preparation can win that race; the worker remains authoritative.
                current = read_health()
                if current is None or current.get("bootId") != health.get("bootId") or current.get("canRetire") is not False:
                    raise
                health = current
            else:
                for _ in range(100):
                    if not location.exists():
                        health = None
                        break
                    time.sleep(0.05)
                else:
                    raise ValueError("Previous chat worker did not finish retiring; reconnect without resending uncertain commands")
        if health is None:
            if files is None:
                raise ValueError("Remote chat worker is unavailable; reconnect to bootstrap it again")
            code = root / digest
            owned_directory(code)
            for name, value in files.items():
                temporary = code / (name + "." + uuid.uuid4().hex + ".tmp")
                descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                try:
                    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                        output.write(value)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, code / name)
                finally:
                    temporary.unlink(missing_ok=True)
            log_path = root / "worker.log"
            log = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(log)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                    raise ValueError("Unsupported worker log")
                os.fchmod(log, 0o600)
                # Reap a short-lived launcher while the detached worker outlives the
                # ephemeral helper, without leaving a live Popen object behind.
                runtime = subprocess.run([sys.executable, str(code / "chat_runtime.py"), str(root)], capture_output=True, text=True, timeout=30, check=True).stdout.strip()
                subprocess.run([sys.executable, str(code / "chat_launcher.py"), runtime, str(code / "chat_worker.py"), "--directory", str(root), "--source-digest", digest], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, close_fds=True, check=True)
            finally:
                os.close(log)
            for _ in range(100):
                health = read_health()
                if health is not None:
                    break
                time.sleep(0.05)
            if health is None:
                raise ValueError("Remote chat worker did not start; inspect its private worker.log")
        return health if request == health_request else rpc(request)
