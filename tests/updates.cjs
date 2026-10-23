const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates, createMainCheck } = require('../electron/updates.cjs');
class FixtureUpdater extends EventEmitter {
  checks = 0; downloads = 0; installs = 0;
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    if (this.checkFailure) throw new Error('Offline');
    this.emit(this.current ? 'update-not-available' : 'update-available', { version: '0.4.2' });
  }
  async downloadUpdate() {
    this.downloads++;
    this.emit('download-progress', { percent: 42 });
    await this.wait;
    if (this.downloadFailure) throw new Error('Checksum mismatch');
    this.emit('update-downloaded');
  }
  quitAndInstall(...args) { this.installs++; this.installArgs = args; if (this.installFailure) this.emit('error', new Error('Installer refused')); }
}
(async () => {
  const native = new FixtureUpdater(), states = [];
  const updates = createUpdates({ updater: native, version: '0.4.1', notify: (state) => states.push(state) });
  assert.equal(native.autoDownload, false); assert.equal(native.autoInstallOnAppQuit, false);
  assert.equal(native.allowPrerelease, false); assert.equal(native.allowDowngrade, false);
  assert.throws(() => updates.install(), /not ready/);
  await assert.rejects(updates.download(), /Check for/);
  await Promise.all([updates.check(), updates.check()]);
  assert.equal(native.checks, 1); assert.equal(updates.state().status, 'available');
  let finish; native.wait = new Promise((resolve) => { finish = resolve; });
  const download = updates.download();
  await Promise.resolve();
  assert.equal(updates.state().percent, 42);
  assert.throws(() => updates.install(), /not ready/);
  const duplicate = updates.download(), checkDuringDownload = updates.check();
  finish(); await Promise.all([download, duplicate, checkDuringDownload]);
  assert.equal(native.downloads, 1); assert.equal(native.checks, 1);
  assert.equal(updates.state().status, 'ready');
  await updates.check(); assert.equal(native.checks, 1, 'Ready updates cannot be overwritten by an hourly check');
  assert.equal(native.installs, 0, 'Downloading does not install or quit');
  updates.install(); assert.equal(native.installs, 1); assert.deepEqual(native.installArgs, [false, true]);
  assert.throws(() => updates.install(), /not ready/);
  assert.ok(states.some((state) => state.status === 'checking'));
  native.emit('error', new Error('Installer refused'));
  assert.equal(updates.state().status, 'error'); assert.match(updates.state().error, /Installer refused/);
  native.checkFailure = true; await updates.check();
  assert.equal(updates.state().status, 'error'); assert.match(updates.state().error, /Offline/);
  native.checkFailure = false; await updates.check();
  native.downloadFailure = true; await updates.download();
  assert.equal(updates.state().status, 'error'); assert.match(updates.state().error, /Checksum mismatch/);
  assert.throws(() => updates.install(), /not ready/);
  native.downloadFailure = false; await updates.check(); await updates.download();
  assert.equal(updates.state().status, 'ready', 'Failed downloads can be retried');
  const current = new FixtureUpdater(); current.current = true;
  const noUpdate = createUpdates({ updater: current, version: '0.4.2' });
  assert.equal((await noUpdate.check()).status, 'current');
  const pending = createUpdates({ updater: current, version: '0.4.2', checkMain: async () => true });
  assert.equal((await pending.check()).status, 'pending', 'A newer main must not be reported as up to date while its release is building');
  await assert.rejects(pending.download(), /Check for/);
  const empty = new FixtureUpdater();
  empty.checkForUpdates = async () => { throw Object.assign(new Error('No published versions'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }); };
  assert.equal((await createUpdates({ updater: empty, version: '0.4.1', checkMain: async () => true }).check()).status, 'pending', 'The first unpublished release still exposes newer main');
  const offlineMain = createUpdates({ updater: current, version: '0.4.2', checkMain: async () => { throw Error('Offline'); } });
  assert.match((await offlineMain.check()).error, /checking main failed/);
  const sha = 'a'.repeat(40);
  for (const [status, ahead_by, expected] of [['ahead', 2, true], ['diverged', 1, true], ['identical', 0, false], ['behind', 0, false]]) {
    assert.equal(await createMainCheck(sha, async (url) => { assert.ok(url.endsWith(`/compare/${sha}...main`)); return { status, ahead_by }; })(), expected);
  }
  assert.equal(await createMainCheck(null, async () => { throw Error('Should not request unknown revision'); })(), null);
  let resolveMain;
  const slowMain = new Promise((resolve) => { resolveMain = resolve; });
  const queuedNative = new FixtureUpdater();
  const queued = createUpdates({ updater: queuedNative, version: '0.4.1', checkMain: () => slowMain });
  const checking = queued.check(); await Promise.resolve();
  const requested = queued.download(); resolveMain(true);
  await Promise.all([checking, requested]);
  assert.equal(queuedNative.downloads, 1, 'An update click during the parallel main check is not lost');
  console.log('PASS update lifecycle, explicit download/install, progress, duplicate actions, concurrent checks, failures, retries, and no-update state');
})().catch((error) => { console.error(error); process.exitCode = 1; });
