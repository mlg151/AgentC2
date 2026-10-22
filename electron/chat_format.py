"""Bounded, explicit provider text formatting for normalized events."""

import json
from chat_protocol import CONTRACT


def display(value, maximum=None):
    value = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    maximum = maximum or CONTRACT["limits"]["text"]
    value = value.replace("\0", "\ufffd")
    raw = value.encode("utf-16-le")
    if len(raw) > maximum * 2:
        suffix = "\n[Output truncated; full content remains on the provider host]"
        return raw[:(maximum - len(suffix)) * 2].decode("utf-16-le", errors="ignore") + suffix
    return value
