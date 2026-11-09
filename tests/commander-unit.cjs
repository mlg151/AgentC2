const assert = require('node:assert/strict');
const { commanderFacade, routeCommanderCommands } = require('../electron/commander.cjs');

const commander = { id: 'centcom-commander', name: 'Commander' };
const phone = { id: 'phone', name: 'Phone' };
const unit = { key: 'alpha/tmux:hq-111111111111', name: 'hq-111111111111', hostId: 'alpha', transport: 'terminal' };
const chat = { ...unit, transport: 'chat', chatSessionId: 'chat-' + '1'.repeat(32) };
const commandId = '11111111-2222-4333-8444-555555555555';
const revision = 'a'.repeat(64), operationId = 'b'.repeat(32);

function fixture(target = unit, options = {}) {
  const record = { owner: options.owner === undefined ? phone : options.owner, handles: new Set(), connection: options.connection || 'connecting' };
  const handles = new Map(), calls = [];
  if (record.owner) { record.handles.add('previous'); handles.set('previous', { client: record.owner }); }
  const views = {
    sessions: new Map([[`${target.hostId}/${target.transport === 'chat' ? target.chatSessionId : target.name}`, record]]), handles,
    open: async (...args) => { calls.push(['open', ...args]); if (options.openError) throw options.openError; record.handles.add('commander'); handles.set('commander', { client: args[0] }); return 'commander'; },
    get: () => ({ record }),
    waitForConnection: async (...args) => { calls.push(['wait', ...args]); if (options.waitError) throw options.waitError; },
    take: async (client, handle, onPrevious) => { calls.push(['take', handle]); onPrevious(record.owner); record.owner = client; },
    close: (_client, handle) => { calls.push(['close', handle]); handles.delete(handle); record.handles.delete(handle); },
    publish: () => calls.push(['publish', record.owner]),
    capabilities: async (hostId) => { calls.push(['capabilities', hostId]); return ['capabilities']; },
    read: async () => options.page,
    request: async () => options.receipt,
    submit: async (...args) => { calls.push(['submit', ...args]); return 'accepted'; },
    write: async (...args) => calls.push(['write', ...args]),
  };
  const facade = commanderFacade({ chats: { ...views }, terminals: views,
    action() {}, interruptFault() {},
    deleteSession: (...args) => { calls.push(['delete', ...args]); return 'deleted'; },
    getHost: (id) => ({ id }), runRemote: async (...args) => { calls.push(['remote', ...args]); return options.remote; },
  });
  return { facade, record, handles, calls, views, options };
}

