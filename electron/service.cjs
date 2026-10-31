const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sshBinary } = require('./platform.cjs');
const { localCommand, connectionKey, localPayload } = require('./local.cjs');
const { EventEmitter } = require('node:events');
const pty = require('node-pty');
const { Store, validateSettings, resolveRoeProfile, validateRoeLaunch, validateSessionPin, validateSessionTitle } = require('./config.cjs');
const { Attention } = require('./attention.cjs');
const { TmuxControl } = require('./tmux-control.cjs');
const { Terminals } = require('./terminals.cjs');
const { scrollTerminal } = require('./terminal-scroll.cjs');
const { createCleanup } = require('./cleanup.cjs');
const { uploadPng } = require('./image-upload.cjs');
const { Tunnels } = require('./tunnels.cjs');
const { createExercises } = require('./exercises.cjs');
const { LoopBreaker } = require('./loop-breaker.cjs');
const { createSpecops } = require('./specops.cjs');
const { createCentcom } = require('./centcom.cjs');
const { createOpOrders } = require('./oporders.cjs');
const { assertDispatchScope } = require('./centcom-dispatch.cjs');
const { fingerprint } = require('./centcom-contract.cjs');
const { Chats } = require('./chat.cjs');
const { commanderFacade, routeCommanderCommands } = require('./commander.cjs');

