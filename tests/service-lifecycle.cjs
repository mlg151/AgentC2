const assert = require('node:assert/strict');
const { serviceFixture } = require('./fixtures/service-boundaries.cjs');

async function commanderRoster() {
  const fixture = serviceFixture(), { service } = fixture;
  const commander = { id: 'hq-cccccccccccc', key: 'tmux:hq-cccccccccccc', kind: 'managed', managed: true, transport: 'chat', title: 'CENTCOM // CODEX (fixture)', cwd: '/home/fixture/.cache/agentc2/centcom', state: 'live', chatState: 'idle' };
  const unit = { ...commander, id: 'hq-aaaaaaaaaaaa', key: 'tmux:hq-aaaaaaaaaaaa', title: 'User task', cwd: '/fixture/project' };
  fixture.setHandler((request) => request.respond({ sessions: [commander, unit] }));
  service.store.data.attention = [{ id: 'commander-alert', sessionKey: 'default/' + commander.key, acknowledged: false }];
  try {
    const snapshot = await service.inventory();
    assert.ok(snapshot.sessions.length > 0);
    assert.ok(snapshot.sessions.every((s) => s.title === 'User task'));
    assert.ok(snapshot.internalSessionKeys.includes('default/' + commander.key));
    assert.ok(!snapshot.attention.some((item) => item.id === 'commander-alert'));
    fixture.setHandler((request) => request.fail(1, 'Offline fixture'));
    const cached = await service.inventory();
    assert.deepEqual(cached.sessions.map((s) => s.key), snapshot.sessions.map((s) => s.key), 'Offline cached inventory must not resurrect commanders');
  } finally { fixture.close(); }
}

async function acknowledgedFailures() {
  const fixture = serviceFixture(), { service } = fixture;
  try {
    fixture.setHandler((request) => request.respond(request.payload.action === 'inventory' ? {} : { name: 'hq-111111111111' }));
    assert.equal((await service.create({ provider: 'terminal', hostId: 'default' })).name, 'hq-111111111111');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.calls.filter((request) => request.payload.action === 'create').length, 1, 'Post-acknowledgement inventory failure must never replay a launch');
    const input = { name: 'hq-111111111111', hostId: 'default', id: 'a'.repeat(32), decision: 'allow' };
    let decided = false;
    fixture.setHandler((request) => {
      if (request.payload.action === 'flash_decide') { decided = true; request.respond({ accepted: true }); }
      else request.respond(decided ? {} : [{ ...input, state: 'pending' }]);
    });
    assert.deepEqual(await service.flashDecide({ id: 'desktop' }, input), { accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.calls.filter((request) => request.payload.action === 'flash_decide').length, 1);
    fixture.setHandler((request) => request.payload.action === 'flash_list' ? request.fail(1, 'Permission inventory offline') : request.respond({ stopped: true }));
    assert.deepEqual(await service.action({ id: 'desktop' }, 'stop', input.name, 'default'), { stopped: true });
    fixture.setHandler((request) => request.respond({ complete: true }));
    const deleting = fixture.adapters.runRemote({ action: 'cleanup_delete', provider: 'claude' }, 'default');
    assert.ok([...fixture.timers.values()].some((timer) => timer.delay === 40000)); await deleting;
  } finally { fixture.close(); }
}

async function imageOwnership() {
  const fixture = serviceFixture(), { service } = fixture;
  const client = { id: 'desktop' }, record = { hostId: 'default', owner: client, connection: 'connected', exitCode: null };
  const id = 'fixture-view';
  service.terminals.handles.set(id, { client, record });
  try {
    let release;
    fixture.setImageHandler(async () => new Promise((resolve) => { release = resolve; }));
    const changed = service.uploadClipboardImage(client, id, Buffer.from('fixture PNG bytes'));
    service.terminals.handles.set(id, { client, record: { ...record } }); release('/tmp/committed-fixture.png');
    await assert.rejects(changed, /Terminal changed during image upload/);
    service.terminals.handles.set(id, { client, record });
    const stolen = service.uploadClipboardImage(client, id, Buffer.from('fixture PNG bytes'));
    record.owner = { id: 'phone' }; release('/tmp/committed-fixture.png');
    await assert.rejects(stolen, /Take control/);
    assert.equal(fixture.calls.length, 0, 'The image seam must not bypass service ownership checks with a process call');
  } finally { service.terminals.handles.clear(); fixture.close(); }
}

