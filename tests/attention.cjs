const assert = require('node:assert/strict');
const { Attention, classify } = require('../electron/attention.cjs');

function fixture(data = {}) {
  const saved = [];
  const store = { data: { attention: [], attentionCursors: {}, flashResolved: [], ...data }, save(field, value) { this.data[field] = value; saved.push(field); return value; } };
  return { store, saved, attention: new Attention(store) };
}
const key = 'default/tmux:hq-111111111111';
const session = { key, hostId: 'default', provider: 'codex', title: 'Fixture', state: 'live', outputTail: '' };
assert.equal(classify({ ...session, transport: 'chat', exitCode: 1 }), null, 'Structured lifecycle evidence supersedes terminal heuristics');
assert.equal(classify({ ...session, outputTail: '\x1b[31m\n\nPermission required\x1b[0m\n' }).kind, 'input');
assert.equal(classify({ ...session, outputTail: ['Permission required', ...Array(9).fill('Later output')].join('\n') }), null, 'An old prompt outside the retained tail is not a current decision');

const legacy = fixture({ attentionCursors: { [key]: 'known' }, attention: [
  { sessionKey: key, signature: 'hook:malformed-time', createdAt: 'bad' },
  { sessionKey: 'other', createdAt: '2026-10-21T17:59:00Z' },
] });
const failed = legacy.attention.update([{ ...session, events: [
  { id: 'known', kind: 'completed', at: '2026-10-21T17:59:00Z' },
  { id: 'new', kind: 'failed', at: '2026-10-21T18:00:00Z' },
] }]);
assert.equal(failed.length, 1);
assert.equal(failed[0].kind, 'failed');
assert.equal(failed[0].detail, 'The provider reported a failed turn.');
assert.equal(legacy.store.data.attentionCursors[key].id, 'new');
assert.deepEqual(legacy.attention.update([{ ...session, events: [{ id: 'new', kind: 'failed', at: '2026-10-21T18:00:00Z' }] }]), []);

const missingTime = fixture({ attentionCursors: { [key]: { id: 'lost' } } });
const before = Date.now();
const generated = missingTime.attention.update([{ ...session, events: [{ id: 'new', kind: 'failed' }] }]);
assert.equal(generated.length, 1);
assert.ok(Date.parse(missingTime.store.data.attentionCursors[key].at) >= before);
assert.ok(Date.parse(generated[0].createdAt) >= before);

const requests = fixture({ flashResolved: undefined, attention: [
  { id: 'first', requestId: 'request', acknowledged: false },
  { id: 'neighbor', requestId: 'other', acknowledged: false },
] });
requests.attention.resolveRequests([]); assert.deepEqual(requests.saved, []);
requests.attention.resolveRequests(['request']);
assert.deepEqual(requests.store.data.flashResolved, ['request']);
assert.equal(requests.store.data.attention[0].acknowledged, true);
assert.equal(requests.store.data.attention[1].acknowledged, false);
assert.deepEqual(requests.saved, ['flashResolved', 'attention']);
requests.saved.length = 0;
requests.attention.resolveRequests(['request']); assert.deepEqual(requests.saved, [], 'A repeated resolution must not create another persisted mutation');
console.log('PASS legacy cursor migration, malformed/missing event timestamps, confirmed failure alerts, recent-only terminal prompts, structured lifecycle isolation, and idempotent request resolution');
