"""Load production helper fragments with real filenames for traceable coverage."""


def exec_sources(scope, *paths):
    for path in paths:
        exec(compile(path.read_text(), str(path), "exec"), scope)