async function main() {
  for (const target of [unit, chat]) {
    const f = fixture(target);
    const result = await f.facade.commanderControl(commander, target, async (handle, ownership) => {
      assert.equal(handle, 'commander');
      assert.deepEqual(ownership, { key: target.key, previousControllerId: phone.id });
      assert.equal(f.record.owner, commander);
      assert.deepEqual(f.record.commanderAction, { ownerId: commander.id, previousControllerId: phone.id });
      return 'completed adapter';
    });
    assert.equal(result, 'completed adapter');
    assert.equal(f.record.owner, phone);
    assert.equal(f.record.commanderAction, undefined);
    assert.equal(f.handles.has('commander'), false);
    const open = f.calls.find((call) => call[0] === 'open');
    assert.deepEqual(open.slice(1), target === chat ? [commander, chat.chatSessionId, 'alpha'] : [commander, unit.name, 'alpha', 120, 32]);
    assert.equal(f.calls.some((call) => call[0] === 'wait'), target !== chat);
  }
  for (const options of [{ openError: Error('Open failed') }, { waitError: Error('Transport failed') }, {}, { connection: 'connected' }]) {
    const f = fixture(unit, options), failure = options.openError || options.waitError || Error('Adapter failed');
    await assert.rejects(f.facade.commanderControl(commander, unit, async () => { throw failure; }), (error) => error === failure);
    assert.equal(f.record.owner, phone);
    assert.equal(f.record.commanderAction, undefined);
    assert.equal(f.handles.has('commander'), false);
  }
  for (const mode of ['no prior controller', 'closed prior controller', 'missing prior handle', 'changed controller', 'different lock']) {
    const f = fixture(unit, { owner: mode === 'no prior controller' ? null : { ...phone, closed: mode === 'closed prior controller' } });
    await f.facade.commanderControl(commander, unit, async () => {
      if (mode === 'missing prior handle') f.handles.delete('previous');
      if (mode === 'changed controller') f.record.owner = { id: 'new-controller' };
      if (mode === 'different lock') f.record.commanderAction = { ownerId: 'other' };
    });
    assert.equal(f.calls.some((call) => call[0] === 'publish'), mode === 'different lock');
    if (mode === 'changed controller') assert.equal(f.record.owner.id, 'new-controller');
    if (mode === 'different lock') assert.equal(f.record.commanderAction.ownerId, 'other');
  }
  const f = fixture();
  for (const remote of [null, { cwd: 'relative', paths: [] }, { cwd: '/repo', paths: null }, { cwd: '/repo', paths: [] }, { cwd: '/repo', paths: ['relative'] }, { cwd: '/repo', paths: [42] }]) {
    f.options.remote = remote;
    await assert.rejects(f.facade.commanderLaunchPaths('alpha', undefined, ['report.txt']), /Launch path identity is unavailable/);
  }
  f.options.remote = { cwd: '/repo', paths: ['/repo/report.txt'] };
  assert.equal(await f.facade.commanderLaunchPaths('alpha', '/repo', ['report.txt']), f.options.remote);
  for (const change of [
    { operationId: undefined }, { operationId: 'bad' }, { path: undefined }, { path: '' }, { path: 'x'.repeat(4097) },
    { revision: 'bad' }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 16001 }, { limit: 0.5 },
  ]) {
    const before = f.calls.length;
    await assert.rejects(f.facade.commanderArtifact({ hostId: 'alpha', operationId, path: 'report.txt', ...change }), /Invalid artifact inspection/);
    assert.equal(f.calls.length, before);
  }
  for (const remote of [null, { text: 42 }, { text: 'x'.repeat(256001) }]) {
    f.options.remote = remote;
    await assert.rejects(f.facade.commanderArtifact({ hostId: 'alpha', operationId, path: 'report.txt' }), /Invalid artifact readback/);
  }
  f.options.remote = { path: 'report.txt', revision, sizeBytes: 10, text: '0123456789' };
  const excerpt = await f.facade.commanderArtifact({ hostId: 'alpha', operationId, path: 'report.txt', revision, offset: 2, limit: 4 });
  assert.equal(excerpt.text, '2345'); assert.equal(excerpt.nextOffset, 6); assert.equal(excerpt.truncated, true);
  f.options.remote = { ...f.options.remote, text: 'password=fixture' };
  assert.equal((await f.facade.commanderArtifact({ hostId: 'alpha', operationId, path: 'report.txt' })).redacted, true);
  assert.deepEqual(await f.facade.commanderCapabilities('alpha'), ['capabilities']);
  for (const id of [null, 42, 'invalid']) await assert.rejects(f.facade.commanderInspection(chat, id), /Invalid chat command ID/);
  assert.equal((await f.facade.commanderInspection(unit)).status, 'unsupported');
  assert.equal((await f.facade.commanderInspection({ ...chat, stale: true })).status, 'stale');
  assert.equal((await f.facade.commanderInspection({ ...chat, missing: true })).status, 'stale');
  assert.equal((await f.facade.commanderInspection({ ...chat, chatSessionId: undefined })).ownership.controller, null);
  f.options.page = { session: { capabilities: {} }, events: [], pendingRequests: [], cursor: 0, latestCursor: 0, retainedFrom: 1, truncated: false };
  assert.equal((await f.facade.commanderInspection(chat)).currentTask.status, 'unknown');
  for (const receipt of [{ commandId: 'other', sessionId: chat.chatSessionId }, { commandId, sessionId: 'other' }]) {
    f.options.receipt = receipt;
    await assert.rejects(f.facade.commanderInspection(chat, commandId), /does not belong/);
  }
  f.options.receipt = { commandId, sessionId: chat.chatSessionId, state: 'unknown', result: null };
  assert.equal((await f.facade.commanderInspection(chat, commandId)).command.facts.providerTurnCompletion, 'unverified');
  f.options.receipt.result = { turnId: 'turn' };
  f.options.page.events = [
    { type: 'message.completed', data: { role: 'user', text: 'Task' }, turnId: 'turn', timestamp: '2026-01-01T00:00:00Z' },
    { sessionId: chat.chatSessionId, turnId: 'turn', type: 'turn.completed', data: { outcome: 'completed' }, sequence: 2, timestamp: '2026-01-01T00:00:01Z' },
  ];
  const inspection = await f.facade.commanderInspection(chat, commandId);
  assert.equal(inspection.currentTask.text, 'Task'); assert.equal(inspection.command.facts.projectAcceptance, 'unverified');
  assert.equal(inspection.command.facts.providerTurnCompletion, 'completed');
  assert.deepEqual(inspection.command.evidence, { sequence: 2, timestamp: '2026-01-01T00:00:01Z' });
  assert.equal(f.facade.commanderDelete(commander, unit.key), 'deleted');
  assert.deepEqual(f.calls.at(-1), ['delete', commander, unit.key, true]);
  await f.facade.chatCommand(commander, 'view', chat, 'send', { text: 'Reviewed task' });
  const submission = f.calls.at(-1); assert.equal(submission[0], 'submit'); assert.equal(submission[3].sessionId, chat.chatSessionId);
  assert.match(submission[3].commandId, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(await f.facade.terminalInput(commander, 'view', 'Reviewed command'), { delivery: 'terminal_input_written', taskCompletion: 'unverified' });
  assert.deepEqual(f.calls.at(-1), ['write', commander, 'view', 'Reviewed command\r', { confirmed: true }]);
  const routing = {}, forwarded = [], result = {};
  routeCommanderCommands(routing, { isCommander: (_host, id) => id === 'commander', submitCommand: (...args) => { forwarded.push(args); return result; } });
  assert.equal(routing.commandRouter(commander, 'view', {}, { sessionId: 'commander' }), null);
  assert.equal(routing.commandRouter(phone, 'view', {}, { sessionId: 'worker' }), null);
  const command = { operation: 'send' }, record = { hostId: 'alpha', sessionId: 'commander' };
  assert.equal(routing.commandRouter(phone, 'view', command, record), result);
  assert.deepEqual(forwarded, [[phone, 'view', command, record]]);
  console.log('PASS commander ownership acquisition/restoration and failure cleanup, read-only inspection, exact receipt binding, artifact/path bounds and redaction, private delete capability, and command routing');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
