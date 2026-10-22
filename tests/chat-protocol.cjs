const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { contract, validateCommand, validateEvent, validateCapabilities, unavailableCapabilities } = require('../electron/chat-protocol.cjs');

const sessionId = `chat-${randomUUID().replaceAll('-', '')}`;
const command = (operation, payload = {}, session = sessionId) => ({ protocolVersion: 1, commandId: randomUUID(), operation, ...(operation === 'create' ? {} : { sessionId: session }), payload });
const event = (type, data) => ({ protocolVersion: 1, sessionId, sequence: 1, timestamp: '2026-10-22T12:00:00.000Z', provider: 'codex', providerSessionId: 'thread-one', turnId: 'turn-one', itemId: 'item-one', type, data });
const cases = [];
const add = (kind, value, valid) => cases.push({ kind, value, valid });
const create = command('create', { provider: 'codex', cwd: '/tmp/repo', title: 'Fixture', roeProfile: 'gated' });
for (const provider of contract.providers) add('command', { ...create, payload: { ...create.payload, provider } }, true);
for (const operation of ['send', 'steer', 'respond', 'interrupt', 'stop']) add('command', command(operation, operation === 'send' ? { text: 'Hello 👋' } : operation === 'steer' ? { text: 'Continue', expectedTurnId: 'turn-one' } : operation === 'respond' ? { requestId: 'request-one', turnId: 'turn-one', itemId: null, decision: 'deny' } : {}), true);
add('command', command('respond', { requestId: 'q', turnId: null, itemId: null, answers: [{ questionId: 'q1', answers: ['Answer'] }] }), true);
for (const change of [{ protocolVersion: 2 }, { protocolVersion: true }, { commandId: '../escape' }, { operation: 'shell' }, { extra: true }, { sessionId }]) add('command', { ...create, ...change }, false);
for (const change of [{ provider: 'shell' }, { cwd: 'relative' }, { cwd: '/tmp\0bad' }, { roeProfile: 'unchecked' }, { title: 'x'.repeat(101) }, { args: '--dangerously-skip-permissions' }]) add('command', { ...create, payload: { ...create.payload, ...change } }, false);
for (const text of ['', '   ', '\0', 'x'.repeat(contract.limits.text + 1), '\ud800']) add('command', command('send', { text }), false);
add('command', command('send', { text: 'ok', command: 'shell' }), false);
add('command', command('stop', { signal: 9 }), false);
add('command', command('send', { text: 'ok' }, '../escape'), false);
add('command', command('respond', { requestId: 'q', turnId: null, itemId: null, decision: 'allow', answers: [] }), false);
add('command', command('respond', { requestId: 'q', turnId: null, itemId: null, answers: [] }), false);

const data = {
  'session.updated': { state: 'running', detail: 'Working' },
  'message.delta': { text: 'Hello' },
  'message.completed': { role: 'assistant', text: 'Hello' },
  'tool.started': { name: 'Bash', input: 'pwd' },
  'tool.completed': { name: 'Bash', output: '/tmp', isError: false },
  'approval.requested': { requestId: 'r1', action: 'Write', detail: 'Reviewed content' },
  'question.requested': { requestId: 'q1', questions: [{ id: 'question', question: 'Which?', options: ['One', 'Two'], multiple: false }] },
  'request.resolved': { requestId: 'r1', state: 'resolved', decision: 'deny' },
  'usage.updated': { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: null, contextUsedTokens: null, contextCapacityTokens: null },
  'turn.completed': { outcome: 'denied', detail: 'Tool was denied' },
  error: { code: 'worker_lost', message: 'Submission outcome is unknown', retryable: false },
  'provider.event': { method: 'provider/specific', payload: { useful: ['retained'] } },
};
assert.deepEqual(Object.keys(data), contract.eventTypes);
for (const [kind, value] of Object.entries(data)) {
  add('event', event(kind, value), true);
  add('event', event(kind, { ...value, arbitrary: true }), false);
}
for (const change of [{ sequence: 0 }, { sequence: true }, { timestamp: '2026-02-31T12:00:00.000Z' }, { timestamp: '2026-10-22T12:00:00.000+01:00' }, { timestamp: 'today' }, { provider: 'unknown' }, { type: 'unknown' }, { turnId: '' }]) add('event', { ...event('message.delta', { text: 'x' }), ...change }, false);
add('event', event('usage.updated', { ...data['usage.updated'], totalTokens: -1 }), false);
add('event', event('usage.updated', { ...data['usage.updated'], totalTokens: true }), false);
add('event', event('tool.completed', { ...data['tool.completed'], isError: 'false' }), false);
add('event', event('question.requested', { requestId: 'q', questions: [] }), false);
const unsupported = unavailableCapabilities('antigravity', '1.4.4', 'Adapter verification pending');
add('capabilities', unsupported, true);
add('capabilities', { ...unsupported, attachments: true }, false);
add('capabilities', { ...unsupported, status: 'supported', streaming: true }, true);
add('capabilities', { ...unsupported, history: 'yes' }, false);
const validators = { command: validateCommand, event: validateEvent, capabilities: validateCapabilities };
for (const [index, item] of cases.entries()) {
  if (item.valid) assert.doesNotThrow(() => validators[item.kind](item.value), `Case ${index}`);
  else assert.throws(() => validators[item.kind](item.value), `Case ${index}`);
}
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = path.join(__dirname, 'chat-journal.py');
const parity = spawnSync(python, [script, '--protocol'], { input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
assert.equal(parity.status, 0, parity.stderr || parity.error?.message);
assert.deepEqual(JSON.parse(parity.stdout), cases.map((item) => item.valid), 'Remote Python and desktop JavaScript must enforce the same contract');
// The production journal is remote-Linux code; Windows runs wire parity only.
if (process.platform !== 'win32') {
  for (const test of [script, path.join(__dirname, 'chat-worker.py'), path.join(__dirname, 'chat-codex.py'), path.join(__dirname, 'chat-antigravity.py'), path.join(__dirname, 'chat-claude-native.py')]) {
    const result = spawnSync(python, [test], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    assert.equal(result.status, 0, result.error?.message);
  }
}
console.log(`PASS ${cases.length} shared chat contract cases, cross-language parity, and durable journal recovery`);
