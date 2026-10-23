const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SourceUpdater, run, resumeSourceUpdate, sourceExecutable } = require('../electron/source-updater.cjs');
const { createUpdates } = require('../electron/updates.cjs');
(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentc2-source-update-'));
  const oldEnvironment = process.env.NODE_ENV;
  try {
    assert.equal(await run(process.execPath, ['-p', 'process.env.NODE_ENV']), 'production', 'Source updates must produce production renderer assets');
    const repository = path.join(temporary, 'original');
    const directory = path.join(temporary, 'updates');
    await fs.mkdir(repository);
    await run('git', ['init', '-b', 'main'], repository);
    await run('git', ['config', 'user.email', 'fixture@example.invalid'], repository);
    await run('git', ['config', 'user.name', 'Fixture'], repository);
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'original');
    await run('git', ['add', '.'], repository);
    await run('git', ['commit', '-m', 'Fixture'], repository);
    const target = await run('git', ['rev-parse', 'HEAD'], repository);
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'unsaved work');
    const calls = [], launches = [];
    let quits = 0, fail = false;
    const app = { getAppPath: () => repository, relaunch: (options) => launches.push(options), quit: () => quits++ };
    const execute = async (file, args, cwd) => {
      calls.push([file, args, cwd]);
      if (file === 'git') return run(file, args, cwd);
      if (fail) throw new Error('npm fixture build failed');
      if (args[0] === 'run') {
        await fs.mkdir(path.join(cwd, 'dist'));
        await fs.writeFile(path.join(cwd, 'dist', 'build-info.json'), JSON.stringify({ revision: target, version: '0.4.2' }));
        await fs.writeFile(path.join(cwd, 'dist', 'index.html'), 'fixture');
        await fs.mkdir(path.dirname(sourceExecutable(cwd)), { recursive: true });
        await fs.writeFile(sourceExecutable(cwd), 'fixture');
      }
      return '';
    };
    const native = new SourceUpdater({ revision: 'a'.repeat(40), directory, app, repository, execute });
    const updates = createUpdates({ updater: native, version: '0.4.1', source: true });
    await updates.check(); assert.equal(updates.state().status, 'available');
    fail = true; await updates.download();
    assert.equal(updates.state().status, 'error'); assert.deepEqual(await fs.readdir(directory), []);
    assert.equal(launches.length, 0); assert.equal(quits, 0);
    fail = false; await updates.check(); await updates.download();
    assert.equal(updates.state().status, 'ready');
    assert.equal(await fs.readFile(path.join(repository, 'tracked.txt'), 'utf8'), 'unsaved work');
    const built = calls.findLast(([file, args]) => file === 'npm' && args[0] === 'run')[2];
    assert.equal(await fs.readFile(path.join(built, 'tracked.txt'), 'utf8'), 'original', 'Build comes from pinned commit, not dirty working files');
    updates.install(); assert.equal(quits, 1); assert.equal(launches[0].execPath, sourceExecutable(built));
    assert.deepEqual(launches[0].args, [built]);
    assert.equal(resumeSourceUpdate({ directory, revision: 'a'.repeat(40), app }), true, 'Original launcher reopens the selected update');
    assert.equal(resumeSourceUpdate({ directory, revision: target, app }), false, 'Manually rebuilt checkouts are not redirected');
    assert.equal(resumeSourceUpdate({ directory, revision: target, app: { ...app, getAppPath: () => built } }), false, 'No relaunch loop');
    assert.equal(sourceExecutable('/fixture', 'win32').endsWith('electron.exe'), true);
    assert.equal(sourceExecutable('/fixture', 'darwin').endsWith(path.join('Electron.app', 'Contents', 'MacOS', 'Electron')), true);
    const current = createUpdates({ updater: new SourceUpdater({ revision: target, directory, app, repository, execute }), version: '0.4.2', source: true });
    assert.equal((await current.check()).status, 'current');
    console.log('PASS real Git fetch, pinned source builds, dirty checkout preservation, build failure cleanup, restart selection/persistence, and platform executable paths');
  } finally {
    if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment;
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
