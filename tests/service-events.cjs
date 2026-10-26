const assert = require('node:assert/strict');
const { serviceFixture } = require('./fixtures/service-boundaries.cjs');
const { validateSettings } = require('../electron/config.cjs');

async function callbacks() {
  const fixture = serviceFixture(), { service } = fixture;
  try {
    for (const name of ['', 'bad/name', 'x'.repeat(81)]) await assert.rejects(service.terminals.configure(name, 'default'), /Invalid tmux session name/);
    await service.terminals.configure('external-valid', 'default');
    assert.equal(fixture.calls.length, 0, 'External terminal configuration must not mutate remote session options');
    const sent = [];
    service.tunnels.feed = (...args) => sent.push(args);
    service.chats.onEvents({ hostId: 'default', session: {} }, [{ type: 'message.completed', data: { text: 'excluded' } }]);
    service.chats.onDispose({ hostId: 'default', session: {} });
    assert.equal(sent.length, 0);
    const record = { hostId: 'default', name: 'hq-111111111111', session: { managedName: 'hq-111111111111' } };
    service.chats.onEvents(record, [{ type: 'message.completed', data: { text: 'x'.repeat(4097) } }, { type: 'tool.completed', data: { output: 'tool evidence' } }, { type: 'provider.event', data: {} }]);
    assert.deepEqual(sent.map((call) => call[2].length), [2048, 2048, 1, 1, 13, 1]);
    service.terminals.onOutput(record, 'terminal evidence'); assert.equal(sent.at(-1)[2], 'terminal evidence');
    service.chats.onDispose(record); service.terminals.onDispose(record);
    service.centcom.observeChat = async () => { throw Error('Observation fixture failed'); };
    service.events.emit('commander:chat-evidence', record, []); await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fixture.logs.some((row) => row.join(' ').includes('CENTCOM chat observation failed: Observation fixture failed')));
    const scrollRecord = { hostId: 'default', name: record.name, control: { closed: false, command: async () => { throw Error('Fixture tmux control disconnected'); } }, disposed: true, exitCode: null };
    await assert.rejects(service.terminals.scroll(scrollRecord, 'up', 10), /Fixture tmux control disconnected/);
    scrollRecord.disposed = false; scrollRecord.exitCode = 1;
    await assert.rejects(service.terminals.scroll(scrollRecord, 'up', 10), /Fixture tmux control disconnected/);
    scrollRecord.exitCode = null;
    fixture.setHandler((request) => request.respond({ historyActive: true }));
    await service.terminals.scroll(scrollRecord, 'up', 10);
    assert.equal(scrollRecord.historyActive, true); assert.equal(fixture.calls.at(-1).payload.action, 'scroll');
    const first = service.worktrees('default');
    const request = fixture.calls.at(-1); request.child.emit('error', Error('First spawn failure')); request.child.emit('error', Error('Late duplicate failure')); request.child.emit('close', 1);
    await assert.rejects(first, /First spawn failure/);
    const waiting = service.chats.request('default', 'capabilities', { prepareProvider: 'codex' });
    assert.ok([...fixture.timers.values()].some((timer) => timer.delay === 330000)); await waiting;
    const deleting = fixture.adapters.runRemote({ action: 'cleanup_delete', provider: 'antigravity' }, 'default');
    assert.ok([...fixture.timers.values()].some((timer) => timer.delay === 300000)); await deleting;
  } finally { fixture.close(); }
}

