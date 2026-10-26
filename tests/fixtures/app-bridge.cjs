// Serialized into a browser: only the public preload boundary is simulated.
function installAppBridge({ settings, commander }) {
  const clone = (value) => structuredClone(value);
  const unit = (index, title) => ({ key: `alpha/tmux:hq-${String(index).padStart(12, '0')}`, id: `hq-${String(index).padStart(12, '0')}`, title, hostId: 'alpha', hostName: 'Alpha theater', provider: 'codex', kind: 'managed', managed: true, transport: 'terminal', canAttach: false, canStop: true, state: 'live', cwd: '/fixture/project', branch: 'fixture-branch', updatedAt: '2026-01-02T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z' });
  const units = [unit(1, 'Alpha unit'), unit(2, 'Bravo unit'), unit(3, 'Charlie unit')];
  units[0].worktreeOperation = 'a'.repeat(32); units[0].headCommit = 'b'.repeat(40); units[0].repository = '/fixture/project';
  let nextUnit = 4;
  const first = units[0].key;
  const listeners = new Map(), pending = new Map();
  const scenario = new URLSearchParams(location.search).get('scenario');
  const qa = window.qa = { settings, units, attention: [], faults: [], flash: [], calls: [], fail: {}, hold: {}, workspace: { tabs: [first], selectedKey: first, splitKey: null, metadata: {} }, missions: [], commander: { config: commander, session: null, status: 'idle', error: '', costUsd: 0, costKnown: true, autoTurnsLastHour: 0, directives: [], automations: [], auditLog: [] }, undocked: false };
  qa.emit = (name, ...args) => { for (const listener of listeners.get(name) || []) listener(...clone(args)); };
  qa.release = (name, fail = false) => { for (const item of pending.get(name) || []) { if (fail) item.reject(Error('Late fixture failure')); else item.resolve(item.value); } pending.delete(name); qa.hold[name] = false; };
  qa.inventory = () => ({ hosts: qa.hosts || [{ id: 'alpha', name: 'Alpha theater', connected: true }, { id: 'beta', name: 'Beta theater', connected: true }], sessions: clone(qa.units), attention: clone(qa.attention), faults: clone(qa.faults), missions: clone(qa.missions) });
  if (scenario === 'initial-events' || scenario === 'failed-initial') { qa.hold.getState = true; qa.workspace.tabs.push(units[1].key); }
  if (scenario === 'late-window') qa.hold.overwatchWindowState = true;
  if (scenario === 'failed-window') { qa.fail.overwatchWindowState = 'Window fixture unavailable'; qa.fail.centcomState = 'Commander fixture unavailable'; }
  if (scenario === 'empty') { qa.units = []; qa.workspace.tabs = []; qa.workspace.selectedKey = null; }
  if (scenario === 'single') qa.units = units.slice(0, 1);
  if (scenario === 'capacity') qa.units = Array.from({ length: 120 }, (_, index) => unit(index + 1, 'Fleet unit ' + (index + 1)));
  if (scenario === 'poll-held') {
    qa.hold.listFlashTraffic = true;
    qa.flash = [{ id: '1'.repeat(32), name: units[0].id, hostId: 'alpha', hostName: 'Alpha theater', provider: 'claude', tool: 'Bash', action: 'echo reviewed-poll-fixture', state: 'pending', connected: true, createdAt: 1, expiresAt: 9999999999 }];
  }
  const methods = {
    getState: () => ({ settings: clone(qa.settings), workspace: clone(qa.workspace), attention: clone(qa.attention) }),
    inventory: () => {
      if (qa.created && --qa.visibilityDelay <= 0) { qa.units.push(qa.created); qa.created = null; }
      return qa.inventory();
    },
    saveWorkspace: (value) => { qa.workspace = clone(value); return clone(value); },
    saveSettings: (value) => { qa.settings = clone(value); return clone(value); },
    setSessionPinned: (key, pinned) => qa.emit('onSessionPinned', key, pinned),
    listFlashTraffic: () => clone(qa.flash),
    decideFlashTraffic: (input) => { const request = qa.flash.find((item) => item.id === input.id); request.state = 'submitted'; request.decision = input.decision; },
    acknowledge: (id) => { qa.attention = qa.attention.map((item) => id === 'all' || item.id === id ? { ...item, acknowledged: true } : item); return clone(qa.attention); },
    interruptFaults: () => qa.faults.map((item, index) => ({ sessionKey: item.sessionKey, status: index ? 'unknown' : 'interrupted', result: index ? '' : 'confirmed fixture stop' })),
    resetFault: (key) => { qa.faults = qa.faults.filter((item) => item.sessionKey !== key); },
    writeClipboard: (text) => { qa.clipboard = text; }, health: () => [], devUrls: () => [],
    centcomState: () => clone(qa.commander),
    overwatchWindowState: () => ({ undocked: qa.undocked }),
    undockOverwatch: () => { qa.undocked = true; qa.emit('onOverwatchWindowState', { undocked: true }); return { undocked: true }; },
    terminalPreviews: (keys) => keys.map((key) => ({ key, text: 'Fixture terminal snapshot', sampledAt: Date.now(), error: false })),
    specopsDefinition: () => ({ profiles: [], workflows: [], yaml: '', directory: '/fixture/specops' }), listSpecops: () => [],
    listExercises: () => [], exerciseCapabilities: () => ({ codex: true, claude: true, antigravity: true, opencode: true }),
    cleanupState: () => ({ results: [], lastRuns: {} }),
    updateState: () => ({ status: 'current', version: '0.4.11', target: null, percent: null, error: '', source: false, mainAhead: false }),
    diffFiles: () => [], listWorktrees: () => [],
    previewSitrep: () => ({ id: 'c'.repeat(32), ready: true, source: { baseCommit: 'b'.repeat(40) }, target: { ready: true }, warnings: [], untracked: [], patchBytes: 0, patchPreview: '', patchPreviewTruncated: false, test: null }),
    launchSitrep: () => { qa.created = unit(nextUnit++, 'SitRep recipient'); qa.visibilityDelay = qa.sitrepVisibilityDelay || 2; return { name: qa.created.id, hostId: qa.created.hostId }; },
    searchHistory: () => ({ matches: [], searched: 0, total: qa.units.length, truncated: false, errors: [] }),
    create: (input) => {
      qa.created = { ...unit(nextUnit++, input.title || 'Created fixture'), hostId: input.hostId, hostName: qa.settings.hosts.find((host) => host.id === input.hostId)?.name || input.hostId };
      qa.created.key = input.hostId + '/tmux:' + qa.created.id;
      qa.visibilityDelay = qa.visibilityDelay || 2;
      if (qa.failInventoryAfterCreate) qa.fail.inventory = 'Inventory is unavailable after acknowledgement';
      return { name: qa.created.id };
    },
  };
  if (scenario === 'browser-only') return;
  window.agentHQ = new Proxy({ platform: 'linux' }, { get(target, name) {
    if (name in target) return target[name];
    if (typeof name === 'string' && name.startsWith('on')) return (listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener); return () => listeners.get(name).delete(listener);
    };
    if (!Object.hasOwn(methods, name)) return undefined;
    return async (...args) => {
      qa.calls.push([name, ...clone(args)]);
      if (qa.fail[name]) throw Error(qa.fail[name]);
      const value = methods[name](...args);
      if (!qa.hold[name]) return value;
      return new Promise((resolve, reject) => { if (!pending.has(name)) pending.set(name, []); pending.get(name).push({ value, resolve, reject }); });
    };
  } });
}
module.exports = { installAppBridge };
