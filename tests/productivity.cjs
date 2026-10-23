// Pure state tests cover attention transitions, restart deduplication, and config validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, defaults, validateSettings, resolveRoeProfile, validateRoeLaunch, validateWorkspace, validateSessionPin } = require('../electron/config.cjs');
const { Attention, classify } = require('../electron/attention.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-state-test-'));
try {
  function legacyStore(name, presets) {
    const location = path.join(directory, name);
    fs.mkdirSync(location);
    fs.writeFileSync(path.join(location, 'workspace.json'), JSON.stringify({
      settings: { ...defaults(), presets },
      workspace: { tabs: [], selectedKey: null, splitKey: null, metadata: {} },
    }));
    return location;
  }
  const legacyPresets = defaults().presets.filter((preset) => preset.provider !== 'opencode');
  const customPresets = legacyPresets.map((preset) => ({ ...preset, cwd: '/srv/project', instructions: 'Keep my guidance' }));
  const upgradePath = legacyStore('upgrade', customPresets);
  const upgraded = new Store(upgradePath);
  assert.deepEqual(upgraded.data.settings.presets.slice(0, customPresets.length), validateSettings({ ...defaults(), presets: customPresets }).presets, 'Upgrade preserves customized presets');
  assert.equal(upgraded.data.settings.presets.at(-1).provider, 'opencode', 'Existing installs receive the OpenCode launch preset');
  assert.equal(upgraded.data.settings.presets.at(-1).command, 'opencode');
  assert.equal(new Store(upgradePath).data.settings.presets.filter((preset) => preset.provider === 'opencode').length, 1, 'Restart must not duplicate the migrated preset');
  upgraded.save('settings', validateSettings({ ...upgraded.data.settings, presets: customPresets }));
  assert.equal(new Store(upgradePath).data.settings.presets.some((preset) => preset.provider === 'opencode'), false, 'Intentional removal must survive restart');

  const customOpenCode = { ...defaults().presets.find((preset) => preset.provider === 'opencode'), id: 'my-opencode', command: '/opt/bin/opencode', args: '--custom' };
  const existingPath = legacyStore('existing-opencode', [...legacyPresets, customOpenCode]);
  assert.deepEqual(new Store(existingPath).data.settings.presets, validateSettings({ ...defaults(), presets: [...legacyPresets, customOpenCode] }).presets, 'Existing OpenCode presets remain unchanged without adding another');

  const collisionPath = legacyStore('id-collision', [...legacyPresets, { ...legacyPresets[0], id: 'opencode' }, { ...legacyPresets[0], id: 'opencode-2' }]);
  assert.equal(new Store(collisionPath).data.settings.presets.at(-1).id, 'opencode-3', 'Migration must not overwrite another provider using the default ID');

  const fullPresets = Array.from({ length: 100 }, (_, index) => ({ ...legacyPresets[0], id: `custom-${index}` }));
  const fullPath = legacyStore('preset-limit', fullPresets);
  const fullStore = new Store(fullPath);
  assert.equal(fullStore.data.settings.presets.length, 100, 'Migration must respect the preset limit');
  fullStore.save('settings', validateSettings({ ...fullStore.data.settings, presets: fullPresets.slice(1) }));
  assert.equal(new Store(fullPath).data.settings.presets.at(-1).provider, 'opencode', 'Deferred migration runs when room becomes available');

  const freshPath = path.join(directory, 'fresh-install');
  const freshStore = new Store(freshPath);
  freshStore.save('settings', validateSettings({ ...freshStore.data.settings, presets: legacyPresets }));
  assert.equal(new Store(freshPath).data.settings.presets.some((preset) => preset.provider === 'opencode'), false, 'Fresh installs also respect intentional removal');

  const store = new Store(directory);
  const config = defaults();
  config.hosts[0].autoForward = true;
  config.hosts.push({ id: 'secondary', name: 'Build server', target: 'deploy@build-server', port: 2222, enabled: true });
  config.presets.push({ ...config.presets[1], id: 'openrouter', name: 'Claude OpenRouter', command: 'claude3', hostId: 'secondary' });
  store.save('settings', validateSettings(config));
  assert.equal(new Store(directory).data.settings.presets.at(-1).command, 'claude3');
  assert.equal(new Store(directory).data.settings.hosts[0].autoForward, true);
  assert.equal(new Store(directory).data.settings.hosts[1].autoForward, false);
  const migrated = validateSettings({ ...config, roe: undefined, presets: config.presets.map(({ roeProfile: _removed, ...preset }) => preset) });
  assert.deepEqual(migrated.roe, { version: 1, hostDefaults: {} });
  assert.equal(migrated.presets[0].roeProfile, '');
  const gated = validateSettings({ ...config, roe: { version: 1, hostDefaults: { secondary: 'gated' } }, presets: config.presets.map((preset) => preset.id === 'codex' ? { ...preset, roeProfile: 'gated' } : preset) });
  assert.equal(gated.roe.hostDefaults.secondary, 'gated');
  assert.equal(gated.presets[0].roeProfile, 'gated');
  assert.equal(resolveRoeProfile(gated, 'secondary', gated.presets[0]), 'gated');
  assert.equal(resolveRoeProfile(gated, 'secondary', config.presets[1]), 'gated');
  assert.equal(resolveRoeProfile(gated, 'secondary', config.presets[1], 'full'), 'full');
  assert.equal(resolveRoeProfile(migrated, 'default', { fullPermissions: false }), 'provider-default');
  assert.equal(resolveRoeProfile(migrated, 'default', { fullPermissions: true }), 'full');
  assert.throws(() => resolveRoeProfile(gated, 'secondary', null, 'unsafe'), /Invalid Rules/);
  assert.throws(() => validateRoeLaunch('antigravity', null, 'gated'), /verified session-scoped/);
  assert.throws(() => validateRoeLaunch('claude', { command: 'claude3', args: '' }, 'gated'), /standard provider/);
  assert.throws(() => validateRoeLaunch('codex', { command: 'codex', args: '--dangerously-bypass-approvals-and-sandbox' }, 'gated'), /conflicting permission/);
  assert.throws(() => validateRoeLaunch('codex', { command: 'codex', args: '-c approval_policy=never' }, 'gated'), /conflicting permission/);
  assert.doesNotThrow(() => validateRoeLaunch('claude', { command: 'claude', args: '--model sonnet' }, 'gated'));
  assert.throws(() => validateSettings({ ...config, roe: { version: 2, hostDefaults: {} } }), /Unsupported Rules/);
  assert.throws(() => validateSettings({ ...config, roe: { version: 1, hostDefaults: { missing: 'gated' } } }), /Invalid host Rules/);
  assert.doesNotThrow(() => validateSettings({ ...config, presets: config.presets.map((preset) => preset.provider === 'antigravity' ? { ...preset, roeProfile: 'gated' } : preset) }));
  assert.doesNotThrow(() => validateRoeLaunch('antigravity', {command: 'agy', args: ''}, 'gated', 'chat'));
  assert.throws(() => validateRoeLaunch('antigravity', {command: 'agy', args: ''}, 'gated', 'terminal'), /verified session-scoped/);
  for (const target of ['-oProxyCommand=bad', 'host with spaces', 'host;echo', 'host\nother']) {
    assert.throws(() => validateSettings({ ...config, hosts: [{ ...config.hosts[0], target }] }));
  }
  assert.throws(() => validateSettings({ ...config, hosts: [config.hosts[0], config.hosts[0]] }));
  assert.throws(() => validateSettings({ ...config, hosts: [{ ...config.hosts[0], enabled: false }] }));
  const opOrder = { version: 1, id: 'project', hostId: 'default', repository: '/srv/project', enabled: false, instructions: 'Shared guidance', overrides: { claude: 'Claude guidance' }, mcp: [{ name: 'docs', transport: 'http', url: 'https://example.com/mcp', providers: ['codex', 'claude'], headers: { Authorization: 'DOCS_TOKEN' } }] };
  const orders = validateSettings({ ...config, opOrders: [opOrder] }).opOrders;
  assert.equal(orders[0].mcp[0].headers.Authorization, 'DOCS_TOKEN');
  assert.equal(orders[0].overrides.codex, '');
  assert.throws(() => validateSettings({ ...config, opOrders: [opOrder, { ...opOrder, id: 'other' }] }), /one OpOrder/);
  assert.throws(() => validateSettings({ ...config, opOrders: [{ ...opOrder, repository: '/srv/../project' }] }), /Invalid OpOrder repository/);
  assert.throws(() => validateSettings({ ...config, opOrders: [{ ...opOrder, mcp: [{ ...opOrder.mcp[0], headers: { Authorization: 'Bearer secret' } }] }] }), /environment variables/);
  assert.throws(() => validateSettings({ ...config, opOrders: [{ ...opOrder, mcp: [{ ...opOrder.mcp[0], url: 'http://example.com/mcp' }] }] }), /transport/);
  const conflict = { id: 'project', hostId: 'default', detail: 'Managed file changed', at: new Date().toISOString() };
  store.save('opOrderConflicts', { project: conflict });
  assert.deepEqual(new Store(directory).data.opOrderConflicts.project, conflict, 'A sync conflict must survive desktop restart');
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
  store.cacheUnits('default', [{ key: firstKey, id: 'hq-123', provider: 'codex', kind: 'managed', title: 'Retained unit', cwd: '/fixture', updatedAt: '2026-10-21T00:00:00Z', state: 'live', canAttach: true, outputTail: 'PRIVATE_TRANSCRIPT_MARKER', events: [{ detail: 'PRIVATE_EVENT_MARKER' }] }]);
  assert.equal(new Store(directory).data.cachedUnits.default[0].title, 'Retained unit');
  assert.equal(new Store(directory).data.cachedUnits.default[0].canAttach, true);
  assert.ok(!fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8').includes('PRIVATE_TRANSCRIPT_MARKER'));
  assert.ok(!fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8').includes('PRIVATE_EVENT_MARKER'));
  assert.throws(() => store.cacheUnits('default', [{ key: secondKey, id: 'hq-123', provider: 'codex', kind: 'managed' }]), /Invalid cached unit/);
  store.forgetSessions([firstKey]);
  assert.equal(new Store(directory).data.cachedUnits.default.length, 0);
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
  const oldEvent = { id: 'late-old-turn', kind: 'completed', at: new Date(Date.now() - 60000).toISOString() };
  assert.equal(attention.update([{ ...eventSession, events: [...eventSession.events, { id: 'event-2', kind: 'input' }, { id: 'event-3', kind: 'completed' }, oldEvent] }]).length, 0);
  assert.equal(new Attention(new Store(directory)).update([{ ...eventSession, events: [...eventSession.events, { id: 'event-2', kind: 'input' }, { id: 'event-3', kind: 'completed' }, oldEvent] }]).length, 0);
  const requestId = 'c'.repeat(32);
  const flashEvent = { id: 'flash-event', kind: 'input', at: new Date().toISOString(), requestId, tool: 'Bash' };
  const alerted = attention.update([{ ...eventSession, events: [...eventSession.events, flashEvent] }]);
  assert.equal(alerted[0].requestId, requestId);
  attention.acknowledge(alerted[0].id);
  assert.deepEqual(store.data.flashResolved, [], 'Acknowledging an alert must not answer or resolve a request');
  attention.resolveRequests([requestId]);
  assert.deepEqual(new Store(directory).data.flashResolved, [requestId]);
  assert.equal(new Attention(new Store(directory)).update([{ ...eventSession, key: 'default/tmux:another', events: [flashEvent] }])[0].acknowledged, true);
  console.log('PASS settings, host validation, workspace persistence, attention confidence, transitions, acknowledgement, restart deduplication, and host isolation');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
