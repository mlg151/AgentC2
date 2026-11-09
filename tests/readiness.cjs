const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/load-renderer.cjs');
const implementations = [loadRenderer('readiness.ts'), require('../electron/readiness.cjs')];
for (const { fleetReadiness, elapsedClock } of implementations) {
  const now = Date.parse('2026-10-21T18:00:00Z');
  const key = 'default/tmux:hq-aaaaaaaaaaaa';
  const unit = { key, hostId: 'default', provider: 'claude', kind: 'managed', title: 'Active QA', state: 'live', events: [{ id: '1', kind: 'working', at: '2026-10-21T17:59:30Z' }], telemetry: { status: 'reported', sampledAt: '2026-10-21T17:59:30Z', costUsd: 1.2, totalTokens: 500 } };
  const base = { hosts: [{ id: 'default', name: 'Primary', connected: true }], sessions: [unit], attention: [], faults: [], conflicts: [] };
  const evaluate = (patch = {}, requests = []) => fleetReadiness({ ...base, ...patch }, requests, now);
  assert.equal(fleetReadiness(null, [], now).level, null);
  assert.equal(evaluate({ hosts: [{ id: 'default', name: 'Primary', connected: false }], faults: [{ sessionKey: key, at: '2026-10-21T17:59:59Z', detail: 'four failures', status: 'review' }] }).level, 1);
  assert.equal(evaluate({ faults: [{ sessionKey: key, at: '2026-10-21T17:59:59Z', detail: 'four failures', status: 'review' }] }).level, 2);
  assert.equal(evaluate({ conflicts: [{ id: 'order', hostId: 'default', detail: 'managed file changed', at: '2026-10-21T17:59:59Z' }] }).level, 2);
  assert.equal(evaluate({ hosts: [{ id: 'default', name: 'Primary', connected: false }], sessions: [{ ...unit, state: 'exited' }], conflicts: [{ id: 'order', hostId: 'default', detail: 'old conflict', at: '2026-10-21T17:59:59Z' }] }).level, null);
  const request = { id: 'request', hostName: 'Primary', name: 'hq-aaaaaaaaaaaa', tool: 'Bash', createdAt: now / 1000, state: 'pending', connected: true };
  assert.equal(evaluate({}, [request]).level, 3);
  assert.equal(evaluate({ sessions: [{ ...unit, events: [{ id: '2', kind: 'completed', at: '2026-10-21T17:59:30Z' }] }] }, [{ ...request, connected: false }]).level, null);
  for (const [chatState, level] of [['starting', null], ['unknown', null], ['idle', 5], ['running', 4], ['waiting', 3], ['stopped', 5], ['failed', 2]]) {
    assert.equal(evaluate({ sessions: [{ ...unit, transport: 'chat', chatState, state: 'live', events: [] }] }).level, level, `Fleet readiness must consume structured ${chatState}`);
  }
  assert.equal(evaluate().level, 4);
  assert.equal(evaluate({ sessions: [{ ...unit, events: [{ id: '2', kind: 'completed', at: '2026-10-21T17:59:30Z' }] }] }).level, 5);
  assert.equal(evaluate({ sessions: [{ ...unit, events: [] }] }).level, null, 'A live process is not confirmed execution');
  assert.equal(evaluate({ hosts: [...base.hosts, { id: 'secondary', name: 'Secondary', connected: false }], sessions: [{ ...unit, events: [{ id: '2', kind: 'completed', at: '2026-10-21T17:59:30Z' }] }] }).level, null, 'Unknown host blocks all-clear');
  const partial = evaluate({ sessions: [unit, { ...unit, key: 'default/tmux:hq-bbbbbbbbbbbb', providerSessionId: 'other', telemetry: { status: 'unsupported' } }] });
  assert.equal(partial.costUsd, 1.2);
  assert.equal(partial.totalTokens, 500);
  assert.equal(partial.costPartial, true);
  assert.equal(evaluate({ sessions: [unit, { ...unit, key: 'default/tmux:hq-bbbbbbbbbbbb', providerSessionId: 'same' }, { ...unit, key: 'default/tmux:hq-cccccccccccc', providerSessionId: 'same' }] }).costUsd, 2.4, 'Repeated provider session is counted once');
  assert.equal(elapsedClock(now - 3661000, now), '01:01:01');
  assert.equal(elapsedClock('bad', now), '—');
  for (const start of [null, undefined, 0, NaN, Infinity, now + 1]) assert.equal(elapsedClock(start, now), '—');
  assert.equal(elapsedClock('2026-10-21T17:59:00Z', now), '00:01:00');
  assert.equal(elapsedClock(undefined), '—');
  assert.equal(fleetReadiness(null, []).level, null);
  assert.equal(evaluate({ sessions: [] }).level, null);
  assert.equal(evaluate({ faults: undefined, conflicts: undefined }).level, 4);
  assert.equal(evaluate({ sessions: [{ ...unit, kind: 'unmanaged' }, { ...unit, provider: 'terminal' }] }).observed, 0);
  for (const attribute of ['stale', 'missing']) assert.equal(evaluate({ sessions: [{ ...unit, [attribute]: true }] }).uncertain, true);
  assert.equal(evaluate({ sessions: [{ ...unit, state: 'exited' }] }).level, 5);
  assert.equal(evaluate({ sessions: [{ ...unit, events: undefined }] }).uncertain, true);
  for (const [at, expected] of [[now - 120000, 4], [now - 120001, null], [now + 60000, 4], [now + 60001, null]]) {
    assert.equal(evaluate({ sessions: [{ ...unit, events: [{ kind: 'tool_ok', at: new Date(at).toISOString() }] }] }).level, expected);
  }
  for (const at of ['', 'invalid', undefined]) assert.equal(evaluate({ sessions: [{ ...unit, events: [{ kind: 'tool_failed', at }] }] }).uncertain, true);
  for (const kind of ['failed', 'completed']) assert.equal(evaluate({ sessions: [{ ...unit, events: [{ kind, at: 'invalid' }] }] }).level, 5, 'An authoritative idle event is not guessed from process age');
  for (const chatState of ['waiting', 'running']) assert.equal(evaluate({ sessions: [{ ...unit, transport: 'chat', chatState, updatedAt: '2026-10-21T17:59:30Z' }] }).reasons[0].at, '2026-10-21T17:59:30Z');
  const inputAlert = { id: 'input', sessionKey: key, title: 'Decision', detail: 'Review question', createdAt: '2026-10-21T17:59:30Z', acknowledged: false, kind: 'input', confidence: 'confirmed' };
  assert.equal(evaluate({ attention: [inputAlert] }).level, 3);
  for (const sessions of [[], [{ ...unit, stale: true }], [{ ...unit, state: 'exited' }]]) assert.equal(evaluate({ attention: [inputAlert], sessions }).uncertain, true);
  for (const change of [{ acknowledged: true }, { confidence: 'inferred' }, { requestId: 'r' }]) assert.equal(evaluate({ attention: [{ ...inputAlert, ...change }] }).level, 4);
  for (const signature of [undefined, 'manual:failure']) assert.equal(evaluate({ attention: [{ ...inputAlert, kind: 'failed', signature }] }).uncertain, true);
  assert.equal(evaluate({ attention: [{ ...inputAlert, kind: 'failed', signature: 'loop:fault' }] }).uncertain, false);
  assert.equal(evaluate({}, [{ ...request, state: 'resolved' }]).level, 4);
  assert.equal(evaluate({ conflicts: [{ id: 'order', hostId: 'absent', detail: 'Unknown host' }] }).uncertain, true);
  for (const invalid of [undefined, null, '2', NaN, Infinity, -1]) {
    const result = evaluate({ sessions: [{ ...unit, telemetry: { ...unit.telemetry, costUsd: invalid, totalTokens: invalid } }] });
    assert.equal(result.costUsd, null); assert.equal(result.totalTokens, null);
    assert.equal(result.costPartial, true); assert.equal(result.tokensPartial, true);
  }
  const zero = evaluate({ sessions: [{ ...unit, telemetry: { ...unit.telemetry, costUsd: 0, totalTokens: 0 } }] });
  assert.equal(zero.costUsd, 0); assert.equal(zero.totalTokens, 0); assert.equal(zero.costPartial, false);
  for (const telemetry of [undefined, { status: 'stale' }, { ...unit.telemetry, sampledAt: null }, { ...unit.telemetry, sampledAt: '2026-10-21T17:00:00Z' }]) assert.equal(evaluate({ sessions: [{ ...unit, telemetry }] }).sampledAt, null);
  const newest = evaluate({ sessions: [unit, { ...unit, key: 'second', telemetry: { ...unit.telemetry, sampledAt: '2026-10-21T17:59:00Z' } }, { ...unit, key: 'third', telemetry: { ...unit.telemetry, sampledAt: '2026-10-21T17:59:50Z' } }] });
  assert.equal(newest.sampledAt, '2026-10-21T17:59:50Z');
  const bounded = evaluate({ sessions: Array.from({ length: 1001 }, (_, i) => ({ ...unit, key: `unit-${i}` })) });
  assert.equal(bounded.observed, 1001); assert.equal(bounded.reasons.length, 20);
  assert.equal(bounded.totalTokens, 500000); assert.equal(bounded.costPartial, true); assert.equal(bounded.tokensPartial, true);
}
const { fleetReadiness: backend } = implementations[1];
assert.equal(backend({}).level, null);
assert.equal(backend({ conflicts: [{ id: 'missing', hostId: 'missing' }] }).uncertain, true);
for (const createdAt of [NaN, 1792605600000, 1792605600]) {
  const result = backend({ sessions: [], hosts: [], attention: [] }, [{ state: 'pending', connected: true, createdAt, hostId: 'host', name: 'unit' }]);
  assert.equal(result.level, 3); assert.equal(result.reasons[0].source, 'host/unit');
  assert.match(result.reasons[0].detail, /^Tool permission/);
}
assert.equal(backend({}, [{ state: 'pending', connected: false, hostId: 'host', name: 'unit' }]).uncertain, true);
assert.equal(backend({ attention: [{ kind: 'input', confidence: 'confirmed', acknowledged: false, sessionKey: 'gone' }] }).uncertain, true);
console.log('PASS renderer and main-process readiness precedence, uncertainty, partial/deduplicated spend, and elapsed clocks');
