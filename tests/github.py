import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("github", Path(__file__).parents[1] / "electron/github.py")
github = importlib.util.module_from_spec(spec)
spec.loader.exec_module(github)


class GithubTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.changed = False
        self.compare = "ahead"
        self.origin = "git@github.com:owner/repo.git"

    def execute(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == "git":
            return subprocess.CompletedProcess(args, 0, self.origin if "get-url" in args else "", "")
        if args[1:] == ["api", "user"]:
            value = {"login": "fixture"}
        elif args[1:3] == ["api", "repos/owner/repo"]:
            value = {"full_name": "owner/repo", "default_branch": "main", "permissions": {"push": True}}
        elif args[1] == "api":
            value = {"status": self.compare}
        elif args[1:3] == ["issue", "view"]:
            value = {"number": 52, "state": "OPEN", "updatedAt": "new" if self.changed else "original"}
        elif args[1:3] == ["pr", "view"]:
            value = {"number": 12, "state": "OPEN", "headRefOid": "b" * 40 if self.changed else "a" * 40, "isDraft": True}
        else:
            value = {}
        return subprocess.CompletedProcess(args, 0, json.dumps(value), "")

    def request(self, operation, **kwargs):
        return github.github_request(dict(repo="owner/repo", operation=operation, **kwargs))

    @patch.object(github.subprocess, "run")
    def test_identity_and_argv(self, run):
        run.side_effect = self.execute
        self.assertEqual(self.request("readiness")["login"], "fixture")
        self.request("readiness", repository="/fixture/repo")
        self.origin = "https://github.com/unrelated/project.git"
        with self.assertRaisesRegex(ValueError, "checkout origin"):
            self.request("readiness", repository="/fixture/repo")
        self.request("issue", issue="https://github.com/owner/repo/issues/52")
        self.assertIn("52", self.calls[-1][0])
        with self.assertRaises(ValueError):
            self.request("issue", issue="https://github.com/other/repo/issues/52")
        with self.assertRaises(ValueError):
            self.request("pr", number=True)
        with self.assertRaises(ValueError):
            github.github_request(dict(repo="--help", operation="readiness"))
        self.request("issues", query="is:open $(touch /tmp/nope)")
        self.assertIn("is:open $(touch /tmp/nope)", self.calls[-1][0])
        self.assertNotIn("shell", self.calls[-1][1])
        self.assertEqual(self.calls[-1][1]["env"]["GH_PROMPT_DISABLED"], "1")

    @patch.object(github.subprocess, "run")
    def test_stale_pr(self, run):
        run.side_effect = self.execute
        self.changed = True
        with self.assertRaisesRegex(ValueError, "PR changed"):
            self.request("ready", number=12, headCommit="a" * 40)
        self.assertFalse(any(args[1:3] == ["pr", "ready"] for args, _ in self.calls))
        self.changed = False
        self.assertFalse(self.request("ready", number=12, headCommit="a" * 40)["isDraft"])

    @patch.object(github.subprocess, "run")
    def test_closure_evidence(self, run):
        run.side_effect = self.execute
        with tempfile.TemporaryDirectory() as repository:
            args = dict(number=52, repository=repository, updatedAt="original", evidence={"commit": "a" * 40, "summary": "Regression fixed in the cited commit; reviewed test coverage."})
            self.compare = "behind"
            with self.assertRaisesRegex(ValueError, "default branch"):
                self.request("close", **args)
            self.compare = "ahead"
            self.changed = True
            with self.assertRaisesRegex(ValueError, "Issue changed"):
                self.request("close", **args)
            self.assertFalse(any(a[1:3] == ["issue", "close"] for a, _ in self.calls))
            self.changed = False
            self.assertEqual(self.request("close", **args)["state"], "CLOSED")
            self.assertIn("https://github.com/owner/repo/commit/" + "a" * 40, self.calls[-1][0][-1])

    @patch.object(github.subprocess, "run")
    def test_auth_error_redacted(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, "token-secret", "token-secret")
        with self.assertRaises(ValueError) as error:
            self.request("readiness")
        self.assertNotIn("token-secret", str(error.exception))
        run.side_effect = FileNotFoundError()
        with self.assertRaisesRegex(ValueError, "Install gh"):
            self.request("readiness")


if __name__ == "__main__":
    unittest.main()
