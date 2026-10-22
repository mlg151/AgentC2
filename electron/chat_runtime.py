"""Private Python runtime and automatic, pinned provider SDK deployment."""

import fcntl
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import urllib.request
import venv

SDK_PACKAGES = {"claude": ("claude-agent-sdk", "0.2.172"), "antigravity": ("google-antigravity", "0.1.22")}


def private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Unsupported SDK runtime directory")
    path.chmod(0o700)


def runtime_python(root):
    # Venv creation does not require ensurepip or administrator privileges.
    root = Path(root)
    private_directory(root)
    identity = hashlib.sha256(json.dumps([sys.version_info[:2], SDK_PACKAGES], sort_keys=True).encode()).hexdigest()[:16]
    location = root / ("python-" + identity)
    lock_fd = os.open(root / "runtime.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        private_directory(location)
        executable = location / "bin" / "python"
        if not (location / "pyvenv.cfg").is_file() or not executable.exists():
            venv.EnvBuilder(with_pip=False).create(location)
        return str(executable)


def installed(package, version):
    try:
        return importlib.metadata.version(package) == version
    except importlib.metadata.PackageNotFoundError:
        return False


def pip_wheel(root):
    # Bootstrap pip from its official wheel when the host has no pip/ensurepip.
    # The metadata digest is checked before running downloaded Python code.
    destination = root / "pip-25.3.whl"
    with urllib.request.urlopen("https://pypi.org/pypi/pip/25.3/json", timeout=30) as response:
        metadata = json.load(response)
    wheel = next(item for item in metadata["urls"] if item["filename"].endswith("-py3-none-any.whl"))
    if not wheel["url"].startswith("https://files.pythonhosted.org/"):
        raise ValueError("Unsupported pip wheel source")
    if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != wheel["digests"]["sha256"]:
        with urllib.request.urlopen(wheel["url"], timeout=60) as response:
            data = response.read(5000000)
        if hashlib.sha256(data).hexdigest() != wheel["digests"]["sha256"]:
            raise ValueError("pip wheel verification failed")
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
    return destination


def ensure_sdk(provider):
    if provider not in SDK_PACKAGES:
        return
    package, version = SDK_PACKAGES[provider]
    if installed(package, version):
        return
    location = Path(sys.prefix)
    if sys.prefix == sys.base_prefix or not (location / "pyvenv.cfg").is_file():
        raise ValueError("Reconnect through the AgentC2 daemon to prepare its private SDK runtime")
    lock_fd = os.open(location / "sdk-install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        importlib.invalidate_caches()
        if installed(package, version):
            return
        wheel = pip_wheel(location)
        runner = "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module('pip',run_name='__main__')"
        result = subprocess.run([sys.executable, "-c", runner, str(wheel), "--isolated", "--disable-pip-version-check", "--no-input", "install", "--index-url", "https://pypi.org/simple", "--only-binary=:all:", package + "==" + version], capture_output=True, timeout=240)
        importlib.invalidate_caches()
        if result.returncode or not installed(package, version):
            # Do not echo pip output: index/proxy diagnostics may contain secrets.
            raise ValueError("Automatic " + package + " setup failed. Check host internet access, disk space, and Python/platform wheel support, then retry.")


if __name__ == "__main__":
    print(runtime_python(sys.argv[1]))
