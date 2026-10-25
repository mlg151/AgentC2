"""Keep Python arcs/contexts while removing redundant source-tracer labels.

The collector has already mapped byte-identical worker copies to their Python
source filenames. Coverage.py also touches unexecuted files using its default
tracer label. Those empty rows conflict with the copy tracer during combine.
Every mapped file is plain Python, so both labels use the same Python reporter.
Raw databases remain untouched as evidence.
"""
from pathlib import Path
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


if __name__ == "__main__":
    source, destination = map(Path, sys.argv[1:])
    destination.mkdir(parents=True, exist_ok=True)
    files = sorted(source.glob(".coverage.*"))
    if not files:
        raise ValueError("Python process coverage is missing; collect suites first")
    for file in files:
        normalize(file, destination / file.name)
    print(f"Normalized {len(files)} Python process reports without changing source arcs or contexts")
