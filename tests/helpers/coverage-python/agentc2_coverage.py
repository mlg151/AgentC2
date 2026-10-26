"""Attribute unchanged deployed worker copies to their production source files."""
from pathlib import Path
import hashlib

from coverage import CoveragePlugin, FileTracer

SOURCE = Path(__file__).resolve().parents[3] / "electron"


class CopiedFile(FileTracer):
    def __init__(self, source):
        self.source = str(source)

    def source_filename(self):
        return self.source


class CopiedSources(CoveragePlugin):
    def file_tracer(self, filename):
        deployed = Path(filename)
        if deployed.name.startswith("agentc2-image-upload-"):
            source = SOURCE / "image-upload.py"
            digest = hashlib.sha256(source.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            if deployed.name == "agentc2-image-upload-" + digest + ".py":
                return CopiedFile(source)
            return None
        source = SOURCE / ("session-hook.py" if deployed.name == "hook.py" else deployed.name)
        if not source.is_file() or source.suffix != ".py":
            return None
        if deployed == source:
            return CopiedFile(source)
        try:
            # Frozen legacy workers and modified fixtures must never be credited
            # as execution of the current worker merely because names match.
            if deployed.read_bytes() == source.read_bytes():
                return CopiedFile(source)
        except OSError:
            pass
        return None

    def file_reporter(self, filename):
        return "python"


def coverage_init(reg, options):
    reg.add_file_tracer(CopiedSources())
