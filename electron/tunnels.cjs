const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:[/?#][^\s<>"'`\\\x00-\x1f]*)?/gi;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseDevUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x1f\\]/.test(raw)) throw new Error('Invalid development URL');
  const explicitPort = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?=[/?#]|$)/i.exec(raw);
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid development URL'); }
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !explicitPort) throw new Error('Only explicit remote loopback HTTP(S) ports can be forwarded');
  const port = Number(explicitPort[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid development port');
  return { href: raw, hostname, port, protocol: url.protocol };
}

function detectedUrls(output, completeOnly = false) {
  const plain = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const found = [];
  for (const match of plain.matchAll(URL_PATTERN)) {
    if (completeOnly && (match.index + match[0].length === plain.length || !/[\s<>"'`\\),;\]]/.test(plain[match.index + match[0].length]))) continue;
    try { found.push(parseDevUrl(match[0].replace(/[),.;!?]+$/, ''))); } catch { /* Printed text is only a hint. */ }
  }
  return found;
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function probe(localPort, remote) {
  const module = remote.protocol === 'https:' ? https : http;
  await new Promise((resolve, reject) => {
    const request = module.request({ hostname: '127.0.0.1', port: localPort, path: '/', method: 'HEAD', headers: { Host: `${remote.hostname === '[::1]' ? '[::1]' : remote.hostname}:${remote.port}` }, rejectUnauthorized: false, timeout: 3000 }, (response) => { response.resume(); resolve(); });
    request.on('timeout', () => request.destroy(new Error('Remote development server did not respond')));
    request.on('error', reject);
    request.end();
  });
}

class Tunnels {
  constructor({ binary, argsForHost, onUpdate, spawnProcess = spawn }) {
    Object.assign(this, { binary, argsForHost, onUpdate, spawnProcess });
    this.records = new Map();
    this.hints = new Map();
    this.carry = new Map();
    this.closed = false;
  }

  key(hostId, remote) { return `${hostId}/${remote.hostname === '[::1]' ? '[::1]' : '127.0.0.1'}:${remote.port}`; }

  list(sessionKey) {
    return [...(this.hints.get(sessionKey)?.values() || [])].map((hint) => {
      const record = this.records.get(hint.key);
      return { url: hint.url, hostId: hint.hostId, port: hint.port, status: record?.status || (hint.local ? 'ready' : 'available'), localUrl: record?.status === 'ready' ? this.localUrl(record, hint.url) : hint.local ? hint.url : null, error: record?.status === 'failed' ? record.error : null };
    });
  }

  notify(sessionKey) { this.onUpdate(sessionKey, this.list(sessionKey)); }

  feed(host, sessionKey, data) {
    if (this.closed) return;
    const previous = this.carry.get(sessionKey) || '';
    const combined = (previous + String(data)).slice(-4096);
    this.carry.set(sessionKey, combined.slice(-256));
    const hints = this.hints.get(sessionKey) || new Map();
    for (const remote of detectedUrls(combined, true)) {
      const key = this.key(host.id, remote);
      if (hints.has(remote.href)) continue;
      if (hints.size >= 8) break;
      hints.set(remote.href, { key, url: remote.href, hostId: host.id, port: remote.port, local: host.kind === 'local' });
      this.hints.set(sessionKey, hints);
      this.notify(sessionKey);
      if (host.autoForward) void this.open(host, sessionKey, remote.href).catch(() => {});
    }
  }

  async open(host, sessionKey, url) {
    if (this.closed || !host?.enabled) throw new Error('Host is unavailable');
    const remote = parseDevUrl(url);
    const key = this.key(host.id, remote);
    const hints = this.hints.get(sessionKey) || new Map();
    if (!hints.has(remote.href) && hints.size < 8) {
      hints.set(remote.href, { key, url: remote.href, hostId: host.id, port: remote.port, local: host.kind === 'local' });
      this.hints.set(sessionKey, hints);
    }
    let record = this.records.get(key);
    if (!record) {
      if (this.records.size >= 24) throw new Error('Too many development tunnels are open');
      record = { key, host, remote, refs: new Set(), status: 'opening', error: null, port: null, child: null, retries: 0, timer: null, flight: null };
      this.records.set(key, record);
    }
    record.refs.add(sessionKey);
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    if (record.status !== 'ready' && !record.flight) record.flight = this.launch(record).finally(() => { record.flight = null; });
    this.updateRecord(record);
    if (record.flight) await record.flight;
    if (record.status !== 'ready') throw new Error(record.error || 'Development tunnel is unavailable');
    return this.localUrl(record, remote.href);
  }

  localUrl(record, source) {
    if (record.host.kind === 'local') return source;
    const url = new URL(source);
    url.hostname = '127.0.0.1';
    url.port = String(record.port);
    return url.href;
  }

  updateRecord(record) {
    const sessions = new Set(record.refs);
    for (const [sessionKey, hints] of this.hints) if ([...hints.values()].some((hint) => hint.key === record.key)) sessions.add(sessionKey);
    for (const sessionKey of sessions) this.notify(sessionKey);
  }

  scheduleRetry(record) {
    if (this.closed || !record.refs.size || record.timer) return;
    record.timer = setTimeout(() => {
      record.timer = null;
      if (record.refs.size && !record.flight) record.flight = this.launch(record).catch(() => {}).finally(() => { record.flight = null; });
    }, Math.min(30000, 1000 * 2 ** Math.min(record.retries++, 5)));
  }

  async launch(record) {
    record.status = 'opening'; record.error = null; this.updateRecord(record);
    if (record.host.kind === 'local') {
      record.port = record.remote.port;
      record.status = 'ready'; this.updateRecord(record); return;
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const port = await allocatePort();
        const destination = record.remote.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
        const args = [...this.argsForHost(record.host), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-N', '-L', `127.0.0.1:${port}:${destination}:${record.remote.port}`, record.host.target];
        const child = this.spawnProcess(this.binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        record.child = child; record.port = port;
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-500); });
        let exited = false;
        child.on('error', (error) => { exited = true; stderr = error.message; });
        child.on('exit', () => {
          exited = true;
          if (record.child !== child || this.closed || !record.refs.size) return;
          if (record.flight) return;
          record.status = 'failed'; record.error = stderr.trim() || 'SSH tunnel disconnected'; record.child = null; record.port = null;
          this.updateRecord(record);
          this.scheduleRetry(record);
        });
        const deadline = Date.now() + 8000;
        let ready = false;
        while (Date.now() < deadline && !exited) {
          try { await probe(port, record.remote); ready = true; break; } catch { await pause(150); }
        }
        if (!exited) {
          if (!ready) { child.kill(); throw new Error('Remote development server is unavailable'); }
          record.status = 'ready'; record.retries = 0; this.updateRecord(record); return;
        }
        child.kill();
        if (!/address already in use/i.test(stderr) || attempt === 2) throw new Error(stderr.trim() || 'SSH tunnel could not bind locally');
      }
    } catch (error) {
      record.status = 'failed'; record.error = error.message; record.port = null; this.updateRecord(record);
      this.scheduleRetry(record);
      throw error;
    }
  }

  release(sessionKey) {
    this.carry.delete(sessionKey);
    this.hints.delete(sessionKey);
    for (const [key, record] of this.records) {
      record.refs.delete(sessionKey);
      if (record.refs.size) { this.updateRecord(record); continue; }
      if (record.timer) clearTimeout(record.timer);
      record.child?.kill();
      this.records.delete(key);
      this.updateRecord(record);
    }
  }

  closeAll() {
    this.closed = true;
    for (const record of this.records.values()) { if (record.timer) clearTimeout(record.timer); record.child?.kill(); }
    this.records.clear(); this.hints.clear(); this.carry.clear();
  }
}

module.exports = { Tunnels, parseDevUrl, detectedUrls };
