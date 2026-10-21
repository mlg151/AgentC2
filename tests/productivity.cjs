// Pure state tests cover attention transitions, restart deduplication, and config validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, defaults, validateSettings, validateWorkspace, validateSessionPin } = require('../electron/config.cjs');
const { Attention, classify } = require('../electron/attention.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-state-test-'));
try {
  const store = new Store(directory);
  const config = defaults();
  config.hosts.push({ id: 'secondary', name: 'Build server', target: 'deploy@build-server', port: 2222, enabled: true });
  config.presets.push({ ...config.presets[1], id: 'openrouter', name: 'Claude OpenRouter', command: 'claude3', hostId: 'secondary' });
  store.save('settings', validateSettings(config));
  assert.equal(new Store(directory).data.settings.presets.at(-1).command, 'claude3');
  for (const target of ['-oProxyCommand=bad', 'host with spaces', 'host;echo', 'host\nother']) {
    assert.throws(() => validateSettings({ ...config, hosts: [{ ...config.hosts[0], target }] }));
  }
  assert.throws(() => validateSettings({ ...config, hosts: [config.hosts[0], config.hosts[0]] }));
  assert.throws(() => validateSettings({ ...config, hosts: [{ ...config.hosts[0], enabled: false }] }));
  const workspace = validateWorkspace({ tabs: ['default/tmux:hq-123', 'secondary/tmux:hq-123'], selectedKey: 'default/tmux:hq-123', splitKey: 'secondary/tmux:hq-123', metadata: { 'default/tmux:hq-123': { pinned: true, project: 'Release', notes: 'Check release notes.' } } });
  store.save('workspace', workspace);
  assert.deepEqual(new Store(directory).data.workspace, workspace);
  // Pins have an authoritative field-level mutation, independent of stale
  // desktop layout/notes snapshots and of the same session on another host.
  const firstKey = 'default/tmux:hq-123', secondKey = 'secondary/tmux:hq-123';
  for (const key of [firstKey, 'default/process:1234', 'default/codex:abc-123', 'secondary/claude:abc-123', 'default/antigravity:abc-123']) assert.ok(validateSessionPin(key, true));
  for (const key of ['', 'default', '../codex:abc', 'default/tmux:../foo', 'default/unknown:abc', 'default/codex:abc\n', '__proto__']) assert.throws(() => store.setSessionPinned(key, true), /Invalid session pin/);
  for (const value of [undefined, null, 'true', 1, {}]) assert.throws(() => store.setSessionPinned(firstKey, value), /Invalid session pin/);
  const stale = structuredClone(workspace);
  store.setSessionPinned(firstKey, false);
  stale.metadata[firstKey].notes = 'Edited while the phone unpinned.';
  store.saveWorkspace(stale);
  assert.equal(store.data.workspace.metadata[firstKey].pinned, false);
  assert.equal(store.data.workspace.metadata[firstKey].notes, stale.metadata[firstKey].notes);
  store.setSessionPinned(secondKey, true);
  store.saveWorkspace({ ...stale, tabs: [secondKey], selectedKey: secondKey, splitKey: null });
  assert.equal(store.data.workspace.metadata[secondKey].pinned, true);
  assert.equal(store.data.workspace.metadata[firstKey].pinned, false);
  assert.deepEqual(store.data.workspace.tabs, [secondKey]);
  store.setSessionPinned(firstKey, true);
  store.setSessionPinned(firstKey, true);
  store.setSessionPinned(firstKey, false);
  assert.equal(new Store(directory).data.workspace.metadata[firstKey].pinned, false);
  assert.equal(new Store(directory).data.workspace.metadata[secondKey].pinned, true);
  assert.equal(store.data.workspace.metadata[firstKey].project, 'Release');
  console.log('PASS validated idempotent pins, stale workspace merging, notes/layout preservation, host isolation, and pin restart persistence');
  const session = { key: 'default/tmux:test', hostId: 'default', title: 'Fixture', provider: 'codex', state: 'live', outputTail: 'Working…' };
  const attention = new Attention(store);
  assert.equal(classify(session), null);
  assert.equal(attention.update([session]).length, 0);
  const prompt = { ...session, outputTail: 'Do you want to proceed? [y/n]' };
  assert.equal(attention.update([prompt])[0].confidence, 'inferred');
  assert.equal(attention.update([prompt]).length, 0);
  attention.acknowledge('all');
  assert.equal(new Attention(new Store(directory)).update([prompt]).length, 0);
  attention.update([session]);
  assert.equal(attention.update([prompt]).length, 1);
  assert.equal(attention.update([{ ...session, exitCode: 0 }])[0].kind, 'completed');
  assert.equal(attention.update([{ ...session, exitCode: 3 }])[0].kind, 'failed');
  assert.equal(classify({ ...session, state: 'blocked' }).confidence, 'confirmed');
  assert.equal(classify({ ...session, outputTail: 'Nothing new for 30 minutes.' }), null);
  const otherHost = { ...prompt, key: 'secondary/tmux:test', hostId: 'secondary' };
  assert.equal(attention.update([otherHost]).length, 1);
  const eventSession = { ...session, events: [{ id: 'event-1', kind: 'completed', at: new Date().toISOString() }] };
  assert.equal(attention.update([eventSession])[0].confidence, 'confirmed');
  attention.acknowledge('all');
  assert.equal(new Attention(new Store(directory)).update([eventSession]).length, 0);
  assert.equal(attention.update([{ ...eventSession, events: [...eventSession.events, { id: 'event-2', kind: 'input' }, { id: 'event-3', kind: 'completed' }] }]).length, 2);
  console.log('PASS settings, host validation, workspace persistence, attention confidence, transitions, acknowledgement, restart deduplication, and host isolation');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
