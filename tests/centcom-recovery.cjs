const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture, action, unit } = require('./fixtures/centcom.cjs');
const { Store } = require('../electron/config.cjs');
const { createExercises } = require('../electron/exercises.cjs');
const { assertDispatchScope } = require('../electron/centcom-dispatch.cjs');

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-recovery-')));
let f;
(async () => {
  try {
    const repository = path.join(directory, 'repository'); fs.mkdirSync(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repository, 'README.md'), 'Fixture\n'); git('add', '.'); git('commit', '-qm', 'Base');
    f = fixture(path.join(directory, 'engine'));
    f.sessions.forEach((record, index) => { record.cwd = `/unrelated/${index}`; });
    const store = new Store(path.join(directory, 'settings'));
    store.update({ settings: { ...store.data.settings, ...f.state.settings }, deletedSessions: f.state.deletedSessions });
    f.service.store = store;
    let fail = true, race = () => {}, index = 500;
    const runRemote = async (request) => {
      const payload = assertDispatchScope(store.data.settings.hosts[0], request, store.data.settings);
      if (payload.action === 'worktree_launch') race();
      const response = JSON.parse(execFileSync('python3', [path.join(__dirname, 'fixtures/worktree-runner.py')], { input: JSON.stringify({ ...payload, fixtureHome: directory, fixtureFail: fail }), encoding: 'utf8', timeout: 15000 }));
      if (response.error) throw new Error(response.error);
      return response.result;
    };
    const attempts = () => fs.existsSync(path.join(directory, 'provider-attempts.jsonl')) ? fs.readFileSync(path.join(directory, 'provider-attempts.jsonl'), 'utf8').trim().split('\n').length : 0;
    f.service.health = async () => [{ hostId: 'alpha', connected: true, sampledAt: Date.now(), cpuPercent: 10, memoryTotal: 8 * 1024 ** 3, memoryUsed: 1024 ** 3, resources: { memoryHeadroomBytes: 2 * 1024 ** 3, memoryLimitStatus: 'limited' } }];
    f.service.worktrees = () => runRemote({ action: 'worktree_list' });
    f.service.commanderLaunchPaths = async (_host, cwd, paths) => ({ cwd: fs.realpathSync(cwd), paths });
    const createSession = (input) => f.engine.guardLaunch(input, async () => {
      const result = await runRemote({ action: 'worktree_launch', ...input.worktree, provider: input.provider, title: input.title, instructions: input.instructions, preset: null });
      f.sessions.push(unit(++index, { name: result.name, id: result.name, key: `alpha/tmux:${result.name}`, cwd: result.worktree.path, worktreeOperation: input.worktree.operationId, provider: input.provider }));
      return result;
    });
    const exercises = createExercises({ store, getHost: () => store.data.settings.hosts[0], runRemote, createSession, beginLaunch: () => () => {}, emit() {} });
    f.service.exercises = exercises;
    await f.engine.start();
    async function stage(operation, input) { const [record] = await f.propose([action(operation, input)]); return record; }
    async function decide(record, choice = 'approve') {
      await f.engine.decideDirective(record.id, choice);
      return f.engine.state().directives.find((item) => item.id === record.id);
    }
    const initial = await decide(await stage('exercise.create', { hostId: 'alpha', repository, baseRef: 'HEAD', title: 'Recovery é', prompt: 'Fixture task', testCommand: '', contestants: [{ provider: 'codex' }, { provider: 'claude' }] }));
    assert.equal(initial.state, 'completed', initial.error);
    const id = initial.result.id;
    assert.equal(attempts(), 2); assert.equal(exercises.list()[0].state, 'partial');
    assert.ok(exercises.list()[0].contestants.every((item) => item.state === 'failed' && !item.name));
    fail = false;
    const retry = () => stage('exercise.control', { id, action: 'retry' });
    const reviewed = await retry();
    assert.equal(reviewed.state, 'pending', reviewed.error || reviewed.validationError);
    assert.equal(reviewed.admission.status, 'unknown');
    assert.equal(reviewed.binding.worktreeRecoveries.length, 2);
    assert.equal(attempts(), 2, 'Staging cannot launch');
    assert.equal((await decide(reviewed, 'deny')).state, 'denied');
    await exercises.launch(id);
    assert.equal(attempts(), 2, 'Saved authority cannot recover without a current review');
    const stale = await retry();
    const records = await f.service.worktrees(), first = records.find((record) => record.operationId === exercises.list()[0].contestants[0].id);
    const changed = path.join(first.path, 'unreviewed.txt'); fs.writeFileSync(changed, 'Changed\n');
    assert.equal((await decide(stale)).state, 'failed'); assert.equal(attempts(), 2);
    const dirty = await retry(); assert.equal(dirty.admission.status, 'blocked');
    fs.unlinkSync(changed);
    const outsider = unit(900, { cwd: first.path }); f.sessions.push(outsider);
    const conflict = await retry(); assert.equal(conflict.admission.status, 'blocked');
    f.sessions.splice(f.sessions.indexOf(outsider), 1);
    f.engine.configure({ ...f.engine.state().config, authority: 'autonomous' });
    const remoteRace = await retry();
    assert.equal(remoteRace.state, 'pending', 'Recovery still requires Watch Officer review in autonomous mode');
    assert.equal(attempts(), 2);
    race = () => { fs.writeFileSync(changed, 'Changed after final JS inspection\n'); race = () => {}; };
    await decide(remoteRace);
    assert.match(exercises.list()[0].contestants.find((item) => item.id === first.operationId).error, /revision changed/);
    // The other independent contestant may succeed; the changed one must not.
    assert.equal(attempts(), 3);
    fs.unlinkSync(changed);
    const recovered = await decide(await retry());
    assert.equal(recovered.state, 'completed', recovered.error);
    assert.equal(exercises.list()[0].state, 'running'); assert.equal(attempts(), 4);
    assert.ok((await f.service.worktrees()).every((record) => record.state === 'launched'));
    console.log('PASS actual exercise adapter and Python worktree recovery: no-participant retry, explicit review, denial, stale/dirty/conflicting worktrees, remote revision race, Unicode digest, and exact recovered launches');
  } finally { f?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
