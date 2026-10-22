"""Read bounded provider metadata without returning transcript contents."""
import datetime
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

MAX_TAIL = 2 * 1024 * 1024
SESSION_ID = re.compile(r"[a-fA-F0-9-]{36}\Z")


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def epoch(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def safe_file(path, root):
    try:
        resolved = path.resolve(strict=True)
        info = path.lstat()
        return (resolved.is_relative_to(root.resolve(strict=True)) and stat.S_ISREG(info.st_mode)
                and info.st_uid == os.getuid() and info.st_nlink == 1)
    except OSError:
        return False


def tail_json(path):
    with path.open("rb") as stream:
        size = stream.seek(0, 2)
        stream.seek(max(0, size - MAX_TAIL))
        if size > MAX_TAIL:
            stream.readline()
        for raw in stream:
            if len(raw) > 256000:
                continue
            try:
                item = json.loads(raw)
                if isinstance(item, dict):
                    yield item
            except (UnicodeDecodeError, ValueError):
                continue


def token_rate(samples):
    recent = [(at, total) for at, total in samples if at is not None and total is not None and at >= time.time() - 60]
    if len(recent) < 2:
        return None
    recent.sort()
    span = recent[-1][0] - recent[0][0]
    delta = recent[-1][1] - recent[0][1]
    return round(delta * 60 / span, 1) if span >= 5 and delta >= 0 else None


def codex_telemetry(session_id, home):
    root = home / ".codex"
    db = root / "state_5.sqlite"
    if not db.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
        row = conn.execute("SELECT rollout_path FROM threads WHERE id=?", (session_id,)).fetchone()
        conn.close()
        path = Path(row[0]) if row and row[0] else None
        if not path or not safe_file(path, root / "sessions"):
            return None
        latest = None
        samples = []
        for item in tail_json(path):
            if item.get("type") != "event_msg" or (item.get("payload") or {}).get("type") != "token_count":
                continue
            info = (item.get("payload") or {}).get("info") or {}
            if not isinstance(info, dict):
                continue
            latest = (epoch(item.get("timestamp")), info)
            total = info.get("total_token_usage") or {}
            samples.append((latest[0], number(total.get("total_tokens")) if isinstance(total, dict) else None))
        if not latest:
            return None
        at, info = latest
        usage = info.get("last_token_usage") or {}
        total = info.get("total_token_usage") or {}
        capacity = number(info.get("model_context_window"))
        used = number(usage.get("input_tokens")) if isinstance(usage, dict) else None
        context = {"usedTokens": used, "capacityTokens": capacity, "percent": round(used * 100 / capacity, 1)} if used is not None and capacity and capacity > 0 else None
        return {"sampledAt": at, "context": context, "totalTokens": number(total.get("total_tokens")) if isinstance(total, dict) else None,
                "tokensPerMinute": token_rate(samples), "costUsd": None, "costBasis": None, "source": "codex-rollout"}
    except (OSError, sqlite3.Error, ValueError):
        return None


def claude_telemetry(session_id, home):
    root = home / ".claude" / "projects"
    try:
        path = next((candidate for candidate in root.glob(f"*/{session_id}.jsonl") if safe_file(candidate, root)), None)
        if not path:
            return None
        messages = {}
        cost = None
        cost_current = False
        for item in tail_json(path):
            if item.get("type") == "cost-state":
                cost = number(item.get("totalCostUSD")) if item.get("hasUnknownModelCost") is False else None
                cost_current = cost is not None
            if item.get("type") != "assistant" or item.get("isSidechain"):
                continue
            cost_current = False
            message = item.get("message") or {}
            if not isinstance(message, dict) or not isinstance(message.get("id"), str):
                continue
            usage = message.get("usage") or {}
            if not isinstance(usage, dict):
                continue
            parts = [number(usage.get(key)) for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
            if any(part is None for part in parts[:2]):
                continue
            at = epoch(item.get("timestamp"))
            count = sum(part or 0 for part in parts)
            previous = messages.get(message["id"])
            if not previous or count > previous[1]:
                messages[message["id"]] = (at, count)
        modified = path.stat().st_mtime
        recent = sorted((at, count) for at, count in messages.values() if at and at >= time.time() - 60)
        rate = None
        if len(recent) >= 2 and recent[-1][0] - recent[0][0] >= 5:
            rate = round(sum(count for _, count in recent) * 60 / (recent[-1][0] - recent[0][0]), 1)
        return {"sampledAt": modified, "context": None, "totalTokens": None, "tokensPerMinute": rate,
                "costUsd": cost if cost_current else None, "costBasis": "Claude-reported session estimate" if cost_current else None, "source": "claude-transcript-metadata"}
    except (OSError, ValueError):
        return None


def provider_telemetry(provider, session_id, home=None):
    if provider not in ("codex", "claude"):
        return {"status": "unsupported", "context": None, "totalTokens": None, "tokensPerMinute": None,
                "costUsd": None, "costBasis": None, "sampledAt": None, "source": None}
    result = None
    if isinstance(session_id, str) and SESSION_ID.fullmatch(session_id):
        result = (codex_telemetry if provider == "codex" else claude_telemetry)(session_id, Path(home) if home else Path.home())
    if not result:
        return {"status": "unknown", "context": None, "totalTokens": None, "tokensPerMinute": None,
                "costUsd": None, "costBasis": None, "sampledAt": None, "source": None}
    timestamp = result["sampledAt"]
    result["status"] = "reported" if timestamp and time.time() - timestamp <= 120 else "stale"
    result["sampledAt"] = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat().replace("+00:00", "Z") if timestamp else None
    return result
