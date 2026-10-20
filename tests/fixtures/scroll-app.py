"""A fullscreen transcript fixture. No provider CLI or model calls are used."""
import os
import re
import signal
import sys
import termios
import tty

label = sys.argv[1]
position = 0
last_input = "ready"
previous = termios.tcgetattr(sys.stdin)
tty.setraw(sys.stdin)


def draw(*_):
    columns, rows = os.get_terminal_size()
    lines = [f"HQ_FULLSCREEN_{label}_POSITION_{position}", f"Input: {last_input}"]
    lines += [f"Transcript line {400 - position + row:04d}" for row in range(max(0, rows - 3))]
    sys.stdout.write("\x1b[H\x1b[2J" + "\r\n".join(line[:columns - 1] for line in lines))
    sys.stdout.flush()


try:
    sys.stdout.write("\x1b[?1049h")
    if label == "MOUSE":
        sys.stdout.write("\x1b[?1003h\x1b[?1006h")
    signal.signal(signal.SIGWINCH, draw)
    draw()
    pending = b""
    keys = {b"\x1b[5~": (20, "page-up"), b"\x1b[6~": (-20, "page-down"),
            b"\x1b[1;5F": (-400, "latest")}
    while True:
        pending += os.read(sys.stdin.fileno(), 4096)
        while pending:
            matched = next((key for key in keys if pending.startswith(key)), None)
            mouse = re.match(rb"\x1b\[<(64|65);\d+;\d+M", pending)
            if matched:
                delta, last_input = keys[matched]
                pending = pending[len(matched):]
            elif mouse:
                delta = 3 if mouse[1] == b"64" else -3
                last_input = "wheel-up" if delta > 0 else "wheel-down"
                pending = pending[mouse.end():]
            elif any(key.startswith(pending) for key in keys) or pending.startswith(b"\x1b[<"):
                break
            else:
                pending = pending[1:]
                continue
            position = max(0, min(400, position + delta))
            draw()
finally:
    sys.stdout.write("\x1b[?1003l\x1b[?1006l\x1b[?1049l")
    sys.stdout.flush()
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, previous)
