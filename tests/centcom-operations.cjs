const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperations } = require('../electron/centcom-operations.cjs');
const { Gateway } = require('../electron/gateway.cjs');
const { commanderFacade } = require('../electron/commander.cjs');
const { defaults } = require('../electron/centcom.cjs');
const { activeFleet } = require('../electron/centcom-fleet.cjs');
const { createEvidence } = require('../electron/centcom-evidence.cjs');
const { fixture, unit, envelope, action, query, desktop, phone, tick, until } = require('./fixtures/centcom.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-operations-'));
const fixtures = [];
function make(name, options) { const f = fixture(path.join(directory, name), options); fixtures.push(f); return f; }
const command = (sessionId, text = 'Assess fixture') => ({ protocolVersion: 1, commandId: crypto.randomUUID(), sessionId, operation: 'send', payload: { text } });
async function settle(f) { await until(() => !['running', 'starting'].includes(f.engine.state().status)); await tick(); }

async function visibility() {
  const f = make('visibility');
  await f.engine.start('Brief fleet');
  const commander = f.engine.state().session;
  const eligible = f.sessions.slice(0, 2);
  const invalidIdentity = { ...unit(900), id: 'external', key: 'alpha/tmux:external' };
  assert.equal(activeFleet({ hosts: f.hosts, sessions: [invalidIdentity] }).sessions.length, 0);
  for (const s of f.sessions) {
    f.faults.push({ sessionKey: s.key, status: 'review', detail: 'Fixture fault' });
    f.state.attention.push({ id: s.key, sessionKey: s.key, title: s.title, kind: 'input', confidence: 'confirmed', acknowledged: false });
    f.flash.push({ id: s.key, name: s.id, hostId: s.hostId, state: 'pending', connected: true });
  }
  f.missions.push({ id: 'mission', hostId: 'alpha', state: 'halted', visits: f.sessions.map((s) => ({ name: s.id, sessionId: s.chatSessionId, output: `Private evidence ${s.id}` })) });
  f.exercises.push({ id: 'exercise', hostId: 'alpha', state: 'running', contestants: f.sessions.map((s) => ({ id: s.id, name: s.id, transcript: `Private ${s.id}` })) });
  await f.engine.submit('Refresh');
  const snapshot = f.snapshot();
  assert.deepEqual(snapshot.units.map((s) => s.key), eligible.map((s) => s.key));
  assert.equal(snapshot.faults.length, 2);
  assert.equal(snapshot.attention.length, 2);
  assert.equal(snapshot.flashCount, 2);
  assert.equal(snapshot.specops[0].visits.length, 2);
  assert.equal(snapshot.exercises[0].contestants.length, 2);
  const evidence = JSON.stringify({ ...snapshot, outcomes: undefined });
  for (const s of f.sessions.slice(2)) for (const id of [s.key, s.id, s.chatSessionId]) assert.ok(!evidence.includes(id), `Excluded identity leaked: ${id}`);
  assert.ok(!evidence.includes(commander.chatSessionId));
  assert.equal(snapshot.capabilities.find((c) => c.operation === 'unit.send').parameters.sessionKey, 'string?');
  assert.ok(snapshot.capabilities.some((c) => c.operation === 'history.discover' && !c.available && c.unavailableReason));
  assert.ok(f.syncs[0].files['AGENTS.md'].includes('unit.delete'));
  assert.ok(f.syncs[0].files['AGENTS.md'].length <= 20000, 'Doctrine must fit the production chat create instruction limit');

  f.responses.push(envelope({ queries: [query('fleet.inspect'), query('unit.search', { query: 'fixture' }), query('unit.inspect', { sessionKey: f.sessions[2].key }), query('history.discover'), query('exercise.inspect', { id: 'exercise', contestantId: eligible[0].id })] }));
  await f.engine.submit('Inspect');
  const prompt = f.submitted.at(-1).payload.text;
  for (const s of f.sessions.slice(3).filter((s) => s.chatSessionId !== commander.chatSessionId)) for (const id of [s.key, s.id, s.chatSessionId]) assert.ok(!prompt.includes(id));
  assert.ok(prompt.includes(f.sessions[2].key), 'Inactive units remain inspectable without becoming action targets');
  assert.match(prompt, /Unavailable operation history.discover/);
  assert.match(prompt, /Only connected active managed sessions can be controlled/);
  assert.equal(f.calls.find((c) => c.operation === 'unit.search').args[1].length, 2);
  assert.equal(f.calls.find((c) => c.operation === 'exercise.inspect').args[2], false);

  f.responses.push(envelope({ queries: [query('specops.inspect', { id: 'mission' })] }));
  await f.engine.submit('Inspect current mission participants');
  const missionPrompt = f.submitted.at(-1).payload.text;
  assert.match(missionPrompt, /Private evidence/);
  for (const s of f.sessions.slice(2)) for (const id of [s.key, s.id, s.chatSessionId]) assert.ok(!missionPrompt.includes(id));

  const previous = f.engine.state().session;
  await f.engine.resetSession();
  const current = f.engine.state().session;
  assert.notEqual(current.name, previous.name);
  await f.engine.configure({ ...f.engine.state().config, model: 'fixture-other-model' });
  await f.engine.start('Fresh config conversation');
  const identities = JSON.parse(fs.readFileSync(path.join(directory, 'visibility/centcom.json'))).commanderIdentities;
  assert.equal(identities.length, 3);
  assert.ok(identities.some((s) => s.name === previous.name));
  assert.ok(identities.some((s) => s.name === current.name));
  assert.equal(f.snapshot().units.length, 2);
}

