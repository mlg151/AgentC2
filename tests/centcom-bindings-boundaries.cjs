const assert = require('node:assert/strict');
const { createBindings, identity, validatePreconditions, reviewSummary } = require('../electron/centcom-bindings.cjs');
const { fingerprint } = require('../electron/centcom-contract.cjs');

function fixture(operation = 'unit.stop', target = 'unit') {
  const unit = { key: 'alpha/tmux:fixture', hostId: 'alpha', id: 'fixture', chatSessionId: 'chat-' + 'a'.repeat(32), providerSessionId: 'native', processId: '100', startedAt: '2026-10-22T00:00:00Z', provider: 'codex', cwd: '/fixture', transport: 'chat', headCommit: 'a'.repeat(40) };
  const settings = { hosts: [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }], presets: [{ id: 'preset', name: 'Reviewed preset' }], roe: null };
  const state = { config: { authority: 'gated', hostId: 'alpha' }, session: { chatSessionId: 'commander' }, automations: [], coordination: [], outcomes: [] };
  const inspection = { ownership: { controller: { id: 'desktop' } }, capabilities: { status: 'supported', approvals: true, questions: true }, journal: { events: [{ turnId: 'turn' }, { turnId: null }] }, pendingRequests: [] };
  const missions = [{ id: 'mission', hostId: 'alpha', stage: 'plan', state: 'halted', workflow: { id: 'reviewed' }, visits: [{ id: 'visit', stage: 'plan', name: 'fixture', sessionId: unit.chatSessionId }] }];
  const exercises = [{ id: 'exercise', hostId: 'alpha', state: 'ready', contestants: [{ presetId: 'preset' }, { presetId: 'missing' }] }];
  const service = { store: { data: { settings } }, commanderInspection: async () => inspection, specops: { list: () => missions, definition: () => ({ profiles: [], workflows: [] }) }, exercises: { list: () => exercises }, flashQueue: async () => [], loopBreaker: { faults: () => [] }, previewOpOrder: async () => ({ ready: true, revision: 'reviewed' }), sitrepSource: () => ({ sourceHostId: 'alpha', targetHostId: 'beta', revision: 'reviewed' }), worktrees: async () => [] };
  let resolved = target === 'none' ? null : unit;
  const entry = { operation, target };
  const directive = { preconditions: {}, input: { sessionKey: unit.key } };
  const bindings = createBindings({ service, state, resolve: async () => resolved, request: () => ({ entry, input: directive.input }) });
  const bind = async () => directive.binding = await bindings.bind(directive, entry, directive.input);
  return { unit, settings, state, inspection, service, missions, exercises, entry, directive, bindings, bind, resolve: (value) => { resolved = value; } };
}
async function rejects(f, pattern) { await assert.rejects(f.bind(), pattern); }
async function snapshot(f) { return (await f.bind()).evidence; }

async function primitives() {
  for (const value of [null, [], { unexpected: 'x' }, { processId: '' }, { processId: 1 }, { revision: 'bad\0revision' }, { startedAt: 'x'.repeat(1001) }]) assert.throws(() => validatePreconditions(value));
  validatePreconditions({ sessionKey: 'host/unit', processId: '100', startedAt: 'now', turnId: 'turn', revision: 'rev', state: 'live', stage: 'plan' });
  const terminal = { key: 'key', name: 'legacy-name', startedAt: 'now', processId: '100' };
  assert.equal(identity(terminal).name, 'legacy-name'); assert.equal(identity(terminal).transport, 'terminal');
  assert.equal(identity({ ...terminal, processId: null, chatSessionId: 'chat-' + 'a'.repeat(32) }).transport, 'chat');
  assert.equal(identity(terminal).providerSessionId, null);
  assert.throws(() => identity({ ...terminal, processId: null }), /incarnation is unknown/);
  assert.throws(() => identity({ ...terminal, startedAt: '' }), /incarnation is unknown/);
  for (const binding of [undefined, {}, { evidence: { targets: {} } }]) assert.equal(reviewSummary(binding), null);
  const f = fixture('unit.create', 'none');
  f.directive.preconditions = { sessionKey: 'non-unit metadata' };
  assert.deepEqual((await snapshot(f)).targets, []);
  f.directive.preconditions = { state: 'live' }; await rejects(f, /does not apply/);
  f.resolve([{ ...f.unit, key: 'beta/tmux:second', hostId: 'beta', id: 'second' }, f.unit]);
  f.directive.preconditions = {}; assert.deepEqual((await snapshot(f)).targets.map((target) => target.identity.key), ['alpha/tmux:fixture', 'beta/tmux:second']);
  f.resolve(f.unit); f.directive.preconditions = { stage: 'plan' }; await rejects(f, /Stage precondition/);
}

