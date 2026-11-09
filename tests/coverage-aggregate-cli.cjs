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
  fs.writeFileSync(path.join(directory, 'electron/empty.cjs'), '"use strict";\n');
  fs.writeFileSync(path.join(directory, 'electron/fixture.py'), 'fixture = 1\n');
  fs.writeFileSync(path.join(directory, 'src/types.ts'), 'export interface Fixture { value: string }\n');
  fs.writeFileSync(path.join(directory, '.coveragerc'), '[run]\nbranch = True\ncore = ctrace\nsource = electron\nrelative_files = True\n[json]\npretty_print = True\n[html]\ndirectory = test-results/coverage/python/html\n');
  for (const file of ['coverage.cjs', 'coverage-artifacts.cjs', 'source-coverage.cjs', 'production-sources.cjs', 'coverage-data.py', 'normalize-coverage.py']) fs.copyFileSync(path.join(root, 'scripts', file), path.join(directory, 'scripts', file));
  const groups = [...new Set(Object.values(SHARDS).flatMap((shard) => shard.groups))];
  const suites = groups.map((group) => ({ id: group === 'linux-python' ? 'chat-upgrade-python' : group + '-fixture', group }));
  fs.writeFileSync(path.join(directory, 'tests/suites.json'), JSON.stringify({ suites }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Coverage fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'Verifier fixture');
  const stamp = metadata(directory);
  assert.equal(stamp.dirty, false);
  const file = 'electron/fixture.cjs';
  const source = require('../scripts/source-coverage.cjs');
  const measured = source.manifest(directory);
  const fixture = measured[file], empty = 'electron/empty.cjs';
  const artifacts = Object.entries(SHARDS).map(([label, policy], index) => ({ version: 2, javascriptMeasurement: { format: source.format, instrumenter: source.version }, label, platform: policy.platform, arch: policy.arch, metadata: stamp,
    suites: Object.fromEntries(policy.groups.map((group) => [group, suites.filter((suite) => suite.group === group).map(({ id }) => ({ id, status: 'success', code: 0, signal: null, durationSeconds: 0.1, skips: [] }))])),
    javascript: { [empty]: { ...measured[empty], all: index !== 0 }, [file]: { ...fixture, all: false, s: Object.fromEntries(Object.keys(fixture.s).map((id) => [id, index === 0 ? 1 : 0])), f: Object.fromEntries(Object.keys(fixture.f).map((id) => [id, index === 0 ? 1 : 0])) } },
    python: { version: '7.16.0', branchCoverage: true, processReports: label === 'linux-cleanup' ? 0 : 1, files: label === 'linux-ssh' ? { 'electron/fixture.py': { fixture: [[-1, 1], [1, -1]] } } : {} },
  }));
  const write = () => { for (const artifact of artifacts) fs.writeFileSync(path.join(directory, 'inputs', artifact.label + '.json'), JSON.stringify(artifact)); };
  // This disposable repository is verifier input, not application execution.
  // Inherited automatic collectors would misattribute its relative Python
  // filename to the parent repository when this suite itself runs in coverage CI.
  const inheritedDirectory = process.env.COVERAGE_FILE && path.dirname(process.env.COVERAGE_FILE);
  const inheritedFiles = inheritedDirectory && fs.existsSync(inheritedDirectory) ? new Set(fs.readdirSync(inheritedDirectory)) : new Set();
  const environment = { ...process.env, AGENTC2_COVERAGE: '0', COVERAGE_PROCESS_START: '', COVERAGE_FILE: path.join(directory, 'test-results/verifier-python/.coverage'), NODE_V8_COVERAGE: path.join(directory, 'test-results/verifier-v8') };
  const run = (...flags) => spawnSync(process.execPath, ['scripts/coverage.cjs', 'aggregate', 'inputs', ...flags], { cwd: directory, encoding: 'utf8', env: environment });
  write();
  const pass = run();
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  let report = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/summary.json'), 'utf8'));
  assert.deepEqual(report.gaps, []); assert.equal(Object.keys(report.files).length, 3);
  assert.deepEqual(report.unobserved, []);
  assert.ok(fs.existsSync(path.join(directory, 'test-results/coverage/javascript/index.html')));
  assert.ok(fs.existsSync(path.join(directory, 'test-results/coverage/python/html/index.html')));
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/provenance.json'), 'utf8'));
  assert.equal(provenance.shards.length, 6);
  const acceptance = run('--acceptance');
  assert.equal(acceptance.status, 0, acceptance.stdout + acceptance.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/summary.json'), 'utf8')).policy, 'acceptance');
  assert.equal(run('--unknown').status, 1, 'Unknown options cannot silently choose a weaker policy');
  for (const artifact of artifacts) artifact.javascript[file].f[0] = 0;
  write();
  const fail = run();
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  report = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/summary.json'), 'utf8'));
  assert.deepEqual(report.gaps, [{ file, metric: 'functions', covered: 0, total: 1, missing: 1 }]);
  assert.equal(run('--acceptance').status, 1, 'Acceptance still rejects uncovered functions below its floor');
  for (const artifact of artifacts) artifact.javascript[empty].all = true;
  artifacts[0].javascript[file].f[0] = 1;
  write();
  const unloaded = run(); assert.equal(unloaded.status, 1, unloaded.stdout + unloaded.stderr);
  report = JSON.parse(fs.readFileSync(path.join(directory, 'test-results/coverage/summary.json'), 'utf8'));
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.unobserved, [empty], 'Even a zero-counter executable module must be observed at runtime');
  assert.match(unloaded.stdout, /Executable production source was never loaded/);
  assert.equal(run('--acceptance').status, 1, 'Acceptance still requires runtime observation');
  assert.ok(fs.existsSync(path.join(directory, 'test-results/coverage/javascript/coverage-final.json')));
  assert.ok(fs.existsSync(path.join(directory, 'test-results/coverage/python/coverage.json')));
  fs.unlinkSync(path.join(directory, 'inputs', 'linux-ssh.json'));
  const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /all six/);
  const missingAcceptance = run('--acceptance'); assert.equal(missingAcceptance.status, 1); assert.match(missingAcceptance.stderr, /all six/);
  if (inheritedDirectory && fs.existsSync(inheritedDirectory)) {
    const reports = fs.readdirSync(inheritedDirectory).filter((name) => name.startsWith('.coverage.') && !inheritedFiles.has(name)).map((name) => path.join(inheritedDirectory, name));
    const script = [
      'from coverage import CoverageData; import json,sys',
      'for filename in json.loads(sys.argv[1]):',
      ' data=CoverageData(basename=filename); data.read(); assert "electron/fixture.py" not in data.measured_files(), filename',
    ].join('\n');
    const probe = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', script, JSON.stringify(reports)], { env: environment, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS disposable verifier CLI: all six shards, JS/Python reports, exact success, uncalled functions and unobserved zero-counter modules failing with retained reports, and missing native evidence rejected');
