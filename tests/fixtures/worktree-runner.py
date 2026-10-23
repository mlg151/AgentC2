"""Exercise production worktree helpers without launching a provider."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
scope = {"__name__": "centcom_worktree_fixture"}
for name in ("worktrees.py", "provider_telemetry.py", "remote.py", "exercises.py"):
    exec((root / "electron" / name).read_text(), scope)
request = json.load(sys.stdin)
home = Path(request.pop("fixtureHome")).resolve()
scope["WORKTREE_ROOT"] = home / "owned"
assert request["action"] in ("worktree_launch", "worktree_list", "exercise_base")
if request.get("repository"):
    assert Path(request["repository"]).resolve().is_relative_to(home)
fail = request.pop("fixtureFail", False)

def create(payload):
    with (home / "provider-attempts.jsonl").open("a") as stream:
        stream.write(json.dumps({"name": payload["managedName"]}) + "\n")
    if fail:
        raise RuntimeError("Fixture provider launch failed after provisioning")
    return {"name": payload["managedName"]}

scope["create"] = create
try:
    print(json.dumps({"result": scope[request["action"]](request)}))
except Exception as error:
    print(json.dumps({"error": str(error)}))