async function targetValidation() {
  const f = make('targets');
  await f.engine.start();
  const a = f.sessions[0], b = f.sessions[1];
  const cases = [
    action('unit.stop', { sessionKey: unit(999).key }),
    action('unit.stop', { sessionKey: a.key, name: b.id, hostId: 'alpha' }),
    action('unit.stop', { sessionKey: a.key, chatSessionId: b.chatSessionId }),
    action('unit.stop', { sessionKey: a.key, hostId: 'offline' }),
    action('unit.stop', {}),
    action('unit.stop', { sessionKey: a.key }, { preconditions: { sessionKey: b.key } }),
    action('unit.create', { provider: 'codex', conversationId: 'saved-history' }),
    action('does.not.exist', {}),
    action('unit.pin', { sessionKey: a.key, pinned: 'yes' }),
    action('unit.resume', {}),
  ];
  const records = await f.propose(cases);
  for (const d of records) {
    const result = await f.engine.decideDirective(d.id, 'approve');
    assert.equal(result.directives.find((r) => r.id === d.id).state, 'failed', d.summary);
  }
  assert.equal(f.calls.filter((c) => c.operation === 'unit.stop').length, 0);

  for (const change of ['deleted', 'disconnected', 'exited', 'identity']) {
    const [d] = await f.propose([action('unit.stop', { sessionKey: a.key })]);
    if (change === 'deleted') f.state.deletedSessions.push(a.key);
    if (change === 'disconnected') f.hosts[0].connected = false;
    if (change === 'exited') a.state = 'exited';
    if (change === 'identity') a.chatSessionId = b.chatSessionId;
    const result = await f.engine.decideDirective(d.id, 'approve');
    assert.equal(result.directives.find((r) => r.id === d.id).state, 'failed', change);
    f.state.deletedSessions = [f.sessions[3].key]; f.hosts[0].connected = true; a.state = 'live'; a.chatSessionId = unit(1).chatSessionId;
  }
  const control = f.service.commanderControl;
  const [racing] = await f.propose([action('unit.send', { sessionKey: a.key, text: 'Race task' })]);
  f.service.commanderControl = async (...args) => { f.hosts[0].connected = false; return control(...args); };
  const rejected = await f.engine.decideDirective(racing.id, 'approve');
  assert.equal(rejected.directives.find((d) => d.id === racing.id).state, 'failed');
  assert.ok(!f.submitted.some((c) => c.payload.text === 'Race task'));
  f.service.commanderControl = control; f.hosts[0].connected = true;

  // A migrated pending directive has no model-supplied preconditions. It must
  // still resolve a fresh target, and must never bypass the fleet boundary.
  const diskPath = path.join(directory, 'targets/centcom.json');
  const disk = JSON.parse(fs.readFileSync(diskPath));
  disk.directives.push({ id: 'legacy-pending', turnId: 'legacy-turn', kind: 'unit.stop', summary: 'Old proposal', params: { name: f.sessions[2].id, hostId: 'alpha' }, state: 'pending' });
  fs.writeFileSync(diskPath, JSON.stringify(disk));
  f.engine.dispose(); f.start();
  const result = await f.engine.decideDirective('legacy-pending', 'approve');
  assert.equal(result.directives.find((d) => d.id === 'legacy-pending').state, 'failed');
}