async function oporders() {
  const order = { version: 1, id: 'fixture', hostId: 'default', repository: '/fixture/repository', instructions: 'Reviewed fixture instruction', mcp: [], enabled: true };
  const fixture = serviceFixture((store) => store.save('settings', validateSettings({ ...store.data.settings, opOrders: [order] }))), { service } = fixture;
  let failSync = true, offline = false;
  fixture.setHandler((request) => {
    if (offline || failSync && request.payload.action === 'oporder_sync') { request.fail(1, 'Fixture OpOrder conflict'); return; }
    request.respond(request.payload.action === 'inventory' ? { user: 'fixture', sessions: [] } : { synchronized: true });
  });
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  const syncCount = () => fixture.calls.filter((request) => request.payload.action === 'oporder_sync').length;
  try {
    await service.inventory(); await drain(); assert.equal(syncCount(), 1); assert.ok(service.store.data.opOrderConflicts.fixture);
    await service.saveSettings(service.store.data.settings);
    assert.ok(service.store.data.opOrderConflicts.fixture, 'Saving an unchanged enabled order retains its unresolved review warning');
    await service.inventory(); await drain(); assert.equal(syncCount(), 1, 'Conflicted sync attempts must respect the retry interval');
    fixture.advance(60001); failSync = false;
    await service.inventory(); await drain(); assert.equal(syncCount(), 2); assert.equal(service.store.data.opOrderConflicts.fixture, undefined);
    await service.inventory(); await drain(); assert.equal(syncCount(), 2, 'An unchanged synchronized order must not be applied again');
    offline = true; await service.inventory(); offline = false;
    await service.inventory(); await drain(); assert.equal(syncCount(), 3, 'Reconnection must revalidate an order after clearing prior sync evidence');
    const changed = structuredClone(service.store.data.settings); changed.opOrders[0].instructions = 'Changed without preview';
    await assert.rejects(service.saveSettings(changed), /Preview and enroll/);
    const created = structuredClone(service.store.data.settings); created.opOrders.push({ ...order, id: 'new', repository: '/fixture/new' });
    await assert.rejects(service.saveSettings(created), /Preview and enroll/);
    await service.saveSettings(changed, undefined, 'peer-sync');
    assert.equal(service.store.data.settings.opOrders[0].instructions, changed.opOrders[0].instructions);
    const disabled = structuredClone(service.store.data.settings); disabled.opOrders[0].enabled = false; await service.saveSettings(disabled);
    assert.equal(service.store.data.settings.opOrders[0].enabled, false);
    // Conflict records outlive their source settings after an interrupted edit.
    // Removing that order must clear its stale persisted review warning.
    const other = { ...order, id: 'orphan', hostId: 'local', repository: '/fixture/other' };
    await service.saveSettings({ ...service.store.data.settings, opOrders: [other] }, undefined, 'peer-sync');
    failSync = true; await service.inventory(); await drain(); assert.ok(service.store.data.opOrderConflicts.orphan);
    await service.saveSettings({ ...service.store.data.settings, opOrders: [] });
    assert.deepEqual(service.store.data.opOrderConflicts, {});
    service.store.save('settings', { ...service.store.data.settings, opOrders: undefined });
    await service.inventory(); offline = true; await service.inventory();
    await service.saveSettings(service.store.data.settings);
    assert.deepEqual(service.store.data.settings.opOrders, [], 'Persistence reconciles the normalized OpOrder array even for legacy missing settings');
  } finally { fixture.close(); }
}

async function inventoryEdges() {
  const fixture = serviceFixture(), { service } = fixture;
  try {
    let returned = [{ key: 'codex:saved', id: 'saved', title: 'Saved fixture', provider: 'codex', kind: 'conversation', canAttach: false, resolvedRequestIds: [] }];
    fixture.setHandler((request) => request.respond({ user: 'fixture', sessions: request.payload.localHost ? [] : returned }));
    const missing = 'default/tmux:hq-111111111111';
    let raised = true;
    service.loopBreaker.observe = () => { if (!raised) return []; raised = false; return [{ sessionKey: missing, id: 'a'.repeat(32), at: new Date().toISOString(), autoInterrupt: true, count: 3, label: 'Verified fixture failure', detail: 'Fixture unit disappeared' }]; };
    const snapshot = await service.inventory(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshot.sessions[0].outputActivity, undefined, 'Saved conversation rows have no native terminal activity');
    assert.equal(snapshot.attention.find((item) => item.signature.startsWith('loop:')).title, missing);
    assert.ok(fixture.logs.some((row) => row.join(' ').includes('Automatic interrupt failed: No eligible confirmed fault')));
    const name = 'hq-222222222222';
    returned = [{ key: `tmux:${name}`, id: name, title: 'Mission fixture', provider: 'codex', kind: 'managed', managed: true }];
    service.specops.list = () => [{ id: 'fixture', hostId: 'default', state: 'running', stage: 'review', visits: [{ name }], workflow: { stages: [{ id: 'work' }, { id: 'review' }] } }];
    assert.equal((await service.inventory()).sessions[0].specops.breadcrumb, '[work] → [*review*]');
  } finally { fixture.close(); }
}

(async () => { await callbacks(); await oporders(); await inventoryEdges(); console.log('PASS service output/disposal/observation callbacks, closed/exited control fallback fences, duplicate child errors and provider deadlines, OpOrder retry/reconnect/review/conflict removal, saved inventory activity, and disappeared automatic-interrupt targets'); })().catch((error) => { console.error(error); process.exitCode = 1; });