async function persistedTargets() {
  const name = 'hq-111111111111', key = `default/tmux:${name}`;
  const unit = { key, id: name, provider: 'terminal', kind: 'managed', managed: true, canAttach: true };
  const fixture = serviceFixture((store) => store.save('cachedUnits', { default: [unit] })), { service } = fixture;
  try {
    const isDeleting = service.cleanup.isDeleting;
    service.cleanup.isDeleting = () => true;
    assert.throws(() => service.setSessionPinned(key, true), /History deletion is in progress/);
    await assert.rejects(service.renameSession(key, 'Reviewed name'), /History deletion is in progress/);
    service.cleanup.isDeleting = isDeleting;
    service.store.save('deletedSessions', [key]);
    assert.throws(() => service.setSessionPinned(key, true), /History has been deleted/);
    await assert.rejects(service.renameSession(key, 'Reviewed name'), /History has been deleted/);
    assert.equal(fixture.calls.length, 0, 'Deleting/deleted targets must reject before any remote mutation');
    service.store.save('deletedSessions', []);
    let visible = true;
    fixture.setHandler(async (request) => {
      if (request.payload.action === 'rename') { visible = false; await service.inventory(); request.respond({ renamed: true }); return; }
      request.respond({ user: 'fixture', sessions: visible && !request.payload.localHost ? [{ ...unit, key: `tmux:${name}` }] : [] });
    });
    assert.equal(await service.renameSession(key, 'Reviewed name'), 'Reviewed name');
    assert.equal(service.store.data.cachedUnits.default.length, 0, 'A session disappearing during rename must not be resurrected in the cache');
    assert.throws(() => service.openDevUrl({ id: 'desktop' }, null, 'http://localhost:3000'), /Terminal is disconnected/);
    await assert.rejects(service.deleteSession({ id: 'desktop' }, key), /Reconnect the host/);
  } finally { fixture.close(); }
}

async function uncertainDeletion() {
  const name = 'hq-222222222222', key = `default/tmux:${name}`, sessionId = 'chat-' + 'b'.repeat(32), client = { id: 'desktop' };
  const unit = { key, id: name, provider: 'codex', kind: 'managed', managed: true, canAttach: true, canStop: true, transport: 'chat', chatSessionId: sessionId };
  const fixture = serviceFixture((store) => store.save('cachedUnits', { default: [unit] })), { service } = fixture;
  let fresh = { ...unit, key: `tmux:${name}` };
  fixture.setHandler((request) => request.respond({ user: 'fixture', sessions: request.payload.localHost ? [] : [fresh] }));
  const record = { hostId: 'default', sessionId, owner: client, connection: 'connected', handles: new Set(['fixture-view']) };
  service.chats.sessions.set(`default/${sessionId}`, record); service.chats.handles.set('fixture-view', { client, record });
  service.chats.submit = async () => ({ state: 'unknown' });
  try {
    service.chats.sessions.delete(`default/${sessionId}`);
    await assert.rejects(service.action(client, 'stop', name, 'default'), /Open the chat and take control/);
    service.chats.sessions.set(`default/${sessionId}`, record);
    await assert.rejects(service.deleteSession(client, key), /Stop is not confirmed/);
    assert.deepEqual(service.store.data.deletedSessions, [], 'An uncertain provider stop must never delete the managed session');
    fresh.canStop = false; fresh.chatState = 'unknown';
    await assert.rejects(service.deleteSession(client, key), /Session state is uncertain/);
    fresh.chatState = 'stopped'; await service.deleteSession(client, key);
    assert.ok(service.store.data.deletedSessions.includes(key));
  } finally { service.chats.handles.clear(); service.chats.sessions.clear(); fixture.close(); }
}

(async () => { await commanderRoster(); await acknowledgedFailures(); await imageOwnership(); await persistedTargets(); await uncertainDeletion(); console.log('PASS service commander-free live/cached inventory, acknowledged mutations without replay after malformed refresh, image-transfer ownership races, deleting/deleted target fences, rename disappearance without cache resurrection, and uncertain chat stop preserving session state'); })().catch((error) => { console.error(error); process.exitCode = 1; });
