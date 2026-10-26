const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, defaults, validateSettings, validateWorkspace } = require('../electron/config.cjs');

assert.deepEqual(validateWorkspace({ tabs: [], metadata: {}, situation: { collapsedGroups: ['host:alpha', 'host:alpha', 'repo:fixture'] } }).situation.collapsedGroups, ['host:alpha', 'repo:fixture']);
const base = () => ({ ...defaults(), hosts: [{ id: 'host', name: 'Fixture', target: 'fixture', port: 22, enabled: true }] });
const order = () => ({ version: 1, id: 'order', hostId: 'host', repository: '/repository', enabled: false, instructions: '', overrides: {}, mcp: [] });
const server = () => ({ name: 'fixture', transport: 'stdio', command: 'fixture', providers: ['codex'] });
const rejectsSettings = (input, message) => assert.throws(() => validateSettings(input), message);

for (const input of [null, {}, { hosts: [], presets: [] }, { hosts: Array(31).fill({}), presets: [] }, { hosts: [{}], presets: null }, { hosts: [{}], presets: Array(101).fill({}) }]) rejectsSettings(input, /Configure between/);
for (const change of [{ name: 1 }, { name: 'x'.repeat(101) }, { name: 'bad\0' }]) rejectsSettings({ ...base(), hosts: [{ ...base().hosts[0], ...change }] }, /configuration text/);
for (const port of [0, 65536, 1.5]) rejectsSettings({ ...base(), hosts: [{ ...base().hosts[0], port }] }, /SSH port/);
assert.equal(validateSettings({ ...base(), hosts: [{ ...base().hosts[0], name: ' ' }] }).hosts[0].name, 'fixture');
assert.equal(validateSettings({ ...base(), hosts: [{ id: 'local', kind: 'local', name: ' ', enabled: true }] }).hosts[0].name, 'This computer');
for (const cleanup of [{}, Array(91).fill({})]) rejectsSettings({ ...base(), cleanup }, /cleanup policies/);
for (const opOrders of [{}, Array(51).fill({})]) rejectsSettings({ ...base(), opOrders }, /Invalid OpOrders/);
for (const change of [{ id: 'bad!' }, { provider: 'other' }, { command: '' }, { command: 'codex\nunsafe' }, { hostId: 'missing' }, { roeProfile: 'other' }, { loopBreaker: { enabled: true } }, { loopBreaker: { autoInterrupt: true } }]) rejectsSettings({ ...base(), presets: [{ ...base().presets[0], ...change }] }, /preset|command|host|Engagement|failure/i);
rejectsSettings({ ...base(), presets: [base().presets[0], base().presets[0]] }, /launch preset/);
assert.equal(validateSettings({ ...base(), presets: [{ ...base().presets[0], name: ' ' }] }).presets[0].name, 'codex');

