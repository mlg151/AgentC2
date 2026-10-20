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
    return { id: h.id, name: text(h.name, 100).trim() || target, target, port, enabled: Boolean(h.enabled) };
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
  return { hosts, presets, notifications: Boolean(input.notifications) };
}
function validateWorkspace(w) {
  if (!w || !Array.isArray(w.tabs) || w.tabs.length > 40 || !w.metadata || typeof w.metadata !== 'object') throw new Error('Invalid workspace');
  const tabs = [...new Set(w.tabs.map((k) => text(k, 300)))];
  const metadata = Object.fromEntries(Object.entries(w.metadata).slice(0, 10000).map(([k, m]) => [text(k, 300), {
    pinned: Boolean(m.pinned), project: text(m.project || '', 100), notes: text(m.notes || '', 20000),
  }]));
  return { tabs, selectedKey: w.selectedKey ? text(w.selectedKey, 300) : null, splitKey: w.splitKey ? text(w.splitKey, 300) : null, metadata };
}
class Store {
  constructor(directory) {
    this.file = path.join(directory, 'workspace.json');
    fs.mkdirSync(directory, { recursive: true });
    this.data = { settings: defaults(), workspace: { tabs: [], selectedKey: null, splitKey: null, metadata: {} }, attention: [], attentionCursors: {} };
    if (fs.existsSync(this.file)) {
      // Do not silently overwrite an unreadable user's configuration.
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { settings: validateSettings(saved.settings), workspace: validateWorkspace(saved.workspace), attention: Array.isArray(saved.attention) ? saved.attention.slice(-500) : [], attentionCursors: saved.attentionCursors || {} };
    }
  }
  save(key, value) {
    const next = { ...this.data, [key]: value };
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = next;
    return value;
  }
}
module.exports = { Store, defaults, validateSettings, validateWorkspace };
