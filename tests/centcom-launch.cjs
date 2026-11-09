const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { fixture, unit, action } = require('./fixtures/centcom.cjs');
const { createSpecops } = require('../electron/specops.cjs');
const { createExercises } = require('../electron/exercises.cjs');
const { createService } = require('../electron/service.cjs');
const { Store } = require('../electron/config.cjs');
const { withLaunchPolicy, launchPolicy } = require('../electron/centcom-launch.cjs');
const { mutationContext } = require('../electron/centcom-dispatch.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-launch-'));
const fixtures = [], workflows = [];
async function make(name) {
  const root = path.join(directory, name), f = fixture(root); fixtures.push(f);
  f.sessions.forEach((record, i) => { record.cwd = `/unrelated/${i}`; });
  const store = new Store(path.join(root, 'workspace'));
  store.update({ settings: { ...store.data.settings, ...f.state.settings }, deletedSessions: f.state.deletedSessions });
  f.service.store = store;
  let memory = 2 * 1024 ** 3, index = 400, afterCreate = () => {};
  const worktrees = [], launches = [];
  f.service.health = async () => [{ hostId: 'alpha', connected: true, sampledAt: Date.now(), cpuPercent: 10, memoryTotal: 8 * 1024 ** 3, memoryUsed: 1024 ** 3, resources: { memoryHeadroomBytes: memory, memoryLimitStatus: 'limited' } }];
  f.service.worktrees = async () => structuredClone(worktrees);
  await f.engine.start();
  const create = (input) => f.engine.guardLaunch(input, async () => {
    const operation = input.worktree?.operationId;
    const cwd = input.worktree ? `/worktrees/${operation}` : input.cwd;
    const created = unit(++index, { cwd, worktreeOperation: operation || '', provider: input.provider, transport: 'chat' });
    f.sessions.push(created); launches.push({ input, created });
    const worktree = operation ? { operationId: operation, path: cwd, repository: input.worktree.repository, state: 'active', status: { owned: true }, name: created.name } : undefined;
    if (worktree) worktrees.push(worktree);
    afterCreate();
    return { name: created.name, chatSessionId: created.chatSessionId, worktree };
  });
  return { f, root, store, launches, worktrees, create, memory: (value) => { memory = value; }, afterCreate: (fn) => { afterCreate = fn; } };
}
async function approve(f, operation, input) {
  const [proposal] = await f.propose([action(operation, input)]);
  await f.engine.decideDirective(proposal.id, 'approve');
  const record = f.engine.state().directives.find((item) => item.id === proposal.id);
  assert.equal(record.state, 'completed', record.error);
  return record;
}

