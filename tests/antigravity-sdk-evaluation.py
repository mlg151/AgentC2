"""Optional pinned SDK boundary probe; only talks to a loopback model fixture.

Install google-antigravity==0.1.22 into an isolated environment before running.
This is evaluation evidence, not a production SDK adapter.
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
from pathlib import Path
import tempfile
import threading
import unittest

try:
    AVAILABLE = importlib.metadata.version('google-antigravity') == '0.1.22'
except importlib.metadata.PackageNotFoundError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, 'Install google-antigravity==0.1.22 in an isolated evaluation environment')
class SdkEvaluation(unittest.TestCase):
    def test_native_persistence_resumes_prior_context_without_cloud_credentials(self):
        from google.antigravity import Agent, LocalOpenAIAgentConfig, types
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(dict(path=self.path, body=body))
                chunks = [dict(id='chatcmpl-fixture', object='chat.completion.chunk', choices=[dict(index=0, delta=dict(role='assistant', content='SDK persistence fixture answer'), finish_reason=None)]), dict(id='chatcmpl-fixture', object='chat.completion.chunk', choices=[dict(index=0, delta={}, finish_reason='stop')])]
                data = (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        async def run(directory):
            base = dict(model='fixture', base_url=f'http://127.0.0.1:{server.server_port}/v1', save_dir=directory + '/save', app_data_dir=directory + '/data', workspaces=[directory], capabilities=types.CapabilitiesConfig(enabled_tools=[]))
            async with Agent(LocalOpenAIAgentConfig(**base)) as agent:
                response = await asyncio.wait_for(agent.chat('FIRST_PERSISTENCE_MARKER'), 30)
                self.assertEqual(await response.text(), 'SDK persistence fixture answer')
                identifier = agent.conversation_id
            self.assertTrue((Path(directory) / 'save' / (identifier + '.db')).is_file())
            async with Agent(LocalOpenAIAgentConfig(**base, conversation_id=identifier, session_continuation_mode=types.SessionContinuationMode.RESUME)) as agent:
                response = await asyncio.wait_for(agent.chat('SECOND_RESUME_MARKER'), 30)
                self.assertEqual(await response.text(), 'SDK persistence fixture answer')
                self.assertEqual(agent.conversation_id, identifier)
            self.assertEqual([request['path'] for request in requests], ['/v1/chat/completions'] * 2)
            self.assertIn('FIRST_PERSISTENCE_MARKER', json.dumps(requests[-1]['body']))
        try:
            with tempfile.TemporaryDirectory(prefix='agentc2-sdk-evaluation-') as directory:
                asyncio.run(run(directory))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
