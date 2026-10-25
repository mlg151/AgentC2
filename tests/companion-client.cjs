const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { loadRenderer } = require('./helpers/load-renderer.cjs');

(async () => {
  const { CompanionClient } = loadRenderer('companion/client.ts');
  const timers = new Map(), sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    closes = 0;
    constructor(url) { this.url = url; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closes++; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    disconnect(code = 1006) { this.readyState = 3; this.onclose({ code }); }
  }
  const location = { protocol: 'https:', host: 'fixture.invalid' };
  const overrides = {
    WebSocket: Socket, location, crypto: webcrypto,
    setTimeout: (run, delay) => { const timer = {}; timers.set(timer, { run, delay }); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  };
  const descriptors = new Map(Object.keys(overrides).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const clients = [];
  const client = () => { const value = new CompanionClient(); clients.push(value); return value; };
  const latest = () => sockets.at(-1);
  const expire = (delay) => {
    const [id, timer] = [...timers].find(([, entry]) => entry.delay === delay) || [];
    assert.ok(timer, `Expected ${delay}ms timer`); timers.delete(id); timer.run();
  };
  try {
    for (const [name, value] of Object.entries(overrides)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const c = client(), states = [], secondary = [];
    const unsubscribe = c.on('connection', (state) => states.push(state));
    c.on('connection', (state) => secondary.push(state));
    await assert.rejects(c.request('inventory'), /Desktop is disconnected/);
    c.connect(); const socket = latest();
    assert.equal(socket.url, 'wss://fixture.invalid/api/v1/socket');
    await assert.rejects(c.request('inventory'), /Desktop is disconnected/);
    socket.open();
    assert.deepEqual(states, ['connecting', 'connected']);
    socket.message({ event: 'unobserved', value: null });
    const updates = []; c.on('inventory:updated', (value) => updates.push(value));
    socket.message({ event: 'inventory:updated', value: { sessions: [] } });
    assert.deepEqual(updates, [{ sessions: [] }]);
    const request = c.request('inventory', { include: 'managed' });
    const wire = socket.sent.at(-1);
    assert.deepEqual({ method: wire.method, args: wire.args }, { method: 'inventory', args: [{ include: 'managed' }] });
    assert.match(wire.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    socket.message({ id: 'unknown-receipt', result: 'ignored' });
    socket.message({ id: wire.id, result: { sessions: ['fixture'] } });
    assert.deepEqual(await request, { sessions: ['fixture'] });
    const denied = c.request('stop', 'managed');
    const rejected = assert.rejects(denied, /Owner required/);
    socket.message({ id: socket.sent.at(-1).id, error: 'Owner required' }); await rejected;
    assert.equal(timers.size, 0);
    for (const [method, delay] of [['inventory', 60000], ['create', 360000]]) {
      const timed = c.request(method), id = socket.sent.at(-1).id;
      const expired = assert.rejects(timed, /Request timed out\. Action outcome may be unknown/);
      expire(delay); await expired;
      socket.message({ id, result: 'late response must be ignored' });
      assert.equal(timers.size, 0);
    }
    const uncertain = c.request('create');
    const disconnected = assert.rejects(uncertain, /Disconnected\. Action outcome may be unknown/);
    socket.disconnect(); await disconnected;
    unsubscribe(); unsubscribe();
    const observed = states.length;
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
      expire(delay); const replacement = latest();
      socket.disconnect(); // A stale socket must never clear its replacement.
      replacement.disconnect();
      assert.equal(states.length, observed);
    }
    expire(15000); latest().open(); latest().disconnect();
    assert.ok([...timers.values()].some((timer) => timer.delay === 1000), 'Successful connection resets exponential backoff');
    c.close(); assert.equal(timers.size, 0); c.connect();
    assert.ok(secondary.includes('offline'));

    location.protocol = 'http:';
    const revoked = client(); let wasRevoked = false;
    revoked.on('revoked', (value) => { assert.equal(value, null); wasRevoked = true; });
    revoked.connect(); const paired = latest(); paired.open();
    assert.equal(paired.url, 'ws://fixture.invalid/api/v1/socket');
    const pending = revoked.request('inventory');
    const revocation = assert.rejects(pending, /This device was revoked\. Pair again from desktop\./);
    paired.disconnect(4001); await revocation;
    assert.equal(wasRevoked, true); assert.equal(timers.size, 0); revoked.close();

    const closing = client(); closing.connect(); const active = latest(); active.open();
    const pendingClose = closing.request('inventory');
    const closed = assert.rejects(pendingClose, /Connection closed/);
    closing.close(); await closed; active.disconnect();
    assert.equal(active.closes, 1); assert.equal(timers.size, 0);
    const count = sockets.length; closing.connect(); assert.equal(sockets.length, count);
    client().close(); // Closing a client before connecting is safe.
    console.log('PASS secure/private-HTTP sockets, listener isolation, events and RPC results/errors, UUIDs, operation-specific deadlines, late receipts, uncertain disconnects, bounded/reset retry backoff, stale sockets, revocation, and pending-request shutdown');
  } finally {
    for (const value of clients) value.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
