const crypto = require('node:crypto');
const { Chats } = require('../../electron/chat.cjs');
const { contract } = require('../../electron/chat-protocol.cjs');
const { commanderFacade, routeCommanderCommands } = require('../../electron/commander.cjs');
const { createCentcom } = require('../../electron/centcom.cjs');

const desktop = { id: 'desktop', name: 'Desktop' };
const phone = { id: 'phone', name: 'Companion' };
const unit = (index, extra = {}) => {
  const name = 'hq-' + index.toString(16).padStart(12, '0');
  return { id: name, name, key: `alpha/tmux:${name}`, hostId: 'alpha', managed: true, kind: 'managed', state: 'live', title: `Unit ${index}`, provider: 'codex', transport: 'chat', chatState: 'idle', chatSessionId: 'chat-' + index.toString(16).padStart(32, '0'), ...extra };
};
const envelope = (content) => '```agentc2-c2\n' + JSON.stringify({ version: 1, rationale: 'Fixture assessment', ...content }) + '\n```';
const action = (operation, input, extra = {}) => ({ kind: 'agentc2.action', summary: operation, params: { operation, input }, ...extra });
const query = (operation, input = {}) => ({ kind: 'agentc2.query', params: { operation, input } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('Fixture condition timed out');
}

function fixture(directory, options = {}) {
  let engine, counter = 100, gate, receiptGate;
  const sessions = [unit(1), unit(2, { state: 'waiting_for_input', chatState: 'waiting' }),
    unit(3, { state: 'exited', chatState: 'stopped' }), unit(4), unit(5, { stale: true }),
    unit(6, { missing: true }), unit(7, { kind: 'conversation', managed: false }),
    unit(8, { kind: 'external-tmux', managed: false }), unit(9, { hostId: 'offline', key: `offline/tmux:${unit(9).name}` }),
    unit(10, { kind: 'conversation', key: 'alpha/codex:saved-history', state: 'exited' })];
  const hosts = [{ id: 'alpha', connected: true }, { id: 'offline', connected: false }];
  const state = { settings: { hosts: [{ id: 'alpha', enabled: true }], presets: [], opOrders: [] }, deletedSessions: [sessions[3].key], attention: [], exercises: [] };
  const journals = new Map(), receipts = new Map(), submitted = [], calls = [], syncs = [], responses = [];
  const faults = [], missions = [], exercises = state.exercises, flash = [];
  const caps = { provider: 'codex', version: 'fixture', status: 'supported', reason: null, ...Object.fromEntries(contract.capabilities.map((k) => [k, true])) };
  const chatSession = (id) => ({ id, provider: 'codex', providerSessionId: null, title: 'Fixture', state: 'idle', cwd: '/tmp', roeProfile: 'gated', capabilities: caps });
  function append(id, type, data, turnId) {
    const events = journals.get(id) || [];
    events.push({ protocolVersion: 1, sessionId: id, sequence: events.length + 1, timestamp: new Date().toISOString(), provider: 'codex', providerSessionId: null, turnId, itemId: null, type, data });
    journals.set(id, events);
  }
  async function remote(hostId, request) {
    if (request.action === 'history') {
      const events = journals.get(request.sessionId) || [], page = events.filter((e) => e.sequence > request.after).slice(0, request.limit);
      return { session: chatSession(request.sessionId), events: structuredClone(page), cursor: page.at(-1)?.sequence || request.after, latestCursor: events.length, retainedFrom: 1, hasMore: events.length > (page.at(-1)?.sequence || request.after), truncated: false, pendingRequests: [], pendingCommands: [] };
    }
    if (request.action === 'command') {
      const c = request.command;
      if (receipts.has(c.commandId)) return receipts.get(c.commandId);
      submitted.push(c);
      const receipt = { commandId: c.commandId, sessionId: c.sessionId, state: 'completed', result: { turnId: c.commandId }, error: null };
      receipts.set(c.commandId, receipt);
      if (engine?.isCommander(hostId, c.sessionId) && c.operation === 'send') {
        const response = responses.shift() || 'Assessment complete.';
        if (gate) await gate;
        append(c.sessionId, 'message.completed', { role: 'assistant', text: response }, c.commandId);
        append(c.sessionId, 'usage.updated', { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01, contextUsedTokens: null, contextCapacityTokens: null }, c.commandId);
        append(c.sessionId, 'turn.completed', { outcome: 'completed', detail: '' }, c.commandId);
      }
      return receipt;
    }
    if (request.action === 'receipt') {
      if (receiptGate) await receiptGate;
      return receipts.get(request.commandId);
    }
    if (request.action === 'capabilities') return contract.providers.map((provider) => ({ ...caps, provider }));
    throw new Error('Unexpected fixture remote request: ' + request.action);
  }
  const chats = new Chats({ remote, resolveHost: (id) => id || 'alpha', emit() {}, interval: 60000 });
  const terminals = { sessions: new Map(), handles: new Map() };
  const recordCall = (operation, result = {}) => (...args) => { calls.push({ operation, args }); return result; };
  const service = {
    store: { data: state },
    inventory: async () => ({ hosts, sessions, attention: state.attention, faults, missions, conflicts: [] }),
    getHost: (id) => ({ id }),
    runRemote: async (payload) => { syncs.push(payload); return { path: '/tmp/centcom-fixture' }; },
    create: async (input) => { const created = unit(++counter); sessions.push(created); calls.push({ operation: 'create', args: [input] }); return { ...created, name: created.id }; },
    flashQueue: async () => flash,
    loopBreaker: { faults: () => faults },
    specops: { list: () => missions, definition: () => ({ profiles: [], workflows: [] }), configure: recordCall('specops.configure'), launch: recordCall('specops.launch'), control: recordCall('specops.control') },
    exercises: { list: () => exercises, create: recordCall('exercise.create'), inspect: recordCall('exercise.inspect'), preview: recordCall('exercise.preview'), markComplete: recordCall('exercise.complete'), promote: recordCall('exercise.promote'), launch: recordCall('exercise.retry'), cancel: recordCall('exercise.cancel') },
    action: async (client, operation, name, hostId) => {
      const u = sessions.find((v) => v.id === name && v.hostId === hostId);
      const r = chats.assertSessionOwner(client, u.chatSessionId, hostId);
      const handle = [...r.handles].find((id) => chats.handles.get(id)?.client.id === client.id);
      calls.push({ operation: `unit.${operation}`, args: [name, hostId] });
      return chats.submit(client, handle, { protocolVersion: 1, commandId: crypto.randomUUID(), sessionId: u.chatSessionId, operation, payload: {} });
    },
    renameSession: recordCall('unit.rename'), setSessionPinned: recordCall('unit.pin'), acknowledge: recordCall('attention.acknowledge'),
    interruptFault: recordCall('fault.interrupt'), resetFault: recordCall('fault.reset'), flashDecide: recordCall('flash.decide'),
    terminalPreviews: async (keys) => keys.map((key) => ({ key, text: 'Visible transcript' })),
    searchHistory: async (search, keys) => { calls.push({ operation: 'unit.search', args: [search, keys] }); return { matches: keys.map((key) => ({ key, excerpt: 'Found fixture' })), total: keys.length }; },
    saveSettings: recordCall('configuration.save'), worktrees: recordCall('worktree.list'), archiveWorktree: recordCall('worktree.archive'), diffRequest: recordCall('diff'),
    previewSitrep: recordCall('sitrep.preview'), launchSitrep: recordCall('sitrep.handoff'), sitrepSource: () => ({ name: sessions[0].id, sourceHostId: 'alpha' }),
    github: recordCall('github'), devUrls: recordCall('devurl.list'), openDevUrl: recordCall('devurl.open'),
    previewOpOrder: recordCall('oporder.preview'), enrollOpOrder: recordCall('oporder.enroll'),
    deleteSession: recordCall('unit.delete'),
  };
  const facade = commanderFacade({ chats, terminals, ...service });
  const start = () => {
    engine = createCentcom({ directory, service: facade, chats, emit() {}, ...options });
    routeCommanderCommands(chats, engine);
    return engine;
  };
  start();
  return { get engine() { return engine; }, start, sessions, hosts, state, journals, receipts, submitted, calls, syncs, responses, chats, faults, missions, exercises, flash, service: facade,
    gate: () => { let resolve; gate = new Promise((r) => { resolve = r; }); return () => { gate = null; resolve(); }; },
    gateReceipt: () => { let resolve; receiptGate = new Promise((r) => { resolve = r; }); return () => { receiptGate = null; resolve(); }; },
    snapshot: () => JSON.parse(syncs.at(-1).files['SITUATION.json']),
    async propose(directives) { responses.push(envelope({ directives })); await engine.submit('Propose fixture actions'); return engine.state().directives.slice(0, directives.length); },
    dispose() { engine.dispose(); chats.closeAll(); },
  };
}
module.exports = { fixture, unit, envelope, action, query, desktop, phone, tick, until };
