"""Run the production OpOrder helper in a disposable test home."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
scope = {"__name__": "centcom_oporder_fixture"}
for name in ("remote.py", "oporders.py"):
    source = root / "electron" / name
    exec(compile(source.read_text(), str(source), "exec"), scope)
request = json.load(sys.stdin)
scope["HOME"] = Path(request.pop("fixtureHome"))
assert Path(request["order"]["repository"]).is_relative_to(scope["HOME"])
assert request["action"] in ("oporder_preview", "oporder_sync")
print(json.dumps(scope[request["action"]](request)))
