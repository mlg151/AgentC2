const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { WebSocket } = require('ws');
const { Gateway } = require('../electron/gateway.cjs');
const { Terminals } = require('../electron/terminals.cjs');
const { createService } = require('../electron/service.cjs');

class FakePty extends EventEmitter {
  constructor() { super(); this.writes = []; this.sizes = []; this.killed = false; }
  onData(fn) { this.on('data', fn); }
  onExit(fn) { this.on('exit', fn); }
  write(data) { this.writes.push(data); this.emit('data', data); }
  resize(cols, rows) { this.sizes.push({ cols, rows }); }
  kill() { this.killed = true; this.emit('exit', { exitCode: 0 }); }
}
function fixture(directory) {
  const service = createService({ directory, home: os.homedir() });
  const events = service.events;
  const ptys = [];
  let creates = 0, actions = 0;
  const terminals = new Terminals({
    spawn: () => { const terminal = new FakePty(); ptys.push(terminal); return terminal; },
    configure: async () => {}, history: async () => ({ text: 'HISTORY_OLD\nHISTORY_NEW', truncated: false }), scroll: async () => {},
    emit: (id, event, value) => events.emit('client', id, event, value),
  });
  Object.assign(service, {
    events, terminals,
    inventory: async () => ({ hosts: [], sessions: [], attention: [] }), health: async () => [], hostId: (id) => id || 'default', acknowledge: () => [],
    create: async () => { creates++; return { name: 'hq-fixture' }; },
    action: (client, action, name, hostId) => { terminals.assertSessionOwner(client, name, hostId); actions++; return { action }; },
  });
  const gateway = new Gateway({ directory, service, assets: path.join(__dirname, '..', 'dist'), secure: false });
  return { gateway, service, terminals, ptys, counts: () => ({ creates, actions }) };
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function connect(url, cookie, origin = url) {
  const ws = new WebSocket(url.replace('http', 'ws') + '/api/v1/socket', { headers: { Cookie: cookie, Origin: origin } });
  const requests = new Map(), messages = [];
  ws.on('message', (buffer) => { const value = JSON.parse(buffer); messages.push(value); const request = requests.get(value.id); if (request) { requests.delete(value.id); value.error ? request.reject(new Error(value.error)) : request.resolve(value.result); } });
  await once(ws, 'open');
  return { ws, messages, request(method, args = [], id = crypto.randomUUID()) { return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, args })); }); } };
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-remote-test-'));
  const { gateway, service, terminals, ptys, counts } = fixture(directory);
  const sockets = [];
  let secureGateway;
  try {
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    assert.equal(gateway.status().enabled, false);
    await gateway.configure({ enabled: true, port, url });
    assert.equal(gateway.server.address().address, '127.0.0.1');
    assert.equal((await fetch(url + '/api/v1/state')).status, 401);
    assert.equal((await fetch(url + '/api/v1/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(url + '/companion.html', { headers: { 'Tailscale-Funnel-Request': '?1' } })).status, 403);
    assert.equal((await fetch(url + '/index.html')).status, 404);
    assert.equal((await fetch(url + '/electron/main.cjs')).status, 404);
    assert.equal((await fetch(url + '/companion.html')).status, 200);
    const worker = await fetch(url + '/companion-sw.js');
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get('cache-control'), 'no-store');
    assert.ok((await worker.text()).includes("url.origin !== self.location.origin"));
    const pair = gateway.pair();
    const secret = new URL(pair.url).hash.slice('#pair='.length);
    const pairRequest = (token) => fetch(url + '/api/v1/pair', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: 'Test phone' }) });
    const response = await pairRequest(secret);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(response.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.equal((await pairRequest(secret)).status, 401);
    assert.equal((await fetch(url + '/api/v1/state', { headers: { Cookie: cookie } })).status, 200);
    assert.ok(!fs.readFileSync(gateway.file, 'utf8').includes(secret));
    assert.ok(!fs.readFileSync(gateway.file, 'utf8').includes(cookie.split('=')[1]));
    console.log('PASS loopback binding, authenticated state, origin checks, static-file allowlist, single-use pairing, and hashed credentials');
    const expired = gateway.pair();
    const invitation = JSON.parse(fs.readFileSync(gateway.pairing.file, 'utf8'));
    invitation.expiresAt = Date.now() - 1;
    fs.writeFileSync(gateway.pairing.file, JSON.stringify(invitation));
    assert.equal((await pairRequest(new URL(expired.url).hash.slice(6))).status, 401);
    const a = await connect(url, cookie); sockets.push(a.ws);
    const b = await connect(url, cookie); sockets.push(b.ws);
    await assert.rejects(connect(url, cookie, 'https://evil.example'), /401/);
    await assert.rejects(connect(url, ''), /401/);
    const desktop = { id: 'desktop', name: 'Desktop' };
    const desktopHandle = await terminals.open(desktop, 'hq-fixture', 'default', 100, 30);
    const aHandle = await a.request('terminal:open', ['hq-fixture', 40, 20, 'default']);
    const bHandle = await b.request('terminal:open', ['hq-fixture', 60, 25, 'default']);
    assert.equal(ptys.length, 1);
    assert.equal((await a.request('terminal:state', [aHandle])).canControl, false);
    const key = 'default/tmux:hq-fixture';
    service.store.save('workspace', { tabs: [key], selectedKey: key, splitKey: null, metadata: { [key]: { pinned: false, project: 'Pin QA', notes: 'Preserve me' } } });
    const stale = structuredClone(service.store.data.workspace);
    const pinEvents = [];
    service.events.on('session:pinned', (...args) => pinEvents.push(args));
    await a.request('session:pin', [key, true]);
    await a.request('session:pin', [key, true]);
    assert.equal((await b.request('state')).metadata[key].pinned, true);
    assert.ok(b.messages.some((message) => message.event === 'state:updated' && message.value.metadata[key]?.pinned));
    assert.deepEqual(pinEvents.at(-1), [key, true]);
    assert.equal(terminals.state(desktop, desktopHandle).canControl, true);
    stale.metadata[key].notes = 'Desktop notes edited concurrently';
    service.saveWorkspace(stale);
    assert.equal((await a.request('state')).metadata[key].pinned, true);
    assert.equal((await a.request('state')).metadata[key].notes, stale.metadata[key].notes);
    await b.request('session:pin', [key, false]);
    assert.equal((await a.request('state')).metadata[key].pinned, false);
    for (const args of [[key, 'true'], ['default/tmux:unknown', true], ['foreign/tmux:hq-fixture', true], ['default/tmux:../bad', true]]) await assert.rejects(a.request('session:pin', args), /Invalid session pin|unavailable/);
    assert.equal(service.store.data.workspace.metadata[key].project, 'Pin QA');
    console.log('PASS authenticated pin edits without terminal ownership, broadcasts to other devices/desktop, stale-save protection, and scoped pin validation');
    await assert.rejects(a.request('terminal:write', [aHandle, 'no']), /Take control/);
    await assert.rejects(b.request('terminal:state', [aHandle]), /disconnected/);
    await a.request('terminal:resize', [aHandle, 30, 10]); assert.equal(ptys[0].sizes.length, 0);
    await a.request('terminal:take', [aHandle]);
    await assert.rejects(terminals.write(desktop, desktopHandle, 'no'), /Take control/);
    await assert.rejects(a.request('saveSettings', [{}]), /Unsupported/);
    await assert.rejects(a.request('cleanup:preview', [{ hostId: 'default', provider: 'claude', days: 30 }]), /Unsupported/);
    await assert.rejects(a.request('cleanup:execute', ['unknown', []]), /Unsupported/);
    await a.request('terminal:write', [aHandle, 'HQ_PHONE_OUTPUT\r\n']);
    const snapshot = await b.request('terminal:ready', [bHandle]);
    assert.ok(snapshot.text.includes('HQ_PHONE_OUTPUT'));
    const history = await a.request('terminal:history', [aHandle]); assert.ok(history.text.includes('HISTORY_OLD'));
    await a.request('terminal:resize', [aHandle, 50, 20]); await terminals.sessions.get('default/hq-fixture').queue;
    assert.deepEqual(ptys[0].sizes.at(-1), { cols: 50, rows: 20 });
    await a.request('terminal:write', [aHandle, 'NEXT_OUTPUT']);
    await terminals.sessions.get('default/hq-fixture').queue;
    for (let i = 0; i < 30 && !b.messages.some((item) => item.event === 'terminal:data' && item.value.data === 'NEXT_OUTPUT'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(b.messages.some((item) => item.event === 'terminal:data' && item.value.sequence > snapshot.sequence && item.value.data === 'NEXT_OUTPUT'));
    await terminals.take(desktop, desktopHandle);
    await assert.rejects(a.request('interrupt', ['hq-fixture', 'default']), /Take control/);
    await a.request('terminal:take', [aHandle]);
    const actionId = crypto.randomUUID();
    await a.request('interrupt', ['hq-fixture', 'default'], actionId);
    await a.request('interrupt', ['hq-fixture', 'default'], actionId);
    assert.equal(counts().actions, 1);
    const requestId = crypto.randomUUID();
    const created = await a.request('create', [{}], requestId);
    assert.deepEqual(await a.request('create', [{}], requestId), created);
    await assert.rejects(a.request('create', [{ changed: true }], requestId), /already used/);
    assert.equal(counts().creates, 1);
    await a.request('terminal:close', [aHandle]);
    assert.equal(ptys[0].killed, false);
    assert.equal(terminals.state(desktop, desktopHandle).controller, null);
    assert.equal((await b.request('terminal:state', [bHandle])).canControl, false);
    console.log('PASS shared PTY, server-enforced control handoff, observer resize isolation, snapshot/output sequencing, scoped handles, and lifecycle deduplication');
    await b.request('terminal:take', [bHandle]);
    const deviceId = gateway.data.devices[0].id;
    const closed = once(b.ws, 'close'); gateway.revoke(deviceId); await closed;
    assert.equal(terminals.state(desktop, desktopHandle).controller, null);
    assert.equal(ptys[0].killed, false);
    assert.equal((await fetch(url + '/api/v1/state', { headers: { Cookie: cookie } })).status, 401);
    terminals.close(desktop, desktopHandle); assert.equal(ptys[0].killed, true);
    const restored = fixture(directory);
    assert.equal(restored.gateway.data.requests.length, 3);
    const savedCreate = restored.gateway.data.requests.find((entry) => entry.key.endsWith('/' + requestId));
    assert.deepEqual(await restored.gateway.once({ id: deviceId }, { id: requestId, method: 'create', args: [{}] }, () => { throw new Error('Must not repeat after restart'); }), created);
    savedCreate.done = false;
    await assert.rejects(restored.gateway.once({ id: deviceId }, { id: requestId, method: 'create', args: [{}] }, () => {}), /outcome is unknown/);
    await restored.gateway.dispose();
    const attempts = gateway.attempts.values().next().value; attempts.count = 10;
    assert.equal((await pairRequest('invalid')).status, 429);
    await gateway.configure({ enabled: false, port, url }); assert.equal(gateway.server, null);
    console.log('PASS revocation disconnects devices and releases control, last-view cleanup, persisted request ledger, pairing rate limit, and gateway shutdown');
    // A client that disconnects while SSH is connecting must not leak a PTY.
    let release;
    const slow = new Terminals({ configure: () => new Promise((resolve) => { release = resolve; }), spawn: () => new FakePty(), history: () => {}, scroll: () => {}, emit: () => {} });
    const client = { id: 'web:slow', name: 'Slow phone' };
    const opening = slow.open(client, 'slow', 'default', 80, 24);
    slow.disconnect(client.id); release(); await assert.rejects(opening, /disconnected/); assert.equal(slow.sessions.size, 0);
    console.log('PASS disconnect during attach does not leak a terminal');
    secureGateway = new Gateway({ directory: path.join(directory, 'secure'), assets: gateway.assets, service: gateway.service });
    await assert.rejects(secureGateway.configure({ enabled: true, port, url }), /Tailscale HTTPS origin/);
    await assert.rejects(secureGateway.configure({ enabled: true, port, url: 'https://public.example.com' }), /Tailscale HTTPS origin/);
    for (const bad of ['http://192.168.1.2:8080', 'http://100.128.0.1:8080', 'http://100.63.0.1:8080', 'http://public.example.com:8080', 'https://100.64.0.10:8080']) {
      await assert.rejects(secureGateway.configure({ enabled: true, port, url: bad, transport: 'tailnet-http' }), /Tailscale HTTPS origin/);
    }
    const ipOrigin = 'http://100.64.0.10:8080';
    const privatePort = await freePort(), privateBackend = `http://127.0.0.1:${privatePort}`;
    const ipFetch = (route, options = {}) => new Promise((resolve, reject) => {
      // Native HTTP preserves Host when simulating the tailnet TCP forwarder.
      const request = http.request(privateBackend + route, { ...options, headers: { ...options.headers, Host: new URL(ipOrigin).host } }, (response) => {
        response.resume();
        resolve({ status: response.statusCode, headers: response.headers });
      });
      request.on('error', reject); request.end(options.body);
    });
    await secureGateway.configure({ enabled: true, port: privatePort, url: ipOrigin, transport: 'tailnet-http' });
    const ipPair = secureGateway.pair();
    assert.ok(!fs.readFileSync(secureGateway.pairing.file, 'utf8').includes(new URL(ipPair.url).hash.slice(6)));
    // A link issued in the owner's local shell survives a gateway restart.
    await secureGateway.stop();
    await secureGateway.start();
    const ipPairResponse = await ipFetch('/api/v1/pair', { method: 'POST', headers: { Origin: ipOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(ipPair.url).hash.slice(6), name: 'IP phone' }) });
    assert.equal(ipPairResponse.status, 200);
    const ipCookie = ipPairResponse.headers['set-cookie'][0];
    assert.ok(ipCookie.startsWith('agenthq-tailnet='));
    assert.ok(ipCookie.includes('HttpOnly; SameSite=Strict'));
    assert.ok(!ipCookie.includes('Secure'));
    assert.equal((await ipFetch('/api/v1/state', { headers: { Cookie: ipCookie.split(';')[0] } })).status, 200);
    const cancelled = secureGateway.pair();
    await secureGateway.configure({ enabled: false, port: privatePort, url: ipOrigin, transport: 'tailnet-http' });
    assert.equal(secureGateway.pairing.consume(new URL(cancelled.url).hash.slice(6), ipOrigin), false);
    console.log('PASS explicit private-IP mode rejects other addresses, uses scoped HttpOnly cookies, and supports restart-safe one-use invitations');
    await secureGateway.dispose();
  } finally {
    for (const socket of sockets) socket.terminate();
    await secureGateway?.dispose();
    await gateway.dispose(); terminals.closeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
