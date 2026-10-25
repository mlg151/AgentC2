"""Collector attribution must distinguish current source from legacy workers."""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from helpers.python_sources import exec_sources

ROOT = Path(__file__).resolve().parents[1]


class CoverageSources(unittest.TestCase):
    def setUp(self):
        # The policy test itself uses only stdlib. Actual pinned Coverage.py is
        # exercised by the opt-in coverage run, including private SDK venvs.
        dependency = types.ModuleType("coverage")
        dependency.CoveragePlugin = type("CoveragePlugin", (), {})
        dependency.FileTracer = type("FileTracer", (), {})
        source = ROOT / "tests/helpers/coverage-python/agentc2_coverage.py"
        spec = importlib.util.spec_from_file_location("coverage_source_policy", source)
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"coverage": dependency}):
            spec.loader.exec_module(self.module)
        self.plugin = self.module.CopiedSources()

    def test_original_and_identical_copy_use_the_same_tracer(self):
        source = ROOT / "electron/chat_worker.py"
        self.assertEqual(self.plugin.file_tracer(str(source)).source_filename(), str(source))
        with tempfile.TemporaryDirectory(prefix="agentc2-coverage-source-") as directory:
            deployed = Path(directory) / source.name
            shutil.copyfile(source, deployed)
            self.assertEqual(self.plugin.file_tracer(str(deployed)).source_filename(), str(source))
            deployed.write_bytes(deployed.read_bytes() + b"\n# frozen legacy worker\n")
            self.assertIsNone(self.plugin.file_tracer(str(deployed)))
            deployed.unlink()
            self.assertIsNone(self.plugin.file_tracer(str(deployed)))

    def test_hook_rename_unknown_files_and_read_errors(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-coverage-source-") as directory:
            deployed = Path(directory) / "hook.py"
            source = ROOT / "electron/session-hook.py"
            shutil.copyfile(source, deployed)
            self.assertEqual(self.plugin.file_tracer(str(deployed)).source_filename(), str(source))
            with patch.object(self.module.Path, "read_bytes", side_effect=OSError("Unreadable fixture")):
                self.assertIsNone(self.plugin.file_tracer(str(deployed)))
            for name in ("unknown.py", "chat-protocol.json"):
                other = Path(directory) / name
                other.write_text("fixture")
                self.assertIsNone(self.plugin.file_tracer(str(other)))
        self.assertEqual(self.plugin.file_reporter(str(source)), "python")
        registered = []
        self.module.coverage_init(types.SimpleNamespace(add_file_tracer=registered.append), {})
        self.assertEqual(len(registered), 1)
        self.assertIsInstance(registered[0], self.module.CopiedSources)

    def test_fragment_loader_retains_filenames_and_shared_scope(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-coverage-source-") as directory:
            first, second = Path(directory) / "first.py", Path(directory) / "second.py"
            first.write_text("base = 40\ndef first():\n    return base\n")
            second.write_text("def second():\n    return first() + 2\n")
            scope = {}
            exec_sources(scope, first, second)
            self.assertEqual(scope["second"](), 42)
            self.assertEqual(scope["first"].__code__.co_filename, str(first))
            self.assertEqual(scope["second"].__code__.co_filename, str(second))


if __name__ == "__main__":
    unittest.main()
