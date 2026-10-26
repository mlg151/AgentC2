"""Exercise the transferred PNG helper without a real user's upload directory."""
import base64
import json
import io
from contextlib import redirect_stderr, redirect_stdout
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import types
import zlib

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "electron/image-upload.py"


def chunk(kind, data):
    return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")


PNG = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\0" * 13) + chunk(b"IEND", b"")


class ImageUpload(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agentc2-upload-helper-")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.root = self.home / ".cache/agent-hq/uploads"

    def run_helper(self, data, transferred=False):
        arguments = [str(HELPER)]
        if transferred:
            encoded = base64.b64encode(HELPER.read_bytes().replace(b"\r\n", b"\n")).decode()
            program = 'import base64,hashlib; source=base64.b64decode("' + encoded + '"); exec(compile(source,"agentc2-image-upload-"+hashlib.sha256(source).hexdigest()+".py","exec"))'
            arguments = ["-c", program]
        return subprocess.run([sys.executable, *arguments], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "HOME": str(self.home)}, timeout=10)

    def test_direct_and_transferred_png_bytes_private_permissions_and_cleanup(self):
        self.root.mkdir(parents=True)
        stale = self.root / ("agentc2-" + "a" * 32 + ".png")
        partial = self.root / ("agentc2-" + "b" * 32 + ".part")
        unrelated = self.root / "user-image.png"
        recent = self.root / ("agentc2-" + "c" * 32 + ".png")
        linked = self.root / ("agentc2-" + "d" * 32 + ".png")
        link = self.root / ("agentc2-" + "e" * 32 + ".png")
        for file in [stale, partial, unrelated, recent, linked]:
            file.write_bytes(b"fixture")
            if file != recent:
                os.utime(file, (time.time() - 9 * 86400,) * 2)
        os.link(linked, self.root / "retained-hardlink")
        link.symlink_to(unrelated)
        for transferred in [False, True]:
            result = self.run_helper(PNG, transferred)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            value = json.loads(result.stdout)
            output = Path(value["path"])
            self.assertEqual(output.parent, self.root)
            self.assertEqual(value["bytes"], len(PNG))
            self.assertEqual(output.read_bytes(), PNG)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(list(self.root.glob("*.part")), [])
        self.assertFalse(stale.exists())
        self.assertFalse(partial.exists())
        for file in [unrelated, recent, linked, link]:
            self.assertTrue(file.exists())

    def test_corruption_truncation_header_trailing_bytes_and_bounded_input(self):
        invalid = [
            b"small", b"x" * 45, b"x" * (8 * 1024 * 1024 + 1),
            PNG[:-1], PNG[:8] + (9 * 1024 * 1024).to_bytes(4, "big") + b"IHDR" + b"x" * 20,
            PNG[:20] + bytes([PNG[20] ^ 1]) + PNG[21:],
            PNG[:8] + chunk(b"WRNG", b"\0" * 13) + chunk(b"IEND", b""),
            PNG[:8] + chunk(b"IHDR", b"\0" * 12) + chunk(b"IEND", b""),
            PNG + b"trailing", PNG[:-12] + chunk(b"IEND", b"nonempty"),
            PNG[:-12],
        ]
        for data in invalid:
            with self.subTest(length=len(data), prefix=data[:16]):
                result = self.run_helper(data)
                self.assertEqual(result.returncode, 1)
                self.assertIn(b"Clipboard PNG", result.stderr)
                self.assertEqual(result.stdout, b"")
        self.assertFalse(self.root.exists(), "Invalid PNGs must fail before creating an upload directory")

    def run_in_process(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(Path, "home", return_value=self.home), patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(PNG))), redirect_stdout(output), redirect_stderr(errors):
            exec(compile(HELPER.read_text(), str(HELPER), "exec"), {})
        self.assertEqual(errors.getvalue(), "")
        value = json.loads(output.getvalue())
        self.assertEqual(Path(value["path"]).read_bytes(), PNG)
        return value

    def test_unreadable_cleanup_entry_does_not_abort_new_transfer(self):
        self.root.mkdir(parents=True)
        unreadable = self.root / ("agentc2-" + "f" * 32 + ".png")
        unreadable.write_bytes(b"existing fixture")
        original = Path.lstat

        def inspect(file, *args, **kwargs):
            if file == unreadable:
                raise PermissionError("Fixture cleanup entry is unreadable")
            return original(file, *args, **kwargs)

        with patch.object(Path, "lstat", inspect):
            self.run_in_process()
        self.assertEqual(unreadable.read_bytes(), b"existing fixture")

    def test_temporary_disappearance_after_link_preserves_committed_png(self):
        original = os.link

        def link_and_remove(source, destination, **kwargs):
            original(source, destination, **kwargs)
            Path(source).unlink()

        with patch.object(os, "link", link_and_remove):
            self.run_in_process()
        self.assertEqual(list(self.root.glob("*.part")), [])

    def test_symlinked_parent_is_rejected_without_writing(self):
        target = self.home / "other"
        target.mkdir()
        self.root.parent.parent.mkdir(parents=True)
        self.root.parent.symlink_to(target, target_is_directory=True)
        result = self.run_helper(PNG)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"ownership is unsafe", result.stderr)
        self.assertEqual(list(target.iterdir()), [])

    def test_symlinked_upload_root_is_rejected_without_writing(self):
        target = self.home / "other"
        target.mkdir()
        self.root.parent.mkdir(parents=True)
        self.root.symlink_to(target, target_is_directory=True)
        result = self.run_helper(PNG)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"ownership is unsafe", result.stderr)
        self.assertEqual(list(target.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
