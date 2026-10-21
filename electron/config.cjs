const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = ['codex', 'claude', 'antigravity'];
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
function text(value, max = 4096) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid configuration text');
  return value;
}
function defaults() {
  const presets = PROVIDERS.map((provider) => ({ id: provider, name: provider === 'antigravity' ? 'Antigravity' : provider === 'claude' ? 'Claude' : 'Codex', provider, command: provider === 'antigravity' ? 'agy' : provider, args: '', cwd: '', instructions: '', fullPermissions: true, attentionHooks: provider !== 'antigravity', hostId: '' }));
  presets.push({ ...presets[1], id: 'claude-openrouter', name: 'Claude (OpenRouter)', command: 'claude3' });
  return {
    hosts: [{ id: 'default', name: 'Primary server', target: process.env.AGENTC2_HOST || process.env.AGENT_HQ_HOST || 'your-ssh-host', port: 22, enabled: true }],
    presets,
    notifications: false,
  };
}
function validateSettings(input) {
  if (!input || !Array.isArray(input.hosts) || !input.hosts.length || input.hosts.length > 30 || !Array.isArray(input.presets) || input.presets.length > 100) throw new Error('Configure between 1 and 30 hosts and at most 100 presets');
  const ids = new Set();
  const hosts = input.hosts.map((h) => {
    if (!ID.test(h.id) || ids.has(h.id)) throw new Error('Host IDs must be unique');
    ids.add(h.id);
    const target = text(h.target, 255).trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]*$/.test(target)) throw new Error('Use an SSH config alias or user@hostname for the host target');
    const port = Number(h.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535');
    return { id: h.id, name: text(h.name, 100).trim() || target, target, port, enabled: Boolean(h.enabled), autoForward: Boolean(h.autoForward) };
  });
  if (!hosts.some((h) => h.enabled)) throw new Error('Enable at least one host');
  ids.clear();
  const presets = input.presets.map((p) => {
    if (!ID.test(p.id) || ids.has(p.id) || !PROVIDERS.includes(p.provider)) throw new Error('Invalid launch preset');
    ids.add(p.id);
    const command = text(p.command).trim();
    if (!command || /[\r\n]/.test(command)) throw new Error('Preset command must be a single line');
    if (p.hostId && !hosts.some((h) => h.id === p.hostId)) throw new Error('Preset host does not exist');
    return { id: p.id, name: text(p.name, 100).trim() || command, provider: p.provider, command, args: text(p.args), cwd: text(p.cwd), instructions: text(p.instructions, 20000), fullPermissions: Boolean(p.fullPermissions), attentionHooks: Boolean(p.attentionHooks), hostId: p.hostId || '' };
  });
  const cleanup = input.cleanup || [];
  if (!Array.isArray(cleanup) || cleanup.length > 90) throw new Error('Invalid cleanup policies');
  const scopes = new Set();
  const policies = cleanup.map((policy) => {
    const key = `${policy.hostId}/${policy.provider}`;
    if (!hosts.some((host) => host.id === policy.hostId) || !PROVIDERS.includes(policy.provider) || scopes.has(key) || typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.days) || policy.days < 1 || policy.days > 36500) throw new Error('Cleanup policies need a unique host/provider and an age between 1 and 36500 days');
    scopes.add(key);
    return { hostId: policy.hostId, provider: policy.provider, enabled: policy.enabled, days: policy.days };
  });
  return { hosts, presets, notifications: Boolean(input.notifications), cleanup: policies };
}
function validateWorkspace(w) {
  if (!w || !Array.isArray(w.tabs) || w.tabs.length > 40 || !w.metadata || typeof w.metadata !== 'object') throw new Error('Invalid workspace');
  const tabs = [...new Set(w.tabs.map((k) => text(k, 300)))];
  const metadata = Object.fromEntries(Object.entries(w.metadata).slice(0, 10000).map(([k, m]) => [text(k, 300), {
    pinned: Boolean(m.pinned), project: text(m.project || '', 100), notes: text(m.notes || '', 20000),
  }]));
  const source = w.situation || {};
  if (typeof source !== 'object' || (source.version !== undefined && source.version !== 1)) throw new Error('Unsupported Situation Room workspace');
  const slot = (key) => key && tabs.includes(text(key, 300)) ? key : null;
  const anchorKey = slot(source.anchorKey === undefined ? w.selectedKey : source.anchorKey);
  const target = slot(source.targetKey === undefined ? w.splitKey : source.targetKey);
  const targetKey = target === anchorKey ? null : target;
  const used = new Set();
  const callsigns = Object.fromEntries(Object.entries(source.callsigns || {}).map(([key, value]) => {
    validateSessionPin(key, false);
    if (typeof value !== 'string' || !/^(0[1-9]|[1-9][0-9])$/.test(value) || used.has(value)) throw new Error('Callsigns must be unique from 01 to 99');
    used.add(value);
    return [text(key, 300), value];
  }));
  if (used.size > 99) throw new Error('At most 99 callsigns can be assigned');
  const shortcuts = Object.fromEntries(Object.entries(source.shortcuts || {}).map(([key, value]) => [text(key, 60), text(value, 80)]));
  if (Object.keys(shortcuts).length > 50) throw new Error('Too many keyboard overrides');
  const focusedPane = source.focusedPane === 'target' && targetKey || !anchorKey && targetKey ? 'target' : 'anchor';
  const selectedKey = focusedPane === 'anchor' ? anchorKey : targetKey;
  const splitKey = focusedPane === 'anchor' ? targetKey : anchorKey;
  const collapsedGroups = Array.isArray(source.collapsedGroups) ? [...new Set(source.collapsedGroups.slice(0, 300).map((value) => text(value, 4096)))] : [];
  const situation = { version: 1, anchorKey, targetKey, focusedPane, callsigns, groupBy: source.groupBy === 'repository' ? 'repository' : 'host', collapsedGroups, urgentFirst: Boolean(source.urgentFirst), rosterCollapsed: Boolean(source.rosterCollapsed), zen: Boolean(source.zen), ligatures: Boolean(source.ligatures), shortcuts };
  return { tabs, selectedKey, splitKey, metadata, situation };
}
function validateSessionPin(key, pinned) {
  if (typeof key !== 'string' || key.length > 300 || !/^[a-zA-Z0-9_-]{1,80}\/(?:tmux|process|codex|claude|antigravity):[a-zA-Z0-9_.:-]{1,200}$/.test(key) || typeof pinned !== 'boolean') throw new Error('Invalid session pin');
  return key.slice(0, key.indexOf('/'));
}
function validateCleanupState(value) {
  if (!value || !value.lastRuns || typeof value.lastRuns !== 'object' || !Array.isArray(value.results)) throw new Error('Invalid saved cleanup state');
  const lastRuns = Object.fromEntries(Object.entries(value.lastRuns).slice(-300).map(([key, at]) => {
    if (!/^[a-zA-Z0-9_-]{1,80}\/(codex|claude|antigravity)$/.test(key) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new Error('Invalid cleanup run timestamp');
    return [key, at];
  }));
  const results = value.results.slice(0, 100).map((item) => {
    if (!item || !ID.test(item.hostId) || !PROVIDERS.includes(item.provider) || !['deleted', 'missing', 'excluded', 'changed', 'unknown', 'failed', 'skipped'].includes(item.status) || typeof item.automatic !== 'boolean' || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) throw new Error('Invalid saved cleanup result');
    if (item.key !== undefined) validateSessionPin(item.key, false);
    if (item.operationId !== undefined && (typeof item.operationId !== 'string' || !ID.test(item.operationId))) throw new Error('Invalid cleanup operation ID');
    if (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || item.bytes < 0)) throw new Error('Invalid cleanup byte count');
    return { hostId: item.hostId, provider: item.provider, at: item.at, automatic: item.automatic, status: item.status, detail: text(item.detail, 500), ...(item.operationId === undefined ? {} : { operationId: item.operationId }), ...(item.key === undefined ? {} : { key: item.key }), ...(item.bytes === undefined ? {} : { bytes: item.bytes }), ...(item.estimated === undefined ? {} : { estimated: Boolean(item.estimated) }) };
  });
  return { lastRuns, results };
}
function validateCachedUnits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 30) throw new Error('Invalid cached unit inventory');
  const cached = {};
  for (const [hostId, units] of Object.entries(value)) {
    if (!ID.test(hostId) || !Array.isArray(units) || units.length > 200) throw new Error('Invalid cached theater inventory');
    const keys = new Set();
    cached[hostId] = units.map((unit) => {
      if (!unit || typeof unit !== 'object' || validateSessionPin(unit.key, false) !== hostId || keys.has(unit.key) || ![...PROVIDERS, 'terminal'].includes(unit.provider) || !['managed', 'external-tmux', 'unmanaged', 'conversation', 'background'].includes(unit.kind)) throw new Error('Invalid cached unit');
      keys.add(unit.key);
      const id = text(unit.id, 200);
      if (!unit.key.endsWith(`:${id}`)) throw new Error('Cached unit identity changed');
      const updatedAt = unit.updatedAt && Number.isFinite(Date.parse(unit.updatedAt)) ? text(unit.updatedAt, 80) : null;
      return { key: unit.key, id, provider: unit.provider, kind: unit.kind, title: text(unit.title || '', 150), cwd: text(unit.cwd || '', 500), updatedAt, state: text(unit.state || '', 40), managed: Boolean(unit.managed), canAttach: Boolean(unit.canAttach), canResume: Boolean(unit.canResume), canInterrupt: Boolean(unit.canInterrupt), canStop: Boolean(unit.canStop), exitCode: Number.isInteger(unit.exitCode) ? unit.exitCode : null, presetName: text(unit.presetName || '', 100), branch: text(unit.branch || '', 200), repository: text(unit.repository || '', 500), worktreeOperation: text(unit.worktreeOperation || '', 32) };
    });
  }
  return cached;
}
class Store {
  constructor(directory) {
    this.file = path.join(directory, 'workspace.json');
    fs.mkdirSync(directory, { recursive: true });
    this.data = { settings: defaults(), workspace: validateWorkspace({ tabs: [], selectedKey: null, splitKey: null, metadata: {} }), attention: [], attentionCursors: {}, deletedSessions: [], cleanupState: { lastRuns: {}, results: [] }, cachedUnits: {} };
    if (fs.existsSync(this.file)) {
      // Do not silently overwrite an unreadable user's configuration.
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, settings: validateSettings(saved.settings), workspace: validateWorkspace(saved.workspace), attention: Array.isArray(saved.attention) ? saved.attention.slice(-500) : [], attentionCursors: saved.attentionCursors || {}, deletedSessions: Array.isArray(saved.deletedSessions) ? saved.deletedSessions.slice(-10000).map((key) => text(key, 300)) : [], cleanupState: validateCleanupState(saved.cleanupState || this.data.cleanupState), cachedUnits: validateCachedUnits(saved.cachedUnits || {}) };
    }
  }
  save(key, value) {
    this.update({ [key]: value });
    return value;
  }
  update(patch) {
    const next = { ...this.data, ...patch };
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = next;
  }
  saveWorkspace(input) {
    const workspace = validateWorkspace(input);
    const deleted = new Set(this.data.deletedSessions);
    for (const key of deleted) delete workspace.metadata[key];
    workspace.tabs = workspace.tabs.filter((key) => !deleted.has(key));
    if (deleted.has(workspace.selectedKey)) workspace.selectedKey = workspace.tabs.at(-1) || null;
    if (deleted.has(workspace.splitKey)) workspace.splitKey = null;
    if (workspace.situation) {
      if (deleted.has(workspace.situation.anchorKey)) workspace.situation.anchorKey = null;
      if (deleted.has(workspace.situation.targetKey)) workspace.situation.targetKey = null;
      for (const key of deleted) delete workspace.situation.callsigns[key];
    }
    // Pin mutations have their own API. An older desktop snapshot must not undo
    // a companion change, even when that snapshot predates the metadata entry.
    for (const [key, metadata] of Object.entries(workspace.metadata)) {
      metadata.pinned = this.data.workspace.metadata[key]?.pinned || false;
    }
    for (const [key, metadata] of Object.entries(this.data.workspace.metadata)) {
      if (!Object.hasOwn(workspace.metadata, key)) workspace.metadata[key] = metadata;
    }
    if (Object.keys(workspace.metadata).length > 10000) throw new Error('Session metadata limit reached');
    return this.save('workspace', validateWorkspace(workspace));
  }
  setSessionPinned(key, pinned) {
    validateSessionPin(key, pinned);
    const workspace = this.data.workspace;
    if (!Object.hasOwn(workspace.metadata, key) && Object.keys(workspace.metadata).length >= 10000) throw new Error('Session metadata limit reached');
    const metadata = { ...workspace.metadata, [key]: { project: '', notes: '', ...workspace.metadata[key], pinned } };
    this.save('workspace', { ...workspace, metadata });
    return pinned;
  }
  cacheUnits(hostId, sessions) {
    if (!ID.test(hostId) || !Array.isArray(sessions)) throw new Error('Invalid host inventory');
    // Persist only a bounded summary. Terminal output, event details, and
    // transcripts must never enter workspace.json through inventory caching.
    const summary = sessions.filter((unit) => !this.data.deletedSessions.includes(unit.key)).slice(0, 200).map((unit) => ({
      key: unit.key, id: unit.id, provider: unit.provider, kind: unit.kind,
      title: String(unit.title || '').slice(0, 150), cwd: String(unit.cwd || '').slice(0, 500),
      updatedAt: unit.updatedAt, state: String(unit.state || '').slice(0, 40),
      managed: unit.managed, canAttach: unit.canAttach, canResume: unit.canResume,
      canInterrupt: unit.canInterrupt, canStop: unit.canStop, exitCode: unit.exitCode,
      presetName: String(unit.presetName || '').slice(0, 100),
      branch: String(unit.branch || '').slice(0, 200), repository: String(unit.repository || '').slice(0, 500), worktreeOperation: String(unit.worktreeOperation || '').slice(0, 32),
    }));
    const next = validateCachedUnits({ ...this.data.cachedUnits, [hostId]: summary });
    if (JSON.stringify(next[hostId]) !== JSON.stringify(this.data.cachedUnits[hostId])) this.save('cachedUnits', next);
  }
  forgetSessions(keys) {
    const deleted = new Set([...this.data.deletedSessions, ...keys]);
    const workspace = structuredClone(this.data.workspace);
    for (const key of keys) delete workspace.metadata[key];
    workspace.tabs = workspace.tabs.filter((key) => !deleted.has(key));
    if (deleted.has(workspace.selectedKey)) workspace.selectedKey = workspace.tabs.at(-1) || null;
    if (deleted.has(workspace.splitKey)) workspace.splitKey = null;
    if (workspace.situation) {
      if (deleted.has(workspace.situation.anchorKey)) workspace.situation.anchorKey = null;
      if (deleted.has(workspace.situation.targetKey)) workspace.situation.targetKey = null;
      for (const key of deleted) delete workspace.situation.callsigns[key];
    }
    const attentionCursors = { ...this.data.attentionCursors };
    for (const key of keys) delete attentionCursors[key];
    // One atomic store replacement prevents stale renderer saves resurrecting history.
    const cachedUnits = Object.fromEntries(Object.entries(this.data.cachedUnits).map(([hostId, units]) => [hostId, units.filter((unit) => !deleted.has(unit.key))]));
    this.update({ deletedSessions: [...deleted].slice(-10000), workspace: validateWorkspace(workspace), attention: this.data.attention.filter((item) => !deleted.has(item.sessionKey)), attentionCursors, cachedUnits });
  }
}
module.exports = { Store, defaults, validateSettings, validateWorkspace, validateSessionPin };
