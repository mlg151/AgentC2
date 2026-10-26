const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/load-renderer.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

function scenarios({ emptyChatTimeline: empty, reduceChatTimeline: reduce }) {
  const event = (sequence, type, data, itemId = 'one', turnId = 'turn-one') => ({ protocolVersion: 1, sessionId: 'chat-' + 'a'.repeat(32), provider: 'codex', providerSessionId: 'native', turnId, itemId, sequence, timestamp: '2026-10-22T00:00:00.000Z', type, data });
  const page = (events, extra = {}) => ({ events, cursor: Math.max(0, ...events.map((entry) => entry.sequence)), retainedFrom: 1, pendingRequests: [], ...extra });
  const delta = (sequence, text, id) => event(sequence, 'message.delta', { text }, id);
  const complete = (sequence, text, id) => event(sequence, 'message.completed', { role: 'assistant', text }, id);
  const started = (sequence, input = '') => event(sequence, 'tool.started', { name: 'Bash', input });
  const ended = (sequence) => event(sequence, 'tool.completed', { name: 'Bash', output: 'Verified result', isError: false });

  assert.equal(reduce(empty, page([])), empty, 'An unchanged empty snapshot retains identity');
  assert.equal(reduce(empty, page([delta(0, 'Pruned event')])), empty);
  const replay = reduce(empty, page([complete(10, 'Exact replay')]));
  assert.equal(reduce(replay, page([complete(10, 'Exact replay')])), replay);
  let state = reduce(empty, page([complete(10, 'Final')]));
  let next = reduce(state, page([delta(11, 'Late delta')], { cursor: 11 }));
  assert.equal(next.items[0].text, 'Final', 'A delayed delta cannot append to a completed message');
  assert.equal(next.items[0], state.items[0]);
  next = reduce(state, page([complete(1, 'Older completed text')]));
  assert.equal(next.items[0], state.items[0], 'Older completion cannot replace a newer completed message');
  state = reduce(empty, page([delta(10, 'tail')]));
  assert.equal(reduce(state, page([complete(1, 'Full historical message')])).items[0].text, 'Full historical message');
  next = reduce(state, page([delta(1, 'first '), delta(2, 'second ')]));
  assert.equal(next.items[0].text, 'first second tail');
  next = reduce(state, page([delta(1, 'prefix '), complete(2, 'Exact completed text')]));
  assert.equal(next.items[0].text, 'Exact completed text', 'Buffered prefixes must not duplicate a completed message');
  next = reduce(state, page([delta(1, 'other ', 'other'), delta(2, 'message', 'other')]));
  assert.deepEqual(next.items.map((item) => item.text), ['other message', 'tail']);

  state = reduce(empty, page([started(10, 'New reviewed command')]));
  assert.deepEqual([state.items[0].input, state.items[0].output, state.items[0].complete, state.items[0].isError], ['New reviewed command', '', false, false]);
  next = reduce(state, page([started(1, 'Old command')]));
  assert.equal(next.items[0].input, 'New reviewed command', 'Earlier tool starts cannot replace a known newer input');
  next = reduce(reduce(empty, page([started(10)])), page([started(1, 'Backfilled exact input')]));
  assert.equal(next.items[0].input, 'Backfilled exact input');
  next = reduce(state, page([started(11, 'Updated input'), ended(12)]));
  assert.deepEqual([next.items[0].input, next.items[0].output, next.items[0].complete, next.items[0].isError], ['Updated input', 'Verified result', true, false]);
  state = reduce(empty, page([ended(10)]));
  assert.equal(state.items[0].input, '');
  next = reduce(state, page([started(1, 'Backfilled input')]));
  assert.deepEqual([next.items[0].input, next.items[0].output, next.items[0].complete], ['Backfilled input', 'Verified result', true]);

  const requested = (sequence, type = 'approval.requested') => event(sequence, type, { requestId: 'request', action: 'Exact action', questions: [] });
  const pending = (state) => [{ requestId: 'request', turnId: 'turn-one', itemId: 'one', type: 'approval.requested', state, data: { requestId: 'request', action: 'Exact action' } }];
  state = reduce(empty, page([requested(10)], { pendingRequests: pending('submitted') }));
  assert.equal(state.items[0].state, 'submitted');
  next = reduce(state, page([], { cursor: 10 }));
  assert.equal(next.items[0].state, 'expired', 'An absent authoritative request expires a submitted decision');
  next = reduce(state, page([requested(1)], { pendingRequests: pending('submitted') }));
  assert.equal(next.items[0].state, 'submitted', 'Older request replay retains the authoritative state');
  assert.equal(next.items[0].title, 'Exact action');
  state = reduce(empty, page([requested(1, 'question.requested')]));
  assert.equal(state.items[0].title, 'User question');
  const resolved = (sequence) => event(sequence, 'request.resolved', { requestId: 'request', state: 'resolved', decision: 'deny' });
  state = reduce(empty, page([resolved(10)]));
  assert.equal(state.items[0].title, 'Interactive request');
  assert.equal(state.items[0].decision, 'deny');
  next = reduce(state, page([requested(1)]));
  assert.equal(next.items[0].state, 'resolved');
  assert.equal(next.items[0].decision, 'deny', 'Older request replay must not lose the recorded decision');
  next = reduce(reduce(empty, page([requested(1)])), page([resolved(2)]));
  assert.equal(next.items[0].title, 'Exact action');

  state = reduce(empty, page([delta(1, 'No item ID', null), event(2, 'tool.started', { name: 'Bash', input: 'Exact' }, null), event(3, 'turn.completed', { outcome: 'completed', detail: 'Verified turn completion' }, null, null)]));
  assert.deepEqual(state.items.map((item) => item.id), ['message:1', 'tool:2', 'outcome:3']);
  assert.equal(state.items[2].detail, 'Verified turn completion');
  next = reduce(empty, page([event(1, 'turn.completed', { outcome: 'failed', detail: 'Provider fault' })]));
  assert.equal(next.items[0].id, 'outcome:turn-one');
  assert.equal(next.items[0].outcome, 'failed');

  next = reduce(reduce(empty, page([complete(10, 'Latest')])), page([complete(1, 'Older other item', 'other')]));
  assert.deepEqual(next.items.map((item) => item.text), ['Older other item', 'Latest']);
  next = reduce(reduce(empty, page([complete(10, 'Latest')])), page([started(1, 'Older tool with no current row')]));
  assert.equal(next.items[0].input, 'Older tool with no current row');
  next = reduce(reduce(empty, page([requested(1)], { pendingRequests: pending('pending') })), page([], { cursor: 1 }));
  assert.equal(next.items[0].state, 'expired');
  next = reduce(reduce(empty, page([resolved(10)])), page([requested(1, 'question.requested')]));
  assert.equal(next.items[0].title, 'User question');
  assert.equal(next.items[0].decision, 'deny');
  const usage = { totalTokens: 10, inputTokens: 4, outputTokens: 6, costUsd: null, contextUsedTokens: null, contextCapacityTokens: null };
  next = reduce(empty, page([event(10, 'usage.updated', usage)]));
  next = reduce(next, page([event(1, 'usage.updated', { ...usage, totalTokens: 1 })]));
  assert.equal(next.usage.totalTokens, 10);
  next = reduce(next, page([event(11, 'error', { code: 'fixture', message: 'Explicit failure' })], { retainedFrom: 11 }));
  assert.equal(next.items[0].message, 'Explicit failure');
  assert.equal(next.retainedFrom, 11);
  next = reduce(state, page([], { cursor: 20, retainedFrom: 2 }));
  assert.deepEqual(next.items.map((item) => item.id), ['tool:2', 'outcome:3']);

  assert.equal(reduce(state, page([], { cursor: state.lastSequence })), state);
}

(async () => {
  scenarios(loadRenderer('chatTimeline.ts'));
  // Exercise the actual Vite target in addition to native Node TypeScript.
  // Optional-chain lowering must preserve replay and request-state semantics.
  const config = await require('vite').resolveConfig({}, 'build');
  const filename = path.resolve(__dirname, '../src/chatTimeline.ts');
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-timeline-layout-')));
  try {
    const compiled = require('esbuild').transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'esm', target: config.build.target, sourcefile: filename, sourcemap: 'inline', sourcesContent: true }).code;
    const moduleFile = path.join(directory, 'timeline.mjs'); fs.writeFileSync(moduleFile, compiled);
    scenarios(await import(pathToFileURL(moduleFile).href));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('PASS native and Vite-target timelines: delayed completion/deltas, history prefixes, exact tool inputs, submitted/expired/resolved requests, stable decisions, and missing-ID fallbacks');
})().catch((error) => { console.error(error); process.exitCode = 1; });
