"""Version/auth admission and native schema checks without SDKs or provider calls."""
import importlib.metadata
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "electron"))
import chat_adapters as registry
import chat_antigravity as antigravity
import chat_claude as claude
import chat_codex as codex
import chat_codex_schema as schema
import chat_opencode as opencode
from chat_protocol import CONTRACT, validate_capabilities


class Registry(unittest.TestCase):
    def probe(self, provider, version="0.0.0", sdk=None, authenticated=False, binary="/fixture/provider", result=None):
        def metadata(name):
            if sdk is None:
                raise importlib.metadata.PackageNotFoundError(name)
            return sdk
        response = result or types.SimpleNamespace(returncode=0, stdout="Fixture " + version)
        with patch.object(registry.shutil, "which", return_value=binary), patch.object(claude, "cli_binary", return_value=binary), patch.object(registry.importlib.metadata, "version", side_effect=metadata), patch.object(claude, "auth_available", return_value=authenticated), patch.object(antigravity, "auth_available", return_value=authenticated), patch.object(registry.subprocess, "run", return_value=response) as run:
            value = registry.probe_capabilities(provider)
            validate_capabilities(value)
            if run.called:
                self.assertEqual(run.call_args.args, ([binary, "--version"],))
                self.assertEqual(run.call_args.kwargs["timeout"], 8)
                self.assertFalse(run.call_args.kwargs["check"])
            return value

    def test_missing_unverified_and_failed_cli_probes_never_advertise_actions(self):
        with self.assertRaisesRegex(ValueError, "Invalid provider"):
            registry.probe_capabilities("terminal")
        for provider in ("codex", "claude", "opencode"):
            self.assertEqual(self.probe(provider, binary=None)["status"], "unverified")
            for response in [types.SimpleNamespace(returncode=1, stdout="1.2.3"), types.SimpleNamespace(returncode=0, stdout="No version"), types.SimpleNamespace(returncode=0, stdout="x" * 1000 + " 1.2.3")]:
                value = self.probe(provider, result=response)
                self.assertNotEqual(value["status"], "supported")
                self.assertFalse(any(value[name] for name in CONTRACT["capabilities"]))
        for error in [OSError("Missing fixture executable"), subprocess.TimeoutExpired("fixture", 8)]:
            with patch.object(registry.shutil, "which", return_value="/fixture/provider"), patch.object(registry.subprocess, "run", side_effect=error):
                self.assertEqual(registry.probe_capabilities("codex")["status"], "unverified")

    def test_supported_cli_versions_and_sdk_authentication_boundaries(self):
        value = self.probe("codex", schema.BUNDLE["version"])
        self.assertEqual(value["status"], "supported")
        self.assertTrue(value["steering"])
        for version in opencode.SUPPORTED_VERSIONS:
            value = self.probe("opencode", version)
            self.assertEqual(value["status"], "supported")
            self.assertFalse(value["steering"])
        cli = claude.SUPPORTED_CLI_VERSIONS[0]
        self.assertIn("automatically prepare", self.probe("claude", cli)["reason"])
        self.assertNotEqual(self.probe("claude", cli, sdk="0.0.0", authenticated=True)["status"], "supported")
        self.assertNotEqual(self.probe("claude", "0.0.0", sdk=claude.SUPPORTED_SDK_VERSION, authenticated=True)["status"], "supported")
        self.assertIn("authentication", self.probe("claude", cli, sdk=claude.SUPPORTED_SDK_VERSION)["reason"])
        self.assertEqual(self.probe("claude", cli, sdk=claude.SUPPORTED_SDK_VERSION, authenticated=True)["status"], "supported")
        self.assertIn("automatically prepare", self.probe("antigravity")["reason"])
        self.assertIn("needs preparation", self.probe("antigravity", sdk="0.0.0")["reason"])
        self.assertIn("authentication", self.probe("antigravity", sdk=antigravity.SUPPORTED_SDK_VERSION)["reason"])
        self.assertEqual(self.probe("antigravity", sdk=antigravity.SUPPORTED_SDK_VERSION, authenticated=True)["status"], "supported")

    def test_codex_upgrade_preserves_old_version_and_rejects_unverified_versions(self):
        for version in ("0.163.0", "0.164.0", "0.165.0"):
            with self.subTest(version=version):
                value = self.probe("codex", version)
                self.assertEqual(value["status"], "supported")
                self.assertEqual(value["version"], version)
                self.assertTrue(value["approvals"])
                self.assertTrue(value["resume"])
        for version in ("0.162.0", "0.166.0", "1.0.0"):
            self.assertEqual(self.probe("codex", version)["status"], "unverified")

    def test_factory_routes_only_currently_verified_providers(self):
        journal = object()
        for provider, module, name in [("codex", codex, "CodexAdapter"), ("opencode", opencode, "OpenCodeAdapter"), ("claude", claude, "ClaudeAdapter"), ("antigravity", antigravity, "AntigravityAdapter")]:
            session = {"provider": provider}
            constructor = Mock(return_value=object())
            with patch.object(module, name, constructor), patch.object(registry, "probe_capabilities", return_value={"status": "unverified"}):
                with self.assertRaises(registry.ProviderRejected):
                    registry.create_adapter(session, journal)
                constructor.assert_not_called()
            with patch.object(module, name, constructor), patch.object(registry, "probe_capabilities", return_value={"status": "supported"}):
                self.assertIs(registry.create_adapter(session, journal), constructor.return_value)
                constructor.assert_called_once_with(session, journal)
        with self.assertRaises(registry.ProviderRejected):
            registry.create_adapter({"provider": "terminal"}, journal)


