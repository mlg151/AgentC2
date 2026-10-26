"""In-memory Codex native protocol dependencies; no CLI or model calls."""
import io
import types
from unittest.mock import Mock


def process(wire=b""):
    return types.SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(wire), pid=424242,
                                 poll=Mock(return_value=None), wait=Mock(return_value=0))


def thread_result(root, active=False):
    return dict(thread=dict(id="native-thread", sessionId="fixture-session", cliVersion="0.163.0", createdAt=0, updatedAt=0, cwd=str(root), ephemeral=False, modelProvider="fixture", preview="", projectId=None, source="appServer", status=dict(type="active", activeFlags=[]) if active else dict(type="idle"), turns=[]),
                approvalPolicy="on-request", approvalsReviewer="user", cwd=str(root), model="fixture", modelProvider="fixture", sandbox=dict(type="readOnly"))


def approval(identifier=1, thread="native-thread", command="Reviewed fixture command"):
    return dict(id=identifier, method="item/commandExecution/requestApproval", params=dict(threadId=thread, turnId="turn", itemId="tool", command=command, cwd="/fixture", startedAtMs=0))


def question(identifier=2, secret=False, options=None):
    return dict(id=identifier, method="item/tool/requestUserInput", params=dict(threadId="native-thread", turnId="turn", itemId="question", isBlocking=True,
                questions=[dict(id="choice", header="Choice", question="Reviewed fixture question", isSecret=secret, options=options)]))