async function identitiesAndRequests() {
  const noHead = fixture('diff.hunk'); delete noHead.unit.headCommit; noHead.unit.branch = 'reviewed branch';
  assert.deepEqual((await snapshot(noHead)).targets[0].revision, { branch: 'reviewed branch', headCommit: null });
  const f = fixture('diff.hunk');
  for (const [preconditions, message] of [[{ startedAt: 'changed' }, /startedAt changed/], [{ revision: 'changed' }, /revision changed/], [{ turnId: 'changed' }, /turn identity changed/]]) {
    f.directive.preconditions = preconditions; await rejects(f, message);
  }
  f.directive.input.revision = 'reviewed snapshot';
  f.directive.preconditions = { revision: 'reviewed snapshot', processId: '100', startedAt: f.unit.startedAt, turnId: 'turn' };
  let evidence = await snapshot(f);
  assert.deepEqual(evidence.targets[0].revision, { branch: null, headCommit: f.unit.headCommit });
  assert.equal(evidence.targets[0].turnId, 'turn');
  assert.ok(reviewSummary(f.directive.binding).targets[0].revision);
  f.inspection.ownership.controller.id = 'commander';
  await f.bindings.assert(f.directive, { key: f.unit.key, previousControllerId: 'desktop' });
  await assert.rejects(f.bindings.assert(f.directive, { key: 'another', previousControllerId: 'desktop' }), /evidence changed/);
  const noMetadata = fixture(); noMetadata.inspection.ownership = undefined; noMetadata.inspection.capabilities = undefined; noMetadata.inspection.journal = undefined;
  evidence = await snapshot(noMetadata); assert.equal(evidence.targets[0].controller, null); assert.equal(evidence.targets[0].capabilities, null);
  const steering = fixture('unit.steer'); steering.directive.input.expectedTurnId = 'changed'; await rejects(steering, /Steering target turn changed/);
  steering.directive.input.expectedTurnId = 'turn'; assert.equal((await snapshot(steering)).targets[0].turnId, 'turn');
  steering.inspection.journal = {}; await rejects(steering, /Steering target turn changed/);

  const r = fixture('chat.respond');
  r.directive.input = { requestId: 'request', turnId: 'turn', itemId: 'tool', decision: 'deny' };
  const pending = { requestId: 'request', turnId: 'turn', itemId: 'tool', type: 'approval.requested', state: 'pending' };
  r.unit.transport = 'terminal'; await rejects(r, /structured chat/); r.unit.transport = 'chat';
  r.inspection.pendingRequests = undefined; await rejects(r, /no longer pending/);
  for (const change of [{ requestId: 'other' }, { state: 'resolved' }, { turnId: 'other' }, { itemId: 'other' }]) {
    r.inspection.pendingRequests = [{ ...pending, ...change }]; await rejects(r, /identity changed/);
  }
  r.inspection.pendingRequests = [pending];
  for (const capabilities of [undefined, { status: 'unsupported' }, { status: 'supported', approvals: false }]) {
    r.inspection.capabilities = capabilities; await rejects(r, /does not support/);
  }
  r.inspection.capabilities = { status: 'supported', approvals: true, questions: true };
  assert.deepEqual((await snapshot(r)).requestEvidence, pending);
  pending.type = 'question.requested'; await rejects(r, /does not match/);
  r.directive.input = { requestId: 'request', turnId: 'turn', itemId: 'tool', answers: [{ questionId: 'choice', answers: ['A'] }] };
  assert.equal((await snapshot(r)).requestEvidence.type, 'question.requested');
  pending.type = 'approval'; await rejects(r, /does not match/);
  pending.type = 'unsupported'; await rejects(r, /Unsupported pending/);
}

