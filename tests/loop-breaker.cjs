const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, defaults, validateSettings } = require('../electron/config.cjs');
const { LoopBreaker } = require('../electron/loop-breaker.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-breaker-'));
try {
  const store = new Store(directory);
  const settings = defaults();
  settings.presets[1].loopBreaker = { enabled: true, autoInterrupt: false, threshold: 4, windowMinutes: 10, cooldownMinutes: 15 };
  store.save('settings', validateSettings(settings));
  assert.throws(() => validateSettings({ ...settings, presets: settings.presets.map((item) => item.id === 'claude' ? { ...item, loopBreaker: { ...item.loopBreaker, threshold: 1 } } : item) }), /failure policy/);
  const key = 'default/tmux:hq-aaaaaaaaaaaa';
  const base = Date.now() - 30000;
  const event = (index, kind, signature) => ({ id: index.toString(16).padStart(32, '0'), at: new Date(base + index * 1000).toISOString(), kind, source: 'claude', failureSignature: signature, failureLabel: 'Bash Exit code 1' });
  const session = (events, extra = {}) => ({ key, kind: 'managed', provider: 'claude', presetId: 'claude', state: 'live', events, ...extra });
  const breaker = new LoopBreaker(store);
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  assert.deepEqual(breaker.observe([session([], { outputTail: 'FAILED FAILED FAILED', telemetry: null })]), [], 'Terminal repetition and missing telemetry are not evidence');
  const alternate = 'default/tmux:hq-bbbbbbbbbbbb';
  assert.deepEqual(breaker.observe([session([event(1, 'tool_failed', a), event(2, 'tool_failed', a), event(3, 'tool_failed'), event(4, 'tool_failed', a), event(5, 'tool_failed', a)], { key: alternate })]), [], 'Unknown intervening failure resets a confirmed streak');
  assert.equal(store.data.loopState[alternate].count, 2);
  assert.deepEqual(breaker.observe([session([event(1, 'tool_failed', a), event(2, 'tool_failed', a), event(3, 'tool_ok'), event(4, 'tool_failed', a), event(5, 'tool_failed', b)])]), []);
  assert.deepEqual(breaker.observe([session([event(1, 'tool_failed', a), event(2, 'tool_failed', a), event(3, 'tool_ok'), event(4, 'tool_failed', a), event(5, 'tool_failed', b), event(6, 'tool_failed', b), event(7, 'tool_failed', b)])]), []);
  const events = [1, 2, 3, 4, 5, 6, 7].map((index) => index === 3 ? event(index, 'tool_ok') : event(index, 'tool_failed', index < 5 ? a : b));
  events.push(event(8, 'tool_failed', b));
  const fault = breaker.observe([session(events)])[0];
  assert.equal(fault.count, 4);
  assert.equal(fault.status, 'review');
  assert.equal(breaker.observe([session(events)]).length, 0);
  assert.equal(new LoopBreaker(new Store(directory)).observe([session(events)]).length, 0, 'Restart must not replay');
  assert.equal(breaker.observe([session([...events, event(9, 'tool_failed', b)], { kind: 'external-tmux' })]).length, 0);
  assert.equal(breaker.observe([session([...events, event(9, 'tool_failed', b)], { stale: true })]).length, 0);
  assert.equal(breaker.faults().length, 1);
  breaker.record(key, 'interrupted', 'tmux accepted');
  assert.equal(new LoopBreaker(new Store(directory)).faults()[0].status, 'interrupted');
  breaker.reset(key);
  assert.equal(breaker.faults().length, 0);
  assert.equal(breaker.observe([session([...events, event(9, 'tool_failed', b)])]).length, 0, 'Cooldown prevents immediate repeat fault');
  breaker.observe([session([...events, event(9, 'tool_failed', b)], { worktreeOperation: 'a'.repeat(32), headCommit: '1'.repeat(40) })]);
  assert.equal(breaker.observe([session([...events, event(9, 'tool_failed', b), event(10, 'tool_failed', b)], { worktreeOperation: 'a'.repeat(32), headCommit: '2'.repeat(40) })]).length, 0, 'Revision progress resets a streak');
  assert.equal(store.data.loopState[key].count, 0);
  for (const id of ['missing-session', key]) {
    assert.throws(() => breaker.record(id, 'interrupted', 'No verified fault'), /No current confirmed fault/);
    assert.throws(() => breaker.reset(id), /No current confirmed fault/);
  }
  const unknownKey = 'default/tmux:hq-cccccccccccc';
  for (const events of [undefined, null, {}]) assert.deepEqual(breaker.observe([session(events, { key: unknownKey })]), []);
  const cursorBefore = store.data.loopState[alternate].cursor;
  assert.deepEqual(breaker.observe([session([], { key: alternate })]), []);
  assert.equal(store.data.loopState[alternate].cursor, cursorBefore);
  assert.equal(store.data.loopState[alternate].count, 0, 'A missing ring cursor cannot prove a consecutive streak');
  const invalidEvents = [null,
    { ...event(10, 'failed', a), source: 'codex' }, { ...event(11, 'failed', a), id: 42 }, { ...event(12, 'failed', a), id: 'invalid' },
    { ...event(13, 'failed', a), at: undefined }, { ...event(14, 'failed', a), at: 'invalid' },
    { ...event(15, 'failed', a), at: new Date(Date.now() + 120000).toISOString() },
  ];
  assert.deepEqual(breaker.observe([session(invalidEvents, { key: unknownKey })]), [], 'Malformed and future events must not become confirmed failure evidence');
  assert.deepEqual(breaker.observe([session([event(16, 'failed', a), { ...event(17, 'failed', a), at: new Date(Date.now() - 11 * 60000).toISOString() }], { key: unknownKey })]), []);
  assert.equal(store.data.loopState[unknownKey].count, 0);
  store.save('settings', { ...store.data.settings, presets: store.data.settings.presets.map((preset) => preset.id === 'claude' ? { ...preset, loopBreaker: { ...preset.loopBreaker, threshold: 2, autoInterrupt: true } } : preset) });
  const auto = breaker.observe([session([18, 19].map((index) => ({ ...event(index, 'failed', a), failureLabel: undefined })), { key: 'default/tmux:hq-dddddddddddd' })])[0];
  assert.equal(auto.status, 'pending'); assert.equal(auto.autoInterrupt, true); assert.equal(auto.label, 'Repeated confirmed failure');
  assert.deepEqual(breaker.observe([session([event(20, 'failed', a)], { presetId: 'missing-preset' })]), []);
  const countBeforeNotice = store.data.loopState[unknownKey].count;
  const notice = event(22, 'notice');
  assert.deepEqual(breaker.observe([session([notice], { key: unknownKey })]), []);
  assert.equal(store.data.loopState[unknownKey].cursor, notice.id);
  assert.equal(store.data.loopState[unknownKey].count, countBeforeNotice, 'An unrelated event cannot establish failure or progress');
  store.save('settings', { ...store.data.settings, presets: store.data.settings.presets.map((preset) => preset.id === 'claude' ? { ...preset, attentionHooks: false } : preset) });
  assert.deepEqual(breaker.observe([session([event(21, 'failed', a)])]), [], 'Disabled attention hooks cannot authorize automatic interruption');
  console.log('PASS repeated confirmed failures, progress and signature resets, scope, restart deduplication, and cooldown');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
