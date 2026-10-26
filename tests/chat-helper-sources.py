"""Standalone worker helper behavior and unchanged process/SDK boundaries."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def execute(name):
    file = ROOT / 'electron' / name
    exec(compile(file.read_text(), str(file), 'exec'), {})


class WorkerHelperSources(unittest.TestCase):
    def test_history_missing_empty_and_populated_native_session(self):
        for messages in [None, [], [SimpleNamespace(uuid='fixture-message', type='assistant', message={'content': 'fixture text'})]]:
            sdk = ModuleType('claude_agent_sdk')
            sdk.get_session_info = Mock(return_value=None if messages is None else SimpleNamespace(id='native-session'))
            sdk.get_session_messages = Mock(return_value=messages)
            output = io.StringIO()
            with patch.dict(sys.modules, {'claude_agent_sdk': sdk}), patch.object(sys, 'argv', ['helper', 'native-session', '/fixture/cwd']), redirect_stdout(output):
                execute('chat_claude_history.py')
            sdk.get_session_info.assert_called_once_with('native-session', directory='/fixture/cwd')
            if messages is None:
                sdk.get_session_messages.assert_not_called()
                self.assertIsNone(json.loads(output.getvalue()))
            else:
                sdk.get_session_messages.assert_called_once_with('native-session', directory='/fixture/cwd')
                self.assertEqual(json.loads(output.getvalue()), [vars(message) for message in messages])

    def test_history_sdk_failure_is_not_converted_to_empty_history(self):
        sdk = ModuleType('claude_agent_sdk')
        sdk.get_session_info = Mock(side_effect=OSError('Fixture history storage is unreadable'))
        sdk.get_session_messages = Mock()
        with patch.dict(sys.modules, {'claude_agent_sdk': sdk}), patch.object(sys, 'argv', ['helper', 'native-session', '/fixture/cwd']):
            with self.assertRaisesRegex(OSError, 'storage is unreadable'):
                execute('chat_claude_history.py')

    def test_launcher_keeps_original_detach_and_stream_flags(self):
        with patch.object(sys, 'argv', ['helper', 'fixture-python', 'worker.py', '--directory', '/fixture']), patch('subprocess.Popen') as spawn, patch('os._exit', side_effect=SystemExit) as exit_process:
            with self.assertRaises(SystemExit):
                execute('chat_launcher.py')
        spawn.assert_called_once_with(['fixture-python', 'worker.py', '--directory', '/fixture'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=None, start_new_session=True, close_fds=True)
        exit_process.assert_called_once_with(0)

    def test_real_launcher_returns_after_starting_the_detached_child(self):
        with tempfile.TemporaryDirectory(prefix='agentc2-detached-helper-') as directory:
            marker = Path(directory) / 'completed'
            child = Path(directory) / 'child.py'
            child.write_text('from pathlib import Path\nimport sys\nPath(sys.argv[1]).write_text("completed")\n')
            result = subprocess.run([sys.executable, str(ROOT / 'electron/chat_launcher.py'), sys.executable, str(child), str(marker)], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(result.stdout, b'')
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(marker.read_text(), 'completed')


if __name__ == '__main__':
    unittest.main()