function createService({ directory, home, specopsDirectory, centcomDirectory }) {
  const events = new EventEmitter();
  const SSH_BINARY = sshBinary();
  const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes'];
  const TMUX_NAME = /^hq-[a-f0-9]{12}$/;
  const OTHER_TMUX_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
  const helperSource = fs.readFileSync(path.join(__dirname, 'github.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'antigravity-cleanup.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'session-cleanup.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'worktrees.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'worktree-diff.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'sitrep.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'exercises.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'flash.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'provider_telemetry.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'oporders.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'chat_remote.py'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'remote.py'), 'utf8');
  const hookSource = fs.readFileSync(path.join(__dirname, 'session-hook.py'), 'utf8');
  const chatFiles = Object.fromEntries(['chat_runtime.py', 'chat_antigravity_cli.py', 'chat_worker.py', 'chat_protocol.py', 'chat_journal.py', 'chat_adapters.py', 'chat-protocol.json', 'chat_format.py', 'chat_codex.py', 'chat_codex_schema.py', 'chat-codex-schema.json', 'chat_antigravity.py', 'chat_claude.py', 'chat_claude_history.py', 'chat_launcher.py', 'chat_opencode.py'].sort().map((name) => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
  const chatDigest = crypto.createHash('sha256').update(JSON.stringify(chatFiles)).digest('hex');
  const chatBootstrapped = new Set();


  const store = new Store(directory);
  const attention = new Attention(store);
  const loopBreaker = new LoopBreaker(store);
  for (const fault of loopBreaker.faults()) if (['pending', 'attempted'].includes(fault.status)) loopBreaker.record(fault.sessionKey, 'unknown', 'Application restarted before the interrupt result was recorded');
  const cleanup = createCleanup({ store, events, inventory, runRemote, hostId: (id) => getHost(id).id });
  const exercises = createExercises({ store, getHost, runRemote, createSession, beginLaunch: (hostId) => cleanup.beginLaunch(hostId), emit: (...args) => events.emit(...args) });
  let inventoryFlight, healthFlight;
  const opOrderSynced = new Map();
  const opOrderAttempts = new Map();
  const opOrderConflicts = new Map(Object.entries(store.data.opOrderConflicts));
  const sitrepPreviews = new Map();
  const flashCache = new Map();
  let flashFlight;
  const faultFlights = new Set();
  const deletionFlights = new Set();
  const renameFlights = new Set();

  const hostCache = new Map(Object.entries(store.data.cachedUnits).map(([hostId, units]) => [hostId, units.map((unit) => ({ ...unit, hostId, hostName: store.data.settings.hosts.find((host) => host.id === hostId)?.name || hostId }))]));
  const healthCache = new Map();
  const cpuSamples = new Map();
  const gpuProbedAt = new Map();

  async function health() {
    if (healthFlight) return healthFlight;
    healthFlight = (async () => {
      const hosts = store.data.settings.hosts.filter((h) => h.enabled);
      const results = await Promise.allSettled(hosts.map(async (h) => {
        const startedAt = Date.now();
        const sample = await runRemote({ action: 'health', includeGpu: startedAt - (gpuProbedAt.get(h.id) || 0) >= 30000 }, h.id);
        return { sample, receivedAt: Date.now(), roundTripMs: Date.now() - startedAt };
      }));
      const readings = results.map((result, index) => {
        const host = hosts[index];
        if (result.status === 'rejected') { cpuSamples.delete(host.id); return { ...healthCache.get(host.id), hostId: host.id, name: host.name, connected: false, error: result.reason.message }; }
        const { sample, receivedAt, roundTripMs } = result.value;
        const previous = cpuSamples.get(host.id);
        const totalDelta = previous ? sample.cpuTotal - previous.cpuTotal : 0;
        const idleDelta = previous ? sample.cpuIdle - previous.cpuIdle : 0;
        const cpuPercent = totalDelta > 0 && idleDelta >= 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null;
        cpuSamples.set(host.id, sample);
        if (sample.gpu) gpuProbedAt.set(host.id, receivedAt);
        const activeChannels = [...terminals.sessions.values()].filter((record) => record.hostId === host.id && !record.disposed && record.connection === 'connected').reduce((count, record) => count + record.handles.size, 0);
        const reading = { hostId: host.id, name: host.name, connected: true, cpuPercent, memoryTotal: sample.memoryTotal, memoryUsed: sample.memoryUsed, resources: sample.resources || { status: 'unknown', reason: 'Helper did not report resource constraints' }, disks: sample.disks, sampledAt: receivedAt, sshRoundTripMs: roundTripMs, activeChannels, gpu: sample.gpu || healthCache.get(host.id)?.gpu || { status: 'unknown', sampledAt: null, devices: [] } };
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
  const tunnels = new Tunnels({ binary: SSH_BINARY, argsForHost: sshArgs, onUpdate: (sessionKey, urls) => events.emit('tunnel:updated', { sessionKey, urls }) });

  async function inventory() {
    if (inventoryFlight) return inventoryFlight;
    inventoryFlight = (async () => {
      const hosts = store.data.settings.hosts.filter((h) => h.enabled);
      const results = await Promise.allSettled(hosts.map((h) => runRemote({ action: 'inventory', sourceDigest: chatDigest, chatFiles, allowUpgrade: true }, h.id)));
      const statuses = results.map((result, index) => {
        const h = hosts[index];
        if (result.status === 'fulfilled') {
          const fresh = result.value.sessions.map((s) => ({ ...s, hostId: h.id, hostName: h.name, key: `${h.id}/${s.key}` }));
          hostCache.set(h.id, fresh);
          try { store.cacheUnits(h.id, fresh); } catch (error) { console.warn(`Could not cache ${h.name} inventory: ${error.message}`); }
          void reconcileOpOrders(h.id);
          return { id: h.id, name: h.name, target: h.target, user: result.value.user, connected: true };
        }
        for (const order of store.data.settings.opOrders || []) if (order.hostId === h.id) { opOrderSynced.delete(order.id); opOrderAttempts.delete(order.id); }
        return { id: h.id, name: h.name, target: h.target, connected: false, error: result.reason.message };
      });
      const roster = centcom.rosterInventory({ sessions: hosts.flatMap((h) => (hostCache.get(h.id) || []).map((s) => ({ ...s, stale: !statuses.find((status) => status.id === h.id).connected }))).filter((session) => !store.data.deletedSessions.includes(session.key)), attention: store.data.attention, faults: loopBreaker.faults() });
      const sessions = roster.sessions;
      for (const session of sessions) if (session.key.startsWith(`${session.hostId}/tmux:`)) session.outputActivity = terminals.activity(session.id, session.hostId);
      attention.resolveRequests(sessions.filter((s) => !s.stale).flatMap((s) => s.resolvedRequestIds || []));
      attention.update(sessions.filter((s) => !s.stale));
      const raised = loopBreaker.observe(sessions.filter((s) => !s.stale));
      for (const fault of raised) {
        const item = { id: crypto.randomUUID(), sessionKey: fault.sessionKey, hostId: fault.sessionKey.split('/')[0], title: sessions.find((s) => s.key === fault.sessionKey)?.title || fault.sessionKey, provider: 'claude', createdAt: fault.at, acknowledged: false, signature: `loop:${fault.id}`, kind: 'failed', confidence: 'confirmed', detail: `${fault.detail}. ${fault.label}. Review the fault before resuming.` };
        store.save('attention', [...store.data.attention, item].slice(-500));
        if (fault.autoInterrupt) void interruptFault({ id: 'desktop' }, fault.sessionKey).catch((error) => console.warn(`Automatic interrupt failed: ${error.message}`));
      }
      const missions = specops.list();
      for (const session of sessions) {
        const mission = missions.find((r) => r.hostId === session.hostId && r.visits.some((v) => v.name === session.id));
        if (mission) session.specops = { id: mission.id, state: mission.state, breadcrumb: mission.workflow.stages.map((s) => s.id === mission.stage ? `[*${s.id}*]` : `[${s.id}]`).join(' → ') };
      }
      const missionSummaries = missions.map(({ id, hostId, repo, state, stage, error, workflow, costUsd, costKnown, canResume, canRetry }) => ({ id, hostId, repo, state, stage, error, workflow, costUsd, costKnown, canResume, canRetry, visits: [] }));
      const snapshot = centcom.rosterInventory({ capturedAt: new Date().toISOString(), missions: missionSummaries, hosts: statuses, sessions, internalSessionKeys: roster.internalSessionKeys, attention: store.data.attention, faults: loopBreaker.faults() });
      snapshot.conflicts = [...opOrderConflicts.values()];
      events.emit('inventory:updated', snapshot);
      return snapshot;
    })().finally(() => { inventoryFlight = null; });
    return inventoryFlight;
  }

  async function reconcileOpOrders(hostId) {
    for (const order of store.data.settings.opOrders || []) {
      if (!order.enabled || order.hostId !== hostId) continue;
      const fingerprint = JSON.stringify(order);
      if (opOrderSynced.get(order.id) === fingerprint || Date.now() - (opOrderAttempts.get(order.id) || 0) < 60000) continue;
      opOrderAttempts.set(order.id, Date.now());
      try {
        await runRemote({ action: 'oporder_sync', order }, hostId);
        opOrderSynced.set(order.id, fingerprint);
        if (opOrderConflicts.delete(order.id)) store.save('opOrderConflicts', Object.fromEntries(opOrderConflicts));
      } catch (error) {
        opOrderConflicts.set(order.id, { id: order.id, hostId, detail: error.message.slice(0, 300), at: new Date().toISOString() });
        store.save('opOrderConflicts', Object.fromEntries(opOrderConflicts));
        console.warn(`OpOrder ${order.id} needs review: ${error.message}`);
        events.emit('oporder:conflict', { id: order.id, hostId, error: error.message });
      }
    }
  }

  async function runRemote(payload, hostId) {
    if (payload.action === 'inventory' && !payload.sourceDigest) payload = { ...payload, sourceDigest: chatDigest, chatFiles, allowUpgrade: true };
    const host = getHost(hostId);
    if (host.kind === 'local') payload = { ...await localPayload(payload), localHost: true };
    payload = assertDispatchScope(getHost(hostId), payload, store.data.settings);
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      const embedded = encoded.length > 60000;
      const execution = host.kind === 'local' ? localCommand('python3', ['-', ...(embedded ? [] : [encoded])]) : { binary: SSH_BINARY, args: [...sshArgs(host), host.target, 'python3', '-', ...(embedded ? [] : [encoded])], env: process.env };
      const child = spawn(execution.binary, execution.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: execution.env,
      });
      let output = '';
      let errors = '';
      let settled = false;
      const timeout = setTimeout(() => child.kill(), payload.request?.prepareProvider ? 330000 : payload.action === 'cleanup_delete' && payload.provider === 'antigravity' ? 300000 : 40000);

      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > 20_000_000) child.kill();
      });
      child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(host.kind === 'local' && error.code === 'ENOENT' ? new Error('Local execution requires Python 3.10+ and tmux. Install them on this computer (inside the default WSL distribution on Windows), then retry.', { cause: error }) : error); }
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error(errors.trim() || (host.kind === 'local' ? 'Local execution failed. Install Python 3 and tmux (inside the default WSL distribution on Windows).' : 'SSH connection failed')));
        try {
          const response = JSON.parse(output.trim());
          if (!response.ok) return reject(new Error(response.error || 'Remote action failed'));
          resolve(response.result);
        } catch (error) {
          reject(new Error(`Invalid response from remote host: ${error.message}`));
        }
      });
      child.stdin.end(embedded ? `AGENTC2_PAYLOAD_B64 = '${encoded}'\n${helperSource}` : helperSource);
    });
  }


  const chats = new Chats({
    remote: async (hostId, request) => {
      const host = getHost(hostId);
      const key = `${host.id}/${connectionKey(host)}`;
      try {
        // A different desktop can replace an idle worker after our first read.
        // Explicit launch preparation must offer this bundle again; the remote
        // retirement guard still preserves workers that own sessions or work.
        const prepareLaunch = request.action === 'capabilities' && request.prepareProvider;
        const result = await runRemote({ action: 'chat', sourceDigest: chatDigest, allowUpgrade: true, ...(!chatBootstrapped.has(key) || prepareLaunch ? { chatFiles } : {}), request }, hostId);
        chatBootstrapped.add(key);
        return result;
      } catch (error) { chatBootstrapped.delete(key); throw error; }
    },
    resolveHost: (hostId) => getHost(hostId).id,
    emit: (clientId, event, value) => events.emit('client', clientId, event, value),
    onEvents: (record, chatEvents) => {
      events.emit('commander:chat-evidence', record, chatEvents);
      const name = record.session.managedName;
      if (!TMUX_NAME.test(name || '')) return;
      for (const event of chatEvents) {
        const output = event.type === 'tool.completed' ? event.data.output : event.type === 'message.completed' ? event.data.text : '';
        // Feed bounded chunks so links near the start of a long tool result
        // remain discoverable by the existing terminal URL detector.
        for (let offset = 0; offset < output.length; offset += 2048) tunnels.feed(getHost(record.hostId), `${record.hostId}/tmux:${name}`, output.slice(offset, offset + 2048));
        if (output) tunnels.feed(getHost(record.hostId), `${record.hostId}/tmux:${name}`, '\n');
      }
    },
    onDispose: (record) => { if (TMUX_NAME.test(record.session.managedName || '')) tunnels.release(`${record.hostId}/tmux:${record.session.managedName}`); },
  });

  const terminals = new Terminals({
    emit: (clientId, event, value) => events.emit('client', clientId, event, value),
    onOutput: (record, data) => tunnels.feed(getHost(record.hostId), `${record.hostId}/tmux:${record.name}`, data),
    onDispose: (record) => tunnels.release(`${record.hostId}/tmux:${record.name}`),
    configure: async (name, hostId) => {
      if (!OTHER_TMUX_NAME.test(name)) throw new Error('Invalid tmux session name');
      getHost(hostId);
      if (TMUX_NAME.test(name)) await runRemote({ action: 'configure', name }, hostId);
    },
    spawn: (name, hostId, size) => {
      const host = getHost(hostId);
      const execution = host.kind === 'local' ? localCommand('tmux', ['attach-session', '-t', name]) : { binary: SSH_BINARY, args: [...sshArgs(host), '-tt', host.target, 'env', 'TERM=xterm-256color', 'tmux', 'attach-session', '-t', name], env: process.env };
      return pty.spawn(execution.binary, execution.args, {
        name: 'xterm-256color', ...size, cwd: home, env: { ...execution.env, TERM: 'xterm-256color' },
      });
    },
    history: (name, hostId) => runRemote({ action: 'history', name }, hostId),
    confirmInput: async (record, data, guard) => {
      // take() has already established this session's control connection.
      // Never reconnect or fall back after an uncertain input submission.
      if (!record.control || record.control.closed) throw new Error('Acknowledged terminal control is unavailable');
      await record.control.sendInput(data, guard);
    },
    scroll: async (record, direction, count) => {
      const host = getHost(record.hostId);
      if (!record.control || record.control.closed) {
        const local = host.kind === 'local' ? localCommand('tmux', []) : null;
        record.control = local ? new TmuxControl(local.binary, local.args, null, record.name, local.env) : new TmuxControl(SSH_BINARY, sshArgs(host), host.target, record.name);
      }
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

  async function saveSettings(input, expectedRevision, source) {
    if (deletionFlights.size || renameFlights.size) throw new Error('Wait for session deletion or renaming before changing settings');
    if (cleanup.isBusy()) throw new Error('Wait for history cleanup before changing settings');
    await inventoryFlight;
    await healthFlight;
    if (expectedRevision && expectedRevision !== fingerprint(store.data.settings)) throw Object.assign(new Error('Configuration changed before persistence; review again'), { beforeMutation: true });
    if (terminals.opening.size) throw new Error('Wait for terminal connections before changing settings');
    const settings = validateSettings(input);
    for (const order of settings.opOrders) {
      if (!order.enabled) continue;
      const previous = store.data.settings.opOrders?.find((item) => item.id === order.id);
      if (source !== 'peer-sync' && (!previous?.enabled || JSON.stringify(previous) !== JSON.stringify(order))) throw new Error('Preview and enroll changed OpOrders before enabling sync');
    }
    for (const record of terminals.sessions.values()) {
      const oldHost = getHost(record.hostId);
      const nextHost = settings.hosts.find((h) => h.id === record.hostId);
      if (!nextHost || !nextHost.enabled || connectionKey(nextHost) !== connectionKey(oldHost)) throw new Error('Close this host’s terminal tabs on every device before changing its connection settings');
    }
    for (const record of chats.sessions.values()) {
      const oldHost = getHost(record.hostId);
      const nextHost = settings.hosts.find((host) => host.id === record.hostId);
      if (!nextHost || !nextHost.enabled || connectionKey(nextHost) !== connectionKey(oldHost)) throw new Error('Close this host’s chat views on every device before changing its connection settings');
    }
    for (const h of settings.hosts) {
      const old = store.data.settings.hosts.find((item) => item.id === h.id);
      if (!old || connectionKey(old) !== connectionKey(h)) { hostCache.delete(h.id); healthCache.delete(h.id); cpuSamples.delete(h.id); gpuProbedAt.delete(h.id); }
    }
    const retained = Object.fromEntries(Object.entries(store.data.cachedUnits).filter(([hostId]) => {
      const old = store.data.settings.hosts.find((host) => host.id === hostId);
      const next = settings.hosts.find((host) => host.id === hostId);
      return old && next && connectionKey(next) === connectionKey(old);
    }));
    const result = settings;
    store.update({ settings, cachedUnits: retained }, source);
    for (const order of settings.opOrders) if (!order.enabled) { opOrderSynced.delete(order.id); opOrderAttempts.delete(order.id); opOrderConflicts.delete(order.id); }
    for (const id of opOrderConflicts.keys()) if (!store.data.settings.opOrders.some((order) => order.id === id)) opOrderConflicts.delete(id);
    if (JSON.stringify(Object.fromEntries(opOrderConflicts)) !== JSON.stringify(store.data.opOrderConflicts)) store.save('opOrderConflicts', Object.fromEntries(opOrderConflicts));
    events.emit('state:updated');
    return result;
  }

  const { previewOpOrder, enrollOpOrder } = createOpOrders({ store, getHost, runRemote, opOrderSynced, events });

  async function create(input, requirePreset = false) {
    if (input?.conversationId && store.data.deletedSessions.includes(`${input.hostId || 'default'}/${input.provider}:${input.conversationId}`)) throw new Error('This saved history has been deleted. Start a new session instead.');
    const release = cleanup.beginLaunch(getHost(input?.hostId).id);
    try { return await createSession(input, requirePreset); } finally { release(); }
  }
  async function createSession(input, requirePreset = false, internalSitrep = null) {
    const provider = input?.provider;
    if (!['codex', 'claude', 'antigravity', 'opencode', 'terminal'].includes(provider)) throw new Error('Invalid provider');
    const isTerminal = provider === 'terminal';
    if (input.transport !== undefined && !['chat', 'terminal'].includes(input.transport)) throw new Error('Invalid session transport');
    if (input.launchId !== undefined && !/^[a-f0-9]{32}$/.test(input.launchId)) throw new Error('Invalid launch ID');
    if (isTerminal && (input.presetId || input.conversationId || input.agentId || input.instructions)) throw new Error('Terminal sessions do not accept agent launch options');
    const preset = input.presetId ? store.data.settings.presets.find((p) => p.id === input.presetId && p.provider === provider) : null;
    if ((input.presetId || (requirePreset && !isTerminal)) && !preset) throw new Error('Launch preset is unavailable');
    const host = getHost(input.hostId);
    if (input.agentId && input.roeProfile) throw new Error('An existing background agent keeps its original permission mode');
    const roeProfile = resolveRoeProfile(store.data.settings, host.id, preset, input.roeProfile);
    const isolated = input.worktree;
    const customCommand = preset && (preset.command !== (provider === 'antigravity' ? 'agy' : provider) || preset.args.trim());
    const transport = isTerminal || input.agentId || customCommand ? 'terminal' : input.transport || 'chat';
    validateRoeLaunch(provider, preset, roeProfile, transport);
    if (input.transport === 'chat' && transport !== 'chat') throw new Error('This launch requires terminal mode because it uses a custom command or an existing background agent');
    if (host.kind === 'local') await runRemote({ action: 'requirements' }, host.id);
    if (transport === 'chat') {
      const capability = (await chats.capabilities(host.id, provider)).find((item) => item.provider === provider);
      if (capability?.status !== 'supported') throw new Error(`${capability?.reason || 'Structured chat is unavailable'}. Select Terminal in the launch dialog to use the existing CLI flow.`);
    }
    if (input.recoverSitrep !== undefined && input.recoverSitrep !== true) throw new Error('Invalid SitRep recovery flag');
    if (input.recoverSitrep && !isolated) throw new Error('SitRep recovery requires an owned worktree');
    if (isolated && (isTerminal || input.conversationId || input.agentId || !/^[a-f0-9]{32}$/.test(isolated.operationId || '') || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(isolated.slug || '') || typeof isolated.repository !== 'string' || isolated.repository.length > 4096 || typeof isolated.baseRef !== 'string' || isolated.baseRef.length > 200)) throw new Error('Invalid isolated task');
    const payload = {
      action: isolated ? 'worktree_launch' : 'create', provider, transport,
      ...(!isolated && transport === 'chat' ? { managedName: `hq-${crypto.createHash('sha256').update(input.launchId || crypto.randomUUID()).digest('hex').slice(0, 12)}` } : {}),
      ...(transport === 'chat' ? { sourceDigest: chatDigest, chatFiles, allowUpgrade: true } : {}),
      ...(input.model ? { model: String(input.model).slice(0, 200) } : {}),
      cwd: String(input.cwd || '').slice(0, 4096), title: String(input.title || '').slice(0, 100),
      conversationId: input.conversationId ? String(input.conversationId) : null,
      agentId: input.agentId ? String(input.agentId) : null,
      preset, roeProfile, hookSource, instructions: String(input.instructions || '').slice(0, 20000),
      ...(isolated ? { operationId: isolated.operationId, repository: isolated.repository, baseRef: isolated.baseRef, slug: isolated.slug, ...(input.recoverSitrep ? { recoverSitrep: true } : {}) } : {}),
      ...(internalSitrep ? { sitrep: internalSitrep } : {}),
    };
    const created = await centcom.guardLaunch({ ...input, hostId: host.id, cwd: input.cwd || preset?.cwd || '' }, () => runRemote(payload, input.hostId));
    void inventory().catch(() => {});
    return created;
  }

  function worktrees(hostId) { return runRemote({ action: 'worktree_list' }, hostId); }
  function assertManagedOwner(client, name, hostId) {
    const session = hostCache.get(hostId)?.find((item) => item.id === name);
    if (session?.transport === 'chat') return chats.assertSessionOwner(client, session.chatSessionId, hostId);
    return terminals.assertSessionOwner(client, name, hostId);
  }
  async function flashQueue() {
    if (flashFlight) return flashFlight;
    flashFlight = (async () => {
      const hosts = store.data.settings.hosts.filter((host) => host.enabled);
      const results = await Promise.allSettled(hosts.map((host) => runRemote({ action: 'flash_list' }, host.id)));
      const queue = results.flatMap((result, index) => {
        const host = hosts[index];
        if (result.status === 'fulfilled') {
          const items = result.value.filter((item) => item?.provider === 'claude' && /^[a-f0-9]{32}$/.test(item.id || '') && TMUX_NAME.test(item.name || '')).map((item) => ({ ...item, hostId: host.id, hostName: host.name, connected: true, branch: item.branch || hostCache.get(host.id)?.find((unit) => unit.id === item.name)?.branch || '' }));
          flashCache.set(host.id, items);
          attention.resolveRequests(items.filter((item) => ['resolved', 'expired'].includes(item.state)).map((item) => item.id));
          return items;
        }
        return (flashCache.get(host.id) || []).map((item) => ({ ...item, connected: false }));
      });
      return queue.sort((a, b) => a.createdAt - b.createdAt);
    })().finally(() => { flashFlight = null; });
    return flashFlight;
  }
  async function flashDecide(client, input) {
    if (!input || !['allow', 'deny'].includes(input.decision) || !TMUX_NAME.test(input.name || '') || !/^[a-f0-9]{32}$/.test(input.id || '')) throw new Error('Invalid Flash Traffic decision');
    const hostId = getHost(input.hostId).id;
    assertManagedOwner(client, input.name, hostId);
    const terminal = terminals.sessions.get(`${hostId}/${input.name}`);
    if (terminal && (terminal.connection !== 'connected' || terminal.exitCode !== null)) throw new Error('Target terminal is disconnected or exited');
    const current = await runRemote({ action: 'flash_list' }, hostId);
    const request = current.find((item) => item.id === input.id && item.name === input.name);
    if (!request || !['pending', 'submitted', 'resolved'].includes(request.state)) throw new Error('Permission request is unavailable or expired');
    if (request.decision && request.decision !== input.decision) throw new Error('Permission request already has a different decision');
    const result = await runRemote({ action: 'flash_decide', name: input.name, id: input.id, decision: input.decision }, hostId);
    void flashQueue().catch(() => {});
    return result;
  }
  function archiveWorktree(hostId, operationId) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)) throw new Error('Invalid worktree operation ID');
    return runRemote({ action: 'worktree_archive', operationId }, hostId);
  }
  function diffRequest(client, input, action) {
    if (!input || !TMUX_NAME.test(input.name || '') || !/^[a-f0-9]{32}$/.test(input.operationId || '') || !['diff_files', 'diff_detail', 'diff_hunk'].includes(action)) throw new Error('Invalid worktree diff request');
    if (action !== 'diff_files' && !/^[a-f0-9]{64}$/.test(input.fileId || '')) throw new Error('Invalid changed file');
    if (action === 'diff_hunk' && (!/^[a-f0-9]{64}$/.test(input.revision || '') || !/^[a-f0-9]{64}$/.test(input.hunkId || '') || !['stage', 'revert'].includes(input.operation))) throw new Error('Invalid hunk action');
    const hostId = getHost(input.hostId).id;
    if (action === 'diff_hunk') assertManagedOwner(client, input.name, hostId);
    return runRemote({ action, name: input.name, operationId: input.operationId, ...(action === 'diff_files' ? {} : { fileId: input.fileId }), ...(action === 'diff_hunk' ? { revision: input.revision, hunkId: input.hunkId, operation: input.operation } : {}) }, hostId);
  }

  async function previewSitrep(client, input) {
    if (!input || !TMUX_NAME.test(input.name || '') || !/^[a-f0-9]{32}$/.test(input.operationId || '') || typeof input.repository !== 'string' || (input.repository && !input.repository.startsWith('/')) || input.repository.length > 4096 || typeof input.testCommand !== 'string' || input.testCommand.length > 500) throw new Error('Invalid SitRep preview request');
    const sourceHostId = getHost(input.sourceHostId).id;
    const targetHostId = getHost(input.targetHostId).id;
    if (input.testCommand) assertManagedOwner(client, input.name, sourceHostId);
    const source = await runRemote({ action: 'sitrep_source_preview', name: input.name, operationId: input.operationId, testCommand: input.testCommand }, sourceHostId);
    const repository = input.repository || (sourceHostId === targetHostId ? source.source.repository : '');
    if (!repository) throw new Error('Enter the primary Git checkout on the target host');
    const target = await runRemote({ action: 'sitrep_target_preview', repository, source: source.source, patchBase64: source.patchBase64 }, targetHostId);
    const id = crypto.randomBytes(16).toString('hex');
    sitrepPreviews.set(id, { sourceHostId, targetHostId, name: input.name, operationId: input.operationId, repository, revision: source.revision, test: source.test, createdAt: Date.now(), launchOperationId: null });
    for (const [key, value] of sitrepPreviews) if (Date.now() - value.createdAt > 15 * 60_000) sitrepPreviews.delete(key);
    return { version: 1, id, source: source.source, target, revision: source.revision, patchPreview: source.patchPreview, patchPreviewTruncated: source.patchPreviewTruncated, patchBytes: source.patchBytes, untracked: source.untracked, warnings: source.warnings, test: source.test, ready: target.ready && !source.warnings.length };
  }

  async function launchSitrep(client, input) {
    const preview = sitrepPreviews.get(input?.id);
    if (!preview || Date.now() - preview.createdAt > 15 * 60_000 || !/^[a-f0-9]{32}$/.test(input?.operationId || '') || (preview.launchOperationId && preview.launchOperationId !== input.operationId)) throw new Error('SitRep preview expired or operation changed; preview again');
    assertManagedOwner(client, preview.name, preview.sourceHostId);
    const field = (value, max) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid SitRep text'); return value.trim(); };
    const objective = field(input.objective, 2000);
    const summary = field(input.summary, 4000);
    const nextSteps = field(input.nextSteps, 2000);
    const title = field(input.title, 100);
    const slug = field(input.slug, 40);
    if (!objective || !summary || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) || !['codex', 'claude', 'antigravity', 'opencode'].includes(input.provider)) throw new Error('SitRep needs an objective, summary, provider, and task slug');
    const source = await runRemote({ action: 'sitrep_source_preview', name: preview.name, operationId: preview.operationId, testCommand: '' }, preview.sourceHostId);
    if (source.revision !== preview.revision || source.warnings.length) throw new Error('Source changed after SitRep preview; review again');
    const target = await runRemote({ action: 'sitrep_target_preview', repository: preview.repository, source: source.source, patchBase64: source.patchBase64 }, preview.targetHostId);
    if (!target.ready) throw new Error(target.reason || 'Target base changed; review again');
    const test = preview.test;
    const evidence = test ? `Ran on ${preview.sourceHostId} in ${source.source.path} at ${new Date(test.ranAt).toISOString()}\nCommand: ${test.command}\nExit: ${test.timedOut ? 'timed out' : test.exitCode}\nOutput${test.outputTruncated ? ' (tail, truncated)' : ''}:\n${test.output}` : 'No test command was run for this handoff.';
    const instructions = `SitRep handoff\nObjective: ${objective}\nSummary: ${summary}\nNext steps: ${nextSteps || 'Review the applied changes and continue the objective.'}\nSource: ${preview.sourceHostId}/${source.source.name} · ${source.source.repository} · ${source.source.branch}\nSource base: ${source.source.baseCommit}\nSource HEAD: ${source.source.headCommit}\nReviewed patch: ${source.patchBytes} bytes, applied to this worktree before launch.\nTest evidence: ${evidence}`;
    if (instructions.length > 20000) throw new Error('SitRep exceeds provider input limit');
    preview.launchOperationId = input.operationId;
    const patch = Buffer.from(source.patchBase64, 'base64');
    const release = cleanup.beginLaunch(preview.targetHostId);
    try {
      const result = await createSession({ provider: input.provider, presetId: input.presetId, hostId: preview.targetHostId, title, instructions, roeProfile: input.roeProfile, worktree: { operationId: input.operationId, repository: preview.repository, baseRef: source.source.baseCommit, slug } }, false,
        { patchBase64: source.patchBase64, digest: crypto.createHash('sha256').update(patch).digest('hex'), source: { version: 1, hostId: preview.sourceHostId, operationId: preview.operationId, name: preview.name, repository: source.source.repository, revision: preview.revision } });
      return { ...result, hostId: preview.targetHostId };
    } finally { release(); }
  }

  async function action(client, action, name, hostId) {
    const host = getHost(hostId);
    if (!['interrupt', 'stop'].includes(action) || !TMUX_NAME.test(name)) throw new Error('Invalid session name');
    const unit = hostCache.get(host.id)?.find((item) => item.id === name);
    if (unit?.transport === 'chat') {
      const record = chats.sessions.get(`${host.id}/${unit.chatSessionId}`);
      const handle = [...(record?.handles || [])].find((id) => chats.handles.get(id)?.client.id === client.id);
      if (!handle) throw new Error('Open the chat and take control before changing this session');
      return chats.submit(client, handle, { protocolVersion: 1, commandId: crypto.randomUUID(), operation: action, sessionId: unit.chatSessionId, payload: {} });
    }
    terminals.assertSessionOwner(client, name, host.id);
    const pending = action === 'stop' ? await runRemote({ action: 'flash_list' }, host.id).catch(() => []) : [];
    const result = await runRemote({ action, name }, host.id);
    if (action === 'stop') attention.resolveRequests(pending.filter((item) => item.name === name).map((item) => item.id));
    return result;
  }
  async function deleteSession(client, key, commander = false) {
    if (client.closed || (client.id !== 'desktop' && !(commander && client.id === 'centcom-commander')) || typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,80}\/tmux:hq-[a-f0-9]{12}$/.test(key)) throw new Error('Invalid managed session deletion');
    if (deletionFlights.has(key) || renameFlights.has(key)) throw new Error('Session deletion or renaming is already in progress');
    deletionFlights.add(key);
    let release;
    try {
      const snapshot = await inventory();
      const unit = snapshot.sessions.find((session) => session.key === key);
      if (!unit || unit.kind !== 'managed' || unit.stale) throw new Error('Reconnect the host and refresh this managed session before deleting it');
      release = cleanup.beginLaunch(unit.hostId);
      if (unit.transport === 'chat') {
        if (unit.canStop) {
          const record = chats.assertSessionOwner(client, unit.chatSessionId, unit.hostId);
          const handle = [...record.handles].find((id) => chats.handles.get(id)?.client.id === client.id);
          let receipt = await action(client, 'stop', unit.id, unit.hostId);
          const deadline = Date.now() + 15000;
          while (['accepted', 'dispatching'].includes(receipt.state) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            receipt = await chats.receipt(client, handle, receipt.commandId);
          }
          if (receipt.state !== 'completed') throw new Error(receipt.error || 'Stop is not confirmed. The session was not deleted; inspect its state before retrying.');
        } else if (!['stopped', 'failed'].includes(unit.chatState)) {
          throw new Error('Session state is uncertain. Reconnect or stop it before deleting it.');
        }
      } else {
        await action(client, 'stop', unit.id, unit.hostId);
      }
      store.forgetSessions([key]);
      events.emit('sessions:deleted', [key]);
      events.emit('state:updated');
    } finally {
      release?.();
      deletionFlights.delete(key);
    }
  }
  async function interruptFault(client, sessionKey) {
    const fault = loopBreaker.faults().find((item) => item.sessionKey === sessionKey);
    if (!fault || !['pending', 'review', 'failed', 'unknown'].includes(fault.status)) throw new Error('No eligible confirmed fault');
    const match = /^([A-Za-z0-9_-]{1,80})\/tmux:(hq-[a-f0-9]{12})$/.exec(sessionKey);
    if (!match) throw new Error('Invalid fault target');
    if (faultFlights.has(sessionKey)) throw new Error('Fault interrupt is already in progress');
    faultFlights.add(sessionKey);
    const [, hostId, name] = match;
    try {
      assertManagedOwner(client, name, hostId);
      const host = getHost(hostId);
      const fresh = await runRemote({ action: 'inventory' }, host.id);
      const unit = fresh.sessions.find((item) => item.key === `tmux:${name}`);
      if (!unit || unit.kind !== 'managed' || unit.provider !== 'claude' || unit.state !== 'live' || !unit.canInterrupt || !unit.presetId || unit.presetId !== (hostCache.get(hostId) || []).find((item) => item.key === sessionKey)?.presetId) throw new Error('Faulted managed unit changed or exited; refresh and review');
      assertManagedOwner(client, name, hostId);
      loopBreaker.record(sessionKey, 'attempted', 'A scoped interrupt was requested; awaiting remote acceptance');
      const response = await action(client, 'interrupt', name, hostId);
      if (unit.transport === 'chat') {
        const record = chats.assertSessionOwner(client, unit.chatSessionId, hostId);
        const handle = [...record.handles].find((id) => chats.handles.get(id)?.client.id === client.id);
        let receipt = response;
        const deadline = Date.now() + 20000;
        while (['accepted', 'dispatching'].includes(receipt.state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          try { receipt = await chats.receipt(client, handle, receipt.commandId); }
          catch { return loopBreaker.record(sessionKey, 'unknown', 'Interrupt receipt could not be read; no action was resent'); }
        }
        if (receipt.state !== 'completed') return loopBreaker.record(sessionKey, receipt.state === 'failed' ? 'failed' : 'unknown', receipt.error || 'Provider interrupt acknowledgement is unresolved; inspect the chat');
      }
      return loopBreaker.record(sessionKey, 'interrupted', unit.transport === 'chat' ? 'Managed provider acknowledged one scoped interrupt' : 'Remote tmux accepted one scoped Ctrl+C');
    } catch (error) {
      if (loopBreaker.faults().some((item) => item.sessionKey === sessionKey && item.status !== 'interrupted')) loopBreaker.record(sessionKey, 'failed', error.message);
      throw error;
    } finally { faultFlights.delete(sessionKey); events.emit('state:updated'); void inventory().catch(() => {}); }
  }
  async function interruptFaults(client) {
    const targets = loopBreaker.faults().filter((item) => ['review', 'failed', 'unknown'].includes(item.status));
    const results = [];
    for (const target of targets) {
      try { results.push(await interruptFault(client, target.sessionKey)); }
      catch (error) { results.push({ sessionKey: target.sessionKey, status: 'failed', result: error.message }); }
    }
    return results;
  }
  function resetFault(sessionKey) {
    if (typeof sessionKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}\/tmux:hq-[a-f0-9]{12}$/.test(sessionKey)) throw new Error('Invalid fault target');
    const result = loopBreaker.reset(sessionKey);
    events.emit('state:updated');
    return result;
  }
  async function uploadClipboardImage(client, id, png) {
    const { record } = terminals.get(client, id);
    terminals.assertOwner(client, record);
    const host = getHost(record.hostId);
    const remotePath = await uploadPng({ binary: SSH_BINARY, args: sshArgs(host), target: host.target, local: host.kind === 'local', png });
    if (terminals.get(client, id).record !== record) throw new Error('Terminal changed during image upload');
    terminals.assertOwner(client, record);
    return remotePath;
  }
  function devUrls(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length > 300) throw new Error('Invalid session key');
    return tunnels.list(sessionKey);
  }
  function openDevUrl(client, id, url) {
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}\/tmux:hq-[a-f0-9]{12}$/.test(id)) {
      const session = cachedSession(id);
      const record = chats.sessions.get(`${session.hostId}/${session.chatSessionId}`);
      if (session.transport !== 'chat' || client.closed || !record || record.connection !== 'connected' || ![...record.handles].some((handleId) => chats.handles.get(handleId)?.client.id === client.id)) throw new Error('Open this connected chat before forwarding its development URL');
      return tunnels.open(getHost(session.hostId), session.key, url);
    }
    const { record } = terminals.get(client, id);
    const host = getHost(record.hostId);
    return tunnels.open(host, `${record.hostId}/tmux:${record.name}`, url);
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
  async function renameSession(key, title) {
    validateSessionPin(key, false);
    title = validateSessionTitle(title);
    if (deletionFlights.has(key) || renameFlights.has(key)) throw new Error('Session deletion or renaming is already in progress');
    renameFlights.add(key);
    try {
      await inventoryFlight;
      const hostId = key.slice(0, key.indexOf('/'));
      const unit = hostCache.get(hostId)?.find((item) => item.key === key);
      if (!unit || unit.kind !== 'managed' || !unit.managed || !TMUX_NAME.test(unit.id)) throw new Error('Managed session is unavailable. Refresh sessions before renaming it.');
      if (cleanup.isDeleting(key)) throw new Error('History deletion is in progress; wait for its result');
      if (store.data.deletedSessions.includes(key)) throw new Error('History has been deleted; refresh sessions');
      getHost(hostId);
      await runRemote({ action: 'rename', name: unit.id, title, ...(unit.transport === 'chat' ? { chatSessionId: unit.chatSessionId, sourceDigest: chatDigest, chatFiles, allowUpgrade: true } : {}) }, hostId);
      await inventoryFlight;
      const current = hostCache.get(hostId)?.find((item) => item.key === key);
      if (current) { current.title = title; store.cacheUnits(hostId, hostCache.get(hostId)); }
      if (store.data.attention.some((item) => item.sessionKey === key && item.title !== title)) store.save('attention', store.data.attention.map((item) => item.sessionKey === key ? { ...item, title } : item));
      await inventory();
      events.emit('state:updated');
      return title;
    } finally { renameFlights.delete(key); }
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
          const mirror = session.transport === 'chat' ? (await chatText(session, 100)).text : await terminals.preview(session.id, session.hostId);
          const text = mirror === null ? (await runRemote({ action: 'preview', name: session.id }, session.hostId)).text : mirror;
          return { key: session.key, text, sampledAt: Date.now(), error: false };
        } catch { return { key: session.key, text: 'Snapshot unavailable. Check this theater or refresh inventory.', sampledAt: null, error: true }; }
      })));
    }
    return results;
  }
  async function chatText(session, limit = 200) {
    const first = await chats.read(session.hostId, session.chatSessionId, 0, 1);
    const after = Math.max(first.retainedFrom - 1, first.latestCursor - limit);
    const page = await chats.read(session.hostId, session.chatSessionId, after, limit);
    const text = page.events.map((event) => event.type === 'message.completed' ? `${event.data.role}: ${event.data.text}` : event.type === 'tool.completed' ? `${event.data.name}: ${event.data.output}` : event.type === 'error' ? event.data.message : '').filter(Boolean).join('\n');
    return { text: text.slice(-100000), truncated: after > 0 || page.hasMore || text.length > 100000 };
  }
  async function searchHistory(query, keys) {
    if (typeof query !== 'string' || query.length < 3 || query.length > 200 || query.includes('\0') || !Array.isArray(keys) || keys.length > 200) throw new Error('History search needs 3–200 characters and up to 200 unit keys');
    const sessions = [...new Set(keys)].map(cachedSession).filter((session) => session.canAttach);
    const selected = sessions.slice(0, 8), matches = [], errors = [];
    let truncated = sessions.length > selected.length;
    for (let index = 0; index < selected.length; index += 2) {
      const results = await Promise.allSettled(selected.slice(index, index + 2).map((session) => session.transport === 'chat' ? chatText(session) : runRemote({ action: 'history', name: session.id }, session.hostId)));
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
  const github = (input) => runRemote({ ...input, action: 'github' }, getHost(input?.hostId).id);
  const specops = createSpecops({ directory: specopsDirectory || path.join(directory, 'specops'), runRemote, createSession: create, chats, getHost, emit: (...args) => events.emit(...args) });
  const centcom = createCentcom({
    directory: centcomDirectory || path.join(directory, 'centcom'),
    service: commanderFacade({
      chats, terminals, deleteSession, interruptFault, acknowledge, worktrees, archiveWorktree, diffRequest,
      github, devUrls, openDevUrl, previewOpOrder, enrollOpOrder,
      sitrepSource: (id) => sitrepPreviews.get(id),
      commanderHandoffs: () => [...sitrepPreviews.entries()].map(([id, value]) => ({ id, ...value })),
      inventory,
      health,
      create,
      action,
      renameSession,
      setSessionPinned,
      searchHistory,
      terminalPreviews,
      previewSitrep,
      launchSitrep,
      runRemote,
      getHost,
      flashQueue,
      flashDecide,
      interruptFaults,
      resetFault,
      specops,
      exercises,
      loopBreaker,
      store,
      saveSettings,
    }),
    chats,
    emit: (...args) => events.emit(...args),
  });
  routeCommanderCommands(chats, centcom);
  events.on('commander:chat-evidence', (record, chatEvents) => { void centcom.observeChat(record, chatEvents).catch((error) => console.error('CENTCOM chat observation failed:', error.message)); });
  events.on('inventory:updated', (snapshot) => { void centcom.observe(snapshot)?.catch((error) => console.error('CENTCOM observation failed:', error.message)); });
  return { centcom, specops, github, store, events, terminals, chats, tunnels, cleanup, exercises, inventory, health, create, worktrees, flashQueue, flashDecide, archiveWorktree, diffRequest, previewSitrep, launchSitrep, action, deleteSession, interruptFaults, resetFault, renameSession, loopBreaker, uploadClipboardImage, devUrls, openDevUrl, saveSettings, previewOpOrder, enrollOpOrder, saveWorkspace, setSessionPinned, acknowledge, terminalPreviews, searchHistory, hostId: (id) => getHost(id).id };
}
module.exports = { createService };
