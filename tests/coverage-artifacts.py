"""Portable Python coverage must retain arcs and contexts without accepting lines-only data."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from coverage import CoverageData

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("coverage_data", ROOT / "scripts" / "coverage-data.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PortableCoverageTests(unittest.TestCase):
    def test_native_paths_and_foreign_sources(self):
        for name, root in [("D:\\a\\AgentC2\\electron\\fixture.py", "d:\\a\\AgentC2"), ("/work/AgentC2/electron/fixture.py", "/work/AgentC2"), ("electron/fixture.py", "/work/AgentC2")]:
            self.assertEqual(module.portable_file(name, root), "electron/fixture.py")
        for name in ("../electron/fixture.py", "/etc/fixture.py", "tests/fixture.py", "electron/../fixture.py"):
            with self.assertRaises(ValueError):
                module.portable_file(name, "/work/AgentC2")

    def test_arcs_contexts_unexecuted_files_and_tracer_labels_survive_export(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-portable-python-") as temporary:
            directory = Path(temporary)
            data = CoverageData(basename=str(directory / ".coverage.one"))
            data.set_context("first")
            data.add_arcs({"electron/fixture.py": [(-1, 2), (2, -1)]})
            data.add_file_tracers({"electron/fixture.py": "agentc2_coverage.CopiedSources"})
            data.set_context("second")
            data.add_arcs({"electron/fixture.py": [(-4, 5), (5, -4)]})
            data.touch_files(["electron/unexecuted.py"])
            data.write()
            exported = module.export_data(directory, directory)
            self.assertTrue(exported["branchCoverage"])
            self.assertEqual(exported["processReports"], 1)
            self.assertEqual(exported["files"]["electron/fixture.py"], {"first": [(-1, 2), (2, -1)], "second": [(-4, 5), (5, -4)]})
            metadata = {"sources": {"electron/fixture.py": "hash", "electron/unexecuted.py": "hash", "electron/never-loaded.py": "hash"}}
            output = directory / "combined"
            module.merge_data([{"label": "linux-ssh", "metadata": metadata, "python": json.loads(json.dumps(exported))}], output)
            combined = CoverageData(basename=str(output))
            combined.read()
            self.assertTrue(combined.has_arcs())
            self.assertEqual(set(combined.measured_files()), set(metadata["sources"]))
            self.assertEqual(set(combined.measured_contexts()), {"linux-ssh:first", "linux-ssh:second"})
            self.assertEqual(sorted(combined.arcs("electron/fixture.py")), [(-4, 5), (-1, 2), (2, -1), (5, -4)])
            self.assertEqual(combined.file_tracer("electron/fixture.py"), "")

    def test_missing_execution_and_line_only_collection_cannot_borrow_arcs(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-portable-python-") as temporary:
            directory = Path(temporary)
            self.assertEqual(module.export_data(directory, directory)["processReports"], 0)
            data = CoverageData(basename=str(directory / ".coverage.lines"))
            data.add_lines({"electron/fixture.py": [1, 2]})
            data.write()
            with self.assertRaisesRegex(ValueError, "branch coverage is missing"):
                module.export_data(directory, directory)


if __name__ == "__main__":
    unittest.main()