async function consoleIntegration() {
  const f = make('console');
  await f.engine.start();
  const session = f.engine.state().session;
  const handle = await f.chats.open(desktop, session.chatSessionId, 'alpha');
  await f.chats.take(desktop, handle);
  const send = command(session.chatSessionId);
  f.responses.push(envelope({ directives: [action('unit.stop', { sessionKey: f.sessions[0].key })] }));
  const [receipt, duplicate] = await Promise.all([f.chats.submit(desktop, handle, send), f.chats.submit(desktop, handle, send)]);
  assert.equal(receipt.commandId, send.commandId);
  assert.deepEqual(duplicate, receipt);
  await settle(f);
  assert.equal(f.engine.state().directives.length, 1);
  assert.equal(f.engine.state().directives[0].state, 'pending');
  assert.equal(f.submitted.filter((c) => c.commandId === send.commandId).length, 1);
  assert.equal(f.chats.state(desktop, handle).controller.id, desktop.id);
  const [d] = f.engine.state().directives;
  await f.engine.decideDirective(d.id, 'approve');
  assert.equal(f.calls.filter((c) => c.operation === 'unit.stop').length, 1);
  assert.match(f.submitted.at(-1).payload.text, /newly executed actions/);
  const count = f.submitted.length;
  await f.chats.submit(desktop, handle, send);
  assert.equal(f.submitted.length, count);
  await assert.rejects(f.chats.submit(desktop, handle, { ...send, payload: { text: 'Changed' } }), /different input/);
  assert.equal(f.chats.handles.size, 1, 'Every temporary commander/action handle must be released');

  // Ordinary chat behavior remains a direct worker submission.
  const worker = await f.chats.open(phone, f.sessions[0].chatSessionId, 'alpha');
  await f.chats.take(phone, worker);
  const ordinary = command(f.sessions[0].chatSessionId, 'Ordinary input');
  await f.chats.submit(phone, worker, ordinary);
  assert.equal(f.submitted.at(-1).payload.text, 'Ordinary input');

  // A worker receipt can acknowledge delivery without proving completion.
  const original = f.service.chatCommand;
  f.service.chatCommand = async (...args) => ({ ...(await original(...args)), state: 'unknown', result: null });
  const [uncertain] = await f.propose([action('unit.send', { sessionKey: f.sessions[0].key, text: 'Work task' })]);
  const result = await f.engine.decideDirective(uncertain.id, 'approve');
  assert.equal(result.directives.find((r) => r.id === uncertain.id).state, 'uncertain');
  assert.equal(result.directives.find((r) => r.id === uncertain.id).result.state, 'unknown');
  assert.equal(result.auditLog.find((r) => r.id === uncertain.id).outcome, 'uncertain');
  const receiptOutcome = f.engine.outcomes({ collection: 'directive', serverId: uncertain.id }).entries.at(-1);
  assert.equal(receiptOutcome.facts.submission, 'unknown');
  assert.equal(receiptOutcome.facts.providerTurnCompletion, 'unverified');
  assert.equal(receiptOutcome.facts.projectAcceptance, 'unverified');
  assert.equal(f.chats.state(phone, worker).controller.id, phone.id);
  f.service.chatCommand = original;

  const remote = f.chats.remote;
  f.chats.remote = async (host, request) => {
    const result = await remote(host, request);
    if (request.action === 'command' && request.command.sessionId === f.sessions[0].chatSessionId && request.command.operation === 'send') throw new Error('SSH acknowledgement lost');
    return result;
  };
  const [lost] = await f.propose([action('unit.send', { sessionKey: f.sessions[0].key, text: 'Lost acknowledgement task' })]);
  const lostResult = await f.engine.decideDirective(lost.id, 'approve');
  const lostRecord = lostResult.directives.find((d) => d.id === lost.id);
  assert.equal(lostRecord.state, 'uncertain');
  assert.ok(lostRecord.result.commandId);
  assert.equal(lostRecord.result.delivery, 'uncertain');
  assert.equal(f.submitted.filter((c) => c.commandId === lostRecord.result.commandId).length, 1);
  f.chats.remote = remote;

  // The companion gateway calls the same production submission boundary as IPC.
  const companion = await f.chats.open(phone, session.chatSessionId, 'alpha');
  await f.chats.take(phone, companion);
  const companionCommand = command(session.chatSessionId, 'Companion assessment');
  f.responses.push(envelope({ directives: [action('unit.pin', { sessionKey: f.sessions[0].key, pinned: true })] }));
  const rpc = () => Gateway.prototype.rpc.call({ service: { chats: f.chats } }, { client: phone }, { method: 'chat:submit', args: [companion, companionCommand] });
  assert.equal((await rpc()).commandId, companionCommand.commandId);
  await settle(f);
  const directives = f.engine.state().directives.length;
  await rpc();
  assert.equal(f.engine.state().directives.length, directives);
  assert.ok(f.engine.state().directives.some((d) => d.summary === 'unit.pin' && d.state === 'pending'));
  assert.equal(f.chats.state(phone, companion).controller.id, phone.id);

  // Restart retains deduplication and does not read old audit into a new turn.
  f.engine.dispose(); f.start();
  const restoredHandle = await f.chats.open(desktop, session.chatSessionId, 'alpha');
  await f.chats.take(desktop, restoredHandle);
  const before = f.submitted.length;
  assert.deepEqual(await f.chats.submit(desktop, restoredHandle, send), receipt);
  assert.equal(f.submitted.length, before);
}

async function cancellation() {
  for (const operation of ['interrupt', 'stop']) {
    const f = make(`cancel-${operation}`);
    await f.engine.start();
    await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
    const session = f.engine.state().session;
    const handle = await f.chats.open(desktop, session.chatSessionId, 'alpha'); await f.chats.take(desktop, handle);
    const release = f.gateReceipt();
    f.responses.push(envelope({ directives: [action('unit.stop', { sessionKey: f.sessions[0].key })] }));
    const send = command(session.chatSessionId);
    await f.chats.submit(desktop, handle, send);
    const cancel = { ...command(session.chatSessionId), operation, payload: {} };
    const receipt = await f.chats.submit(desktop, handle, cancel);
    assert.equal(receipt.commandId, cancel.commandId);
    release();
    await until(() => f.engine.state().status === 'halted'); await tick();
    assert.equal(f.engine.state().directives.length, 0, 'Cancellation fences directives from a completed-but-unprocessed envelope');
    assert.equal(f.calls.filter((c) => c.operation === 'unit.stop').length, 0);
    await until(() => f.chats.handles.size === 1);
    const finish = f.gateReceipt();
    await f.chats.submit(desktop, handle, command(session.chatSessionId, 'New turn after cancellation'));
    assert.equal(f.engine.state().status, 'running');
    assert.deepEqual(await f.chats.submit(desktop, handle, cancel), receipt);
    assert.equal(f.engine.state().status, 'running', 'Retrying an old cancellation cannot abort a later turn');
    finish(); await settle(f);

  }
}

