const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sshBinary } = require('./platform.cjs');
const { EventEmitter } = require('node:events');
const pty = require('node-pty');
const { Store, validateSettings, validateSessionPin } = require('./config.cjs');
const { Attention } = require('./attention.cjs');
const { TmuxControl } = require('./tmux-control.cjs');
const { Terminals } = require('./terminals.cjs');
const { scrollTerminal } = require('./terminal-scroll.cjs');
const { createCleanup } = require('./cleanup.cjs');
const { uploadPng } = require('./image-upload.cjs');

function createService({ directory, home }) {
  const events = new EventEmitter();
  const SSH_BINARY = sshBinary();
  const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes'];
  const TMUX_NAME = /^hq-[a-f0-9]{12}$/;
  const OTHER_TMUX_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
  const helperSource = fs.readFileSync(path.join(__dirname, 'session-cleanup.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'worktrees.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'worktree-diff.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'remote.py'), 'utf8');
  const hookSource = fs.readFileSync(path.join(__dirname, 'session-hook.py'), 'utf8');


  const store = new Store(directory);
  const attention = new Attention(store);
  const cleanup = createCleanup({ store, events, inventory, runRemote, hostId: (id) => getHost(id).id });
  let inventoryFlight, healthFlight;

  const hostCache = new Map(Object.entries(store.data.cachedUnits).map(([hostId, units]) => [hostId, units.map((unit) => ({ ...unit, hostId, hostName: store.data.settings.hosts.find((host) => host.id === hostId)?.name || hostId }))]));
  const healthCache = new Map();
  const cpuSamples = new Map();

  async function health() {
    if (healthFlight) return healthFlight;
    healthFlight = (async () => {
      const hosts = store.data.settings.hosts.filter((h) => h.enabled);
      const results = await Promise.allSettled(hosts.map(async (h) => ({ sample: await runRemote({ action: 'health' }, h.id), receivedAt: Date.now() })));
      const readings = results.map((result, index) => {
        const host = hosts[index];
        if (result.status === 'rejected') return { ...healthCache.get(host.id), hostId: host.id, name: host.name, connected: false, error: result.reason.message };
        const { sample, receivedAt } = result.value;
        const previous = cpuSamples.get(host.id);
        const totalDelta = previous ? sample.cpuTotal - previous.cpuTotal : 0;
        const idleDelta = previous ? sample.cpuIdle - previous.cpuIdle : 0;
        const cpuPercent = totalDelta > 0 && idleDelta >= 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null;
        cpuSamples.set(host.id, sample);
        const reading = { hostId: host.id, name: host.name, connected: true, cpuPercent, memoryTotal: sample.memoryTotal, memoryUsed: sample.memoryUsed, disks: sample.disks, sampledAt: receivedAt };
        healthCache.set(host.id, reading);
        return reading;
      });
      events.emit('health:updated', readings);
      return readings;
    })().finally(() => { healthFlight = null; });
    return healthFlight;
  }

  function getHost(id) {
    const host = store.data.settings.hosts.find((h) => h.id === (id || 'default'));
    if (!host || !host.enabled) throw new Error('Host is unavailable. Enable it in Settings.');
    return host;
  }
  function sshArgs(host) { return [...SSH_ARGS, '-p', String(host.port)]; }

  async function inventory() {
    if (inventoryFlight) return inventoryFlight;
    inventoryFlight = (async () => {
      const hosts = store.data.settings.hosts.filter((h) => h.enabled);
      const results = await Promise.allSettled(hosts.map((h) => runRemote({ action: 'inventory' }, h.id)));
      const statuses = results.map((result, index) => {
        const h = hosts[index];
        if (result.status === 'fulfilled') {
          const fresh = result.value.sessions.map((s) => ({ ...s, hostId: h.id, hostName: h.name, key: `${h.id}/${s.key}` }));
          hostCache.set(h.id, fresh);
          try { store.cacheUnits(h.id, fresh); } catch (error) { console.warn(`Could not cache ${h.name} inventory: ${error.message}`); }
          return { id: h.id, name: h.name, target: h.target, user: result.value.user, connected: true };
        }
        return { id: h.id, name: h.name, target: h.target, connected: false, error: result.reason.message };
      });
      const sessions = hosts.flatMap((h) => (hostCache.get(h.id) || []).map((s) => ({ ...s, stale: !statuses.find((status) => status.id === h.id).connected }))).filter((session) => !store.data.deletedSessions.includes(session.key));
      for (const session of sessions) if (session.key.startsWith(`${session.hostId}/tmux:`)) session.outputActivity = terminals.activity(session.id, session.hostId);
      attention.update(sessions.filter((s) => !s.stale));
      const snapshot = { hosts: statuses, sessions, attention: store.data.attention };
      events.emit('inventory:updated', snapshot);
      return snapshot;
    })().finally(() => { inventoryFlight = null; });
    return inventoryFlight;
  }

  function runRemote(payload, hostId) {
    const host = getHost(hostId);
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      const child = spawn(SSH_BINARY, [...sshArgs(host), host.target, 'python3', '-', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      let settled = false;
      const timeout = setTimeout(() => child.kill(), 40000);

      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > 20_000_000) child.kill();
      });
      child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error(errors.trim() || 'SSH connection failed'));
        try {
          const response = JSON.parse(output.trim());
          if (!response.ok) return reject(new Error(response.error || 'Remote action failed'));
          resolve(response.result);
        } catch (error) {
          reject(new Error(`Invalid response from remote host: ${error.message}`));
        }
      });
      child.stdin.end(helperSource);
    });
  }


  const terminals = new Terminals({
    emit: (clientId, event, value) => events.emit('client', clientId, event, value),
    configure: async (name, hostId) => {
      if (!OTHER_TMUX_NAME.test(name)) throw new Error('Invalid tmux session name');
      getHost(hostId);
      if (TMUX_NAME.test(name)) await runRemote({ action: 'configure', name }, hostId);
    },
    spawn: (name, hostId, size) => {
      const host = getHost(hostId);
      return pty.spawn(SSH_BINARY, [...sshArgs(host), '-tt', host.target, 'env', 'TERM=xterm-256color', 'tmux', 'attach-session', '-t', name], {
        name: 'xterm-256color', ...size, cwd: home, env: { ...process.env, TERM: 'xterm-256color' },
      });
    },
    history: (name, hostId) => runRemote({ action: 'history', name }, hostId),
    scroll: async (record, direction, count) => {
      const host = getHost(record.hostId);
      if (!record.control || record.control.closed) record.control = new TmuxControl(SSH_BINARY, sshArgs(host), host.target, record.name);
      const target = record.name;
      try {
        record.historyActive = await scrollTerminal((text) => record.control.command(text), target, direction, count);
      } catch (error) {
        if (record.disposed || record.exitCode !== null) throw error;
        const result = await runRemote({ action: 'scroll', name: target, direction, lines: count }, record.hostId);
        record.historyActive = result.historyActive;
      }
    },
  });

  async function saveSettings(input) {
    if (cleanup.isBusy()) throw new Error('Wait for history cleanup before changing settings');
    await inventoryFlight;
    await healthFlight;
    if (terminals.opening.size) throw new Error('Wait for terminal connections before changing settings');
    const settings = validateSettings(input);
    for (const record of terminals.sessions.values()) {
      const oldHost = getHost(record.hostId);
      const nextHost = settings.hosts.find((h) => h.id === record.hostId);
      if (!nextHost || !nextHost.enabled || nextHost.target !== oldHost.target || nextHost.port !== oldHost.port) throw new Error('Close this host’s terminal tabs on every device before changing its connection settings');
    }
    for (const h of settings.hosts) {
      const old = store.data.settings.hosts.find((item) => item.id === h.id);
      if (!old || old.target !== h.target || old.port !== h.port) { hostCache.delete(h.id); healthCache.delete(h.id); cpuSamples.delete(h.id); }
    }
    const retained = Object.fromEntries(Object.entries(store.data.cachedUnits).filter(([hostId]) => {
      const old = store.data.settings.hosts.find((host) => host.id === hostId);
      const next = settings.hosts.find((host) => host.id === hostId);
      return old && next && next.target === old.target && next.port === old.port;
    }));
    const result = settings;
    store.update({ settings, cachedUnits: retained });
    events.emit('state:updated');
    return result;
  }

  async function create(input, requirePreset = false) {
    if (input?.conversationId && store.data.deletedSessions.includes(`${input.hostId || 'default'}/${input.provider}:${input.conversationId}`)) throw new Error('This saved history has been deleted. Start a new session instead.');
    const release = cleanup.beginLaunch(getHost(input?.hostId).id);
    try { return await createSession(input, requirePreset); } finally { release(); }
  }
  async function createSession(input, requirePreset = false) {
    const provider = input?.provider;
    if (!['codex', 'claude', 'antigravity', 'terminal'].includes(provider)) throw new Error('Invalid provider');
    const isTerminal = provider === 'terminal';
    if (isTerminal && (input.presetId || input.conversationId || input.agentId || input.instructions)) throw new Error('Terminal sessions do not accept agent launch options');
    const preset = input.presetId ? store.data.settings.presets.find((p) => p.id === input.presetId && p.provider === provider) : null;
    if ((input.presetId || (requirePreset && !isTerminal)) && !preset) throw new Error('Launch preset is unavailable');
    getHost(input.hostId);
    const isolated = input.worktree;
    if (isolated && (isTerminal || input.conversationId || input.agentId || !/^[a-f0-9]{32}$/.test(isolated.operationId || '') || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(isolated.slug || '') || typeof isolated.repository !== 'string' || isolated.repository.length > 4096 || typeof isolated.baseRef !== 'string' || isolated.baseRef.length > 200)) throw new Error('Invalid isolated task');
    const created = await runRemote({
      action: isolated ? 'worktree_launch' : 'create', provider,
      cwd: String(input.cwd || '').slice(0, 4096), title: String(input.title || '').slice(0, 100),
      conversationId: input.conversationId ? String(input.conversationId) : null,
      agentId: input.agentId ? String(input.agentId) : null,
      preset, hookSource, instructions: String(input.instructions || '').slice(0, 20000),
      ...(isolated ? { operationId: isolated.operationId, repository: isolated.repository, baseRef: isolated.baseRef, slug: isolated.slug } : {}),
    }, input.hostId);
    void inventory().catch(() => {});
    return created;
  }

  function worktrees(hostId) { return runRemote({ action: 'worktree_list' }, hostId); }
  function archiveWorktree(hostId, operationId) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)) throw new Error('Invalid worktree operation ID');
    return runRemote({ action: 'worktree_archive', operationId }, hostId);
  }
  function diffRequest(client, input, action) {
    if (!input || !TMUX_NAME.test(input.name || '') || !/^[a-f0-9]{32}$/.test(input.operationId || '') || !['diff_files', 'diff_detail', 'diff_hunk'].includes(action)) throw new Error('Invalid worktree diff request');
    if (action !== 'diff_files' && !/^[a-f0-9]{64}$/.test(input.fileId || '')) throw new Error('Invalid changed file');
    if (action === 'diff_hunk' && (!/^[a-f0-9]{64}$/.test(input.revision || '') || !/^[a-f0-9]{64}$/.test(input.hunkId || '') || !['stage', 'revert'].includes(input.operation))) throw new Error('Invalid hunk action');
    const hostId = getHost(input.hostId).id;
    if (action === 'diff_hunk') terminals.assertSessionOwner(client, input.name, hostId);
    return runRemote({ action, name: input.name, operationId: input.operationId, ...(action === 'diff_files' ? {} : { fileId: input.fileId }), ...(action === 'diff_hunk' ? { revision: input.revision, hunkId: input.hunkId, operation: input.operation } : {}) }, hostId);
  }

  function action(client, action, name, hostId) {
    const host = getHost(hostId);
    if (!['interrupt', 'stop'].includes(action) || !TMUX_NAME.test(name)) throw new Error('Invalid session name');
    terminals.assertSessionOwner(client, name, host.id);
    return runRemote({ action, name }, host.id);
  }
  async function uploadClipboardImage(client, id, png) {
    const { record } = terminals.get(client, id);
    terminals.assertOwner(client, record);
    const host = getHost(record.hostId);
    const remotePath = await uploadPng({ binary: SSH_BINARY, args: sshArgs(host), target: host.target, png });
    if (terminals.get(client, id).record !== record) throw new Error('Terminal changed during image upload');
    terminals.assertOwner(client, record);
    return remotePath;
  }
  function acknowledge(id) {
    const items = attention.acknowledge(id);
    events.emit('state:updated');
    return items;
  }
  function saveWorkspace(input) {
    const result = store.saveWorkspace(input);
    events.emit('state:updated');
    return result;
  }
  function setSessionPinned(key, pinned) {
    const hostId = validateSessionPin(key, pinned);
    if (cleanup.isDeleting(key)) throw new Error('History deletion is in progress; wait for its result');
    if (store.data.deletedSessions.includes(key)) throw new Error('History has been deleted; refresh sessions');
    if (!store.data.settings.hosts.some((host) => host.id === hostId) || !(Object.hasOwn(store.data.workspace.metadata, key) || hostCache.get(hostId)?.some((session) => session.key === key))) throw new Error('Session is unavailable. Refresh sessions before pinning it.');
    const result = store.setSessionPinned(key, pinned);
    events.emit('session:pinned', key, result);
    events.emit('state:updated');
    return result;
  }
  function cachedSession(key) {
    if (typeof key !== 'string' || key.length > 300) throw new Error('Invalid session key');
    const session = [...hostCache.values()].flat().find((item) => item.key === key);
    if (!session || store.data.deletedSessions.includes(key)) throw new Error('Session unavailable; refresh inventory');
    getHost(session.hostId);
    return session;
  }
  async function terminalPreviews(keys) {
    if (!Array.isArray(keys) || keys.length > 16 || new Set(keys).size !== keys.length) throw new Error('Choose up to 16 unique units');
    const sessions = keys.map(cachedSession);
    const results = [];
    for (let index = 0; index < sessions.length; index += 4) {
      results.push(...await Promise.all(sessions.slice(index, index + 4).map(async (session) => {
        if (!session.canAttach) return { key: session.key, text: 'This process has no attachable terminal.', sampledAt: null, error: true };
        try {
          const mirror = await terminals.preview(session.id, session.hostId);
          const text = mirror === null ? (await runRemote({ action: 'preview', name: session.id }, session.hostId)).text : mirror;
          return { key: session.key, text, sampledAt: Date.now(), error: false };
        } catch { return { key: session.key, text: 'Snapshot unavailable. Check this theater or refresh inventory.', sampledAt: null, error: true }; }
      })));
    }
    return results;
  }
  async function searchHistory(query, keys) {
    if (typeof query !== 'string' || query.length < 3 || query.length > 200 || query.includes('\0') || !Array.isArray(keys) || keys.length > 200) throw new Error('History search needs 3–200 characters and up to 200 unit keys');
    const sessions = [...new Set(keys)].map(cachedSession).filter((session) => session.canAttach);
    const selected = sessions.slice(0, 8), matches = [], errors = [];
    let truncated = sessions.length > selected.length;
    for (let index = 0; index < selected.length; index += 2) {
      const results = await Promise.allSettled(selected.slice(index, index + 2).map((session) => runRemote({ action: 'history', name: session.id }, session.hostId)));
      results.forEach((result, offset) => {
        const session = selected[index + offset];
        if (result.status === 'rejected') { errors.push(session.key); return; }
        truncated ||= result.value.truncated;
        const lines = result.value.text.split('\n');
        let count = 0;
        for (let line = 0; line < lines.length; line++) if (lines[line].toLowerCase().includes(query.toLowerCase())) {
          if (++count > 5) { truncated = true; break; }
          const position = lines[line].toLowerCase().indexOf(query.toLowerCase());
          matches.push({ key: session.key, line: line + 1, excerpt: lines[line].slice(Math.max(0, position - 70), position + query.length + 100) });
        }
      });
    }
    return { matches, searched: selected.length, total: sessions.length, truncated, errors };
  }
  return { store, events, terminals, cleanup, inventory, health, create, worktrees, archiveWorktree, diffRequest, action, uploadClipboardImage, saveSettings, saveWorkspace, setSessionPinned, acknowledge, terminalPreviews, searchHistory, hostId: (id) => getHost(id).id };
}
module.exports = { createService };
