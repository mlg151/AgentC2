const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { appDataDirectory, sshBinary, tailscaleBinaries, tailscaleStatus, closeAction } = require('../electron/platform.cjs');
const { checkVersion } = require('../scripts/check-version.cjs');
const { packagePath } = require('../scripts/package-path.cjs');

(async () => {
  assert.equal(sshBinary('win32', {}), 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  assert.equal(sshBinary('darwin', { PATH: '/nothing' }), '/usr/bin/ssh');
  assert.equal(sshBinary('linux', {}), 'ssh');
  assert.equal(sshBinary('win32', { AGENTC2_SSH_BINARY: 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe' }), 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe');
  assert.equal(sshBinary('linux', { AGENTC2_SSH_BINARY: '/opt/ssh/bin/ssh' }), '/opt/ssh/bin/ssh');
  for (const binary of ['ssh', '/opt/ssh\0ignored', true]) assert.throws(() => sshBinary('linux', { AGENTC2_SSH_BINARY: binary }), /absolute executable path/);
  assert.equal(sshBinary(), sshBinary(process.platform, process.env));
  assert.equal(appDataDirectory('linux', {}, '/home/qa'), path.join('/home/qa', '.config'));
  assert.equal(appDataDirectory('linux', { XDG_CONFIG_HOME: '/config' }, '/home/qa'), '/config');
  assert.equal(appDataDirectory('darwin', {}, '/Users/qa'), path.join('/Users/qa', 'Library', 'Application Support'));
  assert.equal(appDataDirectory('win32', {}, '/fixture/home'), path.join('/fixture/home', 'AppData', 'Roaming'));
  assert.equal(appDataDirectory('win32', { APPDATA: '/fixture/roaming' }, '/fixture/home'), '/fixture/roaming');
  assert.deepEqual(tailscaleBinaries('win32', {}), ['C:\\Program Files\\Tailscale\\tailscale.exe']);
  assert.deepEqual(tailscaleBinaries('win32', { ProgramFiles: 'D:\\Programs' }), ['D:\\Programs\\Tailscale\\tailscale.exe']);
  assert.deepEqual(tailscaleBinaries(), tailscaleBinaries(process.platform, process.env));
  assert.equal(closeAction({ quitting: false, remoteEnabled: true, hasTray: true }), process.platform === 'linux' ? 'minimize' : 'hide');
  // Capture the module's normal execFile dependency before loading it in a
  // child; default options are exercised without reading the user's tailnet.
  const defaultStatus = JSON.parse(execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    require('node:child_process').execFile = (file, args, options, done) => {
      assert.ok(file); assert.deepEqual(args, ['status', '--json']);
      assert.equal(options.env.TAILSCALE_BE_CLI, '1');
      done(null, '{}');
    };
    require(process.argv[1]).tailscaleStatus().then((value) => process.stdout.write(JSON.stringify(value))).catch((error) => { console.error(error); process.exitCode = 1; });
  `, require.resolve('../electron/platform.cjs')], { encoding: 'utf8' }));
  assert.deepEqual(defaultStatus, { installed: true, state: 'Unavailable', url: '', error: '' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-platform-'));
  try {
    fs.writeFileSync(path.join(directory, 'remote-access.json'), JSON.stringify({ enabled: true, url: 'https://qa.example.ts.net' }));
    const invitation = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pair-companion.cjs')], { env: { ...process.env, AGENTC2_DATA_DIR: directory, APPDATA: '' }, encoding: 'utf8' }));
    assert.equal(new URL(invitation.url).origin, 'https://qa.example.ts.net');
    assert.ok(fs.existsSync(path.join(directory, 'companion-invitation.json')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const calls = [];
  const status = await tailscaleStatus({ platform: 'darwin', execute: (file, args, options, done) => {
    calls.push(file);
    assert.deepEqual(args, ['status', '--json']); assert.equal(options.timeout, 8000); assert.equal(options.env.TAILSCALE_BE_CLI, '1');
    if (calls.length < 3) done(Object.assign(new Error('missing'), { code: 'ENOENT' }), '');
    else done(null, JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desktop.example.ts.net.' } }));
  } });
  assert.deepEqual(calls, tailscaleBinaries('darwin').slice(0, 3));
  assert.deepEqual(status, { installed: true, state: 'Running', url: 'https://desktop.example.ts.net', error: '' });
  const missing = await tailscaleStatus({ platform: 'linux', execute: (_file, _args, _options, done) => done(Object.assign(new Error('missing'), { code: 'ENOENT' }), '') });
  assert.equal(missing.installed, false);
  const stopped = await tailscaleStatus({ execute: (_file, _args, _options, done) => done(new Error('not signed in'), '{}') });
  assert.equal(stopped.installed, true); assert.ok(stopped.error);
  const malformed = await tailscaleStatus({ execute: (_file, _args, _options, done) => done(null, 'invalid fixture JSON') });
  assert.deepEqual(malformed, { installed: true, state: 'Unavailable', url: '', error: 'Start Tailscale and sign in on your computer and phone.' });
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(closeAction({ platform, quitting: true, remoteEnabled: true, hasTray: true }), 'close');
    assert.equal(closeAction({ platform, remoteEnabled: false, hasTray: true }), 'close');
    assert.equal(closeAction({ platform, remoteEnabled: true, hasTray: true }), platform === 'linux' ? 'minimize' : 'hide');
    assert.equal(closeAction({ platform, remoteEnabled: true, hasTray: false }), platform === 'darwin' ? 'hide' : 'minimize');
  }
  const version = checkVersion();
  assert.equal(checkVersion(`refs/tags/v${version}`), version);
  assert.throws(() => checkVersion('refs/tags/v0.0.0'), /Release tag/);
  assert.ok(packagePath('/build', 'darwin', 'arm64').endsWith(path.join('mac-arm64', 'AgentC2.app', 'Contents', 'MacOS', 'AgentC2')));
  for (const name of ['app-icon.ico', 'app-icon.png', 'app-icon.icns', 'trayTemplate.png', 'trayTemplate@2x.png']) assert.ok(fs.statSync(path.join(__dirname, '..', 'assets', name)).size > 0);
  console.log('PASS platform SSH discovery, Finder Tailscale fallback, tray recovery policy, icons, and release version guard');
})().catch((error) => { console.error(error); process.exitCode = 1; });
