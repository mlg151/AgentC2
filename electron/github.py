"""Host-scoped GitHub CLI bridge. Credentials remain in the host's gh store."""
import json
import os
from pathlib import Path
import re
import subprocess


def github_request(payload):
    repo = payload.get("repo", "")
    if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or any(part.startswith(".") for part in repo.split("/")):
        raise ValueError("Use a GitHub owner/repository")
    operation = payload.get("operation")
    env = {**os.environ, "GH_HOST": "github.com", "GH_PROMPT_DISABLED": "1", "GH_PAGER": "cat"}

    def gh(*args, json_output=True):
        try:
            result = subprocess.run(["gh", *args], env=env, capture_output=True, text=True, timeout=25)
        except FileNotFoundError:
            raise ValueError("Install gh on this host and run gh auth login") from None
        if result.returncode:
            # Do not return auth diagnostics: some gh versions print token details.
            raise ValueError("GitHub request failed; check host gh authentication, repository access, and network")
        if len(result.stdout) > 500000:
            raise ValueError("GitHub response is too large; narrow the query")
        return json.loads(result.stdout) if json_output else result.stdout.strip()

    def number(value):
        if not isinstance(value, int) or isinstance(value, bool) or not 0 < value < 1000000000:
            raise ValueError("Invalid issue or PR number")
        return str(value)

    if operation == "readiness":
        if payload.get("repository"):
            repository_path = payload["repository"]
            if not isinstance(repository_path, str) or not Path(repository_path).is_absolute():
                raise ValueError("Choose an absolute repository path")
            origin = subprocess.run(["git", "-C", repository_path, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=10)
            remote = origin.stdout.strip().removesuffix(".git")
            match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)", remote)
            if origin.returncode or not match or match[1].lower() != repo.lower():
                raise ValueError("Selected checkout origin must match the GitHub repository")
        identity = gh("api", "user")
        repository = gh("api", "repos/" + repo)
        return {"login": identity["login"], "repo": repository["full_name"], "defaultBranch": repository["default_branch"], "permissions": repository.get("permissions", {})}
    if operation == "issue":
        issue = payload.get("issue")
        if isinstance(issue, str):
            match = re.fullmatch(r"https://github.com/([^/]+/[^/]+)/issues/([0-9]+)", issue)
            if match:
                if match[1].lower() != repo.lower():
                    raise ValueError("Issue URL belongs to another repository")
                issue = int(match[2])
            elif re.fullmatch(r"#?[0-9]+", issue):
                issue = int(issue.lstrip("#"))
        return gh("issue", "view", number(issue), "--repo", repo, "--json", "number,title,body,url,state,updatedAt,labels")
    if operation == "issues":
        query = payload.get("query", "is:open is:issue")
        if not isinstance(query, str) or len(query) > 500 or "\0" in query:
            raise ValueError("Invalid issue filter")
        return gh("issue", "list", "--repo", repo, "--search", query, "--limit", "100", "--json", "number,title,body,url,state,updatedAt,labels")
    if operation in ("pr", "ready"):
        pr_number = number(payload.get("number"))
        pr = gh("pr", "view", pr_number, "--repo", repo, "--json", "number,title,url,state,isDraft,headRefOid,headRefName,baseRefName,reviewDecision,statusCheckRollup")
        if operation == "ready":
            if pr["headRefOid"] != payload.get("headCommit") or pr["state"] != "OPEN" or (payload.get("expectedBranch") and pr["headRefName"] != payload["expectedBranch"]):
                raise ValueError("PR changed; refresh and review its current head")
            if pr["isDraft"]:
                gh("pr", "ready", pr_number, "--repo", repo, json_output=False)
            pr["isDraft"] = False
        return pr
    if operation == "close":
        issue_number = number(payload.get("number"))
        evidence = payload.get("evidence")
        repository = payload.get("repository")
        if not isinstance(repository, str) or not Path(repository).is_absolute() or not Path(repository).is_dir():
            raise ValueError("Choose an absolute repository path")
        if not isinstance(evidence, dict) or not re.fullmatch(r"[a-f0-9]{40,64}", evidence.get("commit", "")) or not isinstance(evidence.get("summary"), str) or not 10 <= len(evidence["summary"]) <= 4000:
            raise ValueError("Closure requires a full commit SHA and a reviewed evidence summary")
        # Validate the commit against GitHub's default branch, not a local branch
        # with an unrelated origin. A matching SHA alone is not proof of a fix.
        metadata = gh("api", "repos/" + repo)
        commit = evidence["commit"]
        comparison = gh("api", "repos/" + repo + "/compare/" + commit + "..." + metadata["default_branch"])
        if comparison.get("status") not in ("ahead", "identical"):
            raise ValueError("Evidence commit is not on the GitHub default branch")
        checked = subprocess.run(["git", "-C", repository, "cat-file", "-e", commit + "^{commit}"], capture_output=True, timeout=10)
        if checked.returncode:
            raise ValueError("Evidence commit is missing from the selected repository")
        issue = gh("issue", "view", issue_number, "--repo", repo, "--json", "number,state,updatedAt")
        if issue["state"] != "OPEN" or issue["updatedAt"] != payload.get("updatedAt"):
            raise ValueError("Issue changed; refresh its closure evidence")
        comment = "AgentC2 reviewed closure evidence: https://github.com/" + repo + "/commit/" + commit + "\n\n" + evidence["summary"]
        gh("issue", "close", issue_number, "--repo", repo, "--comment", comment, json_output=False)
        return {"number": int(issue_number), "state": "CLOSED", "commit": commit}
    raise ValueError("Unsupported GitHub operation")