async function specopsStages() {
  const h = await make('specops'), { f } = h;
  const dependencies = { directory: path.join(h.root, 'specops'), getHost: (id) => ({ id }), emit() {}, chats: f.chats, createSession: h.create,
    runRemote: async (request) => request.action === 'exercise_base' ? { repository: '/repo', baseCommit: 'a'.repeat(40) } : request.operation === 'issue' ? { number: 69, title: 'Fixture issue', body: 'Fixture task' } : {} };
  let specops = createSpecops(dependencies); specops.dispose(); workflows.push(specops); f.service.specops = specops;
  specops.configure(YAML.stringify({ version: 1, profiles: [{ id: 'worker', name: 'Fixture', provider: 'codex', model: 'fixture', ranks: ['officer'] }], workflows: [{ version: 1, id: 'stages', name: 'Fixture workflow', trigger: 'github_issue', max_loop_retries: 2, max_steps: 10,
    stages: [{ id: 'plan', profile: 'worker', rank: 'officer', role: 'planner', prompt_template: 'Plan the task', next: 'implement' }, { id: 'implement', profile: 'worker', rank: 'officer', role: 'implementer', prompt_template: 'Implement the plan', next: 'COMPLETE' }] }] }));
  const launched = await approve(f, 'specops.launch', { workflowId: 'stages', hostId: 'alpha', repository: '/repo', repo: 'owner/repo', issue: 69 });
  const id = launched.result.id;
  assert.equal(h.launches.length, 1);
  assert.ok(specops.list()[0].launchPolicy.authority.commander);
  await specops.tick(id); // Submit the first stage's actual Chats command.
  const visit = specops.list()[0].visits[0], turnId = visit.sendId;
  f.journals.set(visit.sessionId, [
    { protocolVersion: 1, sessionId: visit.sessionId, timestamp: new Date().toISOString(), provider: 'codex', providerSessionId: null, itemId: null, sequence: 1, turnId, type: 'message.completed', data: { role: 'assistant', text: 'The reviewed plan' } },
    { protocolVersion: 1, sessionId: visit.sessionId, timestamp: new Date().toISOString(), provider: 'codex', providerSessionId: null, itemId: null, sequence: 2, turnId, type: 'usage.updated', data: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01, contextUsedTokens: null, contextCapacityTokens: null } },
    { protocolVersion: 1, sessionId: visit.sessionId, timestamp: new Date().toISOString(), provider: 'codex', providerSessionId: null, itemId: null, sequence: 3, turnId, type: 'turn.completed', data: { outcome: 'completed', detail: '' } },
  ]);
  h.memory(128 * 1024 ** 2);
  await specops.tick(id); // Automatic next stage, outside the original C2 context.
  let run = specops.list()[0];
  assert.equal(run.state, 'halted'); assert.equal(h.launches.length, 1);
  assert.equal(run.visits.at(-1).launchBlocked, true, run.error);
  assert.match(run.error, /256 MiB/); assert.equal(run.canRetry, true);
  assert.equal(run.visits[0].turnId, turnId);
  specops = createSpecops(dependencies); specops.dispose(); workflows.push(specops); f.service.specops = specops;
  assert.ok(specops.list()[0].launchPolicy, 'Workflow authorization survives restart');
  h.memory(2 * 1024 ** 3);

  // A different live writer cannot be excused as the completed predecessor.
  const outsider = unit(800, { cwd: h.worktrees[0].path }); f.sessions.push(outsider);
  await specops.control(id, 'retry');
  assert.equal(h.launches.length, 1); assert.match(specops.list()[0].error, /already assigned/);
  f.sessions.splice(f.sessions.indexOf(outsider), 1);
  // The same predecessor starting a different turn also invalidates reuse.
  f.journals.get(visit.sessionId).push({ protocolVersion: 1, sessionId: visit.sessionId, timestamp: new Date().toISOString(), provider: 'codex', providerSessionId: null, itemId: null, sequence: 4, turnId: 'another-task', type: 'message.completed', data: { role: 'user', text: 'New work' } });
  await specops.control(id, 'retry');
  assert.equal(h.launches.length, 1); assert.match(specops.list()[0].error, /already assigned/);
  f.journals.get(visit.sessionId).pop();
  const retried = await approve(f, 'specops.control', { id, action: 'retry' });
  assert.equal(retried.result.state, 'running'); assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1].input.cwd, h.worktrees[0].path);
  assert.equal(h.launches[1].input.roeProfile, 'full');
  await assert.rejects(withLaunchPolicy(null, { kind: 'specops', id }, () => h.create({ hostId: 'alpha', provider: 'codex', cwd: '/fresh' })), (error) => error.beforeMutation && error.launchPolicy.legacy && /review the mission/.test(error.message), 'Legacy C2-owned missions cannot silently bypass the guard');

  // Admission can fail after a mission is persisted but before its first unit
  // exists. Fresh review must be able to retry that owned mission with no target.
  specops = createSpecops({ ...dependencies, createSession: (input) => { h.memory(128 * 1024 ** 2); return h.create(input); } }); specops.dispose(); workflows.push(specops); f.service.specops = specops;
  const blocked = await approve(f, 'specops.launch', { workflowId: 'stages', hostId: 'alpha', repository: '/repo', repo: 'owner/repo', issue: 70 });
  assert.equal(blocked.result.visits[0].launchBlocked, true); assert.equal(blocked.result.visits[0].name, '');
  h.memory(2 * 1024 ** 3);
  specops = createSpecops(dependencies); specops.dispose(); workflows.push(specops); f.service.specops = specops;
  const firstRetry = await approve(f, 'specops.control', { id: blocked.result.id, action: 'retry' });
  assert.equal(firstRetry.result.state, 'running'); assert.equal(h.launches.length, 3);
  await specops.tick(blocked.result.id);
  const healthyVisit = specops.list().find((item) => item.id === blocked.result.id).visits.at(-1);
  f.journals.set(healthyVisit.sessionId, f.journals.get(visit.sessionId).map((event) => ({ ...event, sessionId: healthyVisit.sessionId, turnId: healthyVisit.sendId })));
  await specops.tick(blocked.result.id);
  assert.equal(h.launches.length, 4, 'Healthy automatic stages reuse only their completed predecessors');
  assert.equal(specops.list().find((item) => item.id === blocked.result.id).state, 'running');

  // A persisted scope cannot follow a changed SSH route or new commander.
  run = specops.list().find((item) => item.id === id);
  const policy = run.launchPolicy;
  const before = h.launches.length;
  const originalHost = structuredClone(h.store.data.settings.hosts[0]);
  h.store.data.settings.hosts[0].target = 'changed.invalid';
  await assert.rejects(withLaunchPolicy(policy, {}, () => h.create({ hostId: 'alpha', provider: 'codex', worktree: { operationId: 'e'.repeat(32), repository: '/repo', baseRef: 'main', slug: 'new' } })), /host route changed/);
  h.store.data.settings.hosts[0] = originalHost;
  f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
  await assert.rejects(withLaunchPolicy(policy, {}, () => h.create({ hostId: 'alpha', provider: 'codex', cwd: '/fresh' })), /authorization changed/);
  assert.equal(h.launches.length, before);
}

