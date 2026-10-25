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
  assert.equal(sshBinary('linux'), 'ssh');
  assert.equal(appDataDirectory('linux', {}, '/home/qa'), path.join('/home/qa', '.config'));
  assert.equal(appDataDirectory('linux', { XDG_CONFIG_HOME: '/config' }, '/home/qa'), '/config');
  assert.equal(appDataDirectory('darwin', {}, '/Users/qa'), path.join('/Users/qa', 'Library', 'Application Support'));
  assert.equal(appDataDirectory('win32', {}, '/fixture/home'), path.join('/fixture/home', 'AppData', 'Roaming'));
  assert.equal(appDataDirectory('win32', { APPDATA: '/fixture/roaming' }, '/fixture/home'), '/fixture/roaming');
  assert.deepEqual(tailscaleBinaries('win32', {}), ['C:\\Program Files\\Tailscale\\tailscale.exe']);
  assert.deepEqual(tailscaleBinaries('win32', { ProgramFiles: 'D:\\Programs' }), ['D:\\Programs\\Tailscale\\tailscale.exe']);
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