async function authorityAndAlerts() {
  const f = make('authority');
  await f.engine.start();
  await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous', maxDirectivesPerTurn: 1 });
  await f.propose([action('unit.pin', { sessionKey: f.sessions[0].key, pinned: true }), action('unit.pin', { sessionKey: f.sessions[1].key, pinned: true })]);
  assert.equal(f.calls.filter((c) => c.operation === 'unit.pin').length, 1);
  assert.equal(f.engine.state().directives.filter((d) => d.state === 'pending').length, 1);
  assert.match(f.submitted.at(-1).payload.text, /action receipts/);
  assert.ok(f.engine.state().costUsd > 0);

  f.faults.push(...f.sessions.slice(2).map((s) => ({ sessionKey: s.key, status: 'review' })));
  const turns = f.engine.state().autoTurnsLastHour;
  await f.engine.observe(await f.service.inventory());
  assert.equal(f.engine.state().autoTurnsLastHour, turns, 'Excluded sessions cannot trigger wakes');
  f.faults.push({ sessionKey: f.sessions[0].key, status: 'review' });
  await f.engine.observe(await f.service.inventory());
  assert.equal(f.engine.state().autoTurnsLastHour, turns + 1);
  f.faults.push({ sessionKey: f.sessions[1].key, status: 'review' });
  await f.engine.observe(await f.service.inventory()); // queued during cooldown
  f.sessions[1].state = 'exited';
  const clock = Date.now;
  try {
    const now = clock(); Date.now = () => now + 61000;
    await f.engine.observe(await f.service.inventory());
    assert.equal(f.engine.state().autoTurnsLastHour, turns + 2, 'The stale fault is discarded, but the newly observed completion must wake CENTCOM');
    assert.match(f.submitted.at(-1).payload.text, /unit_transition/);
  } finally { Date.now = clock; }
  const alerts = make('flash-and-failure-alerts');
  await alerts.engine.start();
  alerts.flash.push({ id: 'live-flash', name: alerts.sessions[0].id, hostId: 'alpha', connected: true, state: 'pending' });
  await alerts.engine.observe(await alerts.service.inventory());
  assert.equal(alerts.engine.state().autoTurnsLastHour, 1);
  const at = Date.now;
  try {
    const now = at(); Date.now = () => now + 61000;
    alerts.state.attention.push({ id: 'failed-turn', sessionKey: alerts.sessions[0].key, kind: 'failed', confidence: 'confirmed', acknowledged: false });
    await alerts.engine.observe(await alerts.service.inventory());
    assert.equal(alerts.engine.state().autoTurnsLastHour, 2, 'A failed turn on a still-live managed unit remains eligible');
  } finally { Date.now = at; }

  await f.engine.configure({ ...f.engine.state().config, maxBudgetUsd: f.engine.state().costUsd });
  const before = f.submitted.length;
  await assert.rejects(f.engine.submit('Over budget'), /budget limit/);
  assert.equal(f.submitted.length, before);
}

async function catalogCoverage() {
  const f = make('catalog');
  const fleet = async () => activeFleet(await f.service.inventory(), f.state.deletedSessions);
  const registry = createOperations({ service: f.service, client: { id: 'centcom-commander' },
    control: (u, fn) => f.service.commanderControl({ id: 'centcom-commander' }, u, fn),
    resolve: async (entry) => entry.target === 'sessions' ? [f.sessions[0]] : f.sessions[0], fleet,
    evidence: createEvidence({ service: f.service, isCommander: () => false, activeKeys: async () => (await fleet()).keys }),
    applyAutomation: async () => ({ applied: true }), readOutcomes: () => f.engine.outcomes(), manifest: () => f.engine.manifest(),
    automations: { validate: () => ({}), preview: () => ({}), read: () => ({}) },
  });
  const catalog = registry.catalog();
  for (const entry of catalog) {
    const definition = registry.definition(entry.operation);
    assert.ok(typeof definition.handler === 'function' || entry.unavailableReason, entry.operation);
    assert.equal(entry.classification, /^(automation\.(validate|preview|read)|units.list|hosts.inspect|context.read|admission.check|artifact.read|capabilities\.(read|support)|outcomes.read|unit\.(inspect|search)|fleet\.|flash.list|specops\.(definition|inspect)|exercise\.(list|inspect|preview)|worktree.list|diff\.(files|detail)|sitrep.inspect|configuration.inspect|oporder.preview|github\.(readiness|issue|issues|pr)|devurl.list|history.discover)/.test(entry.operation) ? 'query' : 'action', entry.operation);
    if (!entry.available) { await assert.rejects(registry.execute(entry.operation, {}, entry.classification), /Unavailable operation/); continue; }
    const p = {};
    for (const [key, type] of Object.entries(definition.parameters)) {
      if (type.endsWith('?')) continue;
      p[key] = type === 'string' ? 'fixture' : type === 'boolean' ? true : type === 'number' ? 1 : type === 'array' ? [] : type === 'nullable' ? null : {};
    }
    if (entry.operation === 'context.read') p.section = 'presets';
    if (entry.operation === 'capabilities.support') p.operation = 'unit.send';
    if (entry.operation === 'artifact.read') { p.operationId = 'a'.repeat(32); p.path = 'report.txt'; }
    if (entry.operation === 'unit.inspect') p.sessionKey = f.sessions[0].key;
    if (entry.target === 'session') p.sessionKey = f.sessions[0].key;
    if ('hostId' in p) p.hostId = 'alpha';
    if ('provider' in p) p.provider = 'codex';
    if ('action' in p) p.action = entry.operation === 'specops.control' ? 'resume' : 'retry';
    if (entry.operation === 'chat.respond') p.decision = 'allow';
    if (entry.operation === 'flash.decide') p.decision = 'allow';
    if (entry.operation === 'exercise.create') p.contestants = [{ provider: 'codex' }, { provider: 'claude' }];
    if (entry.operation === 'diff.hunk') p.operation = 'stage';
    if (entry.operation === 'sitrep.handoff') { p.operationId = 'a'.repeat(32); p.slug = 'fixture'; }
    if (entry.operation.startsWith('oporder.')) { p.order = { version: 1, id: 'fixture', hostId: 'alpha', repository: '/repo' }; if (p.revision) p.revision = 'a'.repeat(64); }
    if (entry.operation.startsWith('automation.') && p.kind) { p.kind = 'centcom_trigger'; p.payload = { fallbackSeconds: 600 }; }
    if (entry.operation.startsWith('github.')) { p.repo = 'fixture/repo'; p.issue = 1; p.number = 1; p.headCommit = 'a'.repeat(40); p.repository = '/repo'; p.updatedAt = '2026-01-01'; p.evidence = { commit: 'a'.repeat(40), summary: 'Verified fixture evidence' }; }
    if (entry.operation === 'sitrep.inspect') p.testCommand = '';
    if (entry.operation === 'attention.acknowledge') f.state.attention.push({ id: p.id, sessionKey: f.sessions[0].key });
    await registry.execute(entry.operation, p, entry.classification);
  }
  await assert.rejects(registry.execute('configuration.save', { settings: { cleanup: [] } }, 'action'), /unknown field cleanup/);
  await assert.rejects(registry.execute('exercise.verify', {}, 'query'), /is an action/);
  await assert.rejects(registry.execute('sitrep.inspect', { operationId: 'fixture', sourceHostId: 'alpha', targetHostId: 'alpha', repository: '/tmp', testCommand: 'npm test', sessionKey: f.sessions[0].key }, 'query'), /sitrep.inspect.testCommand/);
  assert.equal(f.chats.handles.size, 0);
}

