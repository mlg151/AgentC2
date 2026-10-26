// End-to-end verifier fixture, not native test evidence for this repository.
// A tiny disposable repository proves the CLI enforces the exact-count gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { SHARDS, metadata } = require('../scripts/coverage-artifacts.cjs');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-aggregate-cli-'));
try {
  for (const name of ['electron', 'src', 'scripts', 'tests', 'inputs']) fs.mkdirSync(path.join(directory, name));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(directory, '.gitignore'), 'node_modules\ntest-results/\ninputs/\n');
  fs.writeFileSync(path.join(directory, 'electron/fixture.cjs'), 'function fixture() { return 1; }\nmodule.exports = fixture;\n');
  fs.writeFileSync(path.join(directory, 'electron/fixture.py'), 'fixture = 1\n');
  fs.writeFileSync(path.join(directory, 'src/types.ts'), 'export interface Fixture { value: string }\n');
  fs.writeFileSync(path.join(directory, '.coveragerc'), '[run]\nbranch = True\ncore = ctrace\nsource = electron\nrelative_files = True\n[json]\npretty_print = True\n[html]\ndirectory = test-results/coverage/python/html\n');
  for (const file of ['coverage.cjs', 'coverage-artifacts.cjs', 'coverage-data.py', 'normalize-coverage.py']) fs.copyFileSync(path.join(root, 'scripts', file), path.join(directory, 'scripts', file));
  const groups = [...new Set(Object.values(SHARDS).flatMap((shard) => shard.groups))];
  const suites = groups.map((group) => ({ id: group === 'linux-python' ? 'chat-upgrade-python' : group + '-fixture', group }));
  fs.writeFileSync(path.join(directory, 'tests/suites.json'), JSON.stringify({ suites }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Coverage fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'Verifier fixture');
  const stamp = metadata(directory);
  assert.equal(stamp.dirty, false);
  const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 31 } };
  const file = 'electron/fixture.cjs';
  const artifacts = Object.entries(SHARDS).map(([label, policy], index) => ({ version: 1, label, platform: policy.platform, arch: policy.arch, metadata: stamp,
    suites: Object.fromEntries(policy.groups.map((group) => [group, suites.filter((suite) => suite.group === group).map(({ id }) => ({ id, status: 'success', code: 0, signal: null, durationSeconds: 0.1, skips: [] }))])),
    javascript: { [file]: { path: file, statementMap: { 0: location, 1: { start: { line: 2, column: 0 }, end: { line: 2, column: 25 } } }, fnMap: { 0: { name: 'fixture', decl: location, loc: location, line: 1 } }, branchMap: { 0: { type: 'branch', line: 1, loc: location, locations: [location] } }, s: { 0: index === 0 ? 1 : 0, 1: index === 0 ? 1 : 0 }, f: { 0: index === 0 ? 1 : 0 }, b: { 0: [index === 0 ? 1 : 0] } } },
    python: { version: '7.16.0', branchCoverage: true, processReports: label === 'linux-cleanup' ? 0 : 1, files: label === 'linux-ssh' ? { 'electron/fixture.py': { fixture: [[-1, 1], [1, -1]] } } : {} },
  }));
  const write = () => { for (const artifact of artifacts) fs.writeFileSync(path.join(directory, 'inputs', artifact.label + '.json'), JSON.stringify(artifact)); };
  const run = () => spawnSync(process.execPath, ['scripts/coverage.cjs', 'aggregate', 'inputs'], { cwd: directory, encoding: 'utf8' });
  write();
  const pass = run();
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  let report = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/summary.json'), 'utf8'));
  assert.deepEqual(report.gaps, []); assert.equal(Object.keys(report.files).length, 2);
  assert.ok(fs.existsSync(path.join(directory, 'test-results/coverage/javascript/index.html')));
  assert.ok(fs.existsSync(path.join(directory, 'test-results/coverage/python/html/index.html')));
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/provenance.json'), 'utf8'));
  assert.equal(provenance.shards.length, 6);
  for (const artifact of artifacts) artifact.javascript[file].f[0] = 0;
  write();
  const fail = run();
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  report = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/summary.json'), 'utf8'));
  assert.deepEqual(report.gaps, [{ file, metric: 'functions', covered: 0, total: 1, missing: 1 }]);
  fs.unlinkSync(path.join(directory, 'inputs', 'linux-ssh.json'));
  const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /all six/);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS disposable verifier CLI: all six shards, JS/Python reports, exact success, an uncalled function failing the gate, and missing native evidence rejected');
