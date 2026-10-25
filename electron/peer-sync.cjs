const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { extract, project, mergeRecords, validateRecords } = require('./peer-state.cjs');
const { validateWorkspace, validateSessionPin } = require('./config.cjs');
const { fingerprint } = require('./centcom-contract.cjs');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const random = () => crypto.randomBytes(32).toString('hex');
const idValid = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const nonceValid = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function privateAddress(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  return [a, b, c, d].every((n) => n <= 255) && (a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127);
}
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !privateAddress(url.hostname) || url.username || url.password || url.search || url.hash || !['/', '/peer-sync'].includes(url.pathname)) throw new Error('Use ws:// with a literal private LAN, VPN, or loopback IPv4 address');
  url.pathname = '/peer-sync';
  return url.href;
}
function config(input) {
  if (!input || typeof input.enabled !== 'boolean' || !privateAddress(input.bindAddress) || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535 || typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 80 || /[\x00-\x1f]/.test(input.deviceName)) throw new Error('Choose a device name, private IPv4 bind address, and port between 0 and 65535');
  return { enabled: input.enabled, bindAddress: input.bindAddress, port: input.port, deviceName: input.deviceName.trim() };
}
function mac(secret, text) { return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(text).digest('hex'); }
function verify(secret, text, proof) { return nonceValid(proof) && crypto.timingSafeEqual(Buffer.from(mac(secret, text), 'hex'), Buffer.from(proof, 'hex')); }
function derive(secret, transcript, purpose) { return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'hex'), crypto.createHash('sha256').update(transcript).digest(), purpose, 32)); }
function channel(secret, transcript, client) {
  const sendKey = derive(secret, transcript, client ? 'client frames' : 'server frames');
  const receiveKey = derive(secret, transcript, client ? 'server frames' : 'client frames');
  let sent = 0, received = 0;
  const nonce = (sequence) => { const value = Buffer.alloc(12); value.writeBigUInt64BE(BigInt(sequence), 4); return value; };
  return {
    seal(value) {
      const sequence = ++sent, cipher = crypto.createCipheriv('aes-256-gcm', sendKey, nonce(sequence));
      const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return JSON.stringify({ sequence, body: body.toString('base64'), tag: cipher.getAuthTag().toString('hex') });
    },
    open(frame) {
      if (frame.sequence !== received + 1 || typeof frame.body !== 'string' || typeof frame.tag !== 'string' || !/^[a-f0-9]{32}$/.test(frame.tag)) throw new Error('Invalid or replayed peer frame');
      const decipher = crypto.createDecipheriv('aes-256-gcm', receiveKey, nonce(frame.sequence));
      decipher.setAuthTag(Buffer.from(frame.tag, 'hex'));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(frame.body, 'base64')), decipher.final()]).toString());
      received++;
      return value;
    },
  };
}
class PeerSync extends EventEmitter {
  constructor({ directory, service }) {
    super();
    this.service = service; this.store = service.store; this.file = path.join(directory, 'peer-sync.json');
    this.data = { version: 1, id: crypto.randomBytes(16).toString('hex'), config: config({ enabled: false, bindAddress: '127.0.0.1', port: 43128, deviceName: os.hostname().slice(0, 80) || 'Desktop' }), peers: {}, records: {}, clock: 0 };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !idValid(saved.id) || !saved.peers || Object.keys(saved.peers).length > 8 || !Number.isSafeInteger(saved.clock)) throw new Error('Invalid saved desktop sync state');
      for (const [id, peer] of Object.entries(saved.peers)) if (!idValid(id) || !nonceValid(peer.secret) || typeof peer.name !== 'string' || peer.name.length > 80 || peer.url && endpoint(peer.url) !== peer.url) throw new Error('Invalid saved desktop peer');
      this.data = { ...saved, config: config(saved.config), records: validateRecords(saved.records) };
    }
    this.connections = new Map(); this.connecting = new Set(); this.failures = new Map(); this.views = new Map(); this.sockets = new Set();
    this.error = ''; this.applying = false; this.closed = false; this.previous = {};
    this.onStore = (source) => {
      if (source === 'peer-sync') { this.previous = extract(this.store.data); this.data.baseline = this.previous; this.persist(); return; }
      this.capture();
    };
    // Reconcile edits made while sync was disabled or before a restart.
    this.previous = this.data.baseline || {};
    this.capture();
    this.store.on('updated', this.onStore);
    this.timer = setInterval(() => { if (this.data.config.enabled) { this.reconnect(); void this.apply(); } }, 1000);
    this.timer.unref();
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.chmodSync(this.file + '.tmp', 0o600);
    fs.renameSync(this.file + '.tmp', this.file);
  }
  capture() {
    const next = extract(this.store.data); let changed = false;
    for (const key of new Set([...Object.keys(this.previous), ...Object.keys(next)])) {
      if (equal(next[key], this.previous[key])) continue;
      if (!(key in next) && ['deleted', 'ack'].includes(JSON.parse(key)[0])) continue;
      const clock = Math.max(Date.now(), this.data.clock + 1);
      this.data.clock = clock;
      this.data.records[key] = { clock, peer: this.data.id, deleted: !(key in next), ...(key in next ? { value: next[key] } : {}) }; changed = true;
    }
    this.previous = next; this.data.baseline = next;
    if (changed) { validateRecords(this.data.records); this.persist(); this.broadcast(); }
    else this.broadcastViews();
  }
  snapshot() {
    const local = new Set(this.store.data.settings.hosts.filter((host) => host.kind === 'local').map((host) => host.id));
    return { type: 'state', records: this.data.records, tabs: this.store.data.workspace.tabs.filter((key) => !local.has(key.split('/')[0])) };
  }
  status() {
    return { ...this.data.config, id: this.data.id, running: Boolean(this.server?.listening), address: this.server?.listening ? `ws://${this.data.config.bindAddress}:${this.server.address().port}/peer-sync` : '', error: this.error, peers: Object.entries(this.data.peers).map(([id, peer]) => ({ id, name: peer.name, url: peer.url || '', direction: peer.url ? 'outbound' : 'inbound', connected: this.connections.has(id), lastSyncedAt: this.views.get(id)?.at || null, remoteTabs: this.views.get(id)?.tabs || [], error: this.failures.get(id)?.error || '' })) };
  }
  changed() { this.emit('status', this.status()); }
  async configure(input) {
    const next = config(input);
    this.stopNetwork(); this.data.config = next; this.persist(); this.error = '';
    if (next.enabled) await this.start();
    this.changed(); return this.status();
  }
  async start() {
    if (this.server || !this.data.config.enabled || this.closed) return;
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 6_000_000, perMessageDeflate: false });
    this.server = server; this.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      if (req.headers.origin || req.url !== '/peer-sync' || this.sockets.size >= 16) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.data.config.port, this.data.config.bindAddress, resolve); });
      server.on('error', (error) => { this.error = error.message; this.changed(); });
      this.reconnect(); this.changed();
    } catch (error) { this.stopNetwork(); this.error = error.message; this.changed(); throw error; }
  }
  pair() {
    if (!this.server?.listening) throw new Error('Enable desktop sync before pairing');
    this.pairing = { code: random(), expiresAt: Date.now() + 15 * 60000 };
    return { ...this.pairing, url: this.status().address };
  }
  stopNetwork() {
    this.pairing = null;
    for (const ws of this.sockets) ws.terminate();
    this.connections.clear(); this.connecting.clear();
    this.wss?.close(); this.server?.close(); this.wss = this.server = null;
  }
  close() { this.closed = true; clearInterval(this.timer); this.store.off('updated', this.onStore); this.stopNetwork(); }
  track(ws) {
    this.sockets.add(ws);
    const timer = setTimeout(() => ws.terminate(), 10000); timer.unref();
    ws.on('error', () => {});
    ws.once('close', () => { clearTimeout(timer); this.sockets.delete(ws); });
    return () => clearTimeout(timer);
  }
  accept(ws) {
    const authenticated = this.track(ws);
    const hello = { id: this.data.id, name: this.data.config.deviceName, nonce: random() };
    ws.send(JSON.stringify(hello));
    ws.once('message', (bytes) => {
      try {
        const request = JSON.parse(bytes.toString());
        if (!idValid(request.id) || request.id === hello.id || !nonceValid(request.nonce) || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 80 || typeof request.pair !== 'boolean') throw new Error('Invalid peer handshake');
        const existing = this.data.peers[request.id];
        const secret = request.pair ? this.pairing?.expiresAt > Date.now() ? this.pairing.code : null : existing?.secret;
        if (!secret || request.pair && (existing || Object.keys(this.data.peers).length >= 8)) throw new Error('Pairing unavailable');
        const transcript = JSON.stringify([hello, { id: request.id, name: request.name, nonce: request.nonce, pair: request.pair }]);
        if (!verify(secret, 'client:' + transcript, request.proof)) throw new Error('Peer authentication failed');
        const credential = request.pair ? derive(secret, transcript, 'paired credential').toString('hex') : secret;
        if (request.pair) { this.pairing = null; this.data.peers[request.id] = { name: request.name, secret: credential, url: '' }; this.persist(); }
        else if (existing.name !== request.name) { existing.name = request.name; this.persist(); }
        ws.send(JSON.stringify({ proof: mac(secret, 'server:' + transcript) }));
        authenticated(); this.attach(ws, request.id, channel(credential, transcript, false));
      } catch { ws.close(1008, 'Peer authentication rejected'); }
    });
  }
  async connect(input) {
    if (!this.data.config.enabled) throw new Error('Enable desktop sync before connecting');
    if (!input || !nonceValid(input.code) || Object.keys(this.data.peers).length >= 8) throw new Error('Enter a valid pairing code; at most eight desktops can be paired');
    const url = endpoint(input.url);
    await this.dial(url, input.code);
    return this.status();
  }
  dial(url, code, peerId) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 6_000_000, perMessageDeflate: false });
      const authenticated = this.track(ws); let complete = false, stage = 0, hello, transcript, secret;
      const fail = () => { if (!complete) reject(new Error('Desktop pairing or authentication failed. Check the address and code.')); };
      ws.once('close', fail); ws.once('error', fail);
      const handler = (bytes) => {
        try {
          const response = JSON.parse(bytes.toString());
          if (stage === 0) {
            hello = response;
            if (!idValid(hello.id) || hello.id === this.data.id || peerId && hello.id !== peerId || !nonceValid(hello.nonce) || typeof hello.name !== 'string' || hello.name.length > 80 || code && this.data.peers[hello.id]) throw new Error('Unexpected peer identity');
            secret = code || this.data.peers[peerId]?.secret;
            if (!secret) throw new Error('Revoked desktop');
            const request = { id: this.data.id, name: this.data.config.deviceName, nonce: random(), pair: Boolean(code) };
            transcript = JSON.stringify([hello, request]);
            ws.send(JSON.stringify({ ...request, proof: mac(secret, 'client:' + transcript) })); stage = 1;
          } else {
            if (!verify(secret, 'server:' + transcript, response.proof)) throw new Error('Peer authentication failed');
            const credential = code ? derive(secret, transcript, 'paired credential').toString('hex') : secret;
            if (code) { this.data.peers[hello.id] = { name: hello.name, url, secret: credential }; this.persist(); }
            else if (this.data.peers[hello.id]?.name !== hello.name) { this.data.peers[hello.id].name = hello.name; this.persist(); }
            if (!this.data.peers[hello.id] || !this.data.config.enabled || this.closed) throw new Error('Desktop sync disabled');
            complete = true; authenticated(); ws.off('message', handler);
            this.attach(ws, hello.id, channel(credential, transcript, true)); resolve();
          }
        } catch { ws.terminate(); fail(); }
      };
      ws.on('message', handler);
    });
  }
  attach(ws, id, cipher) {
    this.connections.get(id)?.ws.terminate();
    const connection = { ws, cipher }; this.connections.set(id, connection); this.failures.delete(id);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 15000); heartbeat.unref();
    ws.once('close', () => { clearInterval(heartbeat); if (this.connections.get(id) === connection) this.connections.delete(id); this.changed(); });
    ws.on('message', (bytes) => {
      try {
        if (this.closed || !this.data.config.enabled || !this.data.peers[id]) throw new Error('Desktop sync disabled or revoked');
        const frame = cipher.open(JSON.parse(bytes.toString()));
        if (!['state', 'view'].includes(frame.type) || !Array.isArray(frame.tabs) || frame.tabs.length > 100) throw new Error('Invalid peer snapshot');
        for (const key of frame.tabs) validateSessionPin(key, false);
        if (frame.type === 'state') {
          const merged = mergeRecords(this.data.records, frame.records);
          // Validate the materialized configuration before accepting a remote revision.
          project(this.store.data, merged);
          if (!equal(merged, this.data.records)) {
            this.data.records = merged;
            this.data.clock = Math.max(this.data.clock, ...Object.values(merged).map((row) => row.clock));
            this.persist(); this.broadcast();
          }
          void this.apply();
        }
        this.views.set(id, { tabs: frame.tabs, at: new Date().toISOString() }); this.changed();
      } catch (error) { this.failures.set(id, { error: error.message, at: Date.now() + 30000, count: 1 }); ws.close(1008, 'Peer state rejected'); this.changed(); }
    });
    this.transmit(connection, this.snapshot()); this.changed();
  }
  transmit(connection, value) {
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    if (connection.ws.bufferedAmount > 8_000_000) { connection.ws.terminate(); return; }
    connection.ws.send(connection.cipher.seal(value));
  }
  broadcast() { for (const connection of this.connections.values()) this.transmit(connection, this.snapshot()); }
  broadcastViews() {
    const tabs = this.snapshot().tabs;
    if (equal(tabs, this.lastTabs)) return;
    this.lastTabs = tabs;
    for (const connection of this.connections.values()) this.transmit(connection, { type: 'view', tabs });
  }
  reconnect() {
    if (this.closed || !this.data.config.enabled) return;
    for (const [id, peer] of Object.entries(this.data.peers)) {
      if (!peer.url || this.connections.has(id) || this.connecting.has(id) || (this.failures.get(id)?.at || 0) > Date.now()) continue;
      this.connecting.add(id);
      void this.dial(peer.url, null, id).catch((error) => {
        const count = (this.failures.get(id)?.count || 0) + 1;
        this.failures.set(id, { error: error.message, count, at: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(count, 6)) }); this.changed();
      }).finally(() => this.connecting.delete(id));
    }
  }
  async apply() {
    if (this.applying || this.closed || !this.data.config.enabled) return;
    this.applying = true;
    try {
      let patch = project(this.store.data, this.data.records);
      if (!equal(patch.settings, this.store.data.settings)) await this.service.saveSettings(patch.settings, fingerprint(this.store.data.settings), 'peer-sync');
      patch = project(this.store.data, this.data.records);
      // Records can advance while saveSettings awaits in-flight inventory. Every
      // subsequent settings version must pass the service's connection guards.
      if (!equal(patch.settings, this.store.data.settings)) {
        const { settings, workspace, attention } = this.store.data;
        this.emit('applied', { settings, workspace, attention });
        return;
      }
      const deleted = patch.deletedSessions.filter((key) => !this.store.data.deletedSessions.includes(key));
      if (Object.entries(patch).some(([key, value]) => !equal(value, this.store.data[key]))) {
        const cachedUnits = Object.fromEntries(Object.entries(this.store.data.cachedUnits).map(([id, units]) => [id, units.filter((unit) => !patch.deletedSessions.includes(unit.key))]));
        this.store.update({ ...patch, cachedUnits }, 'peer-sync');
        this.service.events.emit('state:updated');
        if (deleted.length) this.service.events.emit('sessions:deleted', deleted);
        this.emit('applied', { settings: patch.settings, workspace: patch.workspace, attention: patch.attention });
      } else if (!equal(this.lastAppliedSettings, patch.settings)) this.emit('applied', { settings: patch.settings, workspace: patch.workspace, attention: patch.attention });
      this.lastAppliedSettings = patch.settings;
      if (this.error) { this.error = ''; this.changed(); }
    } catch (error) { if (this.error !== error.message) { this.error = error.message; this.changed(); } }
    finally { this.applying = false; }
  }
  revoke(id) {
    if (!idValid(id) || !this.data.peers[id]) throw new Error('Unknown paired desktop');
    delete this.data.peers[id]; this.persist(); this.connections.get(id)?.ws.terminate(); this.connections.delete(id); this.views.delete(id); this.failures.delete(id); this.changed(); return this.status();
  }
  pullTabs(id) {
    if (!this.data.peers[id] || !this.views.has(id)) throw new Error('Connect this desktop before pulling its tabs');
    const hosts = new Set(this.store.data.settings.hosts.filter((host) => host.kind !== 'local').map((host) => host.id));
    const tabs = this.views.get(id).tabs.filter((key) => hosts.has(key.split('/')[0]) && !this.store.data.deletedSessions.includes(key));
    const workspace = validateWorkspace({ ...this.store.data.workspace, tabs, selectedKey: tabs[0] || null, splitKey: null, situation: { ...this.store.data.workspace.situation, anchorKey: tabs[0] || null, targetKey: null, focusedPane: 'anchor' } });
    this.store.saveWorkspace(workspace); this.emit('applied', { settings: this.store.data.settings, workspace: this.store.data.workspace, attention: this.store.data.attention });
    this.service.events.emit('state:updated'); return this.store.data.workspace;
  }
}
module.exports = { PeerSync, endpoint, privateAddress, channel, config };
