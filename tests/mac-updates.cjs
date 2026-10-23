const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createMacUpdater, installMacArchive } = require('../electron/mac-update.cjs');
const { createUpdates } = require('../electron/updates.cjs');
const run = promisify(execFile);
(async () => {
  let restarts = 0, quits = 0, installs = 0;
  const app = { relaunch: () => restarts++, quit: () => quits++ };
  const native = new EventEmitter();
  native.quitAndInstall = () => { installs++; };
  const original = native.quitAndInstall;
  createMacUpdater(app, { updater: native, inspect: () => ({ status: 0, stderr: 'Authority=Developer ID Application: Fixture' }) });
  assert.equal(native.quitAndInstall, original, 'Publisher signed apps retain native signature verification and installation');
  let fail = true;
  native.closeServerIfExists = () => {};
  createMacUpdater(app, { updater: native, bundle: '/Applications/AgentC2.app', inspect: () => ({ status: 0, stderr: 'Signature=adhoc' }), install: async (input) => {
    assert.equal(input.archive, '/tmp/fixture.zip'); assert.equal(input.version, '0.4.2');
    installs++; if (fail) throw new Error('Authorization cancelled');
  } });
  const updates = createUpdates({ updater: native, version: '0.4.1' });
  native.emit('update-downloaded', { downloadedFile: '/tmp/fixture.zip', version: '0.4.2' });
  await updates.install(); assert.equal(updates.state().status, 'error');
  assert.equal(restarts, 0); assert.equal(quits, 0, 'Failed installation leaves the current application running');
  fail = false; native.emit('update-downloaded', { downloadedFile: '/tmp/fixture.zip', version: '0.4.2' });
  await updates.install(); assert.equal(restarts, 1); assert.equal(quits, 1);
  if (process.platform !== 'darwin') {
    console.log('PASS Mac signed/ad hoc installer routing, asynchronous failure handling, and restart only after installation; native bundle replacement runs on macOS CI');
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentc2-mac-update-'"));
  try {
    const bundle = path.join(directory, 'AgentC2.app');
    const source = path.join(directory, 'incoming', 'AgentC2.app');
    async function makeBundle(root, marker, version) {
      await fs.mkdir(path.join(root, 'Contents', 'MacOS'), { recursive: true });
      await fs.writeFile(path.join(root, 'Contents', 'MacOS', 'AgentC2'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await fs.writeFile(path.join(root, 'Contents', 'marker'), marker);
      await fs.writeFile(path.join(root, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.agentc2.desktop</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleExecutable</key><string>AgentC2</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      await run('/usr/bin/codesign', ['--force', '--sign', '-', root]);
    }
    await makeBundle(bundle, 'old', '0.4.1'); await makeBundle(source, 'new', '0.4.2');
    const archive = path.join(directory, 'fixture.zip');
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', source, archive]);
    await assert.rejects(installMacArchive({ archive, bundle, version: '0.4.3', directory }), /identity or version/);
    assert.equal(await fs.readFile(path.join(bundle, 'Contents', 'marker'), 'utf8'), 'old');
    // Force the final move to fail in the actual shell transaction, then check rollback.
    await assert.rejects(installMacArchive({ archive, bundle, version: '0.4.2', directory, run: (file, args) => {
      if (file === '/bin/sh') args = [args[0], args[1].replace('if /bin/mv ', 'if /usr/bin/false ')];
      return run(file, args);
    } }));
    assert.equal(await fs.readFile(path.join(bundle, 'Contents', 'marker'), 'utf8'), 'old', 'Failed replacement restores the original bundle');
    const backup = await installMacArchive({ archive, bundle, version: '0.4.2', directory });
    assert.equal(await fs.readFile(path.join(bundle, 'Contents', 'marker'), 'utf8'), 'new');
    assert.equal(await fs.readFile(path.join(backup, 'Contents', 'marker'), 'utf8'), 'old');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    console.log('PASS actual Mac ZIP extraction, ad hoc signature verification, version rejection, quoted paths, atomic bundle replacement, and rollback after failed rename');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
