"""Reproduce Coverage.py's real mixed-tracer merge failure without providers."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

from coverage import Coverage, CoverageData
from coverage.exceptions import DataError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("normalize_coverage", ROOT / "scripts/normalize-coverage.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Normalization(unittest.TestCase):
    def test_lambda_definitions_need_actual_calls_and_ambiguous_lines_stay_unknown(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-coverage-lambdas-") as directory:
            root = Path(directory)
            source = root / "electron"
            source.mkdir()
            file = source / "fixture.py"
            file.write_text('"Fixture"\nunused = lambda value: value + 1\nused = lambda value: value + 2\ndef owner(): return lambda: 3\npair = (lambda: 4, lambda: 5)\n')
            data_file = root / ".coverage"
            collector = Coverage(data_file=str(data_file), source=[str(source)], branch=True, config_file=False)
            collector.set_option('run:core', 'ctrace')
            scope = {}
            collector.start()
            try:
                exec(compile(file.read_text(), str(file), "exec"), scope)
                self.assertEqual(scope["used"](1), 3)
                scope["owner"]()
                scope["pair"][0]()
            finally:
                collector.stop()
                collector.save()
            self.assertIn(2, collector.get_data().lines(str(file)), 'The unused callback definition executed')
            result = module.lambda_coverage(data_file, source)["electron/fixture.py"]
            self.assertEqual(result, {"total": 5, "covered": 1, "ambiguousLines": [4, 5]})

    def test_mixed_source_labels_reproduce_failure_and_preserve_all_arcs_contexts(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-coverage-merge-") as directory:
            root = Path(directory)
            inputs = []
            for name, context, arcs, plugin in [
                ("original", "unit", [(1, 2), (2, -1)], ""),
                ("deployed", "integration", [(1, 3), (3, -1)], "agentc2_coverage.CopiedSources"),
            ]:
                data = CoverageData(basename=str(root / name))
                data.set_context(context)
                data.add_arcs({"fixture.py": arcs, "unexecuted.py": []})
                data.touch_files(["fixture.py", "unexecuted.py"])
                if plugin:
                    data.add_file_tracers({"fixture.py": plugin})
                data.write()
                inputs.append(data)
            broken = CoverageData(basename=str(root / "broken"))
            broken.update(inputs[0])
            with self.assertRaisesRegex(DataError, "Conflicting file tracer"):
                broken.update(inputs[1])
            combined = CoverageData(basename=str(root / "combined"))
            for name in ["original", "deployed"]:
                normalized = root / (name + "-normalized")
                module.normalize(root / name, normalized)
                data = CoverageData(basename=str(normalized))
                data.read()
                self.assertEqual(data.file_tracer("fixture.py"), "")
                combined.update(data)
            self.assertEqual(combined.measured_contexts(), {"unit", "integration"})
            self.assertEqual(combined.measured_files(), {"fixture.py", "unexecuted.py"})
            self.assertEqual(set(combined.arcs("fixture.py")), {(1, 2), (2, -1), (1, 3), (3, -1)})
            for context, expected in [("unit", {(1, 2), (2, -1)}), ("integration", {(1, 3), (3, -1)})]:
                combined.set_query_context(context)
                self.assertEqual(set(combined.arcs("fixture.py")), expected)
            unchanged = CoverageData(basename=str(root / "deployed"))
            unchanged.read()
            self.assertEqual(unchanged.file_tracer("fixture.py"), "agentc2_coverage.CopiedSources")

    def test_line_only_execution_is_rejected_but_unexecuted_files_remain(self):
        with tempfile.TemporaryDirectory(prefix="agentc2-coverage-merge-") as directory:
            root = Path(directory)
            data = CoverageData(basename=str(root / "line-only"))
            data.add_lines({"fixture.py": [1]})
            data.write()
            with self.assertRaisesRegex(ValueError, "branch coverage is missing"):
                module.normalize(root / "line-only", root / "rejected")
            empty = CoverageData(basename=str(root / "unexecuted"))
            empty.add_lines({"fixture.py": []})
            empty.touch_files(["fixture.py"])
            empty.write()
            module.normalize(root / "unexecuted", root / "preserved")
            preserved = CoverageData(basename=str(root / "preserved"))
            preserved.read()
            self.assertTrue(preserved.has_arcs())
            self.assertEqual(preserved.measured_files(), {"fixture.py"})
            self.assertEqual(preserved.arcs("fixture.py"), [])


if __name__ == "__main__":
    unittest.main()
