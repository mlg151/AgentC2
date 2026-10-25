const assert = require('node:assert/strict');
const { loadRenderer: load } = require('./helpers/load-renderer.cjs');
const { emptyChatTimeline: empty, reduceChatTimeline: reduce } = load('chatTimeline.ts');
const { chatLink, chatCommandId, companionChatApi } = load('chatClient.ts');
function event(sequence, type, data, itemId = 'message-one') {
  return { protocolVersion: 1, sessionId: 'chat-' + 'a'.repeat(32), provider: 'codex', providerSessionId: 'native-one', turnId: 'turn-one', itemId, sequence, timestamp: '2026-10-22T00:00:00.000Z', type, data };
}
function page(events, extra = {}) { return { events, cursor: Math.max(0, ...events.map((item) => item.sequence)), retainedFrom: 1, pendingRequests: [], ...extra }; }
const delta = (sequence, text, id) => event(sequence, 'message.delta', { text }, id);
const final = (sequence, text, id) => event(sequence, 'message.completed', { role: 'assistant', text }, id);

let state = reduce(empty, page([delta(1, 'Hello '), delta(2, 'world')]));
assert.equal(state.items[0].text, 'Hello world');
state = reduce(state, page([final(3, 'Hello world!')]));
assert.equal(state.items.length, 1);
assert.equal(state.items[0].text, 'Hello world!');
assert.equal(reduce(state, page([delta(1, 'Hello '), delta(2, 'world'), final(3, 'Hello world!')])), state, 'Replayed pages must not duplicate content or rerender unchanged rows');

state = reduce(empty, page([delta(3, 'third')]));
state = reduce(state, page([delta(1, 'first '), delta(2, 'second ')]));
assert.equal(state.items[0].text, 'first second third');
assert.equal(state.firstSequence, 1);
assert.equal(state.lastSequence, 3);
state = reduce(state, page([final(4, 'The full final answer')]));
assert.equal(state.items[0].text, 'The full final answer');

state = reduce(empty, page([final(10, 'Latest', 'new-message')]));
state = reduce(state, page([delta(1, 'Old ', 'old-message'), delta(2, 'message', 'old-message'), final(3, 'Old message', 'old-message')]));
assert.deepEqual(state.items.map((item) => item.text), ['Old message', 'Latest']);
state = reduce(state, page([delta(0, 'ignored')], { retainedFrom: 1 }));
assert.equal(state.items.length, 2);

state = reduce(empty, page([event(20, 'tool.completed', { name: 'Bash', output: 'Denied', isError: true }, 'tool-one')]));
state = reduce(state, page([event(19, 'tool.started', { name: 'Bash', input: 'exact reviewed command' }, 'tool-one')]));
assert.equal(state.items.length, 1);
assert.equal(state.items[0].input, 'exact reviewed command');
assert.equal(state.items[0].output, 'Denied');
assert.equal(state.items[0].isError, true);

const pending = { requestId: 'approval-one', turnId: 'turn-one', itemId: 'tool-one', type: 'approval.requested', state: 'pending', data: { requestId: 'approval-one', action: 'Write', detail: 'Exact content' } };
const requested = event(30, 'approval.requested', pending.data, 'tool-one');
state = reduce(empty, page([requested]));
assert.equal(state.items[0].state, 'expired', 'Historical requests cannot become actionable without the authoritative pending snapshot');
state = reduce(state, page([], { cursor: 30, pendingRequests: [pending] }));
assert.equal(state.items[0].state, 'pending');
state = reduce(state, page([event(31, 'request.resolved', { requestId: 'approval-one', state: 'resolved', decision: 'deny' }, 'tool-one')]));
assert.equal(state.items[0].state, 'resolved');
assert.equal(state.items[0].decision, 'deny');

state = reduce(state, page([event(50, 'error', { code: 'fixture', message: 'Content removed', retryable: false })], { retainedFrom: 50 }));
assert.equal(state.items.length, 1);
assert.equal(state.items[0].kind, 'error');
assert.equal(state.firstSequence, 50);

const usage = (totalTokens) => ({ totalTokens, inputTokens: null, outputTokens: null, costUsd: null, contextUsedTokens: null, contextCapacityTokens: null });
state = reduce(empty, page([event(10, 'usage.updated', usage(300))]));
state = reduce(state, page([event(9, 'usage.updated', usage(150))]));
assert.equal(state.usage.totalTokens, 300, 'Earlier snapshots must not overwrite current cumulative usage');
state = reduce(state, page([event(11, 'usage.updated', usage(450))]));
assert.equal(state.usage.totalTokens, 450, 'Cumulative counters are snapshots, never sums');
assert.equal(chatLink('https://example.com/docs'), 'https://example.com/docs');
assert.equal(chatLink('HTTP://example.com'), 'http://example.com/');
for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'mailto:test@example.com', '/relative', '//example.com']) assert.equal(chatLink(value), undefined);
for (let index = 0; index < 20; index++) assert.match(chatCommandId(), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const calls = [];
const companionApi = companionChatApi({ request: (method, ...args) => { calls.push(JSON.parse(JSON.stringify({ method, args }))); return Promise.resolve({}); } });
void companionApi.ready('view'); void companionApi.ready('view', 0); void companionApi.ready('view', 27); void companionApi.history('view');
assert.deepEqual(calls, [
  { method: 'chat:ready', args: ['view'] },
  { method: 'chat:ready', args: ['view', 0] },
  { method: 'chat:ready', args: ['view', 27] },
  { method: 'chat:history', args: ['view', 0, 200] },
], 'Optional companion cursors must remain omitted, never serialized to null');
console.log('PASS chat stream/final reconciliation, replay identity, backward history order, tool errors, request expiry, pruning, cumulative usage, and URL safety');
