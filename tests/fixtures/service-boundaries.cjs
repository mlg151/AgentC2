const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('../../electron/config.cjs');
const { loadCommonJs } = require('../helpers/load-commonjs.cjs');

function serviceFixture(seed = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-service-boundary-'));
  const saved = new Store(directory);
  saved.save('settings', { ...saved.data.settings, hosts: [{ id: 'default', name: 'Fixture host', target: 'fixture.invalid', port: 22, enabled: true }, { id: 'local', name: 'Local fixture', kind: 'local', enabled: true }, { id: 'disabled', name: 'Disabled', target: 'disabled.invalid', port: 22, enabled: false }] });
  seed(saved);
  let now = 1800000000000;
  const calls = [], timers = new Map();
  let adapters;
  let handler = (request) => request.respond(request.payload.action === 'inventory' ? { user: 'fixture', sessions: [] } : {});
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    const request = { binary, args, child, payload: null, kills: 0, respond(result) { child.stdout.emit('data', JSON.stringify({ ok: true, result })); child.emit('close', 0); }, fail(code, error = '') { child.stderr.emit('data', error); child.emit('close', code); } };
    child.kill = () => { request.kills++; queueMicrotask(() => child.emit('close', 143)); };
    child.stdin.end = (source) => {
      const embedded = /^AGENTC2_PAYLOAD_B64 = '([^']+)'/.exec(source)?.[1];
      request.payload = JSON.parse(Buffer.from(embedded || args.at(-1), 'base64').toString('utf8'));
      request.embedded = Boolean(embedded);
      calls.push(request);
      queueMicrotask(() => handler(request));
    };
    return child;
  };
  class Clock extends Date { static now() { return now; } }
  const commander = require('../../electron/commander.cjs');
  const { createService } = loadCommonJs('electron/service.cjs', { './commander.cjs': { ...commander, commanderFacade(input) { adapters = input; return commander.commanderFacade(input); } }, 'node:child_process': { spawn }, 'node-pty': { spawn() { throw Error('A read-only boundary test attempted a native terminal'); } } }, {
    Date: Clock,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.set(timer, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const service = createService({ directory, home: directory });
  return { service, adapters, directory, calls, timers, setHandler(next) { handler = next; }, advance(milliseconds) { now += milliseconds; },
    close() { service.centcom.dispose(); service.specops.dispose(); service.chats.closeAll(); service.terminals.closeAll(); service.tunnels.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
module.exports = { serviceFixture };
