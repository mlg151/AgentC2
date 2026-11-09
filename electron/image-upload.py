
import json, os, re, stat, sys, time, uuid, zlib
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024
SIGNATURE = b'\x89PNG\r\n\x1a\n'
parent = Path.home() / '.cache' / 'agent-hq'
root = parent / 'uploads'

def main():
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) < 24 or len(data) > MAX_BYTES or not data.startswith(SIGNATURE):
        raise ValueError('Clipboard PNG is missing, invalid, or larger than 8 MB')
    cursor = 8
    while cursor + 12 <= len(data):
        size = int.from_bytes(data[cursor:cursor + 4], 'big')
        end = cursor + size + 12
        if end > len(data) or size > MAX_BYTES:
            raise ValueError('Clipboard PNG transfer is incomplete')
        kind = data[cursor + 4:cursor + 8]
        chunk = data[cursor + 4:end - 4]
        if zlib.crc32(chunk) != int.from_bytes(data[end - 4:end], 'big'):
            raise ValueError('Clipboard PNG transfer failed integrity check')
        if cursor == 8 and (kind != b'IHDR' or size != 13):
            raise ValueError('Clipboard PNG has no image header')
        cursor = end
        if kind == b'IEND':
            if size != 0 or cursor != len(data):
                raise ValueError('Clipboard PNG has trailing or invalid data')
            break
    else:
        raise ValueError('Clipboard PNG transfer is incomplete')
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if parent.is_symlink() or parent.stat().st_uid != os.getuid() or not parent.is_dir():
        raise ValueError('Upload directory ownership is unsafe')
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or not root.is_dir():
        raise ValueError('Upload directory ownership is unsafe')
    root.chmod(0o700)
    # Only old AgentC2-generated names are removed; never touch other files.
    cutoff = time.time() - 7 * 86400
    for item in root.iterdir():
        if not re.fullmatch(r'agentc2-[a-f0-9]{32}\.(png|part)', item.name):
            continue
        try:
            info = item.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and info.st_mtime < cutoff:
                item.unlink()
        except OSError:
            pass
    name = 'agentc2-' + uuid.uuid4().hex
    temporary, final = root / (name + '.part'), root / (name + '.png')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, final, follow_symlinks=False)
    finally:
        try: temporary.unlink()
        except FileNotFoundError: pass
    print(json.dumps({'path': str(final), 'bytes': len(data)}))

try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