async function terminalControl() {
  const commander = { id: 'centcom-commander' };
  const u = unit(20, { transport: 'terminal' });
  const record = { owner: desktop, handles: new Set(['desktop-view']) };
  const views = { sessions: new Map([[`${u.hostId}/${u.id}`, record]]), handles: new Map([['desktop-view', { client: desktop, record }]]),
    async open(client) { this.handles.set('temporary', { client, record }); record.handles.add('temporary'); return 'temporary'; },
    get(client, id) { const value = this.handles.get(id); assert.equal(value.client.id, client.id); return value; },
    async take(client, _id, captureOwner) { captureOwner?.(record.owner); record.owner = client; }, publish() {},
    close(_client, id) { this.handles.delete(id); record.handles.delete(id); },
    async write(client, _id, data) { assert.equal(record.owner.id, client.id); assert.equal(data, 'Run fixture\r'); },
  };
  const facade = commanderFacade({ chats: {}, terminals: views });
  const result = await facade.commanderControl(commander, u, (handle) => facade.terminalInput(commander, handle, 'Run fixture'));
  assert.deepEqual(result, { delivery: 'terminal_input_written', taskCompletion: 'unverified' });
  assert.equal(record.owner.id, desktop.id); assert.equal(views.handles.size, 1);
  await assert.rejects(facade.commanderControl(commander, u, () => { throw new Error('Delivery failed'); }), /Delivery failed/);
  assert.equal(record.owner.id, desktop.id); assert.equal(views.handles.size, 1);
  await facade.commanderControl(commander, u, () => { record.owner = phone; });
  assert.equal(record.owner.id, phone.id, 'A later controller must not be overwritten on release');
  record.owner = desktop;
  views.handles.set('phone-view', { client: phone, record }); record.handles.add('phone-view');
  const open = views.open;
  views.open = async (...args) => { const handle = await open.apply(views, args); record.owner = phone; return handle; };
  await facade.commanderControl(commander, u, () => {});
  assert.equal(record.owner.id, phone.id, 'Restore the controller observed at acquisition, including a takeover while opening');
}

async function migration() {
  const target = path.join(directory, 'migration'); fs.mkdirSync(target);
  const old = unit(44), audit = [{ id: 'audit', summary: 'Historical audit retained' }], proposals = [{ id: 'proposal', state: 'proposed' }];
  fs.writeFileSync(path.join(target, 'centcom.json'), JSON.stringify({ version: 1, config: defaults('alpha'), session: { ...old, name: old.id, provider: 'codex', model: defaults().model }, costUsd: 2, auditLog: audit, directives: [], automations: proposals }));
  const f = fixture(target); fixtures.push(f); f.sessions.push(old);
  assert.equal(f.engine.state().session, null);
  assert.deepEqual(f.engine.state().auditLog, audit);
  assert.deepEqual(f.engine.state().automations, proposals);
  assert.equal(f.engine.state().costUsd, 2);
  await f.engine.start();
  assert.notEqual(f.engine.state().session.name, old.id);
  assert.ok(!JSON.stringify(f.snapshot()).includes(old.chatSessionId));
  assert.ok(!f.submitted.at(-1).payload.text.includes('Historical audit retained'));
  const current = f.engine.state().session;
  f.engine.dispose(); f.start();
  await f.engine.start();
  assert.equal(f.engine.state().session.name, current.name, 'Context revision resets once');
  assert.equal(f.calls.filter((c) => c.operation === 'create').length, 1);
}

