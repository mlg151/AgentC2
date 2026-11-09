"""Real pinned SDK/harness against a loopback model; no cloud calls or keys."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'electron'))
from chat_antigravity import AntigravityAdapter
from chat_adapters import ProviderRejected
from chat_journal import Journal
from chat_protocol import CONTRACT

try:
    AVAILABLE = importlib.metadata.version('google-antigravity') == '0.1.22'
except importlib.metadata.PackageNotFoundError:
    AVAILABLE = False


def poll(callback, predicate=bool):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        value = callback()
        if predicate(value):
            return value
        time.sleep(0.02)
    raise AssertionError('SDK fixture timed out')


@unittest.skipUnless(AVAILABLE, 'Run with the daemon-managed Antigravity SDK runtime')
class SdkAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agentc2-agy-sdk-')
        self.root = Path(self.temporary.name)
        self.journal = Journal(self.root / 'journal')
        self.adapters, self.requests = [], []
        self.command = 'printf SDK_WITNESS > ' + str(self.root / 'witness')
        case = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                case.requests.append(body)
                messages = body['messages']
                prompt = next((item.get('content') for item in reversed(messages) if item['role'] == 'user'), '')
                if 'PROTECTED_COMMAND' in str(prompt) and messages[-1]['role'] != 'tool':
                    delta = dict(role='assistant', tool_calls=[dict(index=0, id='call-fixture', type='function', function=dict(name='run_command', arguments=json.dumps(dict(CommandLine=case.command, Cwd=str(case.root), SafeToAutoRun=False, WaitMsBeforeAsync=1000))))])
                    finish = 'tool_calls'
                else:
                    delta, finish = dict(role='assistant', content='SDK fixture answer'), 'stop'
                chunks = [dict(id='chatcmpl-fixture', object='chat.completion.chunk', choices=[dict(index=0, delta=delta, finish_reason=None)]), dict(id='chatcmpl-fixture', object='chat.completion.chunk', choices=[dict(index=0, delta={}, finish_reason=finish)], usage=dict(prompt_tokens=10, completion_tokens=5, total_tokens=15))]
                data = (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        for adapter in self.adapters:
            adapter.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.journal.close()
        self.temporary.cleanup()

    def start(self, profile='full', native=None):
        payload = dict(provider='antigravity', cwd=str(self.root), title='SDK fixture', roeProfile=profile)
        if native:
            payload['providerSessionId'] = native
        capabilities = dict(provider='antigravity', version='SDK 0.1.22', status='supported', reason=None, **{name: name in ('streaming', 'history', 'resume', 'interrupt', 'approvals', 'questions') for name in CONTRACT['capabilities']})
        receipt, _ = self.journal.accept(dict(protocolVersion=1, commandId=str(uuid.uuid4()), operation='create', payload=payload), capabilities)
        identifier = receipt['sessionId']
        adapter = AntigravityAdapter(self.journal.history(identifier)['session'], self.journal, env={**os.environ, 'AGENTC2_ANTIGRAVITY_BASE_URL': f'http://127.0.0.1:{self.server.server_port}/v1', 'AGENTC2_ANTIGRAVITY_MODEL': 'fixture'})
        self.adapters.append(adapter)
        adapter.start()
        return adapter

    def page(self, adapter):
        page = self.journal.history(adapter.session['id'])
        page['pendingRequests'] = self.journal.pending_requests(adapter.session['id'])
        return page

    def send(self, adapter, text):
        command = str(uuid.uuid4())
        adapter.send(text, command)
        return command

    def finished(self, adapter, command):
        return poll(lambda: self.page(adapter), lambda page: any(event['type'] == 'turn.completed' and event['turnId'] == command for event in page['events']))

    def decide(self, adapter, request, decision):
        return adapter.respond(dict(requestId=request['requestId'], turnId=request['turnId'], itemId=request['itemId'], decision=decision))

    def test_stream_and_native_resume_preserve_context(self):
        first = self.start()
        command = self.send(first, 'FIRST_CONTEXT_MARKER')
        page = self.finished(first, command)
        native = page['session']['providerSessionId']
        self.assertTrue(native)
        self.assertEqual([event['data']['text'] for event in page['events'] if event['type'] == 'message.completed' and event['data']['role'] == 'assistant'], ['SDK fixture answer'])
        first.stop()
        second = self.start(native=native)
        self.assertTrue(any(event['turnId'] == 'sdk-history' and event['type'] == 'message.completed' for event in self.page(second)['events']))
        command = self.send(second, 'SECOND_CONTEXT_MARKER')
        page = self.finished(second, command)
        self.assertEqual(page['session']['providerSessionId'], native)
        self.assertIn('FIRST_CONTEXT_MARKER', json.dumps(self.requests[-1]))
        self.assertTrue(any(event['type'] == 'usage.updated' for event in page['events']))

    def test_model_change_resumes_same_native_conversation(self):
        adapter = self.start()
        self.finished(adapter, self.send(adapter, 'MODEL_CONTEXT_MARKER'))
        native = adapter.native_id
        before = len(self.journal.history(adapter.session['id'], limit=500)['events'])
        adapter.set_model('fixture-second')
        self.finished(adapter, self.send(adapter, 'Continue after model switch'))
        self.assertEqual(adapter.native_id, native)
        self.assertEqual(self.requests[-1]['model'], 'fixture-second')
        self.assertIn('MODEL_CONTEXT_MARKER', json.dumps(self.requests[-1]))
        events = self.journal.history(adapter.session['id'], limit=500)['events'][before:]
        self.assertFalse(any(event['turnId'] == 'sdk-history' for event in events))

    def test_real_sdk_gated_deny_allow_and_stale_decision(self):
        adapter = self.start('gated')
        denied = self.send(adapter, 'PROTECTED_COMMAND deny')
        request = poll(lambda: self.page(adapter)['pendingRequests'])[0]
        self.assertFalse((self.root / 'witness').exists())
        self.decide(adapter, request, 'deny')
        page = self.finished(adapter, denied)
        self.assertEqual(next(event for event in page['events'] if event['type'] == 'turn.completed' and event['turnId'] == denied)['data']['outcome'], 'denied')
        self.assertFalse((self.root / 'witness').exists())
        allowed = self.send(adapter, 'PROTECTED_COMMAND allow')
        current = poll(lambda: self.page(adapter)['pendingRequests'])[0]
        with self.assertRaises(ProviderRejected):
            self.decide(adapter, request, 'allow')
        self.assertFalse((self.root / 'witness').exists())
        self.decide(adapter, current, 'allow')
        self.finished(adapter, allowed)
        self.assertEqual((self.root / 'witness').read_text(), 'SDK_WITNESS')

    def test_sdk_question_maps_native_option_ids_and_answers(self):
        from google.antigravity import types
        adapter = self.start('gated')
        command = self.send(adapter, 'PROTECTED_COMMAND question boundary')
        approval = poll(lambda: self.page(adapter)['pendingRequests'])[0]
        spec = types.AskQuestionInteractionSpec(questions=[types.AskQuestionEntry(question='Which suite?', options=[types.AskQuestionOption(id='full-id', text='Full suite'), types.AskQuestionOption(id='small-id', text='Focused checks')])])
        future = asyncio.run_coroutine_threadsafe(adapter.question(spec), adapter.loop)
        pending = poll(lambda: [item for item in self.page(adapter)['pendingRequests'] if item['type'] == 'question.requested'])[0]
        adapter.respond(dict(requestId=pending['requestId'], turnId=pending['turnId'], itemId=pending['itemId'], answers=[dict(questionId='q0', answers=['Full suite'])]))
        result = future.result(timeout=5)
        self.assertEqual(result.responses[0].selected_option_ids, ['full-id'])
        with self.assertRaises(ProviderRejected):
            adapter.respond(dict(requestId=pending['requestId'], turnId=pending['turnId'], itemId=pending['itemId'], answers=[dict(questionId='q0', answers=['Focused checks'])]))
        self.decide(adapter, approval, 'deny')
        self.finished(adapter, command)

    def test_interrupt_pending_approval_and_reject_cli_history(self):
        adapter = self.start('gated')
        command = self.send(adapter, 'PROTECTED_COMMAND interrupt')
        request = poll(lambda: self.page(adapter)['pendingRequests'])[0]
        adapter.interrupt()
        page = self.finished(adapter, command)
        self.assertFalse((self.root / 'witness').exists())
        self.assertEqual(page['pendingRequests'], [])
        with self.assertRaises(ProviderRejected):
            self.decide(adapter, request, 'allow')
        with self.assertRaisesRegex(ProviderRejected, 'not a saved'):
            self.start(native='cli-history-01234567890123456789012345678901')


if __name__ == '__main__':
    unittest.main()
