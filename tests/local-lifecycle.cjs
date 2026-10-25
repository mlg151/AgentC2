// Production service/helper on localhost with a private HOME and tmux server.
// No SSH daemon, provider credentials, or model calls are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const local = require('../electron/local.cjs');

(async () => {
  const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  const tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-local-lifecycle-'));
  const home = path.join(directory, 'home');
  const emptyPath = path.join(directory, 'empty-bin');
  fs.mkdirSync(home); fs.mkdirSync(emptyPath);
  const env = { HOME: home, PATH: emptyPath, TMUX_TMPDIR: directory, LANG: 'C.UTF-8' };
  const filename = path.resolve(__dirname, '../electron/service.cjs');
  const load = createRequire(filename);
  const moduleFixture = { exports: {} };
  let missingPython = false;
  const fixtureRequire = (name) => {
    if (name === 'node-pty') return {};
    if (name === './local.cjs') return { ...local, localCommand: (command, args) => {
      assert.equal(command, 'python3');
      return { binary: missingPython ? path.join(emptyPath, 'python3') : python, args, env: { ...env } };
    } };
    if (name === 'node:child_process') return { spawn: (binary, args, options) => {
      assert.notEqual(path.basename(binary), 'ssh', 'Local execution must not invoke SSH');
      return spawn(binary, args, options);
    } };
    return load(name);
  };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', '__dirname'], { filename, parsingContext: vm.createContext({ process, console, Buffer, setTimeout, clearTimeout }) })(fixtureRequire, moduleFixture, path.dirname(filename));
  let service;
  try {
    service = moduleFixture.exports.createService({ directory: path.join(directory, 'store'), home });
    service.store.save('settings', { ...service.store.data.settings, hosts: [{ id: 'local', kind: 'local', name: 'Local fixture', enabled: true }] });
    const input = { hostId: 'local', provider: 'terminal', transport: 'terminal', cwd: home, title: 'Local lifecycle fixture' };
    let snapshot = await service.inventory();
    assert.equal(snapshot.hosts[0].connected, false);
    assert.match(snapshot.hosts[0].error, /tmux is required on this computer.*Install tmux/);
    await assert.rejects(service.create(input), /tmux is required/);
    service.chats.capabilities = async () => { throw new Error('Missing tmux must fail before provider setup'); };
    await assert.rejects(service.create({ ...input, provider: 'codex', transport: 'chat' }), /tmux is required/);
    assert.equal(fs.existsSync(path.join(home, '.cache', 'agent-hq')), false);
    missingPython = true;
    await assert.rejects(service.create(input), /requires Python 3.10\+ and tmux/);
    missingPython = false;
    // Install a discoverable executable and retry on the same service instance.
    const userBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(userBin, { recursive: true });
    fs.symlinkSync(tmux, path.join(userBin, 'tmux'));
    const resolved = local.localCommand('tmux', ['-V'], 'linux', env);
    assert.match(execFileSync(resolved.binary, resolved.args, { env: resolved.env, encoding: 'utf8' }), /^tmux /);
    env.PATH = resolved.env.PATH;
    snapshot = await service.inventory();
    assert.equal(snapshot.hosts[0].connected, true, snapshot.hosts[0].error);
    const created = await service.create(input);
    snapshot = await service.inventory();
    assert.ok(snapshot.sessions.some((session) => session.id === created.name && session.managed && session.hostId === 'local'));
    execFileSync(tmux, ['send-keys', '-t', created.name, 'printf "localhost-regression-ok\\n"', 'Enter'], { env });
    let history;
    for (let attempt = 0; attempt < 30; attempt++) {
      history = await service.searchHistory('localhost-regression-ok', [`local/tmux:${created.name}`]);
      if (history.matches.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(history.matches.length, 'Read actual local terminal history through the service');
    await service.action({ id: 'desktop' }, 'stop', created.name, 'local');
    snapshot = await service.inventory();
    assert.equal(snapshot.sessions.some((session) => session.id === created.name), false);
    console.log('PASS localhost missing tmux/Python preflight, terminal/chat failures, same-instance retry, real terminal inventory/history/stop, and SSH isolation');
  } finally {
    service?.centcom.dispose();
    if (service) await service.flashQueue().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    service?.specops.dispose();
    service?.tunnels.closeAll();
    try { execFileSync(tmux, ['-S', path.join(directory, `tmux-${process.getuid()}`, 'default'), 'kill-server'], { env, stdio: 'ignore' }); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
