const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../electron/config.cjs');
const { createExercises } = require('../electron/exercises.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-exercise-store-'));
  try {
    const store = new Store(directory);
    const launched = [];
    let failClaude = true;
    const dependencies = {
      store,
      getHost: () => ({ id: 'default' }),
      runRemote: async (payload) => {
        if (payload.action === 'exercise_base') return { repository: '/fixture/repo', baseCommit: 'a'.repeat(40) };
        if (payload.action === 'exercise_inspect') return { revision: 'b'.repeat(64), active: true, patchBytes: 42, warnings: [], test: { command: 'true', exitCode: 0, timedOut: false } };
        if (payload.action === 'exercise_target_preview') return { ready: true, revision: payload.revision, target: '/fixture/repo' };
        if (payload.action === 'exercise_promote') return { applied: true, revision: payload.revision, target: '/fixture/repo' };
        throw new Error('Unexpected remote action');
      },
      createSession: async (input) => {
        launched.push(input);
        if (input.provider === 'claude' && failClaude) { failClaude = false; throw new Error('CLI unavailable'); }
        return { name: `hq-${input.worktree.operationId.slice(0, 12)}` };
      },
      beginLaunch: () => () => {}, emit: () => {},
    };
    const service = createExercises(dependencies);
    const record = await service.create({ title: 'Compare', hostId: 'default', repository: '/fixture/repo', baseRef: 'HEAD', prompt: 'same task', testCommand: 'true', contestants: [{ provider: 'codex' }, { provider: 'claude' }] });
    assert.equal(record.state, 'partial');
    assert.equal(new Store(directory).data.exercises[0].id, record.id, 'partial launch must survive restart');
    assert.equal(new Set(launched.map((item) => item.worktree.operationId)).size, 2);
    assert.deepEqual([...new Set(launched.map((item) => item.worktree.baseRef))], ['a'.repeat(40)]);
    const retry = createExercises({ ...dependencies, store: new Store(directory) });
    const resumed = await retry.launch(record.id);
    assert.equal(resumed.state, 'running');
    assert.equal(launched[1].worktree.operationId, launched[2].worktree.operationId, 'retry must reuse the owned operation');
    assert.equal(launched[1].instructions, launched[2].instructions);
    const winner = resumed.contestants[0];
    await retry.markComplete(record.id, winner.id);
    const inspected = await retry.inspect(record.id, winner.id, true);
    assert.equal(inspected.evidence.test.exitCode, 0);
    await retry.preview(record.id, winner.id);
    const promoted = await retry.promote(record.id, winner.id, inspected.revision);
    assert.equal(promoted.state, 'promoted');
    assert.equal((await retry.promote(record.id, winner.id, inspected.revision)).promotion.contestantId, winner.id);
    const cancelled = await service.create({ title: 'Cancel', hostId: 'default', repository: '/fixture/repo', baseRef: 'HEAD', prompt: 'second task', testCommand: '', contestants: [{ provider: 'codex' }, { provider: 'claude' }] });
    assert.equal((await service.cancel(cancelled.id)).state, 'cancelled');
    await assert.rejects(service.launch(cancelled.id), /cannot be relaunched/);
    assert.equal(new Store(directory).data.exercises.find((item) => item.id === cancelled.id).state, 'cancelled');
    console.log('PASS durable partial Joint Exercise launch, same-base retry, explicit verification, and idempotent promotion');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
