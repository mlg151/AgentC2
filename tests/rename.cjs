const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Store, validateSessionTitle } = require('../electron/config.cjs');
const { createService } = require('../electron/service.cjs');

(async () => {
  assert.equal(validateSessionTitle('  New name  '), 'New name');
  assert.equal(validateSessionTitle('🛰'.repeat(50)), '🛰'.repeat(50));
  assert.throws(() => validateSessionTitle('🛰'.repeat(51)), /session title/);
  for (const title of ['', '   ', null, {}, 'x'.repeat(101), 'bad\nname', 'bad\tname', '\x7f', '\x85', '\ud800']) assert.throws(() => validateSessionTitle(title), /session title/);
  if (process.platform !== 'linux' || !process.argv.includes('--native')) { console.log('PASS strict session title validation'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-rename-'));
  const before = { HOME: process.env.HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  process.env.HOME = directory; process.env.TMUX_TMPDIR = directory;
  const name = `hq-${crypto.randomBytes(6).toString('hex')}`;
  const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    tmux('new-session', '-d', '-s', name, 'sleep 600');
    tmux('set-option', '-t', name, '@hq_provider', 'terminal');
    tmux('set-option', '-t', name, '@hq_title', 'Original');
    const store = new Store(directory);
    store.save('settings', { ...store.data.settings, hosts: [{ id: 'default', kind: 'local', name: 'Fixture', enabled: true, target: 'localhost', port: 22 }] });
    const service = createService({ directory, home: directory });
    const snapshot = await service.inventory();
    const key = `default/tmux:${name}`;
    assert.ok(snapshot.sessions.find((item) => item.key === key)?.managed);
    for (const invalid of [key + '\n', 'default/process:12345', 'default/tmux:hq-000000000000']) await assert.rejects(service.renameSession(invalid, 'New name'));
    const rename = service.renameSession(key, '-- Renamed terminal');
    await assert.rejects(service.renameSession(key, 'Racing title'), /already in progress/);
    await assert.rejects(service.deleteSession({ id: 'desktop' }, key), /already in progress/);
    await assert.rejects(service.saveSettings(service.store.data.settings), /renaming/);
    assert.equal(await rename, '-- Renamed terminal');
    assert.equal(tmux('show-options', '-qv', '-t', name, '@hq_title'), '-- Renamed terminal');
    assert.equal((await service.inventory()).sessions.find((item) => item.key === key).title, '-- Renamed terminal');
    assert.equal(new Store(directory).data.cachedUnits.default.find((item) => item.key === key).title, '-- Renamed terminal');
    const configure = await service.terminals.configure(name, 'default');
    assert.equal(configure, undefined); // configure callback only validates/executes helper.
    tmux('kill-session', '-t', name);
    await assert.rejects(service.renameSession(key, 'Gone session'), /managed session/);
    console.log('PASS native terminal rename, strict validation, managed-only guards, inventory/cache persistence, configure response, and removed-session rejection');
  } finally {
    try { tmux('kill-session', '-t', name); } catch { /* Fixture may already be removed. */ }
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
