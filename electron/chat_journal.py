"""Durable receipts, ordered events, and correlated requests for remote chat.

Only the worker dispatches commands. A stored receipt is never an instruction to
resend to a provider: after worker loss, in-flight dispatch is explicitly unknown.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import threading

from chat_protocol import CONTRACT, session_id, validate_capabilities, validate_command, validate_event


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def private_directory(directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Chat directory must be an owned, real directory")
    directory.chmod(0o700)
    return directory


class Journal:
    def __init__(self, directory):
        self.directory = private_directory(directory)
        database = self.directory / "journal.sqlite3"
        for candidate in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm")):
            if candidate.is_symlink() or (candidate.exists() and (not candidate.is_file() or candidate.stat().st_uid != os.getuid())):
                raise ValueError("Unsupported chat journal file")
        descriptor = os.open(database, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.fchmod(descriptor, 0o600)
        os.close(descriptor)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(database, timeout=10, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, CONTRACT["version"]):
            self.db.close()
            raise ValueError("Unsupported chat journal version")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_session_id TEXT,
                title TEXT NOT NULL, cwd TEXT NOT NULL, roe_profile TEXT NOT NULL,
                state TEXT NOT NULL, active_turn_id TEXT, capabilities TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                last_sequence INTEGER NOT NULL DEFAULT 0, retained_from INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS events (
                session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL,
                body TEXT NOT NULL, PRIMARY KEY(session_id, sequence)
            );
            CREATE TABLE IF NOT EXISTS commands (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
                operation TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS requests (
                session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
                turn_id TEXT, item_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL,
                event_sequence INTEGER NOT NULL, body TEXT NOT NULL, command_id TEXT,
                PRIMARY KEY(session_id, id)
            );
        """)
        self.db.execute("PRAGMA user_version=" + str(CONTRACT["version"]))
        if "managed_name" not in {row[1] for row in self.db.execute("PRAGMA table_info(sessions)")}:
            self.db.execute("ALTER TABLE sessions ADD COLUMN managed_name TEXT")

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def _session(self, identifier):
        row = self.db.execute("SELECT * FROM sessions WHERE id=?", (session_id(identifier),)).fetchone()
        if row is None:
            raise ValueError("Chat session is unavailable")
        return row

    @staticmethod
    def _view(row):
        return dict(id=row["id"], managedName=row["managed_name"], provider=row["provider"], providerSessionId=row["provider_session_id"], title=row["title"], cwd=row["cwd"], roeProfile=row["roe_profile"], state=row["state"], activeTurnId=row["active_turn_id"], capabilities=json.loads(row["capabilities"]), createdAt=row["created_at"], updatedAt=row["updated_at"])

    @staticmethod
    def _receipt(row):
        return dict(commandId=row["id"], sessionId=row["session_id"], state=row["state"], result=json.loads(row["result"]) if row["result"] is not None else None, error=row["error"])

    def receipt(self, command_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM commands WHERE id=?", (command_id,)).fetchone()
            if row is None:
                raise ValueError("Command receipt is unavailable; do not automatically resubmit")
            return self._receipt(row)

    def accept(self, command, capabilities=None):
        validate_command(command)
        digest = hashlib.sha256(encoded(command).encode()).hexdigest()
        with self.transaction():
            previous = self.db.execute("SELECT * FROM commands WHERE id=?", (command["commandId"],)).fetchone()
            if previous is not None:
                if previous["digest"] != digest:
                    raise ValueError("Command ID was already used for different content")
                return self._receipt(previous), False
            operation, payload = command["operation"], command["payload"]
            if operation == "create":
                validate_capabilities(capabilities)
                if capabilities["provider"] != payload["provider"] or capabilities["status"] != "supported":
                    raise ValueError("Provider chat integration is unavailable")
                if "providerSessionId" in payload and not capabilities["resume"]:
                    raise ValueError("Provider does not support conversation resume")
                identifier = "chat-" + command["commandId"].replace("-", "")
                at = now()
                self.db.execute("INSERT INTO sessions(id,provider,provider_session_id,title,cwd,roe_profile,state,capabilities,created_at,updated_at) VALUES(?,?,?,?,?,?,'starting',?,?,?)", (identifier, payload["provider"], payload.get("providerSessionId"), payload["title"], payload["cwd"], payload["roeProfile"], encoded(capabilities), at, at))
                self.db.execute("UPDATE sessions SET managed_name=? WHERE id=?", (payload.get("managedName"), identifier))
                self._append(identifier, "session.updated", dict(state="starting", detail="Starting remote provider"))
            else:
                identifier = command["sessionId"]
                session = self._session(identifier)
                capabilities = json.loads(session["capabilities"])
                if operation != "stop" and session["state"] in ("stopped", "failed", "unknown", "starting"):
                    raise ValueError("Chat session is not ready; inspect its current state")
                needed = dict(send="streaming", steer="steering", interrupt="interrupt").get(operation)
                if needed and not capabilities[needed]:
                    raise ValueError("Provider does not support this operation")
                if operation == "send" and session["state"] != "idle":
                    raise ValueError("Wait for the active turn before sending another message")
                # Reserve the turn before acknowledgement so concurrent senders cannot
                # both dispatch a new turn while the provider is still starting it.
                if operation == "send":
                    self._append(identifier, "session.updated", dict(state="running", detail="Message accepted; awaiting provider"))
                if operation == "steer" and (session["state"] != "running" or session["active_turn_id"] != payload["expectedTurnId"]):
                    raise ValueError("The active turn changed; steering is stale")
                if operation == "respond":
                    request = self.db.execute("SELECT * FROM requests WHERE session_id=? AND id=?", (identifier, payload["requestId"])).fetchone()
                    if request is None or request["state"] != "pending" or request["turn_id"] != payload["turnId"] or request["item_id"] != payload["itemId"] or session["active_turn_id"] != request["turn_id"]:
                        raise ValueError("Request is stale, unavailable, or already answered")
                    is_approval = request["kind"] == "approval.requested"
                    if is_approval != ("decision" in payload) or not capabilities["approvals" if is_approval else "questions"]:
                        raise ValueError("Unsupported request response")
                    if not is_approval:
                        questions = json.loads(request["body"])["questions"]
                        answers = payload["answers"]
                        if len({item["questionId"] for item in answers}) != len(answers) or {item["questionId"] for item in answers} != {item["id"] for item in questions}:
                            raise ValueError("Answers do not match this request's questions")
                        for question in questions:
                            answer = next(item for item in answers if item["questionId"] == question["id"])
                            if not question["multiple"] and len(answer["answers"]) > 1:
                                raise ValueError("Question accepts only one answer")
                    self.db.execute("UPDATE requests SET state='submitted',command_id=? WHERE session_id=? AND id=?", (command["commandId"], identifier, payload["requestId"]))
            at = now()
            self.db.execute("INSERT INTO commands VALUES(?,?,?,?, 'accepted',NULL,NULL,?,?)", (command["commandId"], digest, identifier, operation, at, at))
            return self._receipt(self.db.execute("SELECT * FROM commands WHERE id=?", (command["commandId"],)).fetchone()), True

    def command_state(self, command_id, state, result=None, error=None):
        if state not in CONTRACT["commandStates"]:
            raise ValueError("Invalid command state")
        with self.transaction():
            previous = self.receipt(command_id)
            allowed = {"accepted": {"dispatching", "failed", "unknown"}, "dispatching": {"completed", "failed", "unknown"}}
            if state not in allowed.get(previous["state"], set()):
                raise ValueError("Command receipt is terminal or transition is invalid")
            self.db.execute("UPDATE commands SET state=?,result=?,error=?,updated_at=? WHERE id=?", (state, encoded(result) if result is not None else None, str(error)[:2000] if error is not None else None, now(), command_id))
            return self.receipt(command_id)

    def append(self, identifier, kind, data, turn_id=None, item_id=None, historical=False):
        with self.transaction():
            return self._append(identifier, kind, data, turn_id, item_id, historical)

    def _append(self, identifier, kind, data, turn_id=None, item_id=None, historical=False):
        session = self._session(identifier)
        if kind in ("approval.requested", "question.requested"):
            existing = self.db.execute("SELECT * FROM requests WHERE session_id=? AND id=?", (identifier, data["requestId"])).fetchone()
            if existing is not None:
                if existing["body"] != encoded(data) or existing["turn_id"] != turn_id or existing["item_id"] != item_id or existing["kind"] != kind:
                    raise ValueError("Provider reused a request ID for a different action")
                row = self.db.execute("SELECT body FROM events WHERE session_id=? AND sequence=?", (identifier, existing["event_sequence"])).fetchone()
                return json.loads(row["body"]) if row else None
        at = now()
        event = validate_event(dict(protocolVersion=CONTRACT["version"], sessionId=identifier, sequence=session["last_sequence"] + 1, timestamp=at, provider=session["provider"], providerSessionId=session["provider_session_id"], turnId=turn_id, itemId=item_id, type=kind, data=data))
        self.db.execute("INSERT INTO events VALUES(?,?,?)", (identifier, event["sequence"], encoded(event)))
        self.db.execute("UPDATE sessions SET last_sequence=?,updated_at=? WHERE id=?", (event["sequence"], at, identifier))
        if historical:
            return event
        if kind == "session.updated":
            self.db.execute("UPDATE sessions SET state=?,active_turn_id=? WHERE id=?", (data["state"], turn_id if data["state"] in ("running", "waiting") else None, identifier))
        if kind in ("approval.requested", "question.requested"):
            self.db.execute("INSERT INTO requests VALUES(?,?,?,?,?,'pending',?,?,NULL)", (identifier, data["requestId"], turn_id, item_id, kind, event["sequence"], encoded(data)))
            self.db.execute("UPDATE sessions SET state='waiting',active_turn_id=? WHERE id=?", (turn_id, identifier))
        if kind == "request.resolved":
            self.db.execute("UPDATE requests SET state=? WHERE session_id=? AND id=?", (data["state"], identifier, data["requestId"]))
            remaining = self.db.execute("SELECT 1 FROM requests WHERE session_id=? AND state IN ('pending','submitted')", (identifier,)).fetchone()
            if not remaining and session["state"] == "waiting":
                self.db.execute("UPDATE sessions SET state='running' WHERE id=?", (identifier,))
        if kind == "turn.completed":
            self.db.execute("UPDATE sessions SET state='idle',active_turn_id=NULL WHERE id=?", (identifier,))
        if kind == "turn.completed" or (kind == "session.updated" and data["state"] in ("stopped", "failed", "unknown")):
            requests = self.db.execute("SELECT * FROM requests WHERE session_id=? AND state IN ('pending','submitted')", (identifier,)).fetchall()
            for request in requests:
                self._append(identifier, "request.resolved", dict(requestId=request["id"], state="expired", decision=None), request["turn_id"], request["item_id"])
        return event

    def set_provider_session(self, identifier, provider_session_id):
        from chat_protocol import identifier as validate_id
        validate_id(provider_session_id)
        with self.transaction():
            self._session(identifier)
            self.db.execute("UPDATE sessions SET provider_session_id=? WHERE id=?", (provider_session_id, identifier))

    def list_sessions(self):
        with self.lock:
            return [self._view(row) for row in self.db.execute("SELECT * FROM sessions ORDER BY created_at,id")]

    def can_retire(self):
        with self.lock:
            live = self.db.execute("SELECT 1 FROM sessions WHERE state NOT IN ('stopped','failed') LIMIT 1").fetchone()
            pending = self.db.execute("SELECT 1 FROM commands WHERE state IN ('accepted','dispatching') LIMIT 1").fetchone()
            return live is None and pending is None

    def history(self, identifier, after=0, limit=200):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= CONTRACT["limits"]["page"]:
            raise ValueError("Invalid chat history cursor or page size")
        with self.lock:
            session = self._session(identifier)
            if after > session["last_sequence"]:
                raise ValueError("Chat history cursor is ahead of the journal")
            rows = self.db.execute("SELECT body FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?", (identifier, after, limit + 1)).fetchall()
            events, size = [], 0
            for row in rows[:limit]:
                length = len(row["body"].encode())
                if events and size + length > CONTRACT["limits"]["wireBytes"]:
                    break
                events.append(json.loads(row["body"]))
                size += length
            pending = [self._receipt(row) for row in self.db.execute("SELECT * FROM commands WHERE session_id=? AND state IN ('accepted','dispatching','unknown') ORDER BY created_at", (identifier,))]
            return dict(session=self._view(session), events=events, cursor=events[-1]["sequence"] if events else max(after, session["retained_from"] - 1), latestCursor=session["last_sequence"], hasMore=len(rows) > len(events), retainedFrom=session["retained_from"], truncated=after < session["retained_from"] - 1, pendingCommands=pending)

    def pending_requests(self, identifier):
        with self.lock:
            self._session(identifier)
            return [dict(requestId=row["id"], turnId=row["turn_id"], itemId=row["item_id"], state=row["state"], type=row["kind"], data=json.loads(row["body"])) for row in self.db.execute("SELECT * FROM requests WHERE session_id=? AND state IN ('pending','submitted') ORDER BY event_sequence", (identifier,))]

    def recover_worker_loss(self):
        with self.transaction():
            self.db.execute("UPDATE commands SET state='unknown',error='Worker restarted before the provider result was recorded; do not automatically resend',updated_at=? WHERE state IN ('accepted','dispatching')", (now(),))
            active = self.db.execute("SELECT id FROM sessions WHERE state IN ('starting','idle','running','waiting')").fetchall()
            for row in active:
                self._append(row["id"], "session.updated", dict(state="unknown", detail="Worker restarted; active provider state cannot be reattached automatically"))
                self._append(row["id"], "error", dict(code="worker_lost", message="Inspect provider history before resuming; outstanding submissions may have executed", retryable=False))
            return len(active)

    def prune_transcript(self, identifier):
        """Explicit local-worker operation; never expires command deduplication receipts."""
        with self.transaction():
            row = self._session(identifier)
            if row["state"] not in ("stopped", "failed"):
                raise ValueError("Only confirmed stopped or failed sessions can be pruned")
            self.db.execute("DELETE FROM events WHERE session_id=?", (identifier,))
            self.db.execute("DELETE FROM requests WHERE session_id=?", (identifier,))
            self.db.execute("UPDATE sessions SET retained_from=last_sequence+1 WHERE id=?", (identifier,))

    def close(self):
        with self.lock:
            self.db.close()
