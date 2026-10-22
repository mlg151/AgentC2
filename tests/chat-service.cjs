const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { WebSocket } = require('ws');
const { Chats } = require('../electron/chat.cjs');
const { Gateway } = require('../electron/gateway.cjs');
const { contract } = require('../electron/chat-protocol.cjs');

const sessionId = 'chat-0123456789abcdef0123456789abcdef';
const caps = { provider: 'codex', version: 'fixture', status: 'supported', reason: null, ...Object.fromEntries(contract.capabilities.map((name) => [name, ['streaming', 'history', 'resume', 'interrupt', 'approvals', 'questions'].includes(name)])) };
const session = { id: sessionId, provider: 'codex', providerSessionId: 'native-one', title: 'Fixture', cwd: '/tmp', roeProfile: 'gated', state: 'idle', activeTurnId: null, createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:00.000Z', capabilities: caps };
const command = () => ({ protocolVersion: 1, commandId: crypto.randomUUID(), operation: 'send', sessionId, payload: { text: 'Fixture task' } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const events = new EventEmitter(), sent = [], commands = [], journal = [];
  let fail = false, gate = null, sequence = 0, retainedFrom = 1;
  const currentSession = structuredClone(session);
  const append = (text) => journal.push({ protocolVersion: 1, sessionId, sequence: ++sequence, timestamp: '2026-10-22T12:00:00.000Z', provider: 'codex', providerSessionId: 'native-one', turnId: 'turn-one', itemId: 'message-one', type: 'message.delta', data: { text } });
  append('First');
  const remote = async (hostId, request) => {
    if (fail) throw new Error('SSH offline');
    if (request.action === 'history') {
      if (gate?.action === 'history') await gate.promise;
      const rows = journal.filter((event) => event.sequence > request.after), list = rows.slice(0, request.limit);
      return { session: structuredClone(currentSession), events: structuredClone(list), cursor: list.at(-1)?.sequence || Math.max(request.after, retainedFrom - 1), latestCursor: sequence, hasMore: rows.length > list.length, retainedFrom, truncated: request.after < retainedFrom - 1, pendingRequests: [], pendingCommands: [] };
    }
    if (request.action === 'command') {
      commands.push({ hostId, command: request.command });
      if (gate?.action === 'command') await gate.promise;
      return { commandId: request.command.commandId, sessionId, state: 'accepted', result: null, error: null };
    }
    if (request.action === 'prune') { if (!['stopped', 'failed'].includes(currentSession.state)) throw new Error('Only confirmed stopped sessions can be pruned'); journal.splice(0); retainedFrom = sequence + 1; return { pruned: true }; }
    if (request.action === 'receipt') return { commandId: request.commandId, sessionId, state: 'completed', result: {}, error: null };
    if (request.action === 'capabilities') return contract.providers.map((provider) => ({ ...caps, provider }));
    if (request.action === 'list') return [structuredClone(session)];
    throw new Error('Unexpected fixture request');
  };
  const chats = new Chats({ remote, resolveHost: (hostId) => { if (!['alpha', 'beta'].includes(hostId)) throw new Error('Host unavailable'); return hostId; }, emit: (client, event, value) => { sent.push({ client, event, value }); events.emit('client', client, event, value); }, interval: 60000 });
  return { chats, events, sent, commands, append, setState: (value) => { currentSession.state = value; }, setFail: (value) => { fail = value; }, gate: (action) => { gate = { action, ...deferred() }; return gate; } };
}

async function controllerTests() {
  const f = fixture(), desktop = { id: 'desktop', name: 'Desktop' }, phone = { id: 'phone', name: 'Phone' };
  const { chats } = f;
  try {
    const d = await chats.open(desktop, sessionId, 'alpha'), p = await chats.open(phone, sessionId, 'alpha');
    assert.equal((await chats.ready(desktop, d)).events.length, 1);
    await chats.ready(phone, p);
    assert.equal(chats.state(desktop, d).canControl, true);
    await assert.rejects(chats.submit(phone, p, command()), /Take control/);
    assert.throws(() => chats.state(phone, d), /disconnected/);
    const gate = f.gate('command');
    const submitted = chats.submit(desktop, d, command());
    await new Promise((resolve) => setImmediate(resolve));
    let taken = false;
    const takeover = chats.take(phone, p).then(() => { taken = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(taken, false, 'Takeover must fence an already dispatched command acknowledgement');
    assert.equal(chats.state(desktop, d).canControl, true);
    gate.resolve();
    await submitted; await takeover;
    assert.equal(chats.state(desktop, d).canControl, false);
    await assert.rejects(chats.submit(desktop, d, command()), /Take control/);
    await chats.submit(phone, p, command());
    assert.equal(f.commands.length, 2);
    assert.throws(() => chats.submit(phone, p, { ...command(), sessionId: 'chat-' + 'f'.repeat(32) }), /does not target/);

    const other = await chats.open(desktop, sessionId, 'beta');
    await chats.ready(desktop, other);
    assert.equal(chats.state(desktop, other).canControl, true, 'Identical provider IDs on another host have independent ownership');
    f.append('Second');
    await chats.poll(chats.get(phone, p).record);
    assert.deepEqual(f.sent.filter((entry) => entry.client === 'phone' && entry.event === 'chat:events').at(-1).value.events.map((event) => event.data.text), ['Second']);
    await chats.poll(chats.get(phone, p).record);
    assert.deepEqual(f.sent.filter((entry) => entry.client === 'phone' && entry.event === 'chat:events').at(-1).value.events, []);
    f.setFail(true);
    await chats.poll(chats.get(phone, p).record);
    assert.equal(chats.state(phone, p).connection, 'reconnecting');
    await assert.rejects(chats.submit(phone, p, command()), /not queued/);
    await assert.rejects(chats.take(desktop, d), /reconnecting/);
    assert.equal(f.commands.length, 2);
    f.setFail(false);
    await chats.poll(chats.get(phone, p).record);
    assert.equal(chats.state(phone, p).connection, 'connected');
    chats.disconnect(phone.id);
    assert.equal(chats.state(desktop, d).controller, null);
    assert.throws(() => chats.get(phone, p), /disconnected/);
    assert.equal(f.commands.length, 2, 'Disconnect must never stop provider work');
  } finally { chats.closeAll(); }
  assert.equal(chats.handles.size, 0);
  assert.equal(chats.sessions.size, 0);
  const late = fixture(), gate = late.gate('history');
  const opening = late.chats.open(phone, sessionId, 'alpha');
  late.chats.disconnect(phone.id); gate.resolve();
  await assert.rejects(opening, /disconnected/);
  assert.equal(late.chats.sessions.size, 0, 'A disconnected opening cannot resurrect a subscription');
}

async function retentionTests() {
  const f = fixture(), desktop = { id: 'desktop', name: 'Desktop' }, phone = { id: 'phone', name: 'Phone' };
  try {
    const d = await f.chats.open(desktop, sessionId, 'alpha'), p = await f.chats.open(phone, sessionId, 'alpha');
    await f.chats.ready(desktop, d); await f.chats.ready(phone, p);
    await assert.rejects(f.chats.prune(phone, p), /Take control/);
    await assert.rejects(f.chats.prune(desktop, d), /confirmed stopped/);
    f.setState('stopped');
    const page = await f.chats.prune(desktop, d);
    assert.equal(page.retainedFrom, 2); assert.deepEqual(page.events, []);
    assert.equal((await f.chats.history(phone, p, 0)).truncated, true);
    assert.equal(f.sent.filter((item) => item.client === 'phone' && item.event === 'chat:events').at(-1).value.retainedFrom, 2);
    f.chats.disconnect(phone.id);
    assert.throws(() => f.chats.prune(phone, p), /disconnected/);
  } finally { f.chats.closeAll(); }
}

async function gatewayTests() {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-chat-gateway-'));
  const service = { chats: f.chats, events: f.events, store: { data: { settings: {}, workspace: { metadata: {} }, attention: [] } }, terminals: { handles: new Map(), disconnect() {} } };
  const gateway = new Gateway({ directory, assets: directory, service, secure: false });
  let ws;
  const requests = new Map();
  try {
    const server = net.createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const url = `http://127.0.0.1:${port}`;
    await gateway.configure({ enabled: true, port, url });
    const secret = crypto.randomBytes(32).toString('base64url');
    const device = { id: crypto.randomUUID(), name: 'Fixture phone', secretHash: crypto.createHash('sha256').update(secret).digest('hex'), expiresAt: Date.now() + 60000 };
    gateway.data.devices.push(device);
    ws = new WebSocket(url.replace('http', 'ws') + '/api/v1/socket', { headers: { Origin: url, Cookie: `agenthq-test=${secret}` } });
    ws.on('message', (buffer) => { const value = JSON.parse(buffer); const pending = requests.get(value.id); if (pending) { requests.delete(value.id); value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result); } });
    await once(ws, 'open');
    const rpc = (method, ...args) => new Promise((resolve, reject) => { const id = crypto.randomUUID(); requests.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, args })); });
    const handle = await rpc('chat:open', sessionId, 'alpha');
    const page = await rpc('chat:ready', handle, 0);
    assert.equal(page.events.length, 1);
    await assert.rejects(rpc('chat:submit', handle, command()), /Take control/);
    await rpc('chat:take', handle);
    const sent = command();
    assert.equal((await rpc('chat:submit', handle, sent)).commandId, sent.commandId);
    assert.equal((await rpc('chat:receipt', handle, sent.commandId)).state, 'completed');
    await assert.rejects(rpc('chat:submit', 'another-client-handle', command()), /disconnected/);
    await assert.rejects(rpc('chat:submit', handle, { ...command(), operation: 'create', sessionId: undefined, payload: { provider: 'codex', title: '', cwd: '/tmp', roeProfile: 'full' } }), /does not target/);
    const closed = once(ws, 'close'); gateway.revoke(device.id); await closed;
    assert.equal(f.chats.handles.size, 0, 'Revocation must remove chat subscriptions and input ownership');
    assert.equal(f.commands.length, 1, 'Revocation must never stop a managed provider');
  } finally {
    ws?.terminate();
    await gateway.dispose();
    f.chats.closeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  await controllerTests();
  await gatewayTests();
  await retentionTests();
  console.log('PASS chat scope, control handoff fences, replay, reconnect, late-open cancellation, gateway authentication, and revocation');
})().catch((error) => { console.error(error); process.exitCode = 1; });