async function exerciseRetries() {
  const h = await make('exercises'), { f } = h;
  const exercises = createExercises({ store: h.store, getHost: (id) => ({ id }), emit() {}, beginLaunch: () => () => {}, createSession: h.create,
    runRemote: async () => ({ repository: '/repo', baseCommit: 'a'.repeat(40) }) });
  f.service.exercises = exercises;
  const preset = { id: 'reviewed-preset', name: 'Reviewed Claude', provider: 'claude', command: 'claude', args: '', cwd: '', instructions: '', fullPermissions: true, hostId: 'alpha' };
  h.store.data.settings.presets.push(preset);
  h.afterCreate(() => h.memory(128 * 1024 ** 2));
  const launched = await approve(f, 'exercise.create', { hostId: 'alpha', repository: '/repo', baseRef: 'main', title: 'Comparison', prompt: 'Fixture task', testCommand: '', contestants: [{ provider: 'codex' }, { provider: 'claude', presetId: preset.id }] });
  const id = launched.result.id;
  assert.equal(h.launches.length, 1); assert.equal(exercises.list()[0].state, 'partial');
  assert.equal(exercises.list()[0].contestants[1].launchBlocked, true);
  h.memory(2 * 1024 ** 3); preset.args = '--changed';
  await exercises.launch(id);
  assert.equal(h.launches.length, 1); assert.match(exercises.list()[0].contestants[1].error, /preset changed/);
  preset.args = '';
  h.memory(undefined); h.afterCreate(() => {});
  await exercises.launch(id);
  assert.equal(h.launches.length, 1, 'Initial approval must not authorize unknown headroom on a later retry');
  assert.equal(exercises.list()[0].contestants[1].admission.status, 'unknown');
  await approve(f, 'exercise.control', { id, action: 'retry' });
  assert.equal(h.launches.length, 2, 'Fresh approval may accept explicitly unknown headroom');
  assert.equal(exercises.list()[0].state, 'running');
}

async function changedAdmission() {
  const h = await make('changed-admission'), { f } = h;
  f.service.create = h.create;
  const input = { hostId: 'alpha', provider: 'codex', worktree: { operationId: 'b'.repeat(32), repository: '/repo', baseRef: 'main', slug: 'fixture' } };
  const [staged] = await f.propose([action('unit.create', input)]);
  assert.equal(staged.admission.status, 'admitted');
  h.memory(undefined);
  await f.engine.decideDirective(staged.id, 'approve');
  assert.equal(f.engine.state().directives.find((item) => item.id === staged.id).state, 'failed');
  assert.equal(h.launches.length, 0, 'A new unknown condition requires a fresh review');
  const fresh = await approve(f, 'unit.create', input);
  assert.equal(fresh.admission.status, 'unknown'); assert.equal(h.launches.length, 1);
  assert.ok(fresh.binding.admissionUnknowns.includes('Resource headroom has incomplete coverage'));
}

async function productionBoundary() {
  const service = createService({ directory: path.join(directory, 'production'), home: directory });
  try {
    service.chats.capabilities = async () => [{ provider: 'codex', status: 'supported' }];
    let guards = 0;
    service.centcom.guardLaunch = async (input) => { guards++; assert.equal(input.provider, 'codex'); throw new Error('Guard stopped before remote dispatch'); };
    await assert.rejects(service.create({ provider: 'codex', transport: 'chat', hostId: service.store.data.settings.hosts[0].id, cwd: '/fixture' }), /Guard stopped/);
    assert.equal(guards, 1, 'The production createSession boundary must call the guard');
  } finally { service.centcom.dispose(); service.specops.dispose(); service.chats.closeAll(); }
  const h = await make('serialization'), { f } = h;
  const scope = { mode: 'gated', commander: f.engine.state().session.chatSessionId, hosts: structuredClone(h.store.data.settings.hosts), roe: h.store.data.settings.roe, preset: null };
  const context = { directive: { id: 'reviewed', approvedAt: Date.now(), binding: { evidence: { authority: scope } } }, authority: () => ({ mode: 'gated', commander: f.engine.state().session.chatSessionId }) };
  const policy = mutationContext.run(context, launchPolicy);
  const attempts = await Promise.allSettled([1, 2].map(() => withLaunchPolicy(policy, {}, () => h.create({ provider: 'codex', hostId: 'alpha', cwd: '/same/assignment' }))));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(attempts.find((result) => result.status === 'rejected').reason.message, /already assigned/);
  const create = f.service.create;
  let detached = false;
  f.service.create = (input) => {
    assert.equal(launchPolicy(), null, 'A queued commander turn cannot inherit an earlier approved directive');
    detached = true;
    return f.engine.guardLaunch(input, () => create(input));
  };
  h.memory(undefined);
  await mutationContext.run(context, () => withLaunchPolicy(policy, {}, () => f.engine.resetSession()));
  assert.equal(detached, true, 'Both mutation and workflow launch contexts must be absent while creating the new commander');
}

(async () => {
  try {
    await specopsStages(); await exerciseRetries(); await changedAdmission(); await productionBoundary();
    console.log('PASS production launch guard, actual SPECOPS/exercise stage and retry admission, restart scope, strict predecessor reuse, fresh review, and serialized assignment checks');
  } finally { for (const workflow of workflows) workflow.dispose(); for (const f of fixtures) f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
