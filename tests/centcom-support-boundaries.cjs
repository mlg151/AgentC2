const assert = require('node:assert/strict');
const { createSupport } = require('../electron/centcom-support.cjs');
const { createOperations } = require('../electron/centcom-operations.cjs');
const { activeFleet } = require('../electron/centcom-fleet.cjs');

function fixture() {
  const terminal = { id: 'hq-000000000001', key: 'alpha/tmux:hq-000000000001', hostId: 'alpha', kind: 'managed', managed: true, state: 'live', provider: 'codex' };
  const chat = { ...terminal, id: 'hq-000000000002', key: 'alpha/tmux:hq-000000000002', transport: 'chat', chatSessionId: 'chat-' + 'a'.repeat(32) };
  const state = { mode: 'gated', inventory: { hosts: [{ id: 'alpha', connected: true }], sessions: [terminal, chat] }, caps: [{ provider: 'codex', status: 'supported', reason: null, version: 'fixture', steering: true, interrupt: true, approvals: true, questions: true }], detail: { ownership: { status: 'unowned' }, pendingRequests: [] }, inspectCalls: [] };
  const denyMutation = () => { throw Error('Read-only support discovery must not dispatch or acquire control'); };
  const service = {
    store: { data: { settings: { hosts: [{ id: 'alpha', enabled: true }] } } },
    inventory: async () => state.inventory,
    commanderCapabilities: async () => { if (state.capFailure) throw Error('Capability observation failed'); return state.caps; },
    commanderInspection: async () => { if (state.detailFailure) throw Error('Unit observation failed'); return state.detail; },
    commanderControl: denyMutation, chatCommand: denyMutation, terminalInput: denyMutation, action: denyMutation,
    create: denyMutation, renameSession: denyMutation, setSessionPinned: denyMutation, devUrls: denyMutation,
    interruptFault: denyMutation, flashDecide: denyMutation,
    diffRequest: denyMutation,
  };
  const registry = createOperations({ service });
  const inspect = createSupport({ service, fleet: async (inventory) => activeFleet(inventory), catalog: registry.catalog, authority: () => state.mode,
    inspectUnit: async (input) => { state.inspectCalls.push(input); if (state.inspectFailure) throw Error('Inspection is unavailable'); } });
  const row = async (operation, extra = {}) => { const result = await inspect({ operation, hostId: 'alpha', provider: 'codex', transport: 'chat', ...extra }); assert.equal(result.entries.length, 1); return result.entries[0]; };
  return { state, service, inspect, row, terminal, chat };
}

(async () => {
  const f = fixture();
  await assert.rejects(f.inspect({ operation: 'not.an.operation' }), (error) => error.code === 'unknown_operation');
  await assert.rejects(f.inspect({ operation: 'unit.create', hostId: 'missing' }), /Unknown capability host/);
  assert.equal((await f.row('unit.send', { sessionKey: f.terminal.key, transport: 'terminal' })).status, 'supported', 'Missing legacy transport metadata uses the terminal adapter');
  for (const operation of ['unit.pin', 'unit.rename', 'devurl.list']) assert.equal((await f.row(operation, { sessionKey: f.terminal.key, transport: 'terminal' })).status, 'supported');
  assert.equal((await f.row('diff.files', { sessionKey: f.terminal.key, transport: 'terminal' })).status, 'unknown', 'Discovery cannot claim that a repository has readable diff evidence');
  assert.equal((await f.row('flash.decide', { sessionKey: f.chat.key })).status, 'unsupported');
  f.service.store.data.settings.hosts[0].enabled = false;
  assert.equal((await f.row('unit.create')).reason, 'Host is disabled');
  f.service.store.data.settings.hosts[0].enabled = true;
  f.state.inventory.hosts[0].connected = false;
  assert.equal((await f.row('unit.create')).reason, 'Host is disconnected');
  f.state.inventory.hosts[0].connected = true;

  f.state.caps[0].status = 'unverified';
  assert.equal((await f.row('unit.create')).reason, 'Native provider capabilities could not be verified');
  f.state.caps[0].status = 'unsupported';
  assert.equal((await f.row('unit.create')).reason, 'Native provider integration is unsupported');
  f.state.caps[0].status = 'supported';
  f.state.caps[0].approvals = false; f.state.caps[0].questions = false;
  assert.equal((await f.row('chat.respond', { sessionKey: f.chat.key })).reason, 'Native provider lacks approvals_or_questions');
  f.state.caps[0].approvals = true; f.state.detailFailure = true;
  let result = await f.row('chat.respond', { sessionKey: f.chat.key });
  assert.equal(result.status, 'unknown'); assert.match(result.reason, /could not be inspected/); assert.equal(result.ownership.status, 'unknown');
  f.state.detailFailure = false;
  f.state.detail = { pendingRequests: undefined };
  result = await f.row('chat.respond', { sessionKey: f.chat.key });
  assert.equal(result.status, 'unknown'); assert.equal(result.ownership.status, 'unknown');
  delete f.service.commanderInspection;
  assert.equal((await f.row('chat.respond', { sessionKey: f.chat.key })).status, 'unknown');
  f.state.capFailure = true;
  assert.equal((await f.row('unit.create')).status, 'unknown');
  f.state.capFailure = false;

  const outside = { ...f.terminal, id: 'hq-000000000003', key: 'alpha/tmux:hq-000000000003', managed: false, kind: 'external-tmux' };
  f.state.inventory.sessions.push(outside);
  result = await f.inspect({ operation: 'inspect_unit', sessionKey: outside.key, provider: 'codex', transport: 'terminal' });
  assert.equal(result.operation, 'unit.inspect'); assert.equal(result.entries[0].status, 'supported');
  f.state.inspectFailure = true;
  result = await f.inspect({ operation: 'unit.inspect', sessionKey: outside.key });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.entries, []); assert.match(result.reason, /inspection is unavailable/);
  assert.deepEqual(f.state.inspectCalls, [{ sessionKey: outside.key }, { sessionKey: outside.key }]);
  result = await f.inspect({ operation: 'unit.stop', sessionKey: 'alpha/tmux:hq-ffffffffffff' });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.entries, []);
  f.state.inventory.sessions = [];
  assert.equal((await f.row('unit.stop')).status, 'unavailable');
  f.state.mode = 'autonomous';
  assert.equal((await f.row('unit.rename')).approval, 'fresh_binding_and_admission');
  console.log('PASS capability discovery rejects unknown scopes, preserves legacy transport, reports disabled/disconnected hosts and missing native evidence, distinguishes unsupported hooks and unproven repositories, and never acquires control');
})().catch((error) => { console.error(error); process.exitCode = 1; });
