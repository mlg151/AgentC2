const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const artifacts = require('../scripts/coverage-artifacts.cjs');

const file = 'electron/fixture.cjs';
const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 12 } };
const coverage = (statement, branch, fn) => structuredClone({ path: file, sourceHash: 'b'.repeat(64), statementMap: { 0: location }, fnMap: { 0: { name: 'fixture', decl: location, loc: location, line: 1 } }, branchMap: { 0: { type: 'branch', line: 1, loc: location, locations: [location] } }, s: { 0: statement }, b: { 0: [branch] }, f: { 0: fn } });
const metadata = { version: 2, revision: 'a'.repeat(40), dirty: false, sources: { [file]: 'b'.repeat(64), 'electron/fixture.py': 'c'.repeat(64) }, instrumentation: { 'scripts/coverage.cjs': 'd'.repeat(64) } };
const groups = [...new Set(Object.values(artifacts.SHARDS).flatMap((shard) => shard.groups))];
const inventory = { suites: groups.map((group) => ({ id: group === 'linux-python' ? 'chat-upgrade-python' : group + '-fixture', group })) };
const result = (id) => ({ id, status: 'success', code: 0, signal: null, durationSeconds: 1.5, skips: [] });
function shard(label) {
  const policy = artifacts.SHARDS[label];
  return { version: 2, javascriptMeasurement: { format: require('../scripts/source-coverage.cjs').format, instrumenter: require('../scripts/source-coverage.cjs').version }, label, platform: policy.platform, arch: policy.arch, metadata: structuredClone(metadata),
    suites: Object.fromEntries(policy.groups.map((group) => [group, inventory.suites.filter((suite) => suite.group === group).map((suite) => result(suite.id))])),
    javascript: { [file]: coverage(0, 0, 0) }, python: { version: '7.16.0', branchCoverage: true, processReports: label === 'linux-cleanup' ? 0 : 1, files: {} } };
}
const all = () => Object.keys(artifacts.SHARDS).map(shard);
const expected = { [file]: { ...coverage(0, 0, 0), all: true } };
const merge = (input) => artifacts.mergeArtifacts(input, metadata, inventory, expected);
const valid = all();
valid[0].javascript[file] = coverage(1, 0, 0); valid[1].javascript[file] = coverage(0, 1, 0); valid[2].javascript[file] = coverage(0, 0, 1);
const combined = merge(valid).getCoverageSummary();
for (const metric of ['lines', 'statements', 'branches', 'functions']) assert.equal(combined[metric].pct, 100, `${metric} must union actual execution, rather than percentages`);
assert.equal(merge(all()).getCoverageSummary().functions.pct, 0, 'Unexecuted functions remain uncovered');
const outer = coverage(1, 1, 1), child = coverage(0, 0, 0);
outer.fnMap[0].loc = { start: { line: 1, column: 0 }, end: { line: 10, column: 0 } };
outer.branchMap[0].loc = outer.fnMap[0].loc; outer.branchMap[0].locations = [outer.fnMap[0].loc];
child.fnMap[0].loc = { start: { line: 3, column: 0 }, end: { line: 4, column: 0 } };
child.branchMap[0].loc = child.fnMap[0].loc; child.branchMap[0].locations = [child.fnMap[0].loc];
const strict = artifacts.mergeJavascript([{ [file]: outer }, { [file]: child }]).getCoverageSummary();
assert.equal(strict.functions.covered, 1); assert.equal(strict.functions.total, 2, 'An uncalled nested function cannot borrow its parent function hit');
assert.equal(strict.branches.covered, 1); assert.equal(strict.branches.total, 2, 'An unexecuted nested branch cannot borrow its parent block hit');
const absent = { ...coverage(0, 0, 0), all: true };
assert.equal(artifacts.mergeJavascript([{ [file]: absent }, { [file]: coverage(1, 1, 1) }]).getCoverageSummary().functions.pct, 100, 'Only an explicit all-files placeholder yields to measured execution');
const crlf = structuredClone(coverage(0, 0, 0)), lf = coverage(1, 1, 1);
crlf.statementMap[0].end.column++;
const newlineUnion = artifacts.mergeJavascript([{ [file]: crlf }, { [file]: lf }]).getCoverageSummary();
assert.equal(newlineUnion.statements.total, 1); assert.equal(newlineUnion.statements.covered, 1, 'C8 line statements must not duplicate because of CRLF trailing columns');
assert.throws(() => merge(valid.slice(1)), /all six/);
assert.throws(() => merge([...valid, valid[0]]), /Duplicate coverage shard/);
for (const mutate of [
  (item) => { item.metadata.revision = 'e'.repeat(40); },
  (item) => { item.metadata.sources[file] = 'e'.repeat(64); },
  (item) => { item.metadata.instrumentation['scripts/coverage.cjs'] = 'e'.repeat(64); },
  (item) => { item.metadata.dirty = true; },
  (item) => { delete item.javascript[file]; },
  (item) => { item.javascript[file].b[0] = [-1]; },
  (item) => { item.javascript[file].b[0] = [1, 1]; },
  (item) => { item.javascript[file].f = {}; },
  (item) => { item.javascript[file].path = 'electron/other.cjs'; },
  (item) => { item.javascriptMeasurement.format = 'v8'; },
  (item) => { item.javascript[file].sourceHash = 'wrong'; },
  (item) => { item.javascript[file].fnMap[0].loc.start.column++; },
  (item) => { item.platform = 'wrong'; },
  (item) => { item.arch = 'wrong'; },
  (item) => { item.version = 3; },
  (item) => { delete item.suites.desktop; },
  (item) => { item.suites.core = []; },
  (item) => { item.suites.core.push(item.suites.core[0]); },
  (item) => { item.suites.core[0].status = 'failure'; },
  (item) => { item.suites.core[0].code = 1; },
  (item) => { item.suites.core[0].signal = 'SIGTERM'; },
  (item) => { item.suites.core[0].durationSeconds = NaN; },
  (item) => { item.python.branchCoverage = false; },
  (item) => { item.python.version = '7.15.0'; },
  (item) => { item.python.processReports = 0; },
  (item) => { item.python.files = { '../fixture.py': {} }; },
  (item) => { item.python.files = { 'electron/fixture.py': { fixture: [[1, '2']] } }; },
]) {
  const input = all(); mutate(input[0]); assert.throws(() => merge(input));
}
const skipped = all().find((item) => item.label === 'linux-ssh'); skipped.suites['linux-python'][0].skips.push('skipped');
assert.throws(() => artifacts.validateArtifact(skipped, metadata, inventory, expected), /upgrade regression may not be skipped/);
const preserved = shard('desktop-linux-x64'); preserved.suites.core[0].skips = ['Optional duplicate system SDK probe; private runtime suite is required separately']; artifacts.validateArtifact(preserved, metadata, inventory, expected);
assert.deepEqual(preserved.suites.core[0].skips, ['Optional duplicate system SDK probe; private runtime suite is required separately']);
for (const [value, base] of [['D:\\a\\AgentC2\\electron\\fixture.cjs', 'd:\\a\\AgentC2'], ['/work/AgentC2/electron/fixture.cjs', '/work/AgentC2'], ['electron/fixture.cjs', '']]) assert.equal(artifacts.canonical(value, base), file);
for (const value of ['../electron/fixture.cjs', 'electron/../fixture.cjs', '/etc/fixture.cjs', 'electron//fixture.cjs']) assert.throws(() => artifacts.canonical(value, '/work/AgentC2'));

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-coverage-artifacts-'));
try {
  fs.mkdirSync(path.join(directory, 'electron')); fs.mkdirSync(path.join(directory, 'scripts'));
  fs.writeFileSync(path.join(directory, file), 'function fixture() {}\r\n');
  fs.writeFileSync(path.join(directory, 'scripts/coverage.cjs'), 'collector\r\n');
  let dirty = '';
  const git = (_binary, args) => args[0] === 'rev-parse' ? metadata.revision : args[0] === 'ls-files' ? file + '\0scripts/coverage.cjs\0' : dirty;
  const before = artifacts.metadata(directory, git);
  fs.writeFileSync(path.join(directory, file), 'function fixture() {}\n'); fs.writeFileSync(path.join(directory, 'scripts/coverage.cjs'), 'collector\n');
  assert.deepEqual(artifacts.metadata(directory, git), before, 'CRLF/LF checkouts represent the same source and collector');
  fs.writeFileSync(path.join(directory, file), 'function fixture() { changed(); }\n');
  assert.throws(() => artifacts.assertMetadata(artifacts.metadata(directory, git), before), /changed/);
  dirty = ' M electron/fixture.cjs'; assert.equal(artifacts.metadata(directory, git).dirty, true);
  fs.writeFileSync(path.join(directory, '.gitignore'), 'reports/\ncollection/\nlegacy/\n');
  const command = (...args) => execFileSync('git', ['-c', 'user.name=Coverage fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, stdio: 'pipe' });
  command('init', '-q'); command('add', '.'); command('commit', '-qm', 'Fixture source');
  const collected = path.join(directory, 'collection');
  assert.throws(() => artifacts.verifyCollection(directory, collected), /metadata is missing/);
  const pinned = artifacts.collection(directory, collected);
  assert.equal(pinned.dirty, false);
  assert.deepEqual(artifacts.collection(directory, collected), pinned);
  const original = fs.readFileSync(path.join(directory, file), 'utf8');
  fs.appendFileSync(path.join(directory, file), 'changed();\n');
  assert.throws(() => artifacts.verifyCollection(directory, collected), /changed/);
  assert.throws(() => artifacts.collection(directory, collected), /changed/);
  fs.writeFileSync(path.join(directory, file), original);
  assert.deepEqual(artifacts.verifyCollection(directory, collected), pinned);
  fs.mkdirSync(path.join(directory, 'legacy/v8'), { recursive: true }); fs.writeFileSync(path.join(directory, 'legacy/v8/report.json'), '{}');
  assert.throws(() => artifacts.collection(directory, path.join(directory, 'legacy')), /Unversioned coverage/);
  command('commit', '--allow-empty', '-qm', 'New revision');
  assert.throws(() => artifacts.verifyCollection(directory, collected), /changed/);
  const output = path.join(directory, 'reports');
  artifacts.writeJavascriptReports(createCoverageMap({ [file]: coverage(1, 0, 1) }), directory, output);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'coverage-summary.json'), 'utf8'));
  assert.equal(report.total.branches.covered, 0); assert.equal(report.total.functions.covered, 1);
  assert.ok(fs.existsSync(path.join(output, 'index.html')));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS exact native shard/suite/source provenance, omitted and failed checks, incompatible data, cross-platform paths, real count union, and retained HTML/JSON evidence');
