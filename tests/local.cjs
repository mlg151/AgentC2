const assert = require('node:assert/strict');
const { localCommand, connectionKey, localPayload } = require('../electron/local.cjs');
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
  for (const platform of ['linux', 'darwin']) {
    const execution = localCommand('python3', [], platform, { HOME: '/fixture', PATH: '/usr/bin:/fixture/bin:/usr/bin' });
    const entries = execution.env.PATH.split(':');
    assert.equal(entries.length, new Set(entries).size);
    assert.deepEqual(entries.slice(0, 2), ['/usr/bin', '/fixture/bin']);
    for (const directory of ['/fixture/.local/bin', '/fixture/.nix-profile/bin', '/nix/var/nix/profiles/default/bin', '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin', '/snap/bin']) assert.ok(entries.includes(directory), directory);
  }
  const windows = localCommand('tmux', ['attach-session', '-t', 'hq-fixture'], 'win32', { SystemRoot: 'D:\\Windows' });
  assert.deepEqual([windows.binary, ...windows.args], ['D:\\Windows\\System32\\wsl.exe', '--exec', 'tmux', 'attach-session', '-t', 'hq-fixture']);
  const paths = new Map([
    ['C:\\', '/drives/c/'],
    ['C:\\Users\\Matthew\\', '/drives/c/Users/Matthew/'],
    ['D:/Project Folder/', '/drives/d/Project Folder/'],
    ["C:\\Project 'quoted' & $(literal)\\", "/drives/c/Project 'quoted' & $(literal)/"],
    ['C:\\Users\\Mátthéw\\', '/drives/c/Users/Mátthéw/'],
  ]);
  const convertedPaths = [];
  const options = { platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, execute: (binary, args, settings, callback) => {
    assert.equal(binary, 'D:\\Windows\\System32\\wsl.exe');
    assert.deepEqual(args.slice(0, 4), ['--exec', 'wslpath', '-a', '-u']);
    assert.equal(args.length, 5, 'A path stays one argument, without shell evaluation');
    assert.equal(settings.windowsHide, true);
    assert.equal(settings.timeout, 10000);
    convertedPaths.push(args[4]);
    callback(null, paths.get(args[4]) + '\n');
  } };
  for (const [cwd, expected] of paths) {
    const input = { action: 'create', provider: 'codex', cwd, title: cwd, instructions: cwd };
    for (const transport of ['chat', 'terminal']) {
      const actual = await localPayload({ ...input, transport }, options);
      assert.equal(actual.cwd, expected);
      assert.equal(actual.title, cwd); assert.equal(actual.instructions, cwd);
      assert.equal(input.cwd, cwd, 'Do not rewrite saved launch data');
    }
  }
  assert.equal((await localPayload({ action: 'worktree_launch', repository: 'C:\\', cwd: '' }, options)).repository, '/drives/c/');
  const noConversion = { ...options, execute: () => { throw Error('Unexpected conversion'); } };
  for (const cwd of ['', '/home/fixture/repo', '~/repo', '/mnt/c/Users/fixture']) assert.equal((await localPayload({ cwd }, noConversion)).cwd, cwd);
  for (const platform of ['linux', 'darwin']) {
    const input = { cwd: 'C:\\' };
    assert.equal(await localPayload(input, { ...noConversion, platform }), input);
  }
  for (const [error, output] of [[Error('WSL unavailable'), ''], [null, ''], [null, 'relative/path\n'], [null, '/path\nextra\n']]) {
    await assert.rejects(localPayload({ cwd: 'C:\\' }, { ...options, execute: (_binary, _args, _settings, callback) => callback(error, output) }), /Could not resolve local cwd in WSL/);
  }
  await assert.rejects(localPayload({ cwd: 'C:\\\0bad' }, noConversion), /null characters/);
  assert.equal((await localPayload({ cwd: 'C:\\' }, options)).cwd, '/drives/c/', 'A failed conversion does not poison the next launch');
  assert.ok(convertedPaths.length > paths.size);
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
