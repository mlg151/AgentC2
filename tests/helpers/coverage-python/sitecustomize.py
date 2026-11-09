"""Opt-in coverage for Python children launched by the standalone test suites."""
import os

if os.environ.get("COVERAGE_PROCESS_START"):
    import coverage
    coverage.process_startup()
