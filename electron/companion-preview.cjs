const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const COOKIE = 'agentc2-preview';
const SECRET_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'origin', 'referer']);
const RESPONSE_HEADERS = new Set(['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials', 'connection', 'transfer-encoding']);

class PreviewGateway {
  constructor({ port, origin, deviceActive, secure = true, requestTimeout = 30000, revalidationInterval = 1000 }) {
    Object.assign(this, { port, origin, deviceActive, secure, requestTimeout, revalidationInterval });
    this.handoffs = new Map();
    this.sessions = new Map();
    this.connections = new Set();
  }

  issue(deviceId, raw) {
    const target = new URL(raw);
    if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.port || target.username || target.password) throw new Error('Preview requires an explicit loopback tunnel URL');
    const now = Date.now();
    for (const [key, value] of this.handoffs) if (value.expiresAt < now) this.handoffs.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt < now) this.sessions.delete(key);
    if (this.handoffs.size >= 100 || this.sessions.size >= 100) throw new Error('Too many development previews; wait for existing previews to expire');
    const secret = crypto.randomBytes(32).toString('base64url');
    this.handoffs.set(digest(secret), { deviceId, target, expiresAt: now + 60000 });
    return `${this.origin}/__agentc2/handoff/${secret}`;
  }

  authenticate(req) {
    if (req.headers.host !== new URL(this.origin).host || req.headers['tailscale-funnel-request']) throw new Error('Invalid preview origin');
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const record = this.sessions.get(digest(cookie ? cookie.slice(COOKIE.length + 1) : ''));
    if (!record || record.expiresAt < Date.now() || !this.deviceActive(record.deviceId)) throw new Error('Preview expired; open the development URL from AgentC2 again');
    return record;
  }

  headers(req, target) {
    return { ...Object.fromEntries(Object.entries(req.headers).filter(([name]) => !SECRET_HEADERS.has(name) && !name.startsWith('tailscale-') && !name.startsWith('x-forwarded-'))), host: target.host, origin: target.origin };
  }

  async start() {
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, handleProtocols: (_protocols, req) => req.previewProtocol });
    server.on('upgrade', (req, socket, head) => {
      try {
        const record = this.authenticate(req);
        if (req.headers.origin !== this.origin) throw new Error('Invalid preview origin');
        const target = new URL(req.url, record.target.origin);
        if (target.origin !== record.target.origin) throw new Error('Invalid preview path');
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        const protocols = req.headers['sec-websocket-protocol'] ? req.headers['sec-websocket-protocol'].split(',').map((value) => value.trim()) : [];
        const remote = new WebSocket(target, protocols, { headers: this.headers(req, record.target), followRedirects: false });
        remote.on('error', () => socket.destroy());
        socket.on('close', () => remote.terminate());
        remote.once('open', () => {
          req.previewProtocol = remote.protocol;
          this.wss.handleUpgrade(req, socket, head, (local) => {
            const connection = { local, remote, deviceId: record.deviceId, expiresAt: record.expiresAt };
            this.connections.add(connection);
            local.on('message', (data, binary) => { if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary }); });
            remote.on('message', (data, binary) => { if (local.readyState === WebSocket.OPEN) local.send(data, { binary }); });
            local.on('error', () => remote.terminate());
            local.on('close', () => { this.connections.delete(connection); remote.terminate(); });
            remote.on('close', () => local.close());
          });
        });
      } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', resolve); });
    this.timer = setInterval(() => {
      for (const connection of this.connections) if (!this.deviceActive(connection.deviceId) || connection.expiresAt < Date.now()) { connection.local.terminate(); connection.remote.terminate(); }
    }, this.revalidationInterval);
    this.timer.unref();
  }

  handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.headers.host !== new URL(this.origin).host || req.headers['tailscale-funnel-request']) throw new Error('Invalid preview origin');
      if (req.url.startsWith('/__agentc2/handoff/')) {
        const key = digest(req.url.slice('/__agentc2/handoff/'.length));
        const record = this.handoffs.get(key);
        this.handoffs.delete(key);
        if (!record || record.expiresAt < Date.now() || !this.deviceActive(record.deviceId)) throw new Error('Preview expired');
        const secret = crypto.randomBytes(32).toString('base64url');
        this.sessions.set(digest(secret), { ...record, expiresAt: Date.now() + 15 * 60000 });
        res.writeHead(303, { 'Set-Cookie': `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900${this.secure ? '; Secure' : ''}`, Location: `${record.target.pathname}${record.target.search}${record.target.hash}` });
        res.end(); return;
      }
      const record = this.authenticate(req);
      if (/^\/api\/v1\/(socket|state|pair|logout)(?:[/?]|$)/.test(req.url)) throw new Error('Invalid preview gateway path');
      if (req.headers.origin && req.headers.origin !== this.origin) throw new Error('Invalid preview origin');
      const target = new URL(req.url, record.target.origin);
      if (target.origin !== record.target.origin) throw new Error('Invalid preview path');
      const transport = target.protocol === 'https:' ? https : http;
      const remote = transport.request(target, { method: req.method, headers: this.headers(req, target), timeout: this.requestTimeout }, (response) => {
        const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !RESPONSE_HEADERS.has(name)));
        if (headers.location) {
          const location = new URL(headers.location, target);
          if (location.origin !== target.origin) { response.resume(); res.writeHead(502); res.end('External preview redirects are blocked'); return; }
          headers.location = `${location.pathname}${location.search}${location.hash}`;
        }
        res.writeHead(response.statusCode, headers); response.pipe(res);
      });
      remote.on('timeout', () => remote.destroy(new Error('Preview timed out')));
      remote.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Development server unavailable'); });
      req.on('aborted', () => remote.destroy());
      req.pipe(remote);
    } catch (error) { res.writeHead(error.message.startsWith('Invalid') ? 403 : 401); res.end(error.message); }
  }

  async close() {
    clearInterval(this.timer);
    this.handoffs.clear(); this.sessions.clear();
    for (const { local, remote } of this.connections) { local.terminate(); remote.terminate(); }
    this.wss?.close();
    if (this.server) { const server = this.server; this.server = null; await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
  }
}

module.exports = { PreviewGateway };