async function contractOutcomes() {
  const f = make('contract-outcomes');
  await f.engine.start();
  const request = action('unit.pin', { sessionKey: f.sessions[0].key, pinned: true }, { id: 'pin-worker' });
  f.responses.push(envelope({ queries: [{ ...query('fleet.inspect'), id: 'inspect-fleet' }], directives: [request] }));
  await f.engine.submit('Mixed envelope');
  const [staged] = f.engine.state().directives;
  assert.equal(staged.state, 'pending');
  assert.equal(staged.clientRequestId, request.id);
  assert.equal(f.calls.filter((c) => c.operation === 'unit.pin').length, 0);
  f.responses.push(envelope({ directives: [request, { ...request, params: { operation: 'unit.pin', input: { sessionKey: f.sessions[0].key, pinned: false } } }] }));
  await f.engine.submit('Retry same ID and conflict');
  assert.equal(f.engine.state().directives.length, 1);
  assert.ok(f.engine.outcomes({ collection: 'diagnostic' }).entries.some((r) => r.code === 'duplicate_request'));
  assert.ok(f.engine.outcomes({ collection: 'diagnostic' }).entries.some((r) => r.code === 'request_id_conflict'));
  await f.engine.decideDirective(staged.id, 'deny');
  assert.match(f.submitted.at(-1).payload.text, /denied/);
  const denied = f.engine.outcomes({ clientRequestId: request.id }).entries;
  assert.ok(denied.some((r) => r.record?.state === 'denied'));
  const approval = f.engine.outcomes({ collection: 'approval', clientRequestId: request.id }).entries;
  assert.equal(approval.at(-1).status, 'denied');
  assert.equal(approval.at(-1).serverId, staged.id);
  const firstPage = f.engine.outcomes({ limit: 1 });
  const secondPage = f.engine.outcomes({ after: firstPage.cursor, limit: 1 });
  assert.ok(secondPage.cursor > firstPage.cursor);
  assert.throws(() => f.engine.outcomes({ limit: 1000 }), /Invalid outcome/);

  f.responses.push('```agentc2-c2\n{bad JSON}\n```');
  await f.engine.submit('Malformed envelope');
  assert.match(f.submitted.at(-1).payload.text, /malformed_envelope/);
  f.responses.push(envelope({ queries: Array.from({ length: 7 }, (_, i) => ({ ...query('fleet.inspect'), id: `q${i}` })), automations: [{ id: 'bad-auto', kind: 'specops', payload: {} }], directives: [null] }));
  await f.engine.submit('Explicit invalid and excess requests');
  const diagnostics = f.engine.outcomes({ collection: 'diagnostic', limit: 50 }).entries;
  for (const code of ['invalid_request', 'invalid_automation', 'over_limit']) assert.ok(diagnostics.some((r) => r.code === code), code);
  assert.ok(diagnostics.some((r) => r.code === 'over_limit' && r.clientRequestId === 'q6'));
  for (const entry of diagnostics) {
    assert.match(entry.outcomeId, /^[a-f0-9-]{36}$/);
    assert.match(entry.serverId, /^[a-f0-9-]{36}$/);
    assert.ok(entry.status);
  }
  const diagnosticIds = diagnostics.map((r) => r.outcomeId);
  assert.equal(new Set(diagnosticIds).size, diagnosticIds.length);
  const successfulQuery = f.engine.outcomes({ collection: 'query', clientRequestId: 'inspect-fleet' }).entries;
  assert.equal(successfulQuery.at(-1).status, 'ok');
  assert.equal(successfulQuery[0].status, 'running');
  assert.equal(successfulQuery[0].serverId, successfulQuery.at(-1).serverId);
  assert.ok(successfulQuery.at(-1).turnId);

  f.responses.push(envelope({ queries: [{ ...query('history.discover'), id: 'unsupported-query' }, { ...query('invented.operation'), id: 'unknown-query' },
    { id: 'ambiguous-kind', kind: 'fleet.inspect', type: 'history.discover' }], directives: [action('unit.resume', {}, { id: 'unsupported-directive' })] }));
  await f.engine.submit('Unsupported and ambiguous requests');
  assert.equal(f.engine.outcomes({ clientRequestId: 'unsupported-query' }).entries.at(-1).code, 'unsupported_operation');
  assert.equal(f.engine.outcomes({ clientRequestId: 'unknown-query' }).entries.at(-1).code, 'unknown_operation');
  assert.equal(f.engine.outcomes({ clientRequestId: 'ambiguous-kind' }).entries.at(-1).code, 'invalid_request');
  assert.ok(f.engine.outcomes({ clientRequestId: 'unsupported-directive' }).entries.some((r) => r.code === 'unsupported_operation'));

  for (let i = 0; i < 4; i++) f.responses.push(envelope({ queries: [{ ...query('fleet.inspect'), id: `hop-${i}` }] }));
  await f.engine.submit('Exhaust query hops');
  assert.ok(f.engine.outcomes({ collection: 'diagnostic', limit: 50 }).entries.some((r) => r.code === 'hop_limit' && r.clientRequestId === 'hop-3'));
  const outcomes = f.engine.outcomes({ clientRequestId: request.id });
  f.engine.dispose(); f.start();
  assert.deepEqual(f.engine.outcomes({ clientRequestId: request.id }), outcomes);
  assert.deepEqual(f.engine.outcomes({ collection: 'query', clientRequestId: 'inspect-fleet' }).entries, successfulQuery);
  f.responses.push(envelope({ directives: [request] }));
  await f.engine.submit('Retry after restart');
  assert.equal(f.engine.state().directives.filter((d) => d.clientRequestId === request.id).length, 1);
}