class NativeSchema(unittest.TestCase):
    def test_codex_version_specific_responses_preserve_the_deployed_contract(self):
        account = dict(account=dict(type="chatgpt", email=None, planType="sci"), requiresOpenaiAuth=True)
        image = dict(threadId="thread", turnId="turn", completedAtMs=1, item=dict(type="imageGeneration", id="image", status="completed", fileId="file"))
        for name, value in [("v2/GetAccountResponse", account), ("v2/ItemCompletedNotification", image)]:
            with self.subTest(name=name):
                self.assertIs(schema.validate_native(name, value, "0.165.0"), value)
                with self.assertRaisesRegex(ValueError, "Invalid Codex"):
                    schema.validate_native(name, value, "0.163.0")
                with self.assertRaisesRegex(ValueError, "Unsupported Codex protocol version"):
                    schema.validate_native(name, value, "0.166.0")
        with self.assertRaisesRegex(ValueError, "Invalid Codex"):
            schema.validate_native("v2/AgentMessageDeltaNotification", dict(delta="text"), "0.165.0")

    def accepts(self, definition, value, valid=True):
        with patch.dict(schema.BUNDLE["schemas"], {"UnitFixture": definition}):
            if valid:
                self.assertIs(schema.validate_native("UnitFixture", value), value)
            else:
                with self.assertRaisesRegex(ValueError, "Invalid Codex UnitFixture payload"):
                    schema.validate_native("UnitFixture", value)

    def test_boolean_combinator_type_and_object_contracts(self):
        for definition, value, valid in [
            (True, None, True), (False, {}, False),
            ({"allOf": [{"type": "integer"}, {"minimum": 0}]}, 1, True),
            ({"allOf": [{"type": "integer"}, {"minimum": 0}]}, -1, False),
            ({"anyOf": [{"type": "string"}, {"type": "integer"}]}, {}, False),
            ({"oneOf": [{"type": "integer"}, {"type": "integer"}]}, 1, False),
            ({"oneOf": [{"type": "string"}, {"type": "integer"}]}, 1, True),
            ({"enum": ["one", "two"]}, "three", False),
            ({"type": ["null", "integer"]}, None, True),
            ({"type": "integer"}, True, False),
            ({"type": "unknown"}, 1, False),
            ({"type": "object", "required": ["id"]}, {}, False),
            ({"type": "object", "additionalProperties": False}, {"extra": True}, False),
        ]:
            with self.subTest(definition=definition, value=value):
                self.accepts(definition, value, valid)

    def test_collection_text_numeric_limits_and_recursive_depth(self):
        self.accepts({"type": "array", "minItems": 1}, [], False)
        self.accepts({"type": "array", "maxItems": 1}, [1, 2], False)
        self.accepts({"type": "array", "items": {"type": "integer"}}, [1, "bad"], False)
        self.accepts({"type": "array"}, [])
        text = {"type": "string", "minLength": 1, "maxLength": 2, "pattern": "^[a-z]+$"}
        for value, valid in [("", False), ("abc", False), ("A", False), ("ok", True)]:
            self.accepts(text, value, valid)
        for value, valid in [(-1, False), (3, False), (1, True)]:
            self.accepts({"type": "number", "minimum": 0, "maximum": 2}, value, valid)
        recursive = {"$ref": "#/definitions/node", "definitions": {"node": {"type": "object", "properties": {"child": {"$ref": "#/definitions/node"}}}}}
        self.accepts(recursive, {"child": {}})
        value = {}
        for _ in range(60):
            value = {"child": value}
        self.accepts(recursive, value, False)


if __name__ == "__main__":
    unittest.main()