async function operations() {
  const automation = fixture('automation.apply', 'none');
  automation.directive.input = { id: 'automation' };
  await rejects(automation, /no longer proposed/);
  const draft = { id: 'automation', kind: 'oporder', state: 'proposed', payload: { order: { hostId: 'beta' } }, preview: { revision: 'reviewed' } };
  automation.state.automations.push({ id: 'other' }, draft);
  assert.deepEqual((await snapshot(automation)).authority.hosts.map((host) => host.id), ['beta']);
  draft.state = 'applied'; await rejects(automation, /no longer proposed/);

  const mission = fixture('specops.control', 'mission'); mission.directive.input = { id: 'mission' };
  for (const preconditions of [{ stage: 'changed' }, { state: 'changed' }]) { mission.directive.preconditions = preconditions; await rejects(mission, /Mission .* changed/); }
  mission.directive.preconditions = { stage: 'plan', state: 'halted' };
  assert.equal((await snapshot(mission)).operationEvidence.visits[0].id, 'visit');
  mission.missions[0].launchPolicy = { version: 1 }; mission.missions[0].launchAdmission = { status: 'admitted' };
  assert.equal((await snapshot(mission)).operationEvidence.launchPolicy.version, 1);

  const exercise = fixture('exercise.control', 'exercise'); exercise.directive.input = { id: 'exercise' };
  for (const preconditions of [{ stage: 'changed' }, { state: 'changed' }]) { exercise.directive.preconditions = preconditions; await rejects(exercise, /Exercise .* changed/); }
  exercise.directive.preconditions = { stage: 'ready', state: 'ready' };
  assert.deepEqual((await snapshot(exercise)).authority.presets, [{ id: 'missing', value: null }, { id: 'preset', value: exercise.settings.presets[0] }]);
  exercise.exercises[0].contestants = undefined;
  assert.deepEqual((await snapshot(exercise)).authority.presets, []);

  const flash = fixture('flash.decide'); flash.directive.input = { id: 'permission', decision: 'allow' };
  await rejects(flash, /Invalid or resolved/);
  flash.service.flashQueue = async () => [{ id: 'other', state: 'pending' }, { id: 'permission', state: 'resolved' }];
  await rejects(flash, /Invalid or resolved/);
  flash.service.flashQueue = async () => [{ id: 'permission', state: 'pending', detail: 'exact command' }];
  assert.equal((await snapshot(flash)).operationEvidence.detail, 'exact command');
  flash.directive.input.decision = 'repeat'; await rejects(flash, /Invalid or resolved/);
  const fault = fixture('fault.reset');
  fault.service.loopBreaker.faults = () => [{ sessionKey: 'another' }]; assert.equal((await snapshot(fault)).operationEvidence, null);
  fault.service.loopBreaker.faults = () => [{ sessionKey: fault.unit.key, id: 'fault' }]; assert.equal((await snapshot(fault)).operationEvidence.id, 'fault');
  fault.resolve(null); assert.equal((await snapshot(fault)).operationEvidence, null);

  const order = fixture('oporder.enroll', 'none'); order.directive.input = { order: { hostId: 'alpha' }, revision: 'reviewed' };
  for (const preview of [null, { ready: false }, { ready: true, revision: 'changed' }]) { order.service.previewOpOrder = async () => preview; await rejects(order, /preview revision changed/); }
  order.service.previewOpOrder = async () => ({ ready: true, revision: 'reviewed' }); assert.equal((await snapshot(order)).operationEvidence.ready, true);
  const tree = fixture('worktree.archive', 'none'); tree.directive.input = { hostId: 'alpha', operationId: 'tree' };
  await rejects(tree, /identity is unavailable/);
  tree.service.worktrees = async () => [{ operationId: 'tree' }]; await rejects(tree, /HEAD revision is unavailable/);
  tree.service.worktrees = async () => [{ operationId: 'tree', status: { headCommit: 'a'.repeat(40) } }]; assert.ok((await snapshot(tree)).operationEvidence.status.headCommit);
  const handoff = fixture('sitrep.handoff'); handoff.directive.input = { id: 'handoff' };
  assert.deepEqual((await snapshot(handoff)).authority.hosts.map((host) => host.id), ['alpha', 'beta']);
  const definition = fixture('specops.configure', 'none'); assert.deepEqual((await snapshot(definition)).operationEvidence, { profiles: [], workflows: [] });
  const configuration = fixture('configuration.save', 'none'); assert.deepEqual((await snapshot(configuration)).operationEvidence, configuration.settings);
}

