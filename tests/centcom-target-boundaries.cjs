const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, action, query, envelope } = require('./fixtures/centcom.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-targets-'));
const f = fixture(directory);
let sequence = 0;
async function rejectAction(operation, input, expected, preconditions = {}) {
  const before = f.calls.filter((call) => !['create'].includes(call.operation)).length;
  const [record] = await f.propose([action(operation, input, { preconditions })]);
  assert.match(record.validationError || record.error, expected);
  await f.engine.decideDirective(record.id, 'approve');
  assert.equal(f.engine.state().directives.find((item) => item.id === record.id).state, 'failed');
  assert.equal(f.calls.filter((call) => !['create'].includes(call.operation)).length, before, 'Rejected target cannot invoke an operation');
}
async function read(operation, input, expected) {
  const id = 'target-query-' + ++sequence;
  f.responses.push(envelope({ queries: [{ ...query(operation, input), id }] }));
  await f.engine.submit('Inspect target boundary');
  const record = f.engine.outcomes({ collection: 'diagnostic', clientRequestId: id }).entries.at(-1);
  assert.equal(record.status, 'failed', JSON.stringify(record)); assert.match(record.error || record.message, expected);
}
(async () => {
  try {
    f.engine.pause(true); await f.engine.start();
    const [first, second] = f.sessions;
    // Read-only preconditions still resolve against the current active fleet.
    await rejectAction('unit.pin', { sessionKey: first.key, pinned: true }, /session is live, expected waiting/, { state: 'waiting' });
    await rejectAction('unit.pin', { sessionKey: first.key, pinned: true }, /Conflicting session target/, { sessionKey: second.key });
    await rejectAction('configuration.save', { settings: {} }, /not an eligible connected active managed session/, { sessionKey: 'alpha/tmux:missing' });
    const [scoped] = await f.propose([action('configuration.save', { settings: {} }, { preconditions: { sessionKey: first.key } })]);
    assert.equal(scoped.state, 'pending', scoped.error); await f.engine.decideDirective(scoped.id, 'deny');
    assert.equal(f.calls.filter((call) => call.operation === 'configuration.save').length, 0);
    f.flash.push({ id: 'target-flash', name: first.name, hostId: 'alpha', state: 'pending', connected: true });
    await rejectAction('flash.decide', { id: 'missing', decision: 'allow' }, /Flash Traffic target is unavailable/);
    await rejectAction('flash.decide', { id: 'target-flash', name: second.name, decision: 'deny' }, /Conflicting Flash Traffic target identities/);

    await rejectAction('specops.control', { id: 'missing', action: 'cancel' }, /Operation is unavailable/);
    const mission = { id: 'target-mission', hostId: 'alpha', state: 'halted', stage: 'review', workflow: { name: 'Fixture', stages: [] }, visits: [] };
    f.missions.push(mission);
    await rejectAction('specops.control', { id: mission.id, action: 'cancel' }, /no active participants/);
    mission.visits.push({ id: 'empty-visit' });
    await rejectAction('specops.control', { id: mission.id, action: 'cancel' }, /no active participants/);
    mission.visits.push({ id: 'old-visit', name: first.name }, { id: 'latest-visit', name: 'hq-ffffffffffff' });
    await rejectAction('specops.control', { id: mission.id, action: 'cancel' }, /participant is outside the active fleet/);
    // Reads can ignore an inactive participant, but cannot claim an all-inactive
    // mission has active participants.
    mission.visits = [{ id: 'inactive', name: 'hq-ffffffffffff' }];
    await read('specops.inspect', { id: mission.id }, /no active participants/);
    mission.visits = [{ id: 'first', name: first.name }, { id: 'duplicate', name: first.name }, { id: 'second', sessionId: second.chatSessionId }];
    await rejectAction('specops.control', { id: mission.id, action: 'cancel' }, /Conflicting operation precondition/, { sessionKey: first.key });
    f.service.worktrees = async () => [];
    f.service.health = async () => [{ hostId: 'alpha', connected: true, sampledAt: Date.now(), cpuPercent: 0, resources: { memoryHeadroomBytes: 2 * 1024 ** 3, memoryLimitStatus: 'limited' } }];
    mission.repository = '/isolated/target-fixture'; mission.launchPolicy = { version: 1 }; mission.visits.at(-1).launchBlocked = true;
    await rejectAction('specops.control', { id: mission.id, action: 'retry' }, /Conflicting operation precondition/, { sessionKey: 'alpha/tmux:missing' });
    const [retry] = await f.propose([action('specops.control', { id: mission.id, action: 'retry' }, { preconditions: { sessionKey: first.key } })]);
    assert.equal(retry.state, 'pending', retry.validationError); assert.equal(retry.validationError, undefined); assert.equal(retry.binding.targets.length, 2, 'Blocked retry must deduplicate active participants before binding approval');
    await f.engine.decideDirective(retry.id, 'deny');
    const exercise = { id: 'target-exercise', hostId: 'alpha', state: 'partial', repository: '/isolated/target-fixture', contestants: [] };
    f.exercises.push(exercise);
    await read('exercise.inspect', { id: exercise.id, contestantId: 'missing' }, /Contestant is unavailable/);
    exercise.contestants.push({ id: 'empty', state: 'queued' });
    await read('exercise.inspect', { id: exercise.id, contestantId: 'empty' }, /no active participants/);
    exercise.contestants.push({ id: 'inactive', name: 'hq-ffffffffffff', state: 'launched' });
    await read('exercise.inspect', { id: exercise.id, contestantId: 'inactive' }, /participant is outside the active fleet/);
    await rejectAction('exercise.control', { id: exercise.id, action: 'cancel' }, /participant is outside the active fleet/);
    exercise.contestants.splice(0, exercise.contestants.length, { id: 'first', name: first.name, state: 'launched' }, { id: 'second', sessionId: second.chatSessionId, state: 'launched' });
    const [valid] = await f.propose([action('exercise.control', { id: exercise.id, action: 'cancel' })]);
    assert.equal(valid.state, 'pending', valid.error); assert.equal(valid.binding.targets.length, 2);
    // A participant disappearing after review invalidates the operation before
    // the fixture cancellation method can run.
    second.stale = true;
    await f.engine.decideDirective(valid.id, 'approve');
    const failed = f.engine.state().directives.find((record) => record.id === valid.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.error, /participant is outside the active fleet/);
    assert.equal(f.calls.filter((call) => call.operation === 'exercise.cancel').length, 0);
    console.log('PASS CENTCOM active-target/state/precondition conflicts, Flash identity binding, empty/inactive mission and contestant refusals, session-ID resolution, and post-review participant disappearance without mutation');
  } finally { f.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
