"""Isolated contracts for ephemeral helper admission, routing, and terminal control."""
import base64
from contextlib import closing
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from helpers.python_sources import exec_sources

ROOT = Path(__file__).resolve().parents[1]
NAME = "hq-123456abcdef"


class RemoteBoundaries(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agentc2-remote-boundaries-")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.scope = {"__name__": "remote_boundary_fixture"}
        exec_sources(self.scope, ROOT / "electron" / "remote.py")
        self.scope.update(HOME=self.home, HOOK_ROOT=self.home / "hooks")
        self.commands = []

    def call(self, name, *args, **kwargs):
        return self.scope[name](*args, **kwargs)

    def result(self, code=0, stdout="", stderr=""):
        return subprocess.CompletedProcess([], code, stdout, stderr)

    def checked(self, args):
        self.commands.append(args)
        return ""

    def test_subprocess_time_and_path_contracts(self):
        with patch.object(subprocess, "run", return_value=self.result(stdout="ok")) as run:
            self.assertEqual(self.call("run", ["fixture"], timeout=7).stdout, "ok")
            run.assert_called_once_with(["fixture"], text=True, capture_output=True, timeout=7, check=False)
        for error, code, detail in [(FileNotFoundError(), 127, "not found"), (subprocess.TimeoutExpired("fixture", 3), 124, "timed out")]:
            with patch.object(subprocess, "run", side_effect=error):
                result = self.call("run", ["fixture"])
                self.assertEqual(result.returncode, code)
                self.assertIn(detail, result.stderr)
        for value in (None, {}, "bad", float("inf")):
            self.assertIsNone(self.call("iso_from_epoch", value))
        self.assertEqual(self.call("normalize_time", "timestamp"), "timestamp")
        self.assertEqual(self.call("normalize_time", 1790000000000), self.call("iso_from_epoch", 1790000000))
        self.assertEqual(self.call("normalize_time", 1000), self.call("iso_from_epoch", 1000))
        self.assertIsNone(self.call("normalize_time", None))
        self.assertEqual(self.call("launch_paths", {}), {"cwd": str(self.home), "paths": []})
        for payload in ({"cwd": 1}, {"cwd": "\0"}, {"cwd": "x" * 4097}, {"paths": {}}, {"paths": [None]}, {"paths": [""]}, {"paths": ["\0"]}, {"paths": ["x" * 4097]}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.call("launch_paths", payload)

    def test_cleanup_lock_rejects_competing_and_unsafe_owners(self):
        with self.call("cleanup_lock"):
            with self.assertRaisesRegex(ValueError, "Another AgentC2"):
                with self.call("cleanup_lock"):
                    self.fail("Competing lock entered")
        lock = self.home / ".agentc2-history.lock"
        os.link(lock, self.home / "second-link")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            with self.call("cleanup_lock"):
                self.fail("Hard-linked lock entered")
        (self.home / "second-link").unlink()
        with patch.object(os, "getuid", return_value=-1), self.assertRaisesRegex(ValueError, "unsupported"):
            with self.call("cleanup_lock"):
                self.fail("Foreign lock entered")

    def test_session_events_are_bounded_and_malformed_evidence_is_ignored(self):
        self.assertEqual(self.call("session_events", "external"), [])
        self.assertEqual(self.call("session_events", NAME), [])
        directory = self.scope["HOOK_ROOT"] / NAME
        directory.mkdir(parents=True)
        source = directory / "events.jsonl"
        source.write_text("\n".join(json.dumps({"id": i}) for i in range(140)))
        events = self.call("session_events", NAME)
        self.assertEqual([events[0]["id"], events[-1]["id"], len(events)], [12, 139, 128])
        source.write_text('[]\nnull\n{"id":1}\n')
        self.assertEqual(self.call("session_events", NAME), [{"id": 1}])
        source.write_text('bad\n{"id":1}\n')
        self.assertEqual(self.call("session_events", NAME), [])

    def test_hook_admission_profiles_and_gated_settings(self):
        for provider, payload in [("codex", {}), ("opencode", {"hookSource": "fixture"}), ("claude", {"hookSource": "fixture", "agentId": "agent-1"}), ("codex", {"hookSource": "fixture", "preset": {"attentionHooks": False}})]:
            self.assertEqual(self.call("hook_arguments", provider, NAME, payload), [])
        gated = {"roeProfile": "gated"}
        settings = self.call("hook_arguments", "claude", NAME, gated)
        self.assertEqual(json.loads(settings[1])["permissions"]["ask"], ["Bash", "Edit", "Write", "NotebookEdit"])
        payload = {"hookSource": "# harmless fixture", "preset": {"attentionHooks": True, "args": '--profile "fixture profile"'}}
        for args, expected in [(payload["preset"]["args"], "fixture profile"), ("-p short", "short"), ("", "")]:
            payload["preset"]["args"] = args
            notify = self.call("hook_arguments", "codex", NAME, payload)
            self.assertEqual(json.loads(notify[1].removeprefix("notify="))[-1], "PROFILE=" + expected)
        payload["preset"]["args"] = "-c notify =custom"
        self.assertEqual(self.call("hook_arguments", "codex", NAME, payload), [])
        hooks = json.loads(self.call("hook_arguments", "claude", NAME, {"hookSource": "# fixture", **gated})[1])
        self.assertIn("permissions", hooks)
        self.assertEqual(hooks["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 310)
        ordinary = json.loads(self.call("hook_arguments", "claude", NAME, {"hookSource": "# fixture"})[1])
        self.assertNotIn("permissions", ordinary)
        script = self.scope["HOOK_ROOT"] / NAME / "hook.py"
        self.assertEqual(script.stat().st_mode & 0o777, 0o600)

    def test_codex_inventory_uses_read_only_database_and_fallback_fields(self):
        self.assertEqual(self.call("codex_sessions"), [])
        database = self.home / ".codex" / "state_5.sqlite"
        database.parent.mkdir()
        database.write_bytes(b"invalid database")
        self.assertEqual(self.call("codex_sessions"), [])
        database.unlink()
        with closing(sqlite3.connect(database)) as conn:
            conn.execute("CREATE TABLE threads(id,title,cwd,updated_at_ms,archived)")
            conn.executemany("INSERT INTO threads VALUES(?,?,?,?,?)", [("saved-id", "T" * 130, "/repo", 1790000000000, 0), ("archived-id", None, None, None, 1)])
            conn.commit()
        rows = self.call("codex_sessions")
        self.assertEqual([row["id"] for row in rows], ["saved-id", "archived-id"])
        self.assertEqual(len(rows[0]["title"]), 120)
        self.assertEqual((rows[1]["title"], rows[1]["cwd"], rows[1]["state"]), ("Codex conversation", "", "archived"))

    def test_claude_transcript_and_active_agent_merge(self):
        root = self.home / ".claude" / "projects" / "project"
        root.mkdir(parents=True)
        transcript = root / "saved-id.jsonl"
        transcript.write_text('\n'.join(["bad json", json.dumps({"type": "assistant"}), json.dumps({"type": "user", "message": {"content": [{"type": "image"}, "skip", {"type": "text", "text": " hello  world "}]} }), json.dumps({"cwd": "/repo"}), json.dumps({"type": "user", "message": {"content": "later"}})]))
        self.assertEqual(self.call("claude_title_and_cwd", transcript), ("hello world", "/repo"))
        self.assertEqual(self.call("claude_title_and_cwd", root / "missing"), (None, None))
        empty = root / "empty-id.jsonl"
        empty.write_text('\n'.join(json.dumps({"type": "user", "message": {"content": " " if i == 0 else 42}}) for i in range(251)))
        (root / "short.jsonl").write_text('{}')
        agents = [{"sessionId": "saved-id", "id": "agent-1", "state": "working", "kind": "background"}, {"id": "new-agent", "name": "New", "cwd": "/new", "startedAt": 1000}, {"id": "fallback-agent"}, {}, {"id": "bad!"}]
        self.scope["run"] = lambda *_args, **_kwargs: self.result(stdout=json.dumps(agents))
        rows = {row["id"]: row for row in self.call("claude_sessions")}
        self.assertEqual(rows["saved-id"]["title"], "hello world")
        self.assertEqual(rows["saved-id"]["state"], "working")
        self.assertEqual(rows["new-agent"]["kind"], "background")
        self.assertEqual(rows["fallback-agent"]["title"], "Claude agent")
        self.assertTrue(rows["empty-id"]["title"].startswith("Claude conversation"))
        self.assertNotIn("short", rows)
        for result in (self.result(1), self.result(stdout="malformed"), self.result(stdout="null")):
            self.scope["run"] = lambda *_args, **_kwargs: result
            self.assertEqual(len(self.call("claude_sessions")), 2)

    def test_tmux_and_process_inventory_do_not_invent_ownership(self):
        self.scope["run"] = lambda *_args, **_kwargs: self.result(1)
        self.assertEqual(self.call("tmux_sessions"), [])
        self.assertEqual(self.call("unmanaged_processes"), [])
        self.assertEqual(self.call("tmux_option", NAME, "@hq_provider"), "")
        self.scope["run"] = lambda *_args, **_kwargs: self.result(stdout="  claude \n")
        self.assertEqual(self.call("tmux_option", NAME, "@hq_provider"), "claude")
        rows = "incomplete\nnot-int 1 codex ?\n10 bad claude ?\n11 12 codex ?\n12 11 sh ?\n20 1 opencode.exe pts/1\n"
        self.scope["run"] = lambda *_args, **_kwargs: self.result(stdout=rows)
        self.assertEqual([row["id"] for row in self.call("unmanaged_processes")], ["11", "20"])
        self.scope["provider_telemetry"] = lambda *_: {"status": "unknown"}
        self.scope["tmux_option"] = lambda *_: ""
        listed = "bad\nunknown\t1\t0\tvim\t/tmp\nexternal\t1\t1\tclaude\t/repo\n"
        self.scope["run"] = lambda args, **_kwargs: self.result(stdout=listed if args[1] == "list-sessions" else "tail")
        [external] = self.call("tmux_sessions")
        self.assertEqual((external["managed"], external["provider"], external["outputTail"], external["processId"]), (False, "claude", "tail", None))
        self.assertFalse(external["canStop"])

    def test_terminal_control_admission_and_exact_commands(self):
        self.scope["checked"] = self.checked
        self.scope["tmux_option"] = lambda *_: "codex"
        self.assertEqual(self.call("configure_session", {"name": NAME}), {"name": NAME})
        self.assertEqual([command[-2:] for command in self.commands], [["mouse", "off"], ["history-limit", "50000"]])
        self.commands.clear()
        self.assertEqual(self.call("rename", {"name": NAME, "title": "  renamed  "}), {"name": NAME, "title": "renamed"})
        self.assertEqual(self.commands[0][-3:], ["--", "@hq_title", "renamed"])
        for title in (None, "", " ", "x" * 101, "😀" * 51, "bad\n", "bad\u0080", "bad\ud800"):
            with self.subTest(title=repr(title)), self.assertRaises(ValueError):
                self.call("rename", {"name": NAME, "title": title})
        for name in ("external", None):
            with self.assertRaises(ValueError):
                self.call("rename", {"name": name, "title": "safe"})
        self.scope["tmux_option"] = lambda *_: "foreign"
        with self.assertRaises(ValueError):
            self.call("rename", {"name": NAME, "title": "safe"})
        for name in ("external", NAME):
            with self.assertRaises(ValueError):
                self.call("configure_session", {"name": name})
        chat = Mock(return_value={})
        self.scope["chat_remote"] = chat
        self.call("rename", {"name": NAME, "title": "safe", "chatSessionId": "chat-id"})
        self.assertEqual(chat.call_args.args[0]["request"], {"protocolVersion": 1, "action": "rename", "sessionId": "chat-id", "managedName": NAME, "title": "safe"})
        for name in ("bad/name", ""):
            with self.assertRaises(ValueError):
                self.call("history", {"name": name})
        self.scope["checked"] = lambda _args: "x" * 4000001
        self.assertEqual(self.call("history", {"name": NAME}), {"text": "x" * 4000000, "truncated": True})
        self.scope["checked"] = lambda _args: "short"
        self.assertFalse(self.call("history", {"name": NAME})["truncated"])

    def test_scroll_routes_copy_mode_and_alternate_screen_without_replaying_input(self):
        for alternate in ("0", "1"):
            for mode in ("0", "1"):
                for provider in ("codex", "claude", "terminal"):
                    for direction in ("up", "down", "latest"):
                        with self.subTest(alternate=alternate, mode=mode, provider=provider, direction=direction):
                            self.commands.clear()
                            def checked(args):
                                self.commands.append(args)
                                return f"%7|{mode}|{alternate}|{provider}|12" if args[1] == "display-message" else ""
                            self.scope["checked"] = checked
                            result = self.call("scroll_session", {"name": NAME, "direction": direction, "lines": 25})
                            expected = alternate == "0" and direction != "latest" and (mode == "1" or direction == "up")
                            self.assertEqual(result["historyActive"], expected)
                            actions = self.commands[1:]
                            if alternate == "1":
                                if mode == "1":
                                    self.assertEqual(actions.pop(0)[-2:], ["-X", "cancel"])
                                if direction == "latest":
                                    self.assertEqual([a[-1] for a in actions], ["C-End"] if provider in ("codex", "claude") else [])
                                else:
                                    self.assertEqual(actions[0][-3:], ["-N", "3", "PPage" if direction == "up" else "NPage"])
                            elif expected:
                                self.assertEqual(actions[-1][-2:], ["25", "scroll-" + direction])
        for payload in ({"name": "bad/name", "direction": "up"}, {"name": NAME, "direction": "sideways"}):
            with self.assertRaises(ValueError):
                self.call("scroll_session", payload)

    def test_managed_stop_is_scoped_and_removes_only_its_hooks(self):
        self.scope["tmux_option"] = lambda _name, option: "codex" if option == "@hq_provider" else ""
        self.scope["run"] = Mock(return_value=self.result())
        hooks = self.scope["HOOK_ROOT"] / NAME
        hooks.mkdir(parents=True)
        sibling = hooks.parent / "other"
        sibling.mkdir()
        self.assertEqual(self.call("managed_action", {"name": NAME}, "interrupt")["action"], "interrupt")
        self.assertTrue(hooks.is_dir())
        self.assertEqual(self.scope["run"].call_args.args[0][-1], "C-c")
        self.call("managed_action", {"name": NAME}, "stop")
        self.assertFalse(hooks.exists())
        self.assertTrue(sibling.is_dir())
        self.call("managed_action", {"name": NAME}, "stop")
        self.scope["run"].return_value = self.result(1, stderr="native failure")
        with self.assertRaisesRegex(RuntimeError, "native failure"):
            self.call("managed_action", {"name": NAME}, "stop")
        self.scope["run"].return_value = self.result(1)
        with self.assertRaisesRegex(RuntimeError, "Could not stop"):
            self.call("managed_action", {"name": NAME}, "stop")
        self.scope["tmux_option"] = lambda *_: "codex"
        with self.assertRaisesRegex(ValueError, "chat control"):
            self.call("managed_action", {"name": NAME}, "stop")
        self.scope["tmux_option"] = lambda *_: "foreign"
        for name in (NAME, "external"):
            with self.assertRaisesRegex(ValueError, "only available"):
                self.call("managed_action", {"name": name}, "stop")

    def test_dispatch_routes_every_request_once_with_required_locks(self):
        routes = {name: name for name in ("inventory", "github", "health", "chat", "launch_paths", "create", "worktree_list", "worktree_launch", "worktree_archive", "oporder_preview", "oporder_sync", "sitrep_source_preview", "sitrep_target_preview", "exercise_base", "exercise_capabilities", "exercise_inspect", "flash_list", "flash_decide", "diff_files", "artifact_read", "diff_detail", "cleanup_preview", "cleanup_delete", "centcom_sync", "rename", "history")}
        routes.update(github="github_request", chat="chat_remote", configure="configure_session", scroll="scroll_session", exercise_target_preview="exercise_target", exercise_promote="exercise_target", diff_hunk="diff_hunk_action", interrupt="managed_action", stop="managed_action")
        locked = {"create", "worktree_launch", "worktree_archive", "oporder_sync", "exercise_promote", "diff_hunk", "centcom_sync"}
        cleanup_lock = self.scope["cleanup_lock"]
        for action, target in routes.items():
            with self.subTest(action=action):
                lock = Mock(wraps=cleanup_lock)
                self.scope["cleanup_lock"] = lock
                handler = Mock(return_value={"fixture": action})
                require = Mock()
                self.scope[target] = handler
                self.scope["require_tmux"] = require
                payload = {"action": action, "name": NAME}
                encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                with patch.object(self.scope["sys"], "argv", ["remote", encoded]), redirect_stdout(io.StringIO()) as out:
                    self.call("main")
                self.assertEqual(json.loads(out.getvalue()), {"ok": True, "result": {"fixture": action}})
                handler.assert_called_once()
                self.assertEqual(handler.call_args.args[0], payload)
                expected = (payload, True) if action == "exercise_promote" else (payload, action) if action in ("interrupt", "stop") else (payload,)
                self.assertEqual(handler.call_args.args, expected)
                self.assertEqual(require.call_count, int(action in ("inventory", "create", "worktree_launch", "configure")))
                self.assertEqual(lock.call_count, int(action in locked))

    def test_dispatch_embedded_payload_preview_and_failure_envelopes(self):
        def invoke(payload=None, embedded=False):
            args = ["remote"]
            if payload is not None:
                encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                if embedded:
                    self.scope["AGENTC2_PAYLOAD_B64"] = encoded
                else:
                    args.append(encoded)
            with patch.object(self.scope["sys"], "argv", args), redirect_stdout(io.StringIO()) as out:
                self.call("main")
            return json.loads(out.getvalue())["result"]
        with self.assertRaisesRegex(ValueError, "Missing remote"):
            invoke()
        self.scope["require_tmux"] = Mock()
        self.assertEqual(invoke({"action": "requirements"}, embedded=True), {"tmux": True})
        self.scope.pop("AGENTC2_PAYLOAD_B64")
        with self.assertRaisesRegex(ValueError, "Unknown action"):
            invoke({"action": "unknown"})
        with self.assertRaisesRegex(ValueError, "Invalid session name"):
            invoke({"action": "preview", "name": "../bad"})
        self.scope["run"] = Mock(return_value=self.result(stdout="\n".join(str(i) for i in range(50))))
        self.assertEqual(invoke({"action": "preview", "name": NAME})["text"].splitlines(), [str(i) for i in range(20, 50)])
        self.scope["run"].return_value = self.result(stdout="x" * 20000)
        self.assertEqual(len(invoke({"action": "preview", "name": NAME})["text"]), 16000)
        self.scope["run"].return_value = self.result(1)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            invoke({"action": "preview", "name": NAME})
        self.scope["run"] = lambda _args, **_kwargs: self.result(1)
        with self.assertRaisesRegex(RuntimeError, "tmux action failed"):
            self.call("checked", ["tmux", "fixture"])
        self.scope["run"] = lambda _args, **_kwargs: self.result(1, stderr="precise reason")
        with self.assertRaisesRegex(RuntimeError, "precise reason"):
            self.call("checked", ["tmux", "fixture"])
        self.scope["run"] = lambda _args, **_kwargs: self.result(stdout=" output \n")
        self.assertEqual(self.call("checked", ["tmux", "fixture"]), "output")

    def test_chat_inventory_state_telemetry_and_repository_evidence(self):
        names = ["hq-" + str(i).zfill(12) for i in range(9)]
        sock = self.home / ".cache" / "agentc2" / "chat-v1" / "worker.sock"
        sock.parent.mkdir(parents=True)
        sock.touch()
        states = ["running", "waiting", "stopped", "failed", "starting", "unknown", "idle", "running", "stopped"]
        chats = [dict(id="chat-" + str(i).zfill(32), managedName=name, providerSessionId="native" if i != 8 else None, provider="claude", cwd="/repo", title="chat " + str(i), roeProfile="gated", state=states[i], updatedAt=str(i), createdAt="0", canStop=i != 7, capabilities={"interrupt": True, "resume": i != 3}) for i, name in enumerate(names)]
        chats.extend([dict(managedName="external"), {}])
        existing = {"id": names[0], "kind": "managed", "cwd": "/repo"}
        self.scope["tmux_sessions"] = lambda: [existing]
        for provider in ("codex", "claude", "antigravity", "opencode"):
            self.scope[provider + "_sessions"] = lambda: []
        def event(sequence, kind, data):
            return dict(sequence=sequence, timestamp="now", type=kind, data=data, itemId="tool")
        events = [event(1, "usage.updated", dict(contextUsedTokens=300, contextCapacityTokens=200, costUsd=0, totalTokens=500)), event(2, "request.resolved", {"requestId": "r1"}), event(3, "question.requested", {}), event(4, "approval.requested", {}), event(5, "turn.completed", {"outcome": "failed"}), event(6, "tool.completed", {"name": "fixture", "isError": False}), event(7, "tool.completed", {"name": "fixture", "isError": True}), event(8, "session.updated", {"state": "idle"})]
        requests = []
        def remote(payload):
            request = payload["request"]
            requests.append(request)
            if request["action"] == "health":
                return {"pid": 100}
            if request["action"] == "list":
                return chats
            if request["limit"] == 1:
                return {"latestCursor": 100}
            index = int(request["sessionId"].removeprefix("chat-"))
            return {"events": events if index == 0 else [event(1, "usage.updated", {})] if index == 1 else []}
        self.scope["chat_remote"] = remote
        self.scope["unmanaged_processes"] = Mock(return_value=[{"id": "external", "cwd": "/invalid", "kind": "unmanaged"}, {"id": "same", "cwd": "/repo", "kind": "external-tmux"}, {"id": "conversation", "cwd": "/not-probed", "kind": "conversation"}])
        self.scope["provider_telemetry"] = lambda *_: {"status": "unknown"}
        self.scope["require_tmux"] = Mock()
        def run(args, **_kwargs):
            return self.result(stdout="/root/repo\nmain\nabcdef\n") if args[2] == "/repo" else self.result(1)
        self.scope["run"] = Mock(side_effect=run)
        rows = {row["id"]: row for row in self.call("inventory", {"fixture": True})["sessions"]}
        self.scope["unmanaged_processes"].assert_called_once_with(100)
        self.assertEqual(self.scope["run"].call_count, 2, "One probe per distinct live repository")
        self.assertEqual([rows[name]["state"] for name in names], ["live", "waiting_for_input", "exited", "exited", "starting", "unknown", "live", "live", "exited"])
        self.assertEqual(rows[names[0]]["telemetry"]["context"]["percent"], 100)
        self.assertEqual(rows[names[0]]["telemetry"]["costBasis"], "provider estimate")
        self.assertEqual(rows[names[0]]["resolvedRequestIds"], ["r1"])
        self.assertEqual([event["kind"] for event in rows[names[0]]["events"]], ["input", "input", "failed", "tool_ok", "tool_failed"])
        self.assertIsNone(rows[names[1]]["telemetry"]["context"])
        self.assertIsNone(rows[names[1]]["telemetry"]["costBasis"])
        self.assertEqual(rows[names[2]]["telemetry"]["status"], "unknown")
        self.assertFalse(rows[names[2]]["canStop"])
        self.assertTrue(rows[names[2]]["canResume"])
        self.assertFalse(rows[names[3]]["canResume"])
        self.assertFalse(rows[names[7]]["canInterrupt"])
        self.assertFalse(rows[names[8]]["canResume"])
        self.assertEqual(rows["same"]["headCommit"], "abcdef")
        self.assertIsNone(rows["external"]["repository"])
        self.assertNotIn("repository", rows["conversation"])
        history = [r for r in requests if r["action"] == "history" and r["limit"] == 100]
        self.assertEqual({r["after"] for r in history}, {40})
        sock.unlink()
        self.scope["tmux_sessions"] = lambda: []
        self.scope["unmanaged_processes"].return_value = [dict(id=str(i), cwd="/repo" + str(i), kind="external-tmux") for i in range(18)]
        self.scope["run"].reset_mock()
        self.call("inventory")
        self.scope["unmanaged_processes"].assert_called_with(None)
        self.assertEqual(self.scope["run"].call_count, 16, "Repository inspection is bounded")

    def test_create_rejects_invalid_launches_before_allocating_a_session(self):
        self.scope["require_tmux"] = Mock()
        self.scope["run"] = Mock(side_effect=AssertionError("Unexpected launch"))
        invalid = [({}, "Unsupported provider"), ({"provider": "terminal", "instructions": "prompt"}, "Terminal sessions"), ({"provider": "codex", "cwd": str(self.home / "missing")}, "does not exist"), ({"provider": "codex", "conversationId": "bad!"}, "conversation ID"), ({"provider": "claude", "agentId": "bad!"}, "background agent ID"), ({"provider": "codex", "roeProfile": "unsafe"}, "Engagement profile"), ({"provider": "codex", "managedName": "external"}, "managed session name")]
        invalid += [({"provider": "codex", "roeProfile": "gated", "preset": {"command": command, "args": args}}, "unmodified provider") for command, args in [("custom", ""), ("codex", "--settings unsafe"), ("codex", "-c unsafe"), ("codex", "-c=unsafe")]]
        invalid += [({"provider": provider, "roeProfile": "gated"}, "unmodified provider") for provider in ("antigravity", "opencode")]
        invalid += [({"provider": "codex", "transport": "chat", "preset": {"command": command, "args": args}}, "standard provider") for command, args in [("custom", ""), ("codex", "--model custom")]]
        invalid += [({"provider": "terminal", "transport": "chat"}, "standard provider"), ({"provider": "claude", "transport": "chat", "agentId": "agent-1"}, "standard provider")]
        for payload, error in invalid:
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, error):
                self.call("create", {"cwd": str(self.home), **payload})
        self.scope["run"].assert_not_called()

    def test_chat_reservation_retry_uses_the_same_command_and_preserves_uncertain_receipts(self):
        self.scope["require_tmux"] = Mock()
        self.scope["checked"] = self.checked
        self.scope["tmux_option"] = Mock(return_value="")
        remote = Mock(return_value={"state": "accepted"})
        self.scope["chat_remote"] = remote
        payload = {"provider": "codex", "transport": "chat", "cwd": str(self.home), "managedName": NAME, "conversationId": "native-id", "model": "fixture", "instructions": "fixture prompt", "title": " test  title ", "preset": {"command": "codex", "name": "Fixture", "id": "fixture"}, "worktreeOperation": "operation"}
        result = self.call("create", payload)
        self.assertEqual(result["receipt"], {"state": "accepted"})
        self.assertRegex(result["chatSessionId"], r"^chat-[a-f0-9]{32}$")
        command = remote.call_args.args[0]["request"]["command"]
        self.assertEqual(command["payload"]["title"], "test title")
        self.assertEqual(command["payload"]["providerSessionId"], "native-id")
        self.assertEqual(command["payload"]["model"], "fixture")
        self.assertEqual(self.commands[0][1], "new-session")
        self.assertEqual(self.commands[-1][-2:], ["@hq_chat_session_id", result["chatSessionId"]])
        self.commands.clear()
        self.scope["tmux_option"].return_value = result["chatSessionId"]
        self.assertEqual(self.call("create", payload), result)
        self.assertEqual(self.commands, [], "A retry cannot allocate another reservation")
        self.assertEqual(remote.call_args.args[0]["request"]["command"], command)
        remote.side_effect = TimeoutError("receipt unknown")
        with self.assertRaisesRegex(TimeoutError, "receipt unknown"):
            self.call("create", payload)
        self.assertEqual(self.commands, [], "An unknown acknowledgement cannot destroy the reservation")
        self.scope["tmux_option"].return_value = "chat-foreign"
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.call("create", payload)
        self.commands.clear()
        self.scope["tmux_option"].return_value = ""
        remote.side_effect = None
        fresh = self.call("create", {"provider": "antigravity", "transport": "chat", "cwd": str(self.home), "roeProfile": "gated"})
        self.assertRegex(fresh["name"], r"^hq-[a-f0-9]{12}$")
        self.assertNotIn("model", remote.call_args.args[0]["request"]["command"]["payload"])

    def test_terminal_launch_quotes_options_records_exit_and_rolls_back_setup_failure(self):
        self.scope["require_tmux"] = Mock()
        self.scope["tmux_option"] = lambda *_: "codex"
        self.scope["checked"] = self.checked
        self.scope["run"] = Mock(return_value=self.result())
        payload = {"provider": "codex", "cwd": str(self.home), "managedName": NAME, "title": "Fixture", "instructions": "literal $(not-executed) 'prompt'"}
        self.call("create", payload)
        launched = next(command for command in self.commands if command[1] == "new-window")
        self.assertIn("@hq_process_exit", launched[-1])
        self.assertIn("exit \"$hq_exit\"", launched[-1])
        self.assertEqual(self.commands[-1][-1], NAME + ":setup")
        for provider, options in [("terminal", {}), ("claude", {"agentId": "agent-id"}), ("claude", {"preset": {"command": "claude3", "args": "--model fixture", "fullPermissions": False}}), ("codex", {"roeProfile": "gated", "preset": {"command": "codex", "args": ""}})]:
            self.commands.clear()
            with patch.object(self.scope["pwd"], "getpwuid", return_value=SimpleNamespace(pw_shell="")):
                self.call("create", {"provider": provider, "cwd": str(self.home), "managedName": NAME, **options})
            launch = next(command[-1] for command in self.commands if command[1] == "new-window")
            if provider == "terminal":
                self.assertIn("/bin/bash -l -i", launch)
            if options.get("roeProfile") == "gated":
                self.assertIn("builtin command codex", launch)
            if options.get("agentId"):
                self.assertIn(["tmux", "set-option", "-t", NAME, "@hq_roe", "unknown"], self.commands)
        hook = self.scope["HOOK_ROOT"] / NAME
        hook.mkdir(parents=True)
        self.scope["run"].return_value = self.result(1, stderr="native launch failed")
        with self.assertRaisesRegex(RuntimeError, "native launch failed"):
            self.call("create", payload)
        self.assertFalse(hook.exists())
        self.scope["run"].return_value = self.result(1)
        with self.assertRaisesRegex(RuntimeError, "Could not start tmux"):
            self.call("create", payload)
        self.scope["run"].return_value = self.result()
        for has_hook in (False, True):
            if has_hook:
                hook.mkdir(parents=True)
            self.scope["checked"] = Mock(side_effect=RuntimeError("configuration failed"))
            with self.assertRaisesRegex(RuntimeError, "configuration failed"):
                self.call("create", payload)
            self.assertFalse(hook.exists())
            self.assertEqual(self.scope["run"].call_args.args, (["tmux", "kill-session", "-t", NAME],))

    def test_provider_mode_and_resume_arguments(self):
        for provider, resume in [("codex", ["resume", "native-id"]), ("claude", ["--resume", "native-id"]), ("antigravity", ["--conversation", "native-id"]), ("opencode", ["--session", "native-id"])]:
            args = self.call("agent_command", provider, "native-id", instructions="prompt", roe_profile="provider-default")
            self.assertEqual(args[1:3], resume)
            self.assertEqual(args[-2:], ["--prompt" if provider == "opencode" else "--", "prompt"])
            full = self.call("agent_command", provider)
            self.assertIn(self.scope["PERMISSION_FLAGS"][provider], full)
        self.assertEqual(self.call("agent_command", "claude", agent_id="agent-id"), ["claude", "attach", "agent-id"])
        self.assertEqual(self.call("agent_command", "claude", roe_profile="gated"), ["claude", "--permission-mode", "default"])
        for provider, profile in [("antigravity", "gated"), ("opencode", "gated"), ("codex", "invalid")]:
            with self.assertRaises(ValueError):
                self.call("agent_command", provider, roe_profile=profile)
        self.assertEqual(self.call("agent_command", "codex", preset={"args": "--model fixture", "fullPermissions": False}), ["--model", "fixture"])

    def test_inventory_disappearing_files_and_empty_transcripts(self):
        self.scope["run"] = lambda *_args, **_kwargs: self.result(1)
        self.assertEqual(self.call("claude_sessions"), [])
        empty = self.home / "empty"
        empty.touch()
        self.assertEqual(self.call("claude_title_and_cwd", empty), (None, None))
        root = self.home / ".claude" / "projects"
        root.mkdir(parents=True)
        transcript = root / "missing-id.jsonl"
        transcript.touch()
        original_stat = Path.stat
        def stat(path, *args, **kwargs):
            if path == transcript:
                raise FileNotFoundError("Transcript disappeared")
            return original_stat(path, *args, **kwargs)
        with patch.object(Path, "stat", stat):
            self.assertEqual(self.call("claude_sessions"), [])
        current = self.home / ".gemini" / "antigravity-cli" / "conversations"
        legacy = self.home / ".gemini" / "antigravity" / "conversations"
        current.mkdir(parents=True)
        legacy.mkdir(parents=True)
        valid = current / "valid-id.db"
        valid.write_bytes(b"SQLite format 3\0fixture")
        (current / "bad!.db").touch()
        (current / "invalid-id.db").write_bytes(b"invalid")
        (current / "folder-id.db").mkdir()
        (current / "linked-id.db").symlink_to(valid)
        (legacy / "valid-id.pb").touch()
        self.assertEqual([row["id"] for row in self.call("antigravity_sessions")], ["valid-id"])
        original_open = Path.open
        def open_file(path, *args, **kwargs):
            if path == valid:
                raise PermissionError("Concurrent removal")
            return original_open(path, *args, **kwargs)
        with patch.object(Path, "open", open_file):
            self.assertEqual([row["id"] for row in self.call("antigravity_sessions")], ["valid-id"], "Legacy layout survives an unreadable current file")
        (legacy / "valid-id.pb").unlink()
        legacy.rmdir()
        legacy.symlink_to(current, target_is_directory=True)
        self.assertEqual(len(self.call("antigravity_sessions")), 1)

    def test_opencode_inventory_migration_ids_and_external_data_home(self):
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(self.home / "data")}):
            database = self.call("opencode_database")
            self.assertEqual(database, self.home / "data" / "opencode" / "opencode.db")
            self.assertEqual(self.call("opencode_sessions"), [])
            database.parent.mkdir(parents=True)
            with closing(sqlite3.connect(database)) as conn:
                for table in ("session", "session_v2"):
                    conn.execute(f"CREATE TABLE {table}(id,title,directory,time_updated,parent_id)")
                conn.executemany("INSERT INTO session VALUES(?,?,?,?,?)", [("ses_saved", "Legacy", "/repo", 1000, None), ("bad-id", "Invalid", "/repo", 1000, None), (1, "Numeric", "/repo", 1000, None), ("ses_child", "Child", "/repo", 1000, "ses_saved"), ("ses_empty", None, "", None, None)])
                conn.execute("INSERT INTO session_v2 VALUES('ses_saved','Migrated','/new',2000,NULL)")
                conn.commit()
            rows = {row["id"]: row for row in self.call("opencode_sessions")}
            self.assertEqual(set(rows), {"ses_saved", "ses_empty"})
            self.assertEqual(rows["ses_saved"]["title"], "Migrated")
            self.assertEqual(rows["ses_empty"]["title"], "OpenCode session")
            with closing(sqlite3.connect(database)) as conn:
                conn.execute("DROP TABLE session")
                conn.execute("DROP TABLE session_v2")
                conn.commit()
            self.assertEqual(self.call("opencode_sessions"), [])
            database.unlink()
            database.symlink_to(self.home / "elsewhere")
            (self.home / "elsewhere").touch()
            self.assertEqual(self.call("opencode_sessions"), [])
            database.unlink()
            database.write_bytes(b"invalid")
            self.assertEqual(self.call("opencode_sessions"), [])

    def test_health_reports_native_counters_and_rejects_invalid_gpu_samples(self):
        original_read = Path.read_text
        original_stat = Path.stat
        memory = "MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 25 kB\n"
        def read(path, *args, **kwargs):
            if str(path) == "/proc/stat":
                return "cpu 1 2 3 4 5 6 7 8 1000 2000\n"
            if str(path) == "/proc/meminfo":
                return memory
            return original_read(path, *args, **kwargs)
        def stat(path, *args, **kwargs):
            if path == self.home:
                return SimpleNamespace(st_dev=2)
            if path == Path("/"):
                return SimpleNamespace(st_dev=1)
            return original_stat(path, *args, **kwargs)
        self.scope["resource_constraints"] = lambda: {"status": "unsupported"}
        disk = SimpleNamespace(total=100, used=60, free=40)
        self.scope["run"] = Mock(return_value=self.result(stdout="GPU, 100, 20\ninvalid\n, 100, 20\nGPU, bad, 20\nGPU, 1, 2\nGPU, 2, -1\n"))
        with patch.object(Path, "read_text", read), patch.object(Path, "stat", stat), patch.object(self.scope["shutil"], "disk_usage", return_value=disk), patch.object(self.scope["shutil"], "which", return_value="fixture"), patch.object(self.scope["sys"], "platform", "linux"):
            result = self.call("health", {"includeGpu": True})
            self.assertEqual((result["cpuTotal"], result["cpuIdle"], result["memoryUsed"]), (36, 9, 825 * 1024))
            self.assertEqual([row["path"] for row in result["disks"]], ["/", str(self.home)])
            self.assertEqual(len(result["gpu"]["devices"]), 1)
            memory += "MemAvailable: 500 kB\n"
            self.scope["run"].return_value = self.result(1)
            result = self.call("health", {"includeGpu": True})
            self.assertEqual(result["memoryUsed"], 500 * 1024)
            self.assertEqual(result["gpu"]["status"], "unknown")
            self.scope["run"].return_value = self.result(stdout="invalid")
            self.assertIsNone(self.call("health", {"includeGpu": True})["gpu"]["sampledAt"])
        self.scope["checked"] = lambda args: "100000"
        self.scope["run"] = lambda args: self.result(stdout="Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 5.\nPages speculative: 1.\n")
        with patch.object(self.scope["sys"], "platform", "darwin"), patch.object(self.scope["shutil"], "disk_usage", return_value=disk):
            result = self.call("health")
            self.assertEqual((result["cpuTotal"], result["cpuIdle"], result["memoryUsed"]), (0, 0, 100000 - 16 * 4096))
            self.assertEqual(result["resources"]["status"], "unsupported")

    def test_cgroup_unlimited_unknown_and_unresolvable_membership(self):
        proc, root = self.home / "proc", self.home / "cgroups"
        (proc / "self").mkdir(parents=True)
        (proc / "pressure").mkdir()
        root.mkdir()
        (root / "cgroup.controllers").touch()
        membership = proc / "self" / "cgroup"
        for value in ("", "1:cpu:/legacy", "0::relative", "0::/missing", "0::/../outside"):
            membership.write_text(value)
            self.assertEqual(self.call("resource_constraints", proc, root)["status"], "unknown")
        membership.write_text("0::/parent/worker")
        group = root / "parent" / "worker"
        group.mkdir(parents=True)
        for ancestor in (root, group.parent, group):
            (ancestor / "memory.max").write_text("max")
            (ancestor / "cpu.max").write_text("max 100000")
        (proc / "pressure" / "cpu").write_text("\nsome avg10=1.5 total=10\n")
        (group / "cpu.pressure").write_text("some invalid=bad\n")
        result = self.call("resource_constraints", proc, root)
        self.assertEqual((result["memoryLimitStatus"], result["cpuLimitStatus"]), ("unlimited", "unlimited"))
        self.assertEqual(result["pressure"]["cpu"]["some"]["avg10"], 1.5)
        self.assertIsNone(result["groupPressure"]["cpu"])
        (root / "memory.max").write_text("bad")
        (root / "cpu.max").write_text("1 0")
        self.assertEqual(self.call("resource_constraints", proc, root)["memoryLimitStatus"], "unknown")
        self.assertEqual(self.call("resource_constraints", proc, root)["cpuLimitStatus"], "unknown")
        (root / "memory.max").unlink()
        (root / "cpu.max").unlink()
        self.assertEqual(self.call("resource_constraints", proc, root)["memoryLimitStatus"], "unlimited")
        self.assertEqual(self.call("resource_constraints", proc, root)["cpuLimitStatus"], "unlimited")
        (group / "memory.max").unlink()
        self.assertEqual(self.call("resource_constraints", proc, root)["memoryLimitStatus"], "unknown")

    def test_centcom_workspace_rejects_unsafe_roots_and_invalid_file_map(self):
        root = self.home / ".cache" / "agentc2" / "centcom"
        root.parent.mkdir(parents=True)
        outside = self.home / "outside"
        outside.mkdir()
        root.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.call("centcom_sync", {})
        root.unlink()
        root.mkdir()
        with patch.object(os, "getuid", return_value=-1), self.assertRaisesRegex(ValueError, "owned safely"):
            self.call("centcom_sync", {})
        with self.assertRaisesRegex(ValueError, "workspace files"):
            self.call("centcom_sync", {"files": ["invalid"]})
        self.assertEqual(self.call("centcom_sync", {}), {"path": str(root), "written": []})

    def test_real_entrypoint_emits_bounded_error_and_success_envelopes(self):
        with patch.object(self.scope["sys"], "argv", ["remote"]), redirect_stdout(io.StringIO()) as out:
            runpy.run_path(str(ROOT / "electron" / "remote.py"), run_name="__main__")
        self.assertEqual(json.loads(out.getvalue()), {"ok": False, "error": "Missing remote request"})
        encoded = base64.b64encode(json.dumps({"action": "launch_paths", "cwd": str(self.home)}).encode()).decode()
        with patch.object(self.scope["sys"], "argv", ["remote", encoded]), redirect_stdout(io.StringIO()) as out:
            runpy.run_path(str(ROOT / "electron" / "remote.py"), run_name="__main__")
        self.assertEqual(json.loads(out.getvalue())["result"], {"cwd": str(self.home), "paths": []})


if __name__ == "__main__":
    unittest.main()
