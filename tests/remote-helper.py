"""Exit evidence must stay authoritative when tmux lacks a wait status."""
from pathlib import Path
import subprocess
import unittest


scope = {"__name__": "agentc2_helper_test"}
exec((Path(__file__).resolve().parents[1] / "electron" / "remote.py").read_text(), scope)


class ExitEvidence(unittest.TestCase):
    def session(self, status="", record="1234:7", pid="1234", dead="1", managed=True):
        name = "hq-123456abcdef" if managed else "external"
        row = "\t".join([name, "1000", "0", "codex", "/tmp", dead, status, "1001", pid, record])

        def run(args, **_):
            return subprocess.CompletedProcess(args, 0, row if args[1] == "list-sessions" else "", "")

        scope["run"] = run
        scope["tmux_option"] = lambda _name, option: "codex" if option == "@hq_provider" else ""
        return scope["tmux_sessions"]()[0]

    def test_recorded_child_failure_and_success(self):
        self.assertEqual(self.session()["exitCode"], 7)
        self.assertEqual(self.session(record="1234:0")["exitCode"], 0)

    def test_native_wait_status_has_priority(self):
        self.assertEqual(self.session(status="9")["exitCode"], 9)

    def test_respawn_and_unknown_exits_do_not_infer_completion(self):
        for values in [{"pid": "5678"}, {"record": ""}, {"record": "bad"}, {"record": "1234:256"}, {"dead": "0"}, {"managed": False}]:
            with self.subTest(values=values):
                self.assertIsNone(self.session(**values)["exitCode"])


if __name__ == "__main__":
    unittest.main()
