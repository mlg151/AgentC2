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
for (const model of ['fixture-model', 'provider/model-v2']) add('command', command('model', { model }), true);
for (const model of ['', null, 42, 'x'.repeat(201), 'model\nname', 'model\tname']) add('command', command('model', { model }), false);
const create = command('create', { provider: 'codex', cwd: '/tmp/repo', title: 'Fixture', roeProfile: 'gated' });
add('command', { ...create, payload: { ...create.payload, model: 'fixture-model' } }, true);
for (const model of ['', 42, 'x'.repeat(201)]) add('command', { ...create, payload: { ...create.payload, model } }, false);
for (const provider of contract.providers) add('command', { ...create, payload: { ...create.payload, provider } }, true);
add('command', { ...create, payload: { ...create.payload, managedName: 'hq-' + 'a'.repeat(12), instructions: '', providerSessionId: 'native-session' } }, true);
for (const change of [
  ...[null, 42, '', 'hq-invalid'].map((managedName) => ({ managedName })),
  { instructions: 'Reviewed repository guidance' }, { providerSessionId: 'native-session' },
]) add('command', { ...create, payload: { ...create.payload, ...change } }, !Object.hasOwn(change, 'managedName'));
for (const instructions of [42, '😀'.repeat(10001)]) add('command', { ...create, payload: { ...create.payload, instructions } }, false);
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
for (const answers of ['invalid', Array(21).fill('answer')]) add('command', command('respond', { requestId: 'q', turnId: null, itemId: null, answers: [{ questionId: 'q1', answers }] }), false);
add('command', command('respond', { requestId: 'q', turnId: null, itemId: null, answers: [{ questionId: 'q1', answers: ['', 'Freeform answer'] }] }), true);

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
for (const change of [{ protocolVersion: 2 }, { sequence: 0 }, { sequence: true }, { timestamp: '2026-02-31T12:00:00.000Z' }, { timestamp: '2026-10-22T12:00:00.000+01:00' }, { timestamp: 'today' }, { provider: 'unknown' }, { type: 'unknown' }, { turnId: '' }]) add('event', { ...event('message.delta', { text: 'x' }), ...change }, false);
add('event', event('usage.updated', { ...data['usage.updated'], totalTokens: -1 }), false);
add('event', event('usage.updated', { ...data['usage.updated'], totalTokens: true }), false);
add('event', event('tool.completed', { ...data['tool.completed'], isError: 'false' }), false);
add('event', event('question.requested', { requestId: 'q', questions: [] }), false);
for (const change of [{ options: 'invalid' }, { options: Array(101).fill('choice') }, { multiple: 'yes' }]) add('event', event('question.requested', { requestId: 'q', questions: [{ id: 'q1', question: 'Which?', options: [], multiple: false, ...change }] }), false);
add('event', event('error', { ...data.error, retryable: 'no' }), false);
for (const payload of [null, [], 42]) add('event', event('provider.event', { method: 'fixture', payload }), false);
const extension = event('provider.event', { method: 'fixture', payload: { text: '' } });
const remaining = contract.limits.wireBytes - Buffer.byteLength(JSON.stringify(extension));
for (const extra of [0, 1]) add('event', { ...extension, data: { ...extension.data, payload: { text: 'x'.repeat(remaining + extra) } } }, extra === 0);
// These values cannot reach a JSON/Python receiver at all, so validate them on
// the producer side instead of serializing them into different parity inputs.
for (const value of [undefined, () => {}, Symbol('fixture'), 1n, NaN, Infinity]) assert.throws(() => validateEvent(event('provider.event', { method: 'fixture', payload: { value } })), /Invalid JSON chat value/);
const unverified = unavailableCapabilities('codex');
assert.equal(unverified.version, null); assert.equal(unverified.reason, 'Provider integration has not been verified');
assert.ok(contract.capabilities.every((name) => unverified[name] === false));
add('event', event('request.resolved', { requestId: 'without-decision', state: 'expired', decision: null }), true);
const unsupported = unavailableCapabilities('antigravity', '1.4.4', 'Adapter verification pending');
add('capabilities', unsupported, true);
add('capabilities', { ...unsupported, reason: null }, true);
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
  for (const test of [script, path.join(__dirname, 'chat-worker.py'), path.join(__dirname, 'chat-codex.py'), path.join(__dirname, 'chat-opencode.py'), path.join(__dirname, 'chat-antigravity.py'), path.join(__dirname, 'chat-claude-native.py')]) {
    const started = Date.now();
    const result = spawnSync(python, [test, '-v'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    console.log(`Nested suite ${path.basename(test)}: ${result.status === 0 ? 'success' : 'failure'}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    assert.equal(result.status, 0, result.error?.message);
  }
}
console.log(`PASS ${cases.length} shared chat contract cases, cross-language parity, and durable journal recovery`);