for (const change of [null, { version: 2 }, { id: 'bad!' }, { hostId: 'missing' }, { repository: 4 }, { repository: 'relative' }, { repository: '/x\0' }, { repository: '/' + 'x'.repeat(4097) }, { repository: '/' }, { repository: '/x/../y' }, { repository: '/repository/' }, { overrides: [] }, { overrides: 'text' }, { mcp: {} }, { mcp: Array(31).fill({}) }]) {
  rejectsSettings({ ...base(), opOrders: [change === null ? null : { ...order(), ...change }] }, /OpOrder/);
}
rejectsSettings({ ...base(), opOrders: [order(), order()] }, /OpOrder scope/);
rejectsSettings({ ...base(), opOrders: [order(), { ...order(), id: 'second' }] }, /Only one OpOrder/);
assert.equal(validateSettings({ ...base(), opOrders: [{ ...order(), repository: '/repository', instructions: undefined, overrides: undefined }] }).opOrders[0].repository, '/repository');
const badServers = [null, { name: 'bad!' }, { transport: 'other' }, { providers: {} }, { providers: [] }, { providers: ['other'] }, { providers: ['codex', 'codex'] }, { env: {} }, { env: Array(31).fill('ENV') }, { env: [1] }, { env: ['bad-name'] }, { env: ['ENV', 'ENV'] }, { headers: [] }, { headers: 'text' }, { headers: { 'bad name': 'ENV' } }, { headers: { Authorization: 1 } }, { headers: { Authorization: 'secret literal' } }, { args: {} }, { args: Array(41).fill('arg') }, { args: [1] }, { args: ['x'.repeat(501)] }, { args: ['bad\0'] }, { command: '' }, { url: 'https://example.invalid/' }, { headers: { Authorization: 'ENV' } }];
for (const change of badServers) rejectsSettings({ ...base(), opOrders: [{ ...order(), mcp: [change === null ? null : { ...server(), ...change }] }] }, /OpOrder/);
rejectsSettings({ ...base(), opOrders: [{ ...order(), mcp: [server(), server()] }] }, /MCP server/);
const http = { name: 'http', transport: 'http', url: 'https://example.invalid/endpoint' };
for (const change of [{ command: 'fixture' }, { args: ['arg'] }, { env: ['ENV'] }, { url: 'http://example.invalid/' }, { url: 'https://[invalid]/' }, { url: 'https://example.invalid/path?q=secret' }, { url: 'https://example.invalid/path#secret' }, { url: 'https://example.invalid/path@secret' }]) rejectsSettings({ ...base(), opOrders: [{ ...order(), mcp: [{ ...http, ...change }] }] }, /OpOrder/);
assert.deepEqual(validateSettings({ ...base(), opOrders: [{ ...order(), mcp: [http, { ...server(), providers: undefined, headers: undefined }] }] }).opOrders[0].mcp[1].providers, ['codex', 'claude', 'antigravity', 'opencode']);

