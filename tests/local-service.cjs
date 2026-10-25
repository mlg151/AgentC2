// Exercise the service boundary with deterministic WSL and helper processes.
// Native WSL execution is covered separately by windows-local.e2e.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const local = require('../electron/local.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-local-service-'));
  const filename = path.resolve(__dirname, '../electron/service.cjs');
  const load = createRequire(filename);
  const calls = [], conversions = [];
  let failure = '', service;
  let fixtureSessions = [];
  const exports = { exports: {} };
  const options = { platform: 'win32', execute: (_binary, args, _settings, callback) => {
    conversions.push(args.at(-1));
    callback(failure === 'conversion' ? Error('WSL unavailable') : null, '/custom/c/Users/Example Folder/\n');
  } };
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.end = (source) => queueMicrotask(() => {
      if (failure === 'spawn') { child.emit('error', Error('WSL could not start')); return; }
      const encoded = /^AGENTC2_PAYLOAD_B64 = '([^']+)'/.exec(source)?.[1] || args.at(-1);
      const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      calls.push({ binary, payload });
      child.stdout.emit('data', JSON.stringify(failure === 'helper' ? { ok: false, error: 'The working directory does not exist' } : { ok: true, result: payload.action === 'inventory' ? { user: 'fixture', sessions: fixtureSessions } : { name: 'hq-123456abcdef' } }));
      child.emit('close', 0);
    });
    return child;
  };
  const requireFixture = (name) => name === 'node:child_process' ? { spawn } : name === 'node-pty' ? {} : name === './local.cjs' ? { ...local, localPayload: (payload) => local.localPayload(payload, options) } : load(name);
  vm.runInNewContext('(function(require,module,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', { process, console, Buffer, setTimeout, clearTimeout })(requireFixture, exports, path.dirname(filename));
  try {
    service = exports.exports.createService({ directory, home: os.homedir() });
    assert.ok(fs.existsSync(path.join(directory, 'centcom/centcom.json')), 'Commander state must stay inside the isolated service directory');
    service.store.save('settings', { ...service.store.data.settings, hosts: [{ id: 'local', kind: 'local', name: 'Local', enabled: true }, { id: 'ssh', name: 'SSH', target: 'fixture.invalid', port: 22, enabled: true }] });
    const input = { provider: 'codex', transport: 'terminal', hostId: 'local', cwd: 'C:\\Users\\Example Folder\\' };
    service.chats.capabilities = async () => [{ provider: 'codex', status: 'supported' }];
    await service.create({ ...input, transport: 'chat' });
    assert.equal(calls.find((call) => call.payload.transport === 'chat').payload.cwd, '/custom/c/Users/Example Folder/');
    await service.create(input);
    assert.equal(calls.find((call) => call.payload.action === 'create').payload.cwd, '/custom/c/Users/Example Folder/');
    assert.equal(calls.find((call) => call.payload.action === 'create').payload.localHost, true);
    assert.equal(input.cwd, 'C:\\Users\\Example Folder\\');
    const count = conversions.length;
    await service.create({ ...input, hostId: 'ssh' });
    assert.equal(calls.filter((call) => call.payload.action === 'create').at(-1).payload.localHost, undefined);
    assert.equal(conversions.length, count, 'SSH must not perform local path conversion');
    assert.equal(calls.filter((call) => call.payload.action === 'create').at(-1).payload.cwd, input.cwd);
    // Let the background inventory settle before deliberately failing a child.
    await service.inventory();
    for (const kind of ['conversion', 'spawn', 'helper']) {
      failure = kind;
      await assert.rejects(service.create(input), kind === 'conversion' ? /Could not resolve local cwd/ : kind === 'spawn' ? /WSL could not start/ : /working directory does not exist/);
      failure = '';
      assert.equal((await service.create(input)).name, 'hq-123456abcdef', 'The service must remain usable after startup failure');
      await service.inventory();
    }
    const managedName = 'hq-0123456789ab', sessionId = 'chat-' + 'a'.repeat(32);
    fixtureSessions = [{ key: `tmux:${managedName}`, id: managedName, provider: 'codex', kind: 'managed', managed: true, state: 'live', transport: 'chat', chatSessionId: sessionId }];
    await service.inventory();
    const desktop = { id: 'desktop' }, phone = { id: 'phone' };
    const record = { hostId: 'local', sessionId, owner: desktop, connection: 'connected', handles: new Set(['desktop-view', 'phone-view']), queue: Promise.resolve() };
    service.chats.sessions.set(`local/${sessionId}`, record);
    service.chats.handles.set('desktop-view', { client: desktop, record });
    service.chats.handles.set('phone-view', { client: phone, record });
    let routed = 0;
    service.centcom.isCommander = () => true;
    service.centcom.submitCommand = async (_client, _handle, command) => { routed++; return { commandId: command.commandId, sessionId, state: 'completed' }; };
    await assert.rejects(service.action(phone, 'stop', managedName, 'local'), /Take control/);
    assert.equal(routed, 0, 'An observer must not cancel a commander turn through session actions');
    assert.equal((await service.action(desktop, 'stop', managedName, 'local')).state, 'completed');
    assert.equal(routed, 1, 'Authorized session actions must use the shared commander cancellation route');
    service.chats.handles.clear(); service.chats.sessions.clear();
    fixtureSessions = [];
    console.log('PASS service path conversion, SSH isolation, WSL/helper error rejection, and successful retry');
  } finally {
    service?.specops?.dispose();
    service?.tunnels.closeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
