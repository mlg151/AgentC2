const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, pythonSummary, declarationFiles } = require('../scripts/coverage.cjs');
const { normalize } = require('./helpers/browser-coverage.cjs');
const complete = Object.fromEntries(['statements', 'branches', 'functions', 'lines'].map((metric) => [metric, { total: 100000, covered: 100000 }]));
assert.deepEqual(check({ 'electron/fixture.cjs': complete }), []);
for (const metric of Object.keys(complete)) {
  const almost = structuredClone(complete);
  almost[metric].covered--;
  almost[metric].pct = 100; // Rounded percentages must never make a gap pass.
  assert.deepEqual(check({ 'electron/fixture.cjs': almost }), [{ file: 'electron/fixture.cjs', metric, covered: 99999, total: 100000, missing: 1 }]);
  for (const invalid of [undefined, { total: -1, covered: 0 }, { total: 1, covered: 2 }, { total: 0, covered: -1 }, { total: 1, covered: 0.5 }]) {
    assert.throws(() => check({ 'electron/fixture.cjs': { ...complete, [metric]: invalid } }), /Invalid/);
  }
}
assert.throws(() => check({}), /Empty coverage/);
assert.throws(() => check({ total: complete }), /Empty coverage/);
const empty = Object.fromEntries(Object.keys(complete).map((metric) => [metric, { total: 0, covered: 0 }]));
assert.deepEqual(check({ 'electron/empty.cjs': empty }), []);
const fixture = { meta: { branch_coverage: true }, files: { 'electron/fixture.py': {
  summary: { num_statements: 2, covered_lines: 1, num_branches: 2, covered_branches: 1 },
  functions: { '': { executed_lines: [1] }, used: { executed_lines: [2] }, unused: { executed_lines: [] } },
} } };
const python = pythonSummary(fixture);
assert.deepEqual(python['electron/fixture.py'].functions, { total: 2, covered: 1 });
assert.equal(check(python).length, 4);
assert.throws(() => pythonSummary({ ...fixture, meta: {} }), /branch coverage/);
delete fixture.files['electron/fixture.py'].functions;
assert.throws(() => pythonSummary(fixture), /function measurement/);
assert.deepEqual(declarationFiles().sort(), ['src/chatTypes.ts', 'src/types.ts', 'src/vite-env.d.ts']);
const source = path.resolve(__dirname, '../src/chatClient.ts');
const map = { version: 3, sources: ['chatClient.ts'], sourcesContent: ['export const value = 1;'], names: [], mappings: 'AAAA' };
const entry = { scriptId: 'fixture', url: pathToFileURL(source).href, source: `export const value = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`, functions: [] };
const browser = normalize([entry, { ...entry, url: 'not a valid URL' }, { ...entry, url: 'https://fixture.invalid/../../etc/passwd.js' }]);
assert.equal(browser.result.length, 1);
assert.deepEqual(browser['source-map-cache'][entry.url].data.sources, [entry.url]);
assert.deepEqual(normalize([{ ...entry, url: source }]), browser, 'Electron preload coverage may use a native path rather than a file URL');
console.log('PASS exact-count coverage enforcement, missing/invalid metrics, empty reports, Python function accounting, declaration-only exclusions, and browser source-map attribution');
