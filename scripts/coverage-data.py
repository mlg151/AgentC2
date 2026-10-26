"""Portable, lossless Python branch data for native CI coverage artifacts."""
import json
from pathlib import Path, PureWindowsPath
import re
import sys

import coverage
from coverage import CoverageData


def portable_file(filename, root):
    name = filename.replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", name):
        relative = PureWindowsPath(name).relative_to(PureWindowsPath(root))
        name = relative.as_posix()
    elif name.startswith("/"):
        name = Path(name).relative_to(Path(root)).as_posix()
    if not name.startswith("electron/") or ".." in name.split("/") or not name.endswith(".py"):
        raise ValueError(f"Unexpected Python coverage source: {filename}")
    return name


def export_data(directory, root):
    if coverage.__version__ != "7.16.0":
        raise ValueError("Coverage.py 7.16.0 is required")
    merged = {}
    reports = sorted(directory.glob(".coverage.*"))
    for file in reports:
        data = CoverageData(basename=str(file))
        data.read()
        files = sorted(data.measured_files())
        if not data.has_arcs() and any(data.lines(name) for name in files):
            raise ValueError(f"Python branch coverage is missing: {file.name}")
        for context in sorted(data.measured_contexts()) or [""]:
            data.set_query_context(context)
            for name in files:
                key = portable_file(name, root)
                arcs = data.arcs(name) or [] if data.has_arcs() else []
                merged.setdefault(key, {}).setdefault(context, set()).update(tuple(arc) for arc in arcs)
    return {"version": coverage.__version__, "branchCoverage": True, "processReports": len(reports),
            "files": {name: {context: sorted(arcs) for context, arcs in contexts.items()} for name, contexts in sorted(merged.items())}}


def merge_data(artifacts, destination):
    output = CoverageData(basename=str(destination))
    output.erase()
    measured = set()
    for artifact in artifacts:
        data = artifact["python"]
        if data["version"] != "7.16.0" or data["branchCoverage"] is not True:
            raise ValueError("Pinned Python branch data is required")
        for name, contexts in data["files"].items():
            if portable_file(name, "") != name:
                raise ValueError("Python artifact paths must be relative")
            measured.add(name)
            for context, arcs in contexts.items():
                output.set_context(artifact["label"] + ":" + context)
                output.add_arcs({name: [tuple(arc) for arc in arcs]})
    expected = {name for name in artifacts[0]["metadata"]["sources"] if name.endswith(".py")}
    output.add_arcs({name: [] for name in expected})
    output.touch_files(expected | measured)
    output.write()


if __name__ == "__main__":
    if sys.argv[1] == "export":
        directory, root, destination = map(Path, sys.argv[2:])
        destination.write_text(json.dumps(export_data(directory, root)) + "\n")
    elif sys.argv[1] == "merge":
        manifest, destination = map(Path, sys.argv[2:])
        merge_data([json.loads(Path(file).read_text()) for file in json.loads(manifest.read_text())], destination)
    else:
        raise ValueError("Unknown Python coverage artifact operation")
