#!/usr/bin/env python3
"""Local GitHub protocol fixture; never calls GitHub or reads credentials."""
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["AGENTC2_CODEX_FIXTURE_DIR"])
settings = json.loads((root / "github.json").read_text())
args = sys.argv[1:]
with (root / "github-calls.jsonl").open("a") as stream:
    stream.write(json.dumps(args) + "\n")
issue = dict(number=69, title="Fixture task", body="Write the reviewed fixture artifact", url="https://github.com/fixture/repo/issues/69", state="OPEN", updatedAt=settings.get("updatedAt", "2026-01-01T00:00:00Z"), labels=[])
pr = dict(number=70, title="Fixture change", url="https://github.com/fixture/repo/pull/70", state="OPEN", isDraft=True, headRefOid=settings["commit"], headRefName="fixture-branch", baseRefName="main", reviewDecision="", statusCheckRollup=[])
if args == ["api", "user"]:
    result = dict(login="fixture")
elif args[:2] == ["api", "repos/fixture/repo"]:
    result = dict(full_name="fixture/repo", default_branch="main", permissions=dict(push=True))
elif args[0] == "api" and args[1].startswith("repos/fixture/repo/compare/"):
    result = dict(status="identical")
elif args[:2] == ["issue", "view"]:
    result = issue
elif args[:2] == ["issue", "list"]:
    result = [issue]
elif args[:2] == ["pr", "view"]:
    result = pr
elif args[:2] in (["issue", "close"], ["pr", "ready"]):
    (root / ("github-" + args[1] + ".json")).write_text(json.dumps(args))
    sys.exit(0)
else:
    raise RuntimeError("Unsupported fixture gh operation: " + repr(args))
print(json.dumps(result))
