const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, action, envelope, desktop, phone } = require('./fixtures/centcom.cjs');
const { mutationContext, assertDispatchScope } = require('../electron/centcom-dispatch.cjs');
const { createService } = require('../electron/service.cjs');
const { fingerprint } = require('../electron/centcom-contract.cjs');
const { Terminals } = require('../electron/terminals.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-bindings-'));
const fixtures = [];
function make(name) { const f = fixture(path.join(directory, name)); fixtures.push(f); return f; }
async function resolve(f, draft) {
  const result = await f.engine.decideDirective(draft.id, 'approve');
  return result.directives.find((d) => d.id === draft.id);
}
async function changedIdentities() {
  for (const field of ['processId', 'startedAt', 'cwd', 'worktreeOperation', 'roeProfile', 'provider']) {
    const f = make(field), unit = f.sessions[0];
    const [draft] = await f.propose([action('unit.stop', { sessionKey: unit.key })]);
    assert.ok(draft.binding);
    unit[field] = 'changed';
    assert.equal((await resolve(f, draft)).state, 'failed', field);
    assert.ok(!f.calls.some((c) => c.operation === 'unit.stop'));
  }
  for (const change of ['route', 'authority', 'roe']) {
    const f = make(change);
    const [draft] = await f.propose([action('unit.stop', { sessionKey: f.sessions[0].key })]);
    if (change === 'route') f.state.settings.hosts[0].target = 'different.invalid';
    if (change === 'authority') f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
    if (change === 'roe') f.state.settings.roe = { version: 1, hostDefaults: { alpha: 'full' } };
    assert.equal((await resolve(f, draft)).state, 'failed', change);
    assert.ok(!f.calls.some((c) => c.operation === 'unit.stop'));
  }
  const f = make('preconditions');
  for (const preconditions of [{ invented: true }, { processId: 'wrong' }, { stage: 'irrelevant' }]) {
    const [draft] = await f.propose([action('unit.stop', { sessionKey: f.sessions[0].key }, { preconditions })]);
    assert.equal((await resolve(f, draft)).state, 'failed');
  }
  delete f.sessions[0].startedAt;
  const [unknown] = await f.propose([action('unit.stop', { sessionKey: f.sessions[0].key })]);
  assert.match((await resolve(f, unknown)).error, /incarnation is unknown/);
}
async function controllersAndRace() {
  const f = make('controllers'), unit = f.sessions[0];
  const desktopHandle = await f.chats.open(desktop, unit.chatSessionId, 'alpha'); await f.chats.take(desktop, desktopHandle);
  const phoneHandle = await f.chats.open(phone, unit.chatSessionId, 'alpha');
  const [stale] = await f.propose([action('unit.send', { sessionKey: unit.key, text: 'Reviewed task' })]);
  await f.chats.take(phone, phoneHandle);
  assert.equal((await resolve(f, stale)).state, 'failed');
  assert.equal(f.chats.state(phone, phoneHandle).controller.id, phone.id);
  await f.chats.take(desktop, desktopHandle);
  const [racing] = await f.propose([action('unit.stop', { sessionKey: unit.key })]);
  const control = f.service.commanderControl;
  f.service.commanderControl = (...args) => { unit.processId = 'replacement'; return control(...args); };
  assert.equal((await resolve(f, racing)).state, 'failed');
  assert.equal(f.chats.state(desktop, desktopHandle).controller.id, desktop.id);
  f.service.commanderControl = control;
  const [valid] = await f.propose([action('unit.stop', { sessionKey: unit.key })]);
  const inspect = f.service.commanderInspection;
  let guarded = false;
  f.service.commanderInspection = async (target) => {
    if (target.key === unit.key && f.chats.get(desktop, desktopHandle).record.commanderAction) {
      await assert.rejects(f.chats.take(phone, phoneHandle), /reviewed action owns/); guarded = true;
    }
    return inspect(target);
  };
  assert.equal((await resolve(f, valid)).state, 'completed'); assert.ok(guarded);
  assert.equal(f.chats.state(desktop, desktopHandle).controller.id, desktop.id);
  assert.equal(f.calls.filter((c) => c.operation === 'unit.stop').length, 1);
  const terminals = new Terminals({ emit() {}, scroll: async () => {} });
  const record = { owner: { id: 'centcom-commander' }, commanderAction: { ownerId: 'centcom-commander' }, connection: 'connected', exitCode: null, handles: new Set(['terminal-handle']), queue: Promise.resolve() };
  terminals.handles.set('terminal-handle', { id: 'terminal-handle', client: phone, record });
  await assert.rejects(terminals.take(phone, 'terminal-handle'), /reviewed action owns/);
  terminals.handles.clear();
}
async function operationRevisions() {
  const f = make('revisions'), unit = f.sessions[0];
  const mission = { id: 'mission', hostId: 'alpha', stage: 'plan', state: 'halted', workflow: { id: 'workflow' }, visits: [{ id: 'visit', stage: 'plan', name: unit.id, sessionId: unit.chatSessionId }] };
  f.missions.push(mission);
  const [draft] = await f.propose([action('specops.control', { id: mission.id, action: 'resume' }, { preconditions: { stage: 'plan' } })]);
  mission.stage = 'implement';
  assert.equal((await resolve(f, draft)).state, 'failed');
  assert.ok(!f.calls.some((c) => c.operation === 'specops.control'));
  f.exercises.push({ id: 'exercise', hostId: 'alpha', state: 'running', contestants: [{ id: 'contestant', name: unit.id, headCommit: 'a'.repeat(40) }] });
  unit.headCommit = 'a'.repeat(40);
  const [promote] = await f.propose([action('exercise.promote', { id: 'exercise', contestantId: 'contestant', revision: 'a'.repeat(64) })]);
  unit.headCommit = 'b'.repeat(40);
  assert.equal((await resolve(f, promote)).state, 'failed');
  assert.ok(!f.calls.some((c) => c.operation === 'exercise.promote'));
  f.flash.push({ id: 'permission', hostId: 'alpha', name: unit.id, state: 'pending', connected: true, tool: 'Read', detail: 'Reviewed path' });
  const [flash] = await f.propose([action('flash.decide', { id: 'permission', decision: 'allow' })]);
  f.flash[0].detail = 'Different path';
  assert.equal((await resolve(f, flash)).state, 'failed');
  assert.ok(!f.calls.some((c) => c.operation === 'flash.decide'));
  const [config] = await f.propose([action('configuration.save', { settings: { presets: [] } })]);
  f.state.settings.presets.push({ id: 'new-preset' });
  assert.equal((await resolve(f, config)).state, 'failed');
  assert.ok(!f.calls.some((c) => c.operation === 'configuration.save'));
  const tree = { operationId: 'a'.repeat(32), status: { headCommit: 'a'.repeat(40), owned: true, active: false, dirty: false, merged: true } };
  f.service.worktrees = async () => [tree];
  const [archive] = await f.propose([action('worktree.archive', { hostId: 'alpha', operationId: tree.operationId })]);
  tree.status.headCommit = 'b'.repeat(40);
  assert.equal((await resolve(f, archive)).state, 'failed');
  assert.ok(!f.calls.some((c) => c.operation === 'worktree.archive'));
}
async function structuredRequests() {
  const f = make('native-requests'), unit = f.sessions[1];
  let pending = { requestId: 'request', turnId: 'provider-turn', itemId: 'tool', state: 'pending', type: 'approval.requested', data: { action: 'Read', detail: 'Reviewed file' } };
  const remote = f.chats.remote;
  f.chats.remote = async (...args) => {
    const result = await remote(...args);
    if (args[1].action === 'history' && args[1].sessionId === unit.chatSessionId) result.pendingRequests = pending ? [structuredClone(pending)] : [];
    return result;
  };
  const input = { sessionKey: unit.key, requestId: 'request', turnId: 'provider-turn', itemId: 'tool', decision: 'allow' };
  const [draft] = await f.propose([action('chat.respond', input)]);
  pending.data.detail = 'Different file';
  assert.equal((await resolve(f, draft)).state, 'failed');
  assert.ok(!f.submitted.some((c) => c.operation === 'respond'));
  const [valid] = await f.propose([action('chat.respond', input)]);
  assert.equal((await resolve(f, valid)).state, 'completed');
  assert.equal(f.submitted.filter((c) => c.operation === 'respond').length, 1);
  const response = f.submitted.find((c) => c.operation === 'respond');
  assert.equal(response.sessionId, unit.chatSessionId); assert.equal(response.payload.turnId, pending.turnId);
  const [stale] = await f.propose([action('chat.respond', input)]);
  pending = null;
  assert.equal((await resolve(f, stale)).state, 'failed');
  const [mismatch] = await f.propose([action('chat.respond', { ...input, itemId: 'different-tool' })]);
  assert.equal((await resolve(f, mismatch)).state, 'failed');
  pending = { requestId: 'question', turnId: 'question-turn', itemId: 'question-item', state: 'pending', type: 'question.requested', data: { questions: [{ id: 'choice', question: 'Choose', options: ['A', 'B'], multiple: false }] } };
  const [answer] = await f.propose([action('chat.respond', { sessionKey: unit.key, requestId: pending.requestId, turnId: pending.turnId, itemId: pending.itemId, answers: [{ questionId: 'choice', answers: ['A'] }] })]);
  assert.equal((await resolve(f, answer)).state, 'completed');
  assert.deepEqual(f.submitted.filter((c) => c.operation === 'respond').at(-1).payload.answers, [{ questionId: 'choice', answers: ['A'] }]);
  for (const type of ['approval', 'question', 'approval.requested', 'question.requested', 'unknown.requested']) {
    pending.type = type;
    const responseInput = { sessionKey: unit.key, requestId: pending.requestId, turnId: pending.turnId, itemId: pending.itemId };
    const payload = type.startsWith('approval') ? { decision: 'deny' } : { answers: [{ questionId: 'choice', answers: ['B'] }] };
    const [responseDraft] = await f.propose([action('chat.respond', { ...responseInput, ...payload })]);
    assert.equal((await resolve(f, responseDraft)).state, type === 'unknown.requested' ? 'failed' : 'completed', type);
    if (type !== 'unknown.requested') {
      const wrongPayload = type.startsWith('approval') ? { answers: [{ questionId: 'choice', answers: ['B'] }] } : { decision: 'allow' };
      const [wrong] = await f.propose([action('chat.respond', { ...responseInput, ...wrongPayload })]);
      assert.equal((await resolve(f, wrong)).state, 'failed', `${type} must reject the wrong response type`);
    }
  }
}
async function persistenceAndUncertainty() {
  const f = make('persist'), unit = f.sessions[0];
  const [draft] = await f.propose([action('unit.pin', { sessionKey: unit.key, pinned: true })]);
  f.engine.dispose(); f.start();
  assert.equal((await resolve(f, draft)).state, 'completed');
  const [changed] = await f.propose([action('unit.pin', { sessionKey: unit.key, pinned: true })]);
  const file = path.join(directory, 'persist/centcom.json');
  const disk = JSON.parse(fs.readFileSync(file));
  disk.directives.find((d) => d.id === changed.id).params.input.pinned = false;
  f.engine.dispose(); fs.writeFileSync(file, JSON.stringify(disk)); f.start();
  assert.match((await resolve(f, changed)).error, /parameters or binding changed/);
  assert.equal(f.calls.filter((c) => c.operation === 'unit.pin').length, 1);
  const request = action('unit.send', { sessionKey: unit.key, text: 'Uncertain task' }, { id: 'stable-client-id' });
  const [uncertain] = await f.propose([request]);
  const wire = f.chats.request.bind(f.chats);
  f.chats.request = async (host, operation, args) => {
    const result = await wire(host, operation, args);
    if (operation === 'command' && args.command.sessionId === unit.chatSessionId && args.command.operation === 'send') throw new Error('Transport lost after dispatch');
    return result;
  };
  const outcome = await resolve(f, uncertain);
  assert.equal(outcome.state, 'uncertain'); assert.ok(outcome.result.commandId);
  assert.ok(f.engine.outcomes({ clientRequestId: 'stable-client-id' }).entries.some((e) => e.record?.state === 'uncertain'));
  const count = f.submitted.filter((c) => c.sessionId === unit.chatSessionId).length;
  f.engine.dispose(); f.start();
  f.responses.push(envelope({ directives: [request] })); await f.engine.submit('Retry same request');
  assert.equal(f.submitted.filter((c) => c.sessionId === unit.chatSessionId).length, count);
  const create = action('unit.create', { provider: 'codex', cwd: '/isolated/new-task' }, { id: 'default-host-create' });
  await f.propose([create]);
  await f.propose([create]);
  assert.equal(f.engine.state().directives.filter((d) => d.clientRequestId === 'default-host-create').length, 1);
  assert.ok(f.engine.outcomes({ clientRequestId: 'default-host-create' }).entries.some((e) => e.code === 'duplicate_request'));
}
async function serviceDispatchScope() {
  const service = createService({ directory: path.join(directory, 'real-service'), home: directory });
  try {
    const settings = service.store.data.settings;
    const scope = { mode: 'gated', commander: 'fixture', hosts: structuredClone(settings.hosts), roe: settings.roe, preset: settings.presets[0] };
    const context = { directive: { binding: { evidence: { authority: scope } } }, authority: () => ({ mode: 'gated', commander: 'fixture' }) };
    await mutationContext.run(context, async () => {
      assertDispatchScope(settings.hosts[0], { action: 'stop' }, settings);
      await Promise.resolve();
      await service.saveSettings({ ...settings, hosts: settings.hosts.map((host) => ({ ...host, target: 'changed.invalid' })) });
      // Exercise the actual service boundary: this must reject before spawning
      // SSH, so the regression needs no remote host or provider credentials.
      await assert.rejects(service.github({ hostId: settings.hosts[0].id, operation: 'ready', repo: 'fixture/repo', number: 1, headCommit: 'a'.repeat(40) }), /host route changed/);
      const changedPreset = { ...settings, presets: [{ ...settings.presets[0], fullPermissions: !settings.presets[0].fullPermissions }, ...settings.presets.slice(1)] };
      assert.throws(() => assertDispatchScope(settings.hosts[0], { action: 'create' }, changedPreset), /preset changed/);
    });
    const before = service.store.data.settings;
    const save = service.saveSettings({ ...before, notifications: true }, fingerprint(before));
    service.store.save('settings', { ...before, notifications: true });
    await assert.rejects(save, /changed before persistence/);
  } finally { service.centcom.dispose(); service.specops.dispose(); service.chats.closeAll(); }
  const f = make('late-route');
  const [draft] = await f.propose([action('unit.stop', { sessionKey: f.sessions[0].key })]);
  f.service.action = async () => {
    await Promise.resolve();
    f.state.settings.hosts[0].target = 'late-change.invalid';
    assertDispatchScope(f.state.settings.hosts[0], { action: 'stop' }, f.state.settings);
    assert.fail('Changed route reached mutation');
  };
  assert.equal((await resolve(f, draft)).state, 'failed');
  const [uncertain] = await f.propose([action('unit.pin', { sessionKey: f.sessions[0].key, pinned: true })]);
  f.service.setSessionPinned = () => { throw new Error('Persistence acknowledgement lost'); };
  assert.equal((await resolve(f, uncertain)).state, 'uncertain');
}
(async () => {
  try {
    for (const test of [changedIdentities, controllersAndRace, operationRevisions, structuredRequests, persistenceAndUncertainty, serviceDispatchScope]) await test();
    console.log('PASS reviewed identity, incarnation, authorization, request/revision/stage binding, control-acquisition races, persisted integrity, and uncertain retry deduplication');
  } finally { for (const f of fixtures) f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
