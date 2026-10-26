const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check } = require('../scripts/quality-gate.cjs');
const { validate } = require('../scripts/run-tests.cjs');
const success = Object.fromEntries(['desktop', 'linux-ssh', 'linux-cleanup', 'coverage'].map((name) => [name, { result: 'success' }]));
assert.doesNotThrow(() => check(success));
for (const name of Object.keys(success)) {
  for (const result of ['failure', 'cancelled', 'skipped', 'pending', undefined]) assert.throws(() => check({ ...success, [name]: { result } }));
  const missing = { ...success }; delete missing[name]; assert.throws(() => check(missing));
}
validate();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-inventory-'));
try {
  fs.mkdirSync(path.join(directory, 'tests'));
  fs.writeFileSync(path.join(directory, 'tests', 'forgotten.cjs'), '');
  assert.throws(() => validate(directory, { suites: [], nested: {}, optional: {} }), /Unregistered test entrypoint/);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS gate rejects non-success and missing dependencies; inventory rejects unregistered tests');
// Reproduce the old Windows CI skip without needing a Windows host or WSL.
const { spawnSync } = require('node:child_process');
const missingWsl = spawnSync(process.execPath, ['-e', `
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.CI = 'true';
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function(id, ...args) {
    if (id === 'node:child_process') return { execFileSync() { throw Error('WSL prerequisite fixture unavailable'); } };
    if (id === 'playwright-core') return {};
    if (id === '../electron/config.cjs') return {};
    if (id === '../electron/local.cjs') return { localCommand() { return { binary: 'wsl.exe', args: [] }; } };
    return original.call(this, id, ...args);
  };
  require('./tests/windows-local.e2e.cjs');
`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
assert.equal(missingWsl.status, 1, missingWsl.stdout + missingWsl.stderr);
assert.match(missingWsl.stderr, /WSL prerequisite fixture unavailable/);
console.log('PASS unavailable WSL prerequisites fail even with CI=true');
const workflow = require('js-yaml').load(fs.readFileSync(path.join(__dirname, '../.github/workflows/desktop.yml'), 'utf8'));
assert.equal(workflow.jobs['quality-gate'].if, 'always()');
assert.deepEqual([...workflow.jobs['quality-gate'].needs].sort(), Object.keys(success).sort());
assert.deepEqual(workflow.jobs.release.needs, ['quality-gate']);
assert.equal(workflow.jobs.desktop.strategy['fail-fast'], false);
assert.equal(workflow.jobs.desktop.strategy.matrix.include.length, 4);
const inventory = require('./suites.json');
assert.ok(inventory.suites.some((suite) => suite.id === 'chat-upgrade-python' && suite.file === 'tests/chat-upgrade.py' && suite.group === 'linux-python'), 'Seamless worker upgrades must remain a required suite');
assert.ok(workflow.jobs['linux-ssh'].steps.some((step) => step.run === 'node scripts/run-tests.cjs linux-python'), 'The quality gate must execute worker upgrade continuity tests');
console.log('PASS workflow connects the complete native matrix and isolated jobs to the release gate');
assert.equal(workflow.jobs.coverage.if, 'always()');
assert.deepEqual(workflow.jobs.coverage.needs, ['desktop', 'linux-ssh', 'linux-cleanup']);
assert.ok(workflow.jobs.coverage.steps.some((step) => step.run === 'node scripts/coverage.cjs aggregate test-results/coverage-input'));
for (const name of ['desktop', 'linux-ssh', 'linux-cleanup']) {
  const job = workflow.jobs[name];
  assert.equal(job.env.AGENTC2_COVERAGE, '1');
  assert.ok(job.steps.some((step) => step.run?.startsWith('node scripts/coverage.cjs export ')));
  assert.ok(job.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name?.startsWith('Coverage-') && step.with['if-no-files-found'] === 'error' && step.with['retention-days'] === 14));
}
for (const name of ['desktop', 'linux-ssh', 'linux-cleanup', 'coverage']) assert.ok(workflow.jobs[name].steps.some((step) => step.uses === 'actions/setup-python@v7.1.0' && step.with['python-version'] === '3.11'), 'Native collectors must use an explicit compatible Python interpreter');
assert.ok(workflow.jobs.desktop.steps.some((step) => step.env?.AGENTC2_COVERAGE === '0' && step.run === 'npm run build'), 'Published packages must retain the optimized production build');
console.log('PASS all six native coverage shards feed the required complete coverage gate while release packages retain optimized builds');
