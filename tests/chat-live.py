"""Opt-in installed-provider smoke; uses host CLI credentials, never prints them.

Run explicitly with --provider; optional --profile selects an existing Claude
wrapper. A private journal and working directory isolate AgentC2 test state.
Native providers retain their own test conversation, as for a normal CLI turn.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_journal import Journal
from chat_protocol import CONTRACT
from chat_codex import CodexAdapter
from chat_antigravity import AntigravityAdapter
from chat_claude import ClaudeAdapter
from chat_opencode import OpenCodeAdapter


def profile_environment(command):
    # Let the user's trusted wrapper prepare its environment, then intercept
    # only the final `claude` exec. Values stay in memory, never in diagnostics.
    with tempfile.TemporaryDirectory(prefix="a2-profile-") as folder:
        executable = Path(folder) / "claude"
        executable.write_text("#!" + sys.executable + "\nimport json,os\nprint(json.dumps(dict(os.environ)))\n")
        executable.chmod(0o700)
        result = subprocess.run([command, "--version"], env={**os.environ, "PATH": folder + os.pathsep + os.environ.get("PATH", "")}, capture_output=True, text=True, timeout=15, check=True)
        return json.loads(result.stdout)


def wait_turn(journal, identifier, after, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        page = journal.history(identifier, after=after, limit=500)
        if journal.pending_requests(identifier):
            raise RuntimeError("Unexpected interactive request in text-only smoke; inspect provider settings")
        if any(event["type"] == "turn.completed" for event in page["events"]):
            outcomes = [event["data"]["outcome"] for event in page["events"] if event["type"] == "turn.completed"]
            if outcomes[-1] != "completed":
                raise RuntimeError("Provider turn outcome: " + outcomes[-1])
            return page
        if page["session"]["state"] in ("failed", "unknown", "stopped"):
            raise RuntimeError("Provider session state: " + page["session"]["state"])
        time.sleep(0.1)
    raise TimeoutError("Provider did not finish within the bounded live-smoke timeout")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=CONTRACT["providers"])
    parser.add_argument("--profile", choices=["claude-ornith", "claude-sparkx"])
    parser.add_argument("--ssh", help="Explicit SSH host; uses existing known-host verification and key authentication")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    if args.profile and args.provider != "claude":
        parser.error("--profile requires Claude")
    if args.ssh:
        repo = Path(__file__).resolve().parents[1]
        names = ["chat_runtime.py", "chat_antigravity_cli.py", "chat_adapters.py", "chat_antigravity.py", "chat_claude.py", "chat_claude_history.py", "chat_opencode.py", "chat_codex.py", "chat_codex_schema.py", "chat-codex-schema.json", "chat_format.py", "chat_journal.py", "chat_protocol.py", "chat-protocol.json"]
        files = {"electron/" + name: (repo / "electron" / name).read_text() for name in names}
        files["tests/chat-live.py"] = Path(__file__).read_text()
        encoded = base64.b64encode(json.dumps(files).encode()).decode()
        arguments = ["--provider", args.provider, "--timeout", str(args.timeout)] + (["--profile", args.profile] if args.profile else [])
        source = "import base64,json,pathlib,subprocess,sys,tempfile\nwith tempfile.TemporaryDirectory(prefix='a2-live-source-') as folder:\n root=pathlib.Path(folder)\n for name,content in json.loads(base64.b64decode(" + repr(encoded) + ")).items():\n  file=root/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(content)\n result=subprocess.run([sys.executable,str(root/'tests/chat-live.py'),*" + repr(arguments) + "])\n sys.exit(result.returncode)\n"
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", args.ssh, "python3", "-"], input=source, text=True)
        sys.exit(result.returncode)
    environment = profile_environment(shutil.which(args.profile)) if args.profile else dict(os.environ)
    adapter = None
    with tempfile.TemporaryDirectory(prefix="a2-live-") as folder:
        root = Path(folder)
        # Codex requires a trusted repository for some user configurations.
        subprocess.run(["git", "init", "-q", folder], check=True)
        journal = Journal(root / "journal")
        marker = "AGENTC2_SMOKE_" + uuid.uuid4().hex[:12]
        capabilities = dict(provider=args.provider, version="live-smoke", status="supported", reason=None, **{name: name in ("streaming", "resume", "interrupt") for name in CONTRACT["capabilities"]})
        native = None
        evidence = []
        try:
            for resumed in (False, True):
                print(json.dumps(dict(provider=args.provider, profile=args.profile, status="turn_started", resumed=resumed)), flush=True)
                command = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation="create", payload=dict(provider=args.provider, cwd=folder, title="AgentC2 disposable live validation", roeProfile="provider-default" if args.provider in ("antigravity", "opencode") else "gated", **({"providerSessionId": native} if resumed else {})))
                receipt, _ = journal.accept(command, capabilities)
                identifier = receipt["sessionId"]
                session = journal.history(identifier)["session"]
                cls = dict(codex=CodexAdapter, claude=ClaudeAdapter, antigravity=AntigravityAdapter, opencode=OpenCodeAdapter)[args.provider]
                adapter = cls(session, journal, env=environment)
                adapter.start()
                before = journal.history(identifier)["latestCursor"]
                prompt = "What exact AGENTC2_SMOKE_ marker did I give you earlier? Reply only with that marker. Do not use tools." if resumed else "Remember this exact marker for our next turn: " + marker + ". Reply only with that marker. Do not use tools, read files, or change anything."
                adapter.send(prompt, str(uuid.uuid4()))
                page = wait_turn(journal, identifier, before, args.timeout)
                text = "\n".join(event["data"]["text"] for event in page["events"] if event["type"] == "message.completed" and event["data"]["role"] == "assistant")
                if marker not in text:
                    raise AssertionError("Provider response did not preserve the requested context marker")
                native = page["session"]["providerSessionId"]
                if not native:
                    raise AssertionError("Provider did not expose its native session identity")
                evidence.append(dict(resumed=resumed, nativeIdentity=True, contextMarker=True, streamed=any(event["type"] == "message.delta" for event in page["events"]), usage=any(event["type"] == "usage.updated" for event in page["events"])))
                adapter.stop()
                adapter = None
            print(json.dumps(dict(provider=args.provider, profile=args.profile, status="passed", turns=evidence)))
        finally:
            if adapter:
                adapter.stop()
            journal.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Provider errors can contain account data; keep automated output to a
        # safe classification. Private native logs remain on the selected host.
        frames = [dict(file=Path(frame.filename).name, line=frame.lineno, function=frame.name) for frame in traceback.extract_tb(error.__traceback__)]
        print(json.dumps(dict(status="failed", category=type(error).__name__, locations=frames)), file=sys.stderr)
        sys.exit(1)