async function boundedOutcomeHistory() {
  const f = make('bounded-outcomes');
  await f.engine.start();
  f.service.setSessionPinned = async () => ({ text: 'x'.repeat(60000), password: 'do-not-persist-in-history' });
  const drafts = await f.propose(Array.from({ length: 12 }, (_, i) => action('unit.pin', { sessionKey: f.sessions[0].key, pinned: true }, { id: `large-${i}` })));
  await f.engine.decideAllDirectives('approve');
  let page = f.engine.outcomes({ collection: 'directive', limit: 50 });
  const observed = [];
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64000);
    observed.push(...page.entries);
    if (!page.hasMore) break;
    page = f.engine.outcomes({ collection: 'directive', limit: 50, after: page.cursor });
  } while (true);
  for (const draft of drafts) {
    const final = observed.filter((e) => e.serverId === draft.id).at(-1);
    assert.equal(final.status, 'completed', 'Status must survive a result larger than the record limit');
    assert.equal(final.facts.projectAcceptance, 'unverified');
    assert.equal(final.record.truncated, true);
  }
  assert.ok(!JSON.stringify(observed).includes('do-not-persist-in-history'));
  const assessment = f.submitted.at(-1).payload.text;
  const receipts = JSON.parse(assessment.match(/<agentc2-c2-results>\n([\s\S]*?)\n<\/agentc2-c2-results>/)[1]);
  assert.equal(receipts.length, 12);
  assert.ok(receipts.every((r) => r.status === 'completed' && r.clientRequestId && r.serverId));

  f.responses.push(envelope({ queries: [{ ...query('outcomes.read', { collection: 'directive', limit: 50 }), id: 'read-large-history' }] }));
  await f.engine.submit('Read large results');
  const read = f.engine.outcomes({ collection: 'query', clientRequestId: 'read-large-history' }).entries.at(-1);
  assert.equal(read.status, 'ok');
  assert.ok(read.result.entries.length);
  assert.ok(read.result.entries.every((e) => e.status && e.serverId && e.outcomeId));
  assert.equal(read.result.hasMore, true);
  assert.equal(read.result.cursor, read.result.entries.at(-1).sequence);
  assert.ok(Buffer.byteLength(JSON.stringify(read.result)) < 12000);

  f.engine.dispose();
  const file = path.join(directory, 'bounded-outcomes/centcom.json');
  const saved = JSON.parse(fs.readFileSync(file));
  const last = { ...read, outcomeId: crypto.randomUUID(), serverId: crypto.randomUUID(), clientRequestId: 'crashed-query', status: 'running', sequence: ++saved.outcomeSequence };
  delete last.result;
  saved.outcomes.push(last);
  fs.writeFileSync(file, JSON.stringify(saved));
  f.start();
  const recovered = f.engine.outcomes({ clientRequestId: 'crashed-query' });
  assert.equal(recovered.entries.at(-1).status, 'uncertain');
  assert.equal(recovered.entries.at(-1).code, 'query_interrupted');
  assert.equal(recovered.entries.at(-1).serverId, last.serverId);
  f.engine.dispose(); f.start();
  assert.deepEqual(f.engine.outcomes({ clientRequestId: 'crashed-query' }), recovered);
}

async function reviewedAutomationReadback() {
  const f = make('automation-readback');
  await f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
  await f.engine.start();
  f.responses.push(envelope({ directives: [action('configuration.save', { settings: { presets: [] } }, { id: 'permanent-config' })] }));
  await f.engine.submit('Propose permanent change');
  assert.equal(f.engine.state().directives[0].state, 'pending');
  assert.ok(!f.calls.some((c) => c.operation === 'configuration.save'));
  f.responses.push(envelope({ automations: [{ id: 'preset-1', kind: 'preset', title: 'Reusable preset', rationale: 'Observed repeated launch arguments', evidence: ['observed actions'], payload: { id: 'fixture-preset', name: 'Fixture', provider: 'codex', command: 'codex' } }] }));
  await f.engine.submit('Save draft');
  const [auto] = f.engine.state().automations;
  assert.throws(() => f.engine.applyAutomation(auto.id, 'yes'), /Invalid automation decision/);
  assert.ok(!f.calls.some((c) => c.operation === 'configuration.save'));
  // A persistence adapter that returns without saving must never claim applied.
  await f.engine.applyAutomation(auto.id, 'apply');
  assert.equal(f.engine.state().automations[0].state, 'uncertain');
  assert.match(f.engine.state().automations[0].error, /readback/);
  f.service.store.file = path.join(directory, 'automation-readback', 'workspace.json');
  f.service.saveSettings = async (settings) => { f.state.settings = settings; fs.writeFileSync(f.service.store.file, JSON.stringify({ settings })); return settings; };
  f.responses.push(envelope({ automations: [{ id: 'preset-2', kind: 'preset', title: 'Saved preset', rationale: 'Verified repetitive task', payload: { id: 'saved-preset', name: 'Saved', provider: 'codex', command: 'codex' } }] }));
  await f.engine.submit('Save a second draft');
  await f.engine.applyAutomation(f.engine.state().automations[0].id, 'apply');
  const saved = f.engine.state().automations[0];
  assert.equal(saved.state, 'applied');
  assert.equal(saved.result.artifact.id, 'saved-preset');
  assert.match(saved.result.revision, /^[a-f0-9]{64}$/);
  assert.ok(f.engine.outcomes({ collection: 'automation', clientRequestId: 'preset-2' }).entries.some((r) => r.record?.state === 'applied'));
}