async function revisionsAndAuthority() {
  const f = fixture('mission.update', 'none');
  f.directive.input = { id: 'coordination', expectedRevision: null, plan: { dependencies: [{ evidenceOutcomeIds: ['outcome'] }], acceptanceCriteria: [{ evidenceOutcomeIds: ['outcome'] }] } };
  await rejects(f, /Cited outcome is unavailable/);
  f.state.outcomes = [{ outcomeId: 'outcome', state: 'completed' }];
  assert.equal((await snapshot(f)).operationEvidence.evidence.length, 1, 'Duplicate citations retain one reviewed outcome digest');
  f.state.coordination = [{ id: 'coordination', revision: 'reviewed' }]; await rejects(f, /Mission revision changed/);
  f.directive.input.expectedRevision = 'reviewed'; assert.equal((await snapshot(f)).operationEvidence.previous.revision, 'reviewed');
  f.state.outcomes[0].state = 'uncertain'; await assert.rejects(f.bindings.assert(f.directive), /evidence changed/);
  const creation = fixture('unit.create', 'none'); creation.directive.input = { presetId: 'preset', contestants: [{ presetId: 'preset' }] };
  assert.equal((await snapshot(creation)).authority.preset.id, 'preset');
  creation.directive.input.presetId = 'missing'; assert.equal((await snapshot(creation)).authority.preset, null);
  creation.state.session = null; creation.settings.roe = undefined;
  assert.equal((await snapshot(creation)).authority.commander, null);
  creation.settings.hosts[0].enabled = false; await rejects(creation, /Approval host is unavailable/);
  const race = fixture(); race.service.commanderInspection = async () => { race.state.config.authority = 'autonomous'; return race.inspection; };
  await rejects(race, /Authorization changed while inspecting/);

  const integrity = fixture(); await integrity.bind();
  const binding = structuredClone(integrity.directive.binding);
  for (const value of [null, { version: 2 }]) { integrity.directive.binding = value; await assert.rejects(integrity.bindings.assert(integrity.directive), /no reviewed identity binding/); }
  integrity.directive.binding = structuredClone(binding); integrity.directive.input.extra = 'changed';
  await assert.rejects(integrity.bindings.assert(integrity.directive), /parameters or binding changed/); delete integrity.directive.input.extra;
  integrity.directive.binding = structuredClone(binding); integrity.directive.binding.evidenceHash = 'changed';
  await assert.rejects(integrity.bindings.assert(integrity.directive), /parameters or binding changed/);
  integrity.directive.binding = structuredClone(binding);
  delete integrity.directive.binding.evidence.admissionUnknowns; delete integrity.directive.binding.evidence.worktreeRecoveries;
  integrity.directive.binding.evidenceHash = fingerprint(integrity.directive.binding.evidence);
  const summary = reviewSummary(integrity.directive.binding);
  assert.deepEqual(summary.admissionUnknowns, []); assert.deepEqual(summary.worktreeRecoveries, []);
  await assert.rejects(integrity.bindings.assert(integrity.directive), /evidence changed/);
}
(async () => {
  await primitives(); await identitiesAndRequests(); await operations(); await revisionsAndAuthority();
  console.log('PASS approval preconditions, identity/control/request binding, exact operation revisions, host/preset scope, cited outcome digests, inspect races, persisted integrity, and legacy review summaries');
})().catch((error) => { console.error(error); process.exitCode = 1; });
