"""Provider registry. Capabilities stay unavailable until an adapter is verified."""

import re
import os
import importlib.metadata
import shutil
import subprocess

from chat_protocol import CONTRACT, unavailable_capabilities


class ProviderRejected(ValueError):
    """The provider definitively rejected a command before executing it."""


def probe_capabilities(provider):
    if provider not in CONTRACT["providers"]:
        raise ValueError("Invalid provider")
    binary = shutil.which(dict(codex="codex", claude="claude", antigravity="agy")[provider])
    if binary is None:
        return unavailable_capabilities(provider, reason="Provider CLI is not available on this host")
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=8, check=False)
        match = re.search(r"\b\d+\.\d+\.\d+\b", result.stdout[:1000])
        version = match.group(0) if result.returncode == 0 and match else None
    except (OSError, subprocess.TimeoutExpired):
        version = None
    if provider == "codex":
        from chat_codex_schema import BUNDLE
        if version == BUNDLE["version"]:
            return dict(provider=provider, version=version, status="supported", reason=None, **{name: name in ("streaming", "history", "resume", "interrupt", "approvals", "questions", "steering") for name in CONTRACT["capabilities"]})
    if provider == "antigravity":
        from chat_antigravity import SUPPORTED_VERSION
        if version == SUPPORTED_VERSION:
            return dict(provider=provider, version=version, status="supported", reason="CLI resume preserves native context; earlier native messages cannot be imported. Approval replies and attachments are unavailable.", **{name: name in ("streaming", "resume", "interrupt") for name in CONTRACT["capabilities"]})
    if provider == "claude":
        from chat_claude import SUPPORTED_SDK_VERSION, SUPPORTED_CLI_VERSION, auth_available
        try:
            sdk_version = importlib.metadata.version("claude-agent-sdk")
        except importlib.metadata.PackageNotFoundError:
            return unavailable_capabilities(provider, version, "Install claude-agent-sdk==" + SUPPORTED_SDK_VERSION + " in the remote worker's Python environment")
        observed = str(version) + "; SDK " + sdk_version
        if version == SUPPORTED_CLI_VERSION and sdk_version == SUPPORTED_SDK_VERSION:
            if not auth_available(os.environ):
                return unavailable_capabilities(provider, observed, "Configure Claude API or supported cloud-provider authentication on the SSH host; CLI subscription sign-in is not used")
            return dict(provider=provider, version=observed, status="supported", reason=None, **{name: name in ("streaming", "history", "resume", "interrupt", "approvals", "questions") for name in CONTRACT["capabilities"]})
    return unavailable_capabilities(provider, version, "Structured adapter has not been verified for this provider/version; use terminal mode")


def create_adapter(session, journal):
    if session["provider"] == "codex":
        from chat_codex import CodexAdapter
        if probe_capabilities("codex")["status"] != "supported":
            raise ProviderRejected("Codex version changed or is unsupported; probe host capabilities again")
        return CodexAdapter(session, journal)
    if session["provider"] == "antigravity":
        from chat_antigravity import AntigravityAdapter
        if probe_capabilities("antigravity")["status"] != "supported":
            raise ProviderRejected("Antigravity version changed or is unsupported; probe host capabilities again")
        return AntigravityAdapter(session, journal)
    if session["provider"] == "claude":
        from chat_claude import ClaudeAdapter
        if probe_capabilities("claude")["status"] != "supported":
            raise ProviderRejected("Claude SDK, CLI version, or supported authentication is unavailable; probe host capabilities again")
        return ClaudeAdapter(session, journal)
    raise ProviderRejected("Structured adapter is not available for this provider/version")
