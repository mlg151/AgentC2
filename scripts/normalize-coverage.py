"""Keep Python arcs/contexts while removing redundant source-tracer labels.

The collector has already mapped byte-identical worker copies to their Python
source filenames. Coverage.py also touches unexecuted files using its default
tracer label. Those empty rows conflict with the copy tracer during combine.
Every mapped file is plain Python, so both labels use the same Python reporter.
Raw databases remain untouched as evidence.
"""
from pathlib import Path
import ast
from collections import Counter
import json
import sys

from coverage import CoverageData


def normalize(source, destination):
    data = CoverageData(basename=str(source))
    data.read()
    output = CoverageData(basename=str(destination))
    files = sorted(data.measured_files())
    if not data.has_arcs():
        if any(data.lines(file) for file in files):
            raise ValueError(f"Python branch coverage is missing: {source.name}")
        output.add_arcs({file: [] for file in files})
    else:
        for context in sorted(data.measured_contexts()) or [""]:
            data.set_query_context(context)
            output.set_context(context)
            output.add_arcs({file: data.arcs(file) or [] for file in files})
    output.touch_files(files)
    output.write()


def lambda_coverage(data_file, source_directory):
    data = CoverageData(basename=str(data_file))
    data.read()
    results = {}
    for file in sorted(source_directory.glob("*.py")):
        tree = ast.parse(file.read_text(), filename=str(file))
        functions = [node for node in ast.walk(tree) if isinstance(node, ast.Lambda)]
        counts = Counter(node.lineno for node in functions)
        definitions = {node.lineno for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
        relative = file.relative_to(source_directory.parent).as_posix()
        arcs = data.arcs(relative) or data.arcs(str(file)) or []
        entered = {-start for start, _end in arcs if start < 0}
        # An executed definition line does not prove the callback ran. Negative
        # entry arcs are runtime call evidence. Ambiguous shared lines stay
        # uncovered rather than borrowing another code object's entry evidence.
        ambiguous = {node.lineno for node in functions if counts[node.lineno] > 1 or node.lineno in definitions or node.lineno == 1}
        results[relative] = {"total": len(functions), "covered": sum(node.lineno in entered and node.lineno not in ambiguous for node in functions), "ambiguousLines": sorted(ambiguous)}
    return results


if __name__ == "__main__":
    if sys.argv[1] == "--functions":
        data_file, source_directory, destination = map(Path, sys.argv[2:])
        destination.write_text(json.dumps(lambda_coverage(data_file, source_directory), indent=2) + "\n")
        sys.exit(0)
    source, destination = map(Path, sys.argv[1:])
    destination.mkdir(parents=True, exist_ok=True)
    files = sorted(source.glob(".coverage.*"))
    if not files:
        raise ValueError("Python process coverage is missing; collect suites first")
    for file in files:
        normalize(file, destination / file.name)
    print(f"Normalized {len(files)} Python process reports without changing source arcs or contexts")
