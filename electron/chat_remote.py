"""Ephemeral helper entrypoint for the detached worker's private Unix socket."""

CHAT_WORKER_FILES = ("chat_worker.py", "chat_runtime.py", "chat_protocol.py", "chat_journal.py", "chat_adapters.py", "chat-protocol.json", "chat_format.py", "chat_codex.py", "chat_codex_schema.py", "chat-codex-schema.json", "chat_antigravity.py", "chat_antigravity_cli.py", "chat_claude.py", "chat_opencode.py")


def chat_remote(payload, directory=None):
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
    try:
        health = rpc(health_request)
    except (FileNotFoundError, ConnectionRefusedError):
        health = None
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
            launcher = "import os,subprocess,sys; subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=None,start_new_session=True,close_fds=True); os._exit(0)"
            runtime = subprocess.run([sys.executable, str(code / "chat_runtime.py"), str(root)], capture_output=True, text=True, timeout=30, check=True).stdout.strip()
            subprocess.run([sys.executable, "-c", launcher, runtime, str(code / "chat_worker.py"), "--directory", str(root), "--source-digest", digest], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, close_fds=True, check=True)
        finally:
            os.close(log)
        for _ in range(100):
            try:
                health = rpc(health_request)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                time.sleep(0.05)
        if health is None:
            raise ValueError("Remote chat worker did not start; inspect its private worker.log")
    if health.get("protocolVersion") != 1 or health.get("sourceDigest") != digest:
        if payload.get("allowUpgrade") is True and health.get("canRetire") is True and files is not None:
            rpc(dict(protocolVersion=1, action="retire"))
            for _ in range(100):
                if not location.exists():
                    return chat_remote(payload, root)
                time.sleep(0.05)
            raise ValueError("Previous chat worker did not finish retiring; reconnect without resending uncertain commands")
        raise ValueError("A different worker version is running; stop its managed chat sessions before upgrading the worker")
    request = payload.get("request")
    if not isinstance(request, dict):
        raise ValueError("Invalid chat request")
    return health if request == health_request else rpc(request)
