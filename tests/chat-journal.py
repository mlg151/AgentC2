"""No provider credentials or model calls: real SQLite persistence and races."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
from chat_journal import Journal
from chat_protocol import CONTRACT, unavailable_capabilities, validate_capabilities, validate_command, validate_event


def command(operation, payload=None, identifier=None, command_id=None):
    result = dict(protocolVersion=1, commandId=command_id or str(uuid.uuid4()), operation=operation, payload=payload or {})
    if identifier is not None:
        result["sessionId"] = identifier
    return result


def capabilities():
    return dict(provider="codex", version="0.163.0", status="supported", reason=None, **{name: name in ("streaming", "history", "resume", "interrupt", "approvals", "questions", "steering") for name in CONTRACT["capabilities"]})


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentc2-chat-journal-")
        self.directory = Path(self.temp.name) / "store"
        self.journal = Journal(self.directory)
        self.creation = command("create", dict(provider="codex", cwd="/tmp/repo", title="Fixture", roeProfile="gated"))
        receipt, fresh = self.journal.accept(self.creation, capabilities())
        self.assertTrue(fresh)
        self.identifier = receipt["sessionId"]
        self.journal.command_state(receipt["commandId"], "dispatching")
        self.journal.command_state(receipt["commandId"], "completed", dict(providerSessionId="thread-fixture"))
        self.journal.set_provider_session(self.identifier, "thread-fixture")
        self.journal.append(self.identifier, "session.updated", dict(state="idle", detail="Ready"))

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def send(self):
        submission = command("send", dict(text="Perform the fixture task"), self.identifier)
        return submission, self.journal.accept(submission)[0]

    def request(self, kind="approval.requested"):
        self.journal.append(self.identifier, "session.updated", dict(state="running", detail="Working"), "turn-one")
        data = dict(requestId="request-one", action="Write file", detail="Exact reviewed action") if kind == "approval.requested" else dict(requestId="request-one", questions=[dict(id="q1", question="Choose", options=["One", "Two"], multiple=False)])
        self.journal.append(self.identifier, kind, data, "turn-one", "item-one")
        return data

    def response(self, **extra):
        return command("respond", dict(requestId="request-one", turnId="turn-one", itemId="item-one", **extra), self.identifier)

    def test_managed_title_rename_survives_restart_without_changing_activity(self):
        creation = command("create", dict(provider="codex", cwd="/tmp/repo", title="Managed title", roeProfile="full", managedName="hq-123456abcdef"))
        receipt, _ = self.journal.accept(creation, capabilities())
        identifier = receipt["sessionId"]
        before = self.journal.history(identifier)["session"]
        with self.assertRaisesRegex(ValueError, "Managed session changed"):
            self.journal.rename(identifier, "hq-000000000000", "Wrong target")
        for title in ["", "\n", "\t", "x" * 101]:
            with self.assertRaisesRegex(ValueError, "Invalid session title"):
                self.journal.rename(identifier, "hq-123456abcdef", title)
        self.journal.rename(identifier, "hq-123456abcdef", "Updated title")
        self.journal.close()
        self.journal = Journal(self.directory)
        after = self.journal.history(identifier)["session"]
        self.assertEqual(after["title"], "Updated title")
        self.assertEqual(after["updatedAt"], before["updatedAt"])
        self.assertEqual(after["providerSessionId"], before["providerSessionId"])

    def test_lost_acknowledgement_returns_same_receipt_after_reopen(self):
        submission, first = self.send()
        self.journal.close()
        self.journal = Journal(self.directory)
        duplicate, fresh = self.journal.accept(submission)
        self.assertFalse(fresh)
        self.assertEqual(first, duplicate)
        changed = json.loads(json.dumps(submission))
        changed["payload"]["text"] = "A different task"
        with self.assertRaisesRegex(ValueError, "different content"):
            self.journal.accept(changed)

    def test_concurrent_retries_create_one_receipt_and_one_reservation(self):
        submission = command("send", dict(text="Exactly once"), self.identifier)
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: self.journal.accept(submission), range(24)))
        self.assertEqual(sum(fresh for _, fresh in results), 1)
        events = self.journal.history(self.identifier)["events"]
        self.assertEqual(sum(event["data"].get("detail") == "Message accepted; awaiting provider" for event in events), 1)

    def test_distinct_concurrent_sends_cannot_overlap(self):
        def attempt(_):
            try:
                self.journal.accept(command("send", dict(text="Task"), self.identifier))
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(sum(pool.map(attempt, range(24))), 1)

    def test_pagination_sequences_and_host_provider_identity(self):
        for i in range(12):
            self.journal.append(self.identifier, "message.delta", dict(text=str(i)), "turn-one", "message-one")
        page = self.journal.history(self.identifier, limit=5)
        self.assertTrue(page["hasMore"])
        self.assertEqual([e["sequence"] for e in page["events"]], list(range(1, 6)))
        following = self.journal.history(self.identifier, after=page["cursor"], limit=5)
        self.assertEqual(following["events"][0]["sequence"], 6)
        self.assertEqual(following["events"][0]["providerSessionId"], "thread-fixture")
        self.assertFalse(page["truncated"])
        for bad in (-1, True, 1.5, 9007199254740992):
            with self.assertRaises(ValueError):
                self.journal.history(self.identifier, after=bad)

    def test_pending_approval_survives_reopen_and_duplicate_is_one_shot(self):
        data = self.request()
        self.journal.close()
        self.journal = Journal(self.directory)
        self.assertEqual(self.journal.pending_requests(self.identifier)[0]["data"], data)
        response = self.response(decision="allow")
        first, fresh = self.journal.accept(response)
        self.assertTrue(fresh)
        self.assertEqual(self.journal.accept(response), (first, False))
        with self.assertRaisesRegex(ValueError, "already answered"):
            self.journal.accept(self.response(decision="deny"))

    def test_stale_wrong_turn_and_item_cannot_authorize(self):
        self.request()
        for field in ("turnId", "itemId", "requestId"):
            response = self.response(decision="allow")
            response["payload"][field] = "changed"
            with self.assertRaisesRegex(ValueError, "stale"):
                self.journal.accept(response)
        self.assertEqual(self.journal.pending_requests(self.identifier)[0]["state"], "pending")

    def test_turn_end_expires_request_and_prevents_late_reply(self):
        self.request()
        self.journal.append(self.identifier, "turn.completed", dict(outcome="interrupted", detail="Cancelled"), "turn-one")
        self.assertEqual(self.journal.pending_requests(self.identifier), [])
        self.assertEqual(self.journal.history(self.identifier)["session"]["state"], "idle")
        with self.assertRaises(ValueError):
            self.journal.accept(self.response(decision="allow"))

    def test_request_id_reuse_cannot_change_reviewed_action(self):
        data = self.request()
        before = self.journal.history(self.identifier)["cursor"]
        self.journal.append(self.identifier, "approval.requested", data, "turn-one", "item-one")
        self.assertEqual(self.journal.history(self.identifier)["cursor"], before)
        with self.assertRaisesRegex(ValueError, "different action"):
            self.journal.append(self.identifier, "approval.requested", {**data, "action": "Delete repository"}, "turn-one", "item-one")

    def test_question_answers_match_request_and_cardinality(self):
        self.request("question.requested")
        for answers in ([dict(questionId="other", answers=["One"])], [dict(questionId="q1", answers=["One", "Two"])], [dict(questionId="q1", answers=["One"])] * 2):
            with self.assertRaises(ValueError):
                self.journal.accept(self.response(answers=answers))
        _, fresh = self.journal.accept(self.response(answers=[dict(questionId="q1", answers=["One"])]))
        self.assertTrue(fresh)

    def test_worker_loss_marks_dispatch_unknown_without_resending(self):
        submission, _ = self.send()
        self.journal.command_state(submission["commandId"], "dispatching")
        self.request()
        self.assertEqual(self.journal.recover_worker_loss(), 1)
        self.assertEqual(self.journal.receipt(submission["commandId"])["state"], "unknown")
        self.assertFalse(self.journal.accept(submission)[1])
        self.assertEqual(self.journal.pending_requests(self.identifier), [])
        page = self.journal.history(self.identifier)
        self.assertEqual(page["session"]["state"], "unknown")
        self.assertFalse(page["events"][-1]["data"]["retryable"])
        self.assertEqual(self.journal.recover_worker_loss(), 0)

    def test_prune_preserves_sequence_and_deduplication_and_rejects_live(self):
        submission, _ = self.send()
        with self.assertRaisesRegex(ValueError, "confirmed stopped"):
            self.journal.prune_transcript(self.identifier)
        self.journal.append(self.identifier, "session.updated", dict(state="stopped", detail="Stopped"))
        with self.assertRaisesRegex(ValueError, "pending commands"):
            self.journal.prune_transcript(self.identifier)
        for receipt in self.journal.history(self.identifier)["pendingCommands"]:
            if receipt["state"] == "accepted":
                self.journal.command_state(receipt["commandId"], "dispatching")
            self.journal.command_state(receipt["commandId"], "completed", {})
        last = self.journal.history(self.identifier)["cursor"]
        self.journal.prune_transcript(self.identifier)
        page = self.journal.history(self.identifier)
        self.assertTrue(page["truncated"])
        self.assertEqual(page["retainedFrom"], last + 1)
        self.assertEqual(page["events"], [])
        self.assertFalse(self.journal.accept(submission)[1])
        event = self.journal.append(self.identifier, "error", dict(code="fixture", message="Diagnostic", retryable=False))
        self.assertEqual(event["sequence"], last + 1)

    def test_transaction_failure_rolls_back_receipt_and_session_mutation(self):
        before = self.journal.history(self.identifier)
        with self.assertRaises(ValueError):
            self.journal.append(self.identifier, "session.updated", dict(state="invented", detail=""))
        self.assertEqual(self.journal.history(self.identifier), before)
        unsupported = unavailable_capabilities("claude")
        with self.assertRaises(ValueError):
            self.journal.accept(command("create", dict(provider="claude", cwd="/tmp", title="", roeProfile="full")), unsupported)
        self.assertEqual(len(self.journal.list_sessions()), 1)

    @unittest.skipIf(os.name == "nt", "Remote journal runs on Linux hosts")
    def test_private_permissions_and_symlink_rejection(self):
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.directory / "journal.sqlite3").stat().st_mode & 0o777, 0o600)
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            Journal(alias)

    def test_future_schema_is_rejected(self):
        self.journal.close()
        db = sqlite3.connect(self.directory / "journal.sqlite3")
        db.execute("PRAGMA user_version=999")
        db.close()
        with self.assertRaisesRegex(ValueError, "version"):
            Journal(self.directory)
        db = sqlite3.connect(self.directory / "journal.sqlite3")
        db.execute("PRAGMA user_version=1")
        db.close()
        self.journal = Journal(self.directory)


if __name__ == "__main__":
    if "--protocol" in sys.argv:
        validators = dict(command=validate_command, event=validate_event, capabilities=validate_capabilities)
        result = []
        for case in json.load(sys.stdin):
            try:
                validators[case["kind"]](case["value"])
                result.append(True)
            except (ValueError, TypeError, KeyError, OverflowError):
                result.append(False)
        print(json.dumps(result))
    else:
        unittest.main()
