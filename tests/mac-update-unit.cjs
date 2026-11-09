const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { loadCommonJs } = require('./helpers/load-commonjs.cjs');

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentc2-mac-unit-'"));
  const bundle = path.join(directory, 'AgentC2.app');
  await fs.mkdir(bundle);
  const witness = path.join(bundle, 'current');
  await fs.writeFile(witness, 'current app');
  const archive = path.join(directory, 'fixture.zip');
  await fs.writeFile(archive, 'verified archive fixture');
  const calls = [], stages = [], lifecycle = [], instances = [];
  class Native extends EventEmitter {
    constructor() { super(); instances.push(this); }
    quitAndInstall() { lifecycle.push('native installer'); }
    closeServerIfExists() { lifecycle.push('close server'); }
  }
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file === options.failAt) throw options.failure;
    if (file === '/usr/libexec/PlistBuddy') return { stdout: args[1].endsWith('Identifier') ? (options.identity ?? 'com.agentc2.desktop\n') : (options.version ?? '0.4.2\n') };
    return { stdout: '' };
  };
  const execFile = () => { throw Error('The fixture expects the native promisified execFile interface'); };
  execFile[promisify.custom] = run;
  const inspect = (...args) => { calls.push({ file: 'inspect', args }); return options.signature ?? { status: 0, stderr: 'Signature=adhoc' }; };
  const library = loadCommonJs('electron/mac-update.cjs', {
    'node:fs/promises': { ...fs,
      mkdtemp: async (...args) => { const result = await fs.mkdtemp(...args); stages.push(result); return result; },
      access: async (target, mode) => { assert.equal(target, directory); assert.equal(mode, require('node:fs').constants.W_OK); if (options.accessError) throw options.accessError; return fs.access(target, mode); },
    },
    'node:child_process': { execFile, spawnSync: inspect },
    'electron-updater': { MacUpdater: Native },
  });
  const app = { relaunch: () => lifecycle.push('relaunch'), quit: () => lifecycle.push('quit') };
  return { ...library, app, options, calls, lifecycle, instances, bundle, archive, directory,
    install: (extra = {}) => library.installMacArchive({ archive, bundle, directory, version: '0.4.2', ...extra }),
    async cleaned() { for (const staging of stages) await assert.rejects(fs.access(staging), { code: 'ENOENT' }); assert.equal(await fs.readFile(witness, 'utf8'), 'current app'); },
    async close() { await fs.rm(directory, { recursive: true, force: true }); },
  };
}

async function main() {
  // Reproduces an elevated retry of a failed replacement command. Only the
  // directory access preflight is allowed to select administrator privileges.
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const failure = Object.assign(new Error(`Replacement failed: ${code}`), { code });
    const f = await fixture({ failAt: '/bin/sh', failure });
    try {
      await assert.rejects(f.install(), (error) => error === failure);
      assert.equal(f.calls.some((call) => call.file === '/usr/bin/osascript'), false, 'A failed installation must never be retried with higher privileges');
      await f.cleaned();
    } finally { await f.close(); }
  }
  for (const code of ['EACCES', 'EPERM']) {
    const f = await fixture({ accessError: Object.assign(new Error('Read-only app directory'), { code }) });
    try {
      const backup = await f.install();
      assert.equal(path.dirname(backup), f.directory);
      assert.match(path.basename(backup), /^\.AgentC2-previous-[a-f0-9-]+\.app$/);
      assert.equal(f.calls.some((call) => call.file === '/bin/sh'), false);
      assert.match(f.calls.at(-1).args[1], /with administrator privileges$/);
      await f.cleaned();
    } finally { await f.close(); }
  }
  for (const options of [
    { identity: 'other.application' }, { version: '0.4.3' },
    ...['/usr/bin/ditto', '/usr/bin/codesign', '/usr/libexec/PlistBuddy', '/usr/bin/osascript'].map((failAt) => ({ failAt, failure: new Error('Native command rejected'), ...(failAt === '/usr/bin/osascript' ? { accessError: Object.assign(new Error('Not writable'), { code: 'EACCES' }) } : {}) })),
    { accessError: Object.assign(new Error('Preflight failed'), { code: 'EIO' }) },
  ]) {
    const f = await fixture(options);
    try {
      await assert.rejects(f.install(), options.failure || options.accessError || /identity or version/);
      if (!options.accessError) assert.equal(f.calls.some((call) => call.file === '/bin/sh' || call.file === '/usr/bin/osascript'), false);
      await f.cleaned();
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    await f.install();
    const command = f.calls.at(-1);
    assert.equal(command.file, '/bin/sh');
    assert.equal(command.args[0], '-c');
    assert.ok(command.args[1].includes("'\"'\"'"), 'Apostrophes in app paths require shell quoting');
    assert.match(command.args[1], /else\n  \/bin\/mv .*\n  exit 1\nfi$/);
    await f.cleaned();
    const updater = f.createMacUpdater(f.app, { bundle: f.bundle });
    await assert.rejects(updater.quitAndInstall(), /No verified Mac update/);
    updater.emit('update-downloaded', {});
    await assert.rejects(updater.quitAndInstall(), /No verified Mac update/);
    updater.emit('update-downloaded', { downloadedFile: f.archive, version: '0.4.2' });
    await updater.quitAndInstall();
    assert.deepEqual(f.lifecycle, ['close server', 'relaunch', 'quit']);
    await f.cleaned();
  } finally { await f.close(); }
  for (const signature of [{ status: 1, stderr: 'Signature=adhoc' }, { status: 0 }, { status: 0, stderr: 'Authority=Trusted publisher' }]) {
    const f = await fixture({ signature });
    try {
      const updater = f.createMacUpdater(f.app);
      assert.equal(updater, f.instances[0]);
      updater.quitAndInstall();
      assert.deepEqual(f.lifecycle, ['native installer']);
    } finally { await f.close(); }
  }
  console.log('PASS Mac archive validation/cleanup, quoting/rollback command, directory-only elevation, no elevated installation retries, native signature routing, verified download guards, and restart ordering');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
