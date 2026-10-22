const assert = require('node:assert/strict');
const { localCommand, connectionKey } = require('../electron/local.cjs');
const { defaults, validateSettings } = require('../electron/config.cjs');
const { Tunnels } = require('../electron/tunnels.cjs');

(async () => {
  const original = defaults();
  assert.equal(validateSettings(original).hosts[0].kind, undefined, 'Legacy hosts retain SSH execution');
  const settings = validateSettings({ ...original, hosts: [{ id: 'local', kind: 'local', name: 'This computer', enabled: true }] });
  assert.equal(settings.hosts[0].target, 'localhost');
  assert.equal(settings.hosts[0].port, 22);
  assert.throws(() => validateSettings({ ...original, hosts: [{ ...original.hosts[0], kind: 'other' }] }), /connection type/);
  assert.throws(() => validateSettings({ ...settings, hosts: [...settings.hosts, { ...settings.hosts[0], id: 'duplicate' }] }), /one local host/);
  assert.notEqual(connectionKey(settings.hosts[0]), connectionKey({ target: 'localhost', port: 22 }));
  assert.equal(connectionKey({ target: 'localhost', port: 22 }), connectionKey({ kind: 'ssh', target: 'localhost', port: 22 }));
  const linux = localCommand('python3', ['-', 'payload'], 'linux', { HOME: '/fixture', PATH: '/fixture/bin', PRIVATE_TEST: 'preserved' });
  assert.deepEqual([linux.binary, ...linux.args], ['python3', '-', 'payload']);
  assert.equal(linux.env.PRIVATE_TEST, 'preserved');
  assert.ok(linux.env.PATH.startsWith('/fixture/bin:'));
  const windows = localCommand('tmux', ['attach-session', '-t', 'hq-fixture'], 'win32', { SystemRoot: 'D:\\Windows' });
  assert.deepEqual([windows.binary, ...windows.args], ['D:\\Windows\\System32\\wsl.exe', '--exec', 'tmux', 'attach-session', '-t', 'hq-fixture']);
  const tunnels = new Tunnels({ binary: 'must-not-run', argsForHost: () => { throw Error('SSH requested'); }, onUpdate: () => {} });
  const local = settings.hosts[0];
  for (const url of ['http://localhost:3000/p?q=1', 'https://[::1]:8443/preview']) {
    assert.equal(await tunnels.open(local, 'local/tmux:fixture', url), url);
    assert.ok(tunnels.list('local/tmux:fixture').some((item) => item.localUrl === url));
  }
  await assert.rejects(() => tunnels.open(local, 'local/tmux:fixture', 'http://example.com:3000'), /loopback/);
  tunnels.release('local/tmux:fixture'); assert.equal(tunnels.records.size, 0); tunnels.closeAll();
  console.log('PASS local/SSH configuration isolation, native/WSL invocation, and direct scoped loopback URLs');
})().catch((error) => { console.error(error); process.exitCode = 1; });
