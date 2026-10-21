const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Pairing } = require('./pairing.cjs');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_MESSAGE = 1_100_000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class Gateway {
  constructor({ directory, assets, service, secure = true }) {
    Object.assign(this, { directory, assets, service, secure });
    this.file = path.join(directory, 'remote-access.json');
    this.data = { enabled: false, port: 43127, url: '', transport: 'https', devices: [], requests: [] };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(saved.devices) || !Array.isArray(saved.requests)) throw new Error('Invalid remote access configuration');
      this.data = { ...this.data, ...saved };
      this.validate(this.data);
    }
    this.server = null;
    this.sockets = new Map();
    this.pairing = new Pairing(directory);
    this.attempts = new Map();
    this.flights = new Map();
    this.error = '';
    this.onClient = (id, event, value) => {
      const record = this.sockets.get(id);
      if (record) this.send(record.ws, { event, value });
    };
    this.onInventory = (value) => this.broadcast('inventory:updated', value);
    this.onHealth = (value) => this.broadcast('health:updated', value);
    this.onState = () => this.broadcast('state:updated', this.bootstrap());
    service.events.on('client', this.onClient);
    service.events.on('inventory:updated', this.onInventory);
    service.events.on('health:updated', this.onHealth);
    service.events.on('state:updated', this.onState);
  }

  validate(input) {
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('Gateway port must be between 1024 and 65535');
    if (input.transport && !['https', 'tailnet-http'].includes(input.transport)) throw new Error('Invalid companion transport');
    if (input.url) {
      const url = new URL(input.url);
      const octets = url.hostname.split('.').map(Number);
      const tailnetIP = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
      const allowed = input.transport === 'tailnet-http' ? url.protocol === 'http:' && tailnetIP : url.protocol === 'https:' && url.hostname.endsWith('.ts.net');
      if ((this.secure && !allowed) || (!this.secure && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter a Tailscale HTTPS origin, or select Private Tailscale IP and use http://100.x.x.x:8080');
    }
  }

  persist() {
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  status() {
    return { enabled: this.data.enabled, running: Boolean(this.server?.listening), port: this.data.port, url: this.data.url, transport: this.data.transport, error: this.error, devices: this.data.devices.map(({ secretHash, ...device }) => device) };
  }

  async configure(input) {
    const next = { enabled: Boolean(input?.enabled), port: Number(input?.port), url: String(input?.url || '').trim().replace(/\/$/, ''), transport: input?.transport || 'https' };
    this.validate(next);
    await this.stop();
    this.pairing.clear();
    Object.assign(this.data, next);
    this.persist();
    this.error = '';
    if (next.enabled) {
      try { await this.start(); } catch (error) { this.error = error.message; throw error; }
    }
    return this.status();
  }

  pair() {
    if (!this.server?.listening || !this.data.url) throw new Error('Enable remote access and set your companion URL first');
    return this.pairing.issue(this.data.url);
  }

  revoke(id) {
    this.data.devices = this.data.devices.filter((device) => device.id !== id);
    this.persist();
    for (const record of this.sockets.values()) if (record.device.id === id) this.drop(record, 4001, 'Device revoked');
    return this.status();
  }

  authenticate(req) {
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${this.cookieName()}=`));
    const secret = cookie?.slice(this.cookieName().length + 1);
    const digest = secret ? hash(secret) : '';
    const device = this.data.devices.find((item) => item.secretHash === digest && item.expiresAt > Date.now());
    if (!device) throw new Error('Pair this device from AgentC2 on your desktop');
    return device;
  }

  secureCookie() { return this.secure && this.data.transport !== 'tailnet-http'; }
  cookieName() { return this.secureCookie() ? '__Host-agenthq' : this.secure ? 'agenthq-tailnet' : 'agenthq-test'; }

  validOrigin(req, mutation = false) {
    if (req.headers['tailscale-funnel-request']) return false;
    const origin = new URL(this.data.url);
    if (req.headers.host !== origin.host) return false;
    if (req.headers.origin) return req.headers.origin === origin.origin;
    return !mutation;
  }

  bootstrap() {
    const { settings, workspace, attention } = this.service.store.data;
    return { settings, metadata: workspace.metadata, attention };
  }

  send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 4_000_000) { ws.close(4002, 'Connection too slow; reconnect'); return; }
    ws.send(JSON.stringify(value));
  }

  broadcast(event, value) {
    for (const record of this.sockets.values()) this.send(record.ws, { event, value });
  }

  async start() {
    if (this.server) return;
    this.validate(this.data);
    if (!this.data.url) { this.error = 'Set your Tailscale companion URL'; return; }
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
    this.wss = wss;
    this.server = server;
    server.on('upgrade', (req, socket, head) => {
      try {
        if (req.url !== '/api/v1/socket' || !this.validOrigin(req, true)) throw new Error('Invalid origin');
        const device = this.authenticate(req);
        if (this.sockets.size >= 20) throw new Error('Too many connections');
        wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, device));
      } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.data.port, '127.0.0.1', resolve); });
    } catch (error) { this.server = null; wss.close(); throw error; }
    server.on('error', (error) => { this.error = error.message; });
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, attempt] of this.attempts) if (attempt.until < now) this.attempts.delete(key);
      for (const record of this.sockets.values()) {
        if (!record.alive || record.device.expiresAt < now) this.drop(record, 4003, 'Connection expired');
        else { record.alive = false; record.ws.ping(); }
      }
    }, 15_000);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    for (const record of [...this.sockets.values()]) this.drop(record, 4000, 'Remote access disabled');
    const server = this.server;
    this.server = null;
    this.wss?.close();
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }

  dispose() {
    const events = this.service.events;
    events.off('client', this.onClient);
    events.off('inventory:updated', this.onInventory);
    events.off('health:updated', this.onHealth);
    events.off('state:updated', this.onState);
    return this.stop();
  }

  drop(record, code, reason) {
    record.client.closed = true;
    this.sockets.delete(record.client.id);
    this.service.terminals.disconnect(record.client.id);
    record.ws.close(code, reason);
    const timeout = setTimeout(() => record.ws.terminate(), 1000);
    timeout.unref();
  }

  connect(ws, device) {
    const client = { id: `web:${crypto.randomUUID()}`, name: device.name };
    const record = { ws, client, device, alive: true, count: 0, reset: Date.now() + 1000, inFlight: 0, opening: 0 };
    this.sockets.set(client.id, record);
    ws.on('error', () => {});
    ws.on('pong', () => { record.alive = true; });
    ws.on('close', () => { client.closed = true; this.sockets.delete(client.id); this.service.terminals.disconnect(client.id); });
    this.send(ws, { event: 'connected', value: { clientId: client.id, ...this.bootstrap() } });
    ws.on('message', async (buffer) => {
      let request;
      try {
        if (!this.sockets.has(client.id) || !this.data.devices.some((item) => item.id === device.id)) throw new Error('Device revoked');
        if (Date.now() > record.reset) { record.count = 0; record.reset = Date.now() + 1000; }
        if (++record.count > 200 || record.inFlight >= 30) throw new Error('Too many requests');
        request = JSON.parse(buffer.toString());
        if (!ID.test(request.id) || typeof request.method !== 'string' || !Array.isArray(request.args) || request.args.length > 6) throw new Error('Invalid request');
        record.inFlight++;
        try {
          const result = await this.rpc(record, request);
          // Ready snapshots must be sent before any queued terminal events.
          this.send(ws, { id: request.id, result });
        } finally { record.inFlight--; }
      } catch (error) { this.send(ws, { id: request?.id, error: error.message }); }
    });
  }

  async once(device, request, fn) {
    const now = Date.now();
    const key = `${device.id}/${request.id}`;
    const signature = hash(JSON.stringify([request.method, request.args]));
    const old = this.data.requests.find((item) => item.key === key && item.at > now - 86_400_000);
    if (old) {
      if (old.signature !== signature) throw new Error('Request ID was already used');
      if (this.flights.has(key)) return this.flights.get(key);
      if (old.error) throw new Error(old.error);
      if (!old.done) throw new Error('Previous request outcome is unknown. Refresh sessions before trying again.');
      return old.result;
    }
    this.data.requests = this.data.requests.filter((item) => item.at > now - 86_400_000);
    if (this.data.requests.length >= 1000) throw new Error('Daily action limit reached');
    const entry = { key, signature, at: now, done: false };
    this.data.requests.push(entry);
    this.persist();
    const flight = Promise.resolve().then(fn).then((result) => {
      Object.assign(entry, { done: true, result }); this.persist(); return result;
    }, (error) => { entry.error = error.message; this.persist(); throw error; }).finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }

  rpc(record, request) {
    const { client, device } = record;
    const args = request.args;
    const service = this.service;
    const terminals = service.terminals;
    switch (request.method) {
      case 'state': return this.bootstrap();
      case 'inventory': return service.inventory();
      case 'health': return service.health();
      case 'acknowledge': return service.acknowledge(args[0]);
      case 'session:pin': return service.setSessionPinned(args[0], args[1]);
      case 'create': return this.once(device, request, () => service.create(args[0], true));
      case 'interrupt': case 'stop': return this.once(device, request, () => service.action(client, request.method, args[0], args[1]));
      case 'terminal:open': {
        if (record.opening + [...terminals.handles.values()].filter((h) => h.client.id === client.id).length >= 4) throw new Error('Close a terminal before opening another');
        record.opening++;
        return terminals.open(client, args[0], service.hostId(args[3]), args[1], args[2]).finally(() => record.opening--);
      }
      case 'terminal:ready': return terminals.ready(client, args[0]);
      case 'terminal:state': return terminals.state(client, args[0]);
      case 'terminal:take': return terminals.take(client, args[0]);
      case 'terminal:write': return terminals.write(client, args[0], args[1]);
      case 'terminal:resize': return terminals.resize(client, args[0], args[1], args[2]);
      case 'terminal:history': return terminals.retained(client, args[0]);
      case 'terminal:close': return terminals.close(client, args[0]);
      default: throw new Error('Unsupported companion operation');
    }
  }

  async body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Use application/json');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new Error('Request too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }

  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (!this.validOrigin(req, req.method !== 'GET')) return json(403, { error: 'Invalid origin' });
      if (req.url === '/api/v1/pair' && req.method === 'POST') {
        const key = String(req.headers['tailscale-user-login'] || req.socket.remoteAddress);
        const attempt = this.attempts.get(key) || { count: 0, until: Date.now() + 60_000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60_000; }
        this.attempts.set(key, attempt);
        if (++attempt.count > 10) return json(429, { error: 'Too many pairing attempts. Wait one minute.' });
        const input = await this.body(req);
        this.data.devices = this.data.devices.filter((device) => device.expiresAt > Date.now());
        if (this.data.devices.length >= 20) throw new Error('Remove an old paired device first');
        if (!this.pairing.consume(input.token, this.data.url)) return json(401, { error: 'Pairing link expired or already used. Generate a new pairing link.' });
        const secret = token();
        const device = { id: crypto.randomUUID(), name: String(input.name || 'Phone').replace(/[\x00-\x1f]/g, '').slice(0, 80), secretHash: hash(secret), createdAt: new Date().toISOString(), expiresAt: Date.now() + 90 * 86_400_000 };
        this.data.devices.push(device);
        this.persist();
        res.setHeader('Set-Cookie', `${this.cookieName()}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000${this.secureCookie() ? '; Secure' : ''}`);
        return json(200, { paired: true });
      }
      if (req.url?.startsWith('/api/')) {
        const device = this.authenticate(req);
        if (req.url === '/api/v1/state' && req.method === 'GET') return json(200, this.bootstrap());
        if (req.url === '/api/v1/logout' && req.method === 'POST') {
          this.revoke(device.id);
          res.setHeader('Set-Cookie', `${this.cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie() ? '; Secure' : ''}`);
          return json(200, { loggedOut: true });
        }
        return json(404, { error: 'Unknown endpoint' });
      }
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
      let target = String(req.url || '').split('?')[0];
      if (target === '/') target = '/companion.html';
      // Never serve the Electron desktop entry point or files outside build assets.
      if (!(target === '/companion.html' || target === '/manifest.webmanifest' || target === '/companion-sw.js' || target === '/companion-icon.svg' || /^\/assets\/[\w.-]+$/.test(target))) return json(404, { error: 'Not found' });
      const file = path.join(this.assets, target.slice(1));
      const content = await fs.promises.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(content);
    } catch (error) {
      if (!res.headersSent) json(error.code === 'ENOENT' ? 404 : /Pair this device/.test(error.message) ? 401 : 400, { error: error.code === 'ENOENT' ? 'Build companion assets first' : error.message });
      else res.end();
    }
  }
}

module.exports = { Gateway };