async function unknownSpend() {
  const f = make('unknown-spend');
  const remote = f.chats.remote;
  f.chats.remote = async (...args) => {
    const result = await remote(...args);
    if (args[1].action === 'history') for (const ev of result.events) if (ev.type === 'usage.updated') ev.data.costUsd = null;
    return result;
  };
  await f.engine.start();
  assert.equal(f.engine.state().costKnown, false);
  assert.equal(f.engine.state().costUsd, 0);
  assert.equal(f.engine.manifest().spend.coverage, 'incomplete');
  assert.match(f.engine.manifest().spend.budgetPolicy, /unknown spend is not zero/);
  f.chats.remote = remote;
  await f.engine.submit('Known cost after unknown cost');
  assert.equal(f.engine.state().costKnown, false);
  assert.equal(f.engine.state().costUsd, 0.01);
}

async function durableWakeups() {
  let now = Date.now();
  const callbacks = new Map(); let timerId = 0;
  const timers = { now: () => now, setTimeout(fn, delay) { const id = ++timerId; callbacks.set(id, { fn, due: now + delay }); return id; }, clearTimeout(id) { callbacks.delete(id); } };
  const advance = async (ms) => {
    now += ms;
    for (const [id, timer] of [...callbacks]) if (timer.due <= now) { callbacks.delete(id); timer.fn(); }
    await tick();
  };
  const f = make('durable-wakeups', { timers });
  await f.engine.start();
  const release = f.gateReceipt();
  const active = f.engine.submit('Busy assessment');
  await until(() => f.engine.state().status === 'running');
  f.flash.push({ id: 'during-turn', name: f.sessions[0].id, hostId: 'alpha', connected: true, state: 'pending' });
  await f.engine.observe(await f.service.inventory());
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'durable-wakeups/centcom.json')));
  assert.ok(persisted.pendingAlerts.some((r) => r.id === 'during-turn'));
  release(); await active; await advance(0);
  await until(() => f.engine.state().autoTurnsLastHour === 1); await settle(f);
  f.flash.push({ id: 'last-event', name: f.sessions[1].id, hostId: 'alpha', connected: true, state: 'pending' });
  await f.engine.observe(await f.service.inventory());
  assert.equal(f.engine.state().autoTurnsLastHour, 1);
  f.engine.dispose(); f.start(); // Cooldown and event survive restart.
  await advance(60001);
  await until(() => f.engine.state().autoTurnsLastHour === 2); await settle(f);
  await f.engine.observe(await f.service.inventory());
  await advance(60001); await tick();
  assert.equal(f.engine.state().autoTurnsLastHour, 2, 'Replayed requests must not wake again');
  // Completion of an observed unit can wake even after it leaves active control.
  f.sessions[0].state = 'exited';
  await f.engine.observe(await f.service.inventory());
  assert.equal(f.engine.state().autoTurnsLastHour, 3);
  assert.match(f.submitted.at(-1).payload.text, /taskAcceptance/);
  await advance(600001);
  await until(() => f.engine.state().autoTurnsLastHour === 4); await settle(f);
  assert.match(f.submitted.at(-1).payload.text, /Scheduled status check/);
  await f.engine.configure({ ...f.engine.state().config, triggers: { ...f.engine.state().config.triggers, fallbackSeconds: 0 } });
  await advance(600001); await tick();
  assert.equal(f.engine.state().autoTurnsLastHour, 4);
  const worker = { hostId: 'alpha', sessionId: f.sessions[1].chatSessionId };
  const question = { sequence: 42, type: 'question.requested', turnId: 'worker-turn', data: { requestId: 'question-42', text: 'Need a choice', token: 'private-value' } };
  await f.engine.observeChat(worker, [question]); await advance(0);
  await until(() => f.engine.state().autoTurnsLastHour === 5); await settle(f);
  assert.match(f.submitted.at(-1).payload.text, /question-42/);
  assert.ok(!f.submitted.at(-1).payload.text.includes('private-value'));
  await f.engine.observeChat(worker, [question]);
  await f.engine.observeChat({ hostId: 'alpha', sessionId: f.engine.state().session.chatSessionId }, [{ ...question, sequence: 43 }]);
  await advance(60001); await tick();
  assert.equal(f.engine.state().autoTurnsLastHour, 5, 'Replay and commander events cannot recursively wake CENTCOM');
  f.missions.push({ id: 'linked-mission', hostId: 'alpha', state: 'running', stage: 'build', visits: [{ name: f.sessions[1].id }], dependencies: ['build-artifact'] });
  await f.engine.observe(await f.service.inventory());
  f.missions[0].stage = 'verify';
  f.missions[0].dependencies = [];
  await f.engine.observe(await f.service.inventory());
  assert.equal(f.engine.state().autoTurnsLastHour, 6);
  assert.match(f.submitted.at(-1).payload.text, /dependency/);
  // A complete turn between inventory polls may be idle in both snapshots.
  await advance(60001);
  f.state.attention.push({ id: 'between-polls', sessionKey: f.sessions[1].key, kind: 'completed', confidence: 'confirmed', acknowledged: false });
  await f.engine.observe(await f.service.inventory());
  assert.equal(f.engine.state().autoTurnsLastHour, 7);
  assert.match(f.submitted.at(-1).payload.text, /between-polls/);
}

(async () => {
  try {
    for (const test of [visibility, targetValidation, consoleIntegration, cancellation, authorityAndAlerts, catalogCoverage, terminalControl, migration, contractOutcomes, boundedOutcomeHistory, reviewedAutomationReadback, unknownSpend, durableWakeups]) { console.log('RUN', test.name); await test(); }
    console.log('PASS CENTCOM active boundary, nested evidence, fresh targets, catalog handlers, control restoration, console receipts/deduplication, cancellation, authority, alerts, and migration');
  } finally { for (const f of fixtures) f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
