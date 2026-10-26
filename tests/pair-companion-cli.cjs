const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadCommonJs } = require('./helpers/load-commonjs.cjs');
const { Pairing } = require('../electron/pairing.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-pair-cli-'));
try {
  let configuration = { enabled: true, url: 'https://fixture.invalid' }, found = '', saved, logs;
  const run = (env = {}) => {
    saved = null; logs = [];
    loadCommonJs('scripts/pair-companion.cjs', {
      'node:fs': { existsSync: (file) => file === path.join(directory, found, 'workspace.json'), readFileSync: () => JSON.stringify(configuration) },
      '../electron/platform.cjs': { appDataDirectory: () => directory },
      '../electron/pairing.cjs': { Pairing: class { constructor(folder) { saved = folder; } issue(url) { assert.equal(url, configuration.url); return { url: url + '/fixture-invitation', expiresAt: 123 }; } } },
    }, { process: { env }, console: { log: (line) => logs.push(JSON.parse(line)) } });
    assert.deepEqual(logs, [{ url: configuration.url + '/fixture-invitation', expiresAt: 123 }]);
    return saved;
  };
  assert.equal(run(), path.join(directory, 'agentc2'));
  for (const name of ['agentc2', 'AgentC2', 'agent-hq', 'Agent HQ']) { found = name; assert.equal(run(), path.join(directory, name)); }
  assert.equal(run({ AGENTC2_DATA_DIR: 'explicit', AGENT_HQ_DATA_DIR: 'legacy' }), 'explicit');
  assert.equal(run({ AGENT_HQ_DATA_DIR: 'legacy' }), 'legacy');
  for (const value of [{ enabled: false, url: 'https://fixture.invalid' }, { enabled: true, url: '' }]) { configuration = value; assert.throws(() => run(), /Enable remote access first/); }
  fs.writeFileSync(path.join(directory, 'remote-access.json'), JSON.stringify({ enabled: true, url: 'https://fixture.invalid' }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-companion.cjs')], { env: { ...process.env, AGENTC2_DATA_DIR: directory }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const invitation = JSON.parse(result.stdout);
  const token = new URL(invitation.url).hash.slice('#pair='.length);
  const persisted = fs.readFileSync(path.join(directory, 'companion-invitation.json'), 'utf8');
  assert.equal(persisted.includes(token), false, 'The CLI must persist a hash rather than the private invitation token');
  const pairing = new Pairing(directory);
  assert.equal(pairing.consume(token, 'https://fixture.invalid'), true);
  assert.equal(pairing.consume(token, 'https://fixture.invalid'), false);
  fs.unlinkSync(path.join(directory, 'remote-access.json'));
  const missing = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-companion.cjs')], { env: { ...process.env, AGENTC2_DATA_DIR: directory }, encoding: 'utf8' });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /ENOENT/);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS pairing CLI directory precedence, legacy discovery, disabled/missing config, JSON output, private hash persistence, and single-use consumption in an isolated home');
