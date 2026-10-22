"""Disposable project tests for OpOrder rendering, ownership, and recovery."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
scope = {"__name__": "agentc2_oporder_test"}
exec((ROOT / "electron" / "remote.py").read_text(), scope)
exec((ROOT / "electron" / "oporders.py").read_text(), scope)


class OpOrders(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="agentc2-oporder-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.repo = self.home / "project"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        scope["HOME"] = self.home
        self.order = {"version": 1, "id": "project", "repository": str(self.repo), "enabled": True,
                      "instructions": "Shared project guidance", "overrides": {"codex": "", "claude": "Claude guidance", "antigravity": "Antigravity guidance"},
                      "mcp": [{"name": "docs", "transport": "http", "url": "https://example.com/mcp", "headers": {}, "env": [], "providers": ["codex", "claude", "antigravity"]},
                              {"name": "database", "transport": "stdio", "command": "db-server", "args": ["--readonly"], "env": ["DB_TOKEN"], "headers": {}, "providers": ["codex", "claude"]}]}

    def preview(self):
        return scope["oporder_preview"]({"order": self.order})

    def sync(self, revision=None):
        return scope["oporder_sync"]({"order": self.order, **({"revision": revision} if revision else {})})

    def test_supported_outputs_idempotence_and_unrelated_content(self):
        (self.repo / "AGENTS.md").write_text("Existing team guidance\n")
        (self.repo / ".mcp.json").write_text(json.dumps({"mcpServers": {"other": {"type": "stdio", "command": "other"}}, "metadata": "keep"}) + "\n")
        preview = self.preview()
        self.assertTrue(preview["ready"])
        self.assertFalse((self.home / ".cache" / "agentc2" / "oporders").exists(), "Preview must not write remote state")
        self.assertIn("AGENTS.md", [item["path"] for item in preview["changes"] if item["status"] != "unchanged"])
        self.assertEqual(self.sync(preview["revision"])["status"], "applied")
        self.assertIn("Existing team guidance", (self.repo / "AGENTS.md").read_text())
        self.assertIn("Shared project guidance", (self.repo / "AGENTS.md").read_text())
        self.assertIn("Claude guidance", (self.repo / "CLAUDE.md").read_text())
        self.assertIn("Antigravity guidance", (self.repo / ".agents/rules/agentc2.md").read_text())
        self.assertIn('env_vars = ["DB_TOKEN"]', (self.repo / ".codex/config.toml").read_text())
        claude = json.loads((self.repo / ".mcp.json").read_text())
        self.assertEqual(claude["mcpServers"]["database"]["env"]["DB_TOKEN"], "${DB_TOKEN}")
        self.assertEqual(claude["mcpServers"]["other"]["command"], "other")
        self.assertEqual(claude["metadata"], "keep")
        antigravity = json.loads((self.repo / ".agents/mcp_config.json").read_text())
        self.assertEqual(antigravity["mcpServers"]["docs"]["serverUrl"], "https://example.com/mcp")
        self.assertEqual(self.sync()["status"], "unchanged")

    def test_conflicts_and_stale_preview_preserve_remote_edits(self):
        preview = self.preview()
        self.sync(preview["revision"])
        agents = self.repo / "AGENTS.md"
        agents.write_text(agents.read_text().replace("Shared project guidance", "Remote edit"))
        before = agents.read_bytes()
        self.assertFalse(self.preview()["ready"])
        with self.assertRaisesRegex(ValueError, "conflicts"):
            self.sync()
        self.assertEqual(agents.read_bytes(), before)
        agents.write_text(agents.read_text().replace("Remote edit", "Shared project guidance"))
        old_revision = self.preview()["revision"]
        agents.write_text("Local unrelated preface\n" + agents.read_text())
        with self.assertRaisesRegex(ValueError, "stale"):
            self.sync(old_revision)

    def test_unsupported_conversions_and_unowned_server(self):
        self.order["overrides"]["codex"] = "Codex-only guidance"
        self.assertFalse(self.preview()["ready"])
        self.assertIn("Codex-only", self.preview()["unsupported"][0])
        self.order["overrides"]["codex"] = ""
        self.order["mcp"][1]["providers"].append("antigravity")
        self.assertFalse(self.preview()["ready"])
        self.order["mcp"][1]["providers"].remove("antigravity")
        (self.repo / ".mcp.json").write_text(json.dumps({"mcpServers": {"docs": {"type": "http", "url": "https://other.example/mcp"}}}))
        self.assertFalse(self.preview()["ready"])
        self.assertEqual(next(item for item in self.preview()["changes"] if item["path"] == ".mcp.json")["status"], "conflict")

    def test_preview_hides_unrelated_secrets_and_preserves_empty_files(self):
        (self.repo / "AGENTS.md").write_text("Unrelated secret: DO_NOT_SHOW_THIS\n")
        (self.repo / ".mcp.json").write_text(json.dumps({"mcpServers": {"unmanaged": {"token": "DO_NOT_SHOW_THIS"}}}))
        (self.repo / ".agents").mkdir()
        (self.repo / ".agents/mcp_config.json").write_text("{}\n")
        preview = self.preview()
        self.assertNotIn("DO_NOT_SHOW_THIS", json.dumps(preview))
        self.sync(preview["revision"])
        self.assertIn("DO_NOT_SHOW_THIS", (self.repo / ".mcp.json").read_text())
        self.order["mcp"] = []
        self.sync(self.preview()["revision"])
        self.assertTrue((self.repo / ".agents/mcp_config.json").exists())

    def test_failed_write_rolls_back_content_and_mode(self):
        agents = self.repo / "AGENTS.md"
        agents.write_text("Existing guidance\n")
        agents.chmod(0o600)
        preview = self.preview()
        before = agents.read_bytes()
        replace = os.replace
        failed = False

        def fail_once(source, destination):
            nonlocal failed
            if not failed and str(destination).endswith("CLAUDE.md"):
                failed = True
                raise OSError("simulated interrupted write")
            return replace(source, destination)

        with patch.object(os, "replace", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "interrupted write"):
                self.sync(preview["revision"])
        self.assertTrue(failed)
        self.assertEqual(agents.read_bytes(), before)
        self.assertEqual(agents.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.repo / "CLAUDE.md").exists())
        self.assertTrue(self.preview()["ready"])


if __name__ == "__main__":
    unittest.main()
