"""Cold daemon bootstrap and real SDK boundary suites; never uses live models."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'electron'))
from chat_remote import CHAT_WORKER_FILES, chat_remote
from chat_runtime import SDK_PACKAGES, runtime_python
from chat_protocol import CONTRACT


class RuntimeTests(unittest.TestCase):
    def test_private_runtime_without_system_sdk_and_automatic_provider_setup(self):
        with tempfile.TemporaryDirectory(prefix='agentc2-runtime-') as temporary:
            directory = Path(temporary)
            files = {name: (ROOT / 'electron' / name).read_text() for name in CHAT_WORKER_FILES}
            health = None
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def do_POST(self):
                    self.rfile.read(int(self.headers['Content-Length']))
                    data = ('data: ' + json.dumps(dict(id='fixture', object='chat.completion.chunk', choices=[dict(index=0, delta=dict(role='assistant', content='Worker SDK answer'), finish_reason=None)])) + '\n\ndata: ' + json.dumps(dict(id='fixture', object='chat.completion.chunk', choices=[dict(index=0, delta={}, finish_reason='stop')])) + '\n\ndata: [DONE]\n\n').encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            old_environment = {key: os.environ.get(key) for key in ('AGENTC2_ANTIGRAVITY_BASE_URL', 'AGENTC2_ANTIGRAVITY_MODEL')}
            os.environ['AGENTC2_ANTIGRAVITY_BASE_URL'] = f'http://127.0.0.1:{server.server_port}/v1'
            os.environ['AGENTC2_ANTIGRAVITY_MODEL'] = 'fixture'
            try:
                health = chat_remote(dict(chatFiles=files, request=dict(protocolVersion=1, action='health')), directory)
                digest = health['sourceDigest']
                def prepare(provider):
                    return chat_remote(dict(sourceDigest=digest, request=dict(protocolVersion=1, action='capabilities', prepareProvider=provider)), directory)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    for result in pool.map(prepare, ['claude', 'antigravity']):
                        self.assertEqual({item['provider'] for item in result}, set(CONTRACT['providers']))
                executable = runtime_python(directory)
                self.assertEqual(Path(executable).parent.parent.stat().st_mode & 0o777, 0o700)
                check = subprocess.run([executable, '-c', "import importlib.metadata,json,sys;print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix,'claude':importlib.metadata.version('claude-agent-sdk'),'antigravity':importlib.metadata.version('google-antigravity')}))"], capture_output=True, text=True, check=True)
                versions = json.loads(check.stdout)
                self.assertNotEqual(versions['prefix'], versions['base'])
                for provider, (_, version) in SDK_PACKAGES.items():
                    self.assertEqual(versions[provider], version)
                self.assertEqual(prepare('antigravity'), prepare('antigravity'), 'Prepared environment is not stable across requests')
                def rpc(action, **values):
                    return chat_remote(dict(sourceDigest=digest, request=dict(protocolVersion=1, action=action, **values)), directory)
                create = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation='create', payload=dict(provider='antigravity', cwd=temporary, title='Worker SDK fixture', roeProfile='full', instructions='Worker SDK prompt'))
                session = rpc('command', command=create)['sessionId']
                def wait_for(callback):
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        if value := callback():
                            return value
                        time.sleep(0.05)
                    self.fail('Worker SDK command did not complete')
                wait_for(lambda: rpc('receipt', commandId=create['commandId'])['state'] == 'completed')
                def completed_turn():
                    page = rpc('history', sessionId=session)
                    return page if any(event['type'] == 'turn.completed' for event in page['events']) else None
                page = wait_for(completed_turn)
                self.assertTrue(page['session']['providerSessionId'])
                self.assertTrue(any(event['type'] == 'message.completed' and event['data']['text'] == 'Worker SDK answer' for event in page['events']))
                stop = dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation='stop', sessionId=session, payload={})
                rpc('command', command=stop)
                wait_for(lambda: rpc('receipt', commandId=stop['commandId'])['state'] == 'completed')
                environment = {**os.environ, 'HOME': str(directory), 'PYTHONDONTWRITEBYTECODE': '1'}
                for test in ['chat-antigravity-sdk.py', 'chat-claude-native.py']:
                    subprocess.run([executable, str(ROOT / 'tests' / test)], check=True, env=environment)
            finally:
                if health:
                    os.kill(health['pid'], signal.SIGTERM)
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
                for key, value in old_environment.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


if __name__ == '__main__':
    unittest.main()