const workspace = { tabs: ['host/tmux:one', 'host/tmux:two'], metadata: {} };
const collapsed = validateWorkspace({ ...workspace, situation: { collapsedGroups: ['one', 'one', 'two'] } });
assert.deepEqual(collapsed.situation.collapsedGroups, ['one', 'two']);
const callsigns = Object.fromEntries(Array.from({ length: 99 }, (_, index) => ['host/tmux:unit' + index, String(index + 1).padStart(2, '0')]));
assert.equal(Object.keys(validateWorkspace({ ...workspace, situation: { callsigns } }).situation.callsigns).length, 99);
assert.throws(() => validateWorkspace({ ...workspace, situation: { callsigns: { ...callsigns, 'host/tmux:overflow': '99' } } }), /Callsigns/);
for (const change of [null, { tabs: null }, { tabs: Array(41).fill('key') }, { metadata: null }, { metadata: 1 }]) assert.throws(() => validateWorkspace(change === null ? null : { ...workspace, ...change }), /Invalid workspace/);
for (const situation of ['text', { version: 2 }, { callsigns: { 'host/tmux:one': 1 } }, { callsigns: { 'host/tmux:one': '00' } }, { callsigns: { 'host/tmux:one': '01', 'host/tmux:two': '01' } }, { shortcuts: Object.fromEntries(Array.from({ length: 51 }, (_, i) => ['key' + i, 'binding'])) }]) assert.throws(() => validateWorkspace({ ...workspace, situation }), /Situation|Callsigns|keyboard/);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-config-boundaries-'));
try {
  const file = path.join(directory, 'workspace.json');
  const saved = (patch = {}) => ({ settings: base(), workspace, openCodePresetMigrated: true, ...patch });
  const reopen = (patch = {}) => { fs.writeFileSync(file, JSON.stringify(saved(patch))); return new Store(directory); };
  for (const cleanupState of [{}, { lastRuns: 1, results: [] }, { lastRuns: {}, results: {} }]) assert.throws(() => reopen({ cleanupState }), /saved cleanup state/);
  for (const lastRuns of [{ 'bad!': '2026-10-25' }, { 'host/codex': 1 }, { 'host/codex': 'invalid' }]) assert.throws(() => reopen({ cleanupState: { lastRuns, results: [] } }), /run timestamp/);
  const result = { hostId: 'host', provider: 'codex', status: 'deleted', automatic: false, at: '2026-10-25T00:00:00Z', detail: 'Fixture' };
  for (const change of [null, { hostId: 'bad!' }, { provider: 'other' }, { status: 'other' }, { automatic: 1 }, { at: 1 }, { at: 'invalid' }, { operationId: 1 }, { operationId: 'bad!' }, { bytes: -1 }, { bytes: 1.5 }]) assert.throws(() => reopen({ cleanupState: { lastRuns: {}, results: [change === null ? null : { ...result, ...change }] } }), /cleanup result|operation ID|byte count/);
  const complete = { ...result, operationId: 'operation', key: 'host/codex:conversation', bytes: 0, estimated: true };
  assert.deepEqual(reopen({ cleanupState: { lastRuns: { 'host/codex': complete.at }, results: [complete] } }).data.cleanupState.results, [complete]);
  assert.deepEqual(reopen({ cleanupState: { lastRuns: {}, results: [result] } }).data.cleanupState.results, [result]);
  for (const cachedUnits of [[], 'text', Object.fromEntries(Array.from({ length: 31 }, (_, i) => ['host' + i, []])), { 'bad!': [] }, { host: {} }, { host: Array(201).fill({}) }]) assert.throws(() => reopen({ cachedUnits }), /cached.*inventory/);
  const unit = { key: 'host/tmux:one', id: 'one', provider: 'codex', kind: 'managed' };
  for (const change of [null, { key: 'other/tmux:one' }, { provider: 'other' }, { kind: 'other' }, { id: 'two' }]) assert.throws(() => reopen({ cachedUnits: { host: [change === null ? null : { ...unit, ...change }] } }), /cached unit|identity changed/i);
  assert.throws(() => reopen({ cachedUnits: { host: [unit, unit] } }), /cached unit/i);
  const chat = { ...unit, transport: 'chat', chatSessionId: 'chat-' + 'a'.repeat(32), providerSessionId: 'native', chatState: 'waiting', updatedAt: '2026-10-25T00:00:00Z', exitCode: 0, roeProfile: 'gated' };
  const restored = reopen({ cachedUnits: { host: [chat] } }).data.cachedUnits.host[0];
  assert.equal(restored.transport, 'chat'); assert.equal(restored.chatState, 'waiting'); assert.equal(restored.providerSessionId, 'native'); assert.equal(restored.exitCode, 0);
  assert.equal(reopen({ cachedUnits: { host: [{ ...unit, transport: 'chat' }] } }).data.cachedUnits.host[0].transport, 'terminal');
  assert.deepEqual(reopen({ opOrderConflicts: { missingHost: { id: 'missingHost', detail: 'Review' }, missingTime: { id: 'missingTime', hostId: 'host', detail: 'Review' } } }).data.opOrderConflicts, {});
  const sanitized = reopen({ attention: {}, deletedSessions: {}, exercises: [null, {}, { version: 1, id: 'a'.repeat(32), contestants: [] }], flashResolved: ['bad!', 'b'.repeat(32)], loopState: { bad: {}, 'host/tmux:hq-123456abcdef': { fault: true } }, opOrderConflicts: { bad: {}, order: { id: 'order', hostId: 'host', detail: 'Review', at: result.at } } });
  assert.equal(sanitized.data.exercises.length, 1); assert.deepEqual(sanitized.data.flashResolved, ['b'.repeat(32)]);
  assert.deepEqual(Object.keys(sanitized.data.loopState), ['host/tmux:hq-123456abcdef']); assert.deepEqual(Object.keys(sanitized.data.opOrderConflicts), ['order']);
  for (const value of [[], 'text']) { const store = reopen({ exercises: value, flashResolved: value, loopState: value, opOrderConflicts: value }); assert.deepEqual(store.data.loopState, {}); assert.deepEqual(store.data.opOrderConflicts, {}); }
  const store = reopen();
  for (const [host, sessions] of [['bad!', []], ['host', {}]]) assert.throws(() => store.cacheUnits(host, sessions), /host inventory/);
  store.cacheUnits('host', [chat]);
  const cachedBytes = fs.readFileSync(file, 'utf8'); store.cacheUnits('host', [chat]); assert.equal(fs.readFileSync(file, 'utf8'), cachedBytes);
  const keys = ['host/tmux:one', 'host/tmux:two'];
  const selected = { ...workspace, selectedKey: keys[0], splitKey: keys[1], metadata: Object.fromEntries(keys.map((key) => [key, { project: '', notes: '', pinned: false }])), situation: { anchorKey: keys[0], targetKey: keys[1], callsigns: { [keys[0]]: '01', [keys[1]]: '02' } } };
  store.data.workspace = validateWorkspace(selected); store.data.deletedSessions = [...keys];
  const pruned = store.saveWorkspace(selected); assert.deepEqual(pruned.tabs, []); assert.equal(pruned.splitKey, null); assert.equal(pruned.situation.targetKey, null);
  store.data.deletedSessions = []; store.data.workspace = validateWorkspace(selected);
  store.data.loopState = { [keys[0]]: { fixture: true }, 'host/tmux:retained': { fixture: true } };
  store.forgetSessions(keys); assert.deepEqual(store.data.workspace.tabs, []); assert.equal(store.data.workspace.situation.anchorKey, null);
  assert.deepEqual(Object.keys(store.data.loopState), ['host/tmux:retained']);
  // Legacy pane input is normalized before tombstones are applied. The
  // normalized situation and retained notes must survive a disk round trip.
  for (const legacy of [{}, { situation: null }, { situation: {} }, { situation: { anchorKey: keys[0], targetKey: keys[1], callsigns: { [keys[0]]: '01', [keys[1]]: '02' } } }]) {
    store.data.workspace = validateWorkspace({ tabs: [], metadata: {} });
    store.data.deletedSessions = [keys[0]];
    const migrated = store.saveWorkspace({ tabs: keys, selectedKey: keys[0], splitKey: keys[1], metadata: { [keys[0]]: { project: '', notes: 'Deleted note', pinned: false }, [keys[1]]: { project: '', notes: 'Retain owned note', pinned: false } }, ...legacy });
    assert.deepEqual(migrated.tabs, [keys[1]]); assert.equal(migrated.selectedKey, keys[1]); assert.equal(migrated.splitKey, null);
    assert.equal(migrated.situation.anchorKey, null); assert.equal(migrated.situation.targetKey, keys[1]);
    assert.equal(migrated.situation.callsigns[keys[0]], undefined);
    assert.equal(migrated.metadata[keys[0]], undefined); assert.equal(migrated.metadata[keys[1]].notes, 'Retain owned note');
    const persisted = new Store(directory).data.workspace;
    assert.equal(persisted.selectedKey, keys[1]); assert.equal(persisted.metadata[keys[0]], undefined); assert.equal(persisted.metadata[keys[1]].notes, 'Retain owned note');
  }
  store.data.deletedSessions = [];
  const many = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['host/tmux:unit' + i, { project: '', notes: '', pinned: false }]));
  store.data.workspace.metadata = many;
  assert.throws(() => store.setSessionPinned('host/tmux:overflow', true), /metadata limit/);
  store.data.workspace.metadata = { 'host/tmux:outside': { project: '', notes: '', pinned: false } };
  assert.throws(() => store.saveWorkspace({ tabs: [], metadata: many }), /metadata limit/);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS configuration bounds, malformed saved state, provider/MCP admission, cache privacy, atomic restore, tombstones, and metadata capacity');
