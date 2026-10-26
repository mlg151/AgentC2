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
            value = {"number": 12, "state": "OPEN", "headRefOid": "b" * 40 if self.changed else "a" * 40, "isDraft": True, "headRefName": "feature/fixture"}
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


    @patch.object(github.subprocess, "run")
    def test_issue_url_requires_the_exact_github_host(self, run):
        run.side_effect = self.execute
        for hostname in ("githubXcom", "github-com", "github.com.evil.invalid"):
            with self.subTest(hostname=hostname), self.assertRaises(ValueError):
                self.request("issue", issue=f"https://{hostname}/owner/repo/issues/52")
        self.assertEqual(self.calls, [], "Invalid URLs must not reach gh")


    @patch.object(github.subprocess, "run")
    def test_direct_issue_numbers_filters_and_unsupported_operations(self, run):
        run.side_effect = self.execute
        for value in (52, "52", "#52"):
            self.request("issue", issue=value)
            self.assertEqual(self.calls[-1][0][3], "52")
        before = len(self.calls)
        for value in (True, 0, -1, 1000000000, "not-an-issue"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "Invalid issue or PR number"):
                self.request("issue", issue=value)
        for value in (1, "x" * 501, "is:open\0injected"):
            with self.subTest(value_type=type(value).__name__), self.assertRaisesRegex(ValueError, "Invalid issue filter"):
                self.request("issues", query=value)
        for repository in (True, "relative/path"):
            with self.assertRaisesRegex(ValueError, "absolute repository path"):
                self.request("readiness", repository=repository)
        with self.assertRaisesRegex(ValueError, "Unsupported GitHub operation"):
            self.request("merge")
        self.assertEqual(len(self.calls), before, "Invalid inputs never reach a subprocess")

    @patch.object(github.subprocess, "run")
    def test_oversized_responses_and_plain_pr_reads(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "x" * 500001, "")
        with self.assertRaisesRegex(ValueError, "too large"):
            self.request("readiness")
        self.assertEqual(run.call_count, 1)
        run.side_effect = self.execute
        pr = self.request("pr", number=12)
        self.assertTrue(pr["isDraft"])
        self.assertFalse(any(args[1:3] == ["pr", "ready"] for args, _ in self.calls))

    @patch.object(github.subprocess, "run")
    def test_ready_checks_state_branch_and_already_ready_readback(self, run):
        def reply(args, **kwargs):
            result = self.execute(args, **kwargs)
            if args[1:3] == ["pr", "view"]:
                value = json.loads(result.stdout)
                value.update(overrides)
                result.stdout = json.dumps(value)
            return result
        run.side_effect = reply
        for overrides, expected_branch in (({"state": "CLOSED"}, "feature/fixture"), ({}, "other-branch")):
            with self.assertRaisesRegex(ValueError, "PR changed"):
                self.request("ready", number=12, headCommit="a" * 40, expectedBranch=expected_branch)
        self.assertFalse(any(args[1:3] == ["pr", "ready"] for args, _ in self.calls))
        overrides = {"isDraft": False}
        value = self.request("ready", number=12, headCommit="a" * 40, expectedBranch="feature/fixture")
        self.assertFalse(value["isDraft"])
        self.assertFalse(any(args[1:3] == ["pr", "ready"] for args, _ in self.calls), "An already-ready PR needs no mutation")

    @patch.object(github.subprocess, "run")
    def test_closure_input_and_missing_local_commit_reject_mutation(self, run):
        run.side_effect = self.execute
        with tempfile.TemporaryDirectory() as repository:
            args = dict(number=52, repository=repository, updatedAt="original", evidence={"commit": "a" * 40, "summary": "Reviewed regression evidence."})
            for value in (None, "relative", str(Path(repository) / "missing")):
                with self.assertRaisesRegex(ValueError, "absolute repository path"):
                    self.request("close", **{**args, "repository": value})
            for evidence in (None, {}, {"commit": "bad", "summary": "Reviewed evidence"}, {"commit": "a" * 40, "summary": 1}, {"commit": "a" * 40, "summary": "short"}, {"commit": "a" * 40, "summary": "x" * 4001}):
                with self.assertRaisesRegex(ValueError, "full commit SHA"):
                    self.request("close", **{**args, "evidence": evidence})
            self.assertEqual(self.calls, [])
            def missing_commit(command, **kwargs):
                if command[0] == "git":
                    self.calls.append((command, kwargs))
                    return subprocess.CompletedProcess(command, 1, "", "fixture missing commit")
                return self.execute(command, **kwargs)
            run.side_effect = missing_commit
            with self.assertRaisesRegex(ValueError, "commit is missing"):
                self.request("close", **args)
            self.assertFalse(any(command[1:3] == ["issue", "close"] for command, _ in self.calls))

    @patch.object(github.subprocess, "run")
    def test_closed_issue_is_not_closed_again_with_identical_ancestor(self, run):
        self.compare = "identical"
        def reply(args, **kwargs):
            result = self.execute(args, **kwargs)
            if args[1:3] == ["issue", "view"]:
                result.stdout = json.dumps({"number": 52, "state": "CLOSED", "updatedAt": "original"})
            return result
        run.side_effect = reply
        with tempfile.TemporaryDirectory() as repository:
            with self.assertRaisesRegex(ValueError, "Issue changed"):
                self.request("close", number=52, repository=repository, updatedAt="original", evidence={"commit": "a" * 40, "summary": "Reviewed regression evidence."})
        self.assertFalse(any(args[1:3] == ["issue", "close"] for args, _ in self.calls))


if __name__ == "__main__":
    unittest.main()
