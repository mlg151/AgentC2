const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, pythonSummary, declarationFiles } = require('../scripts/coverage.cjs');
const { normalize } = require('./helpers/browser-coverage.cjs');
const { nameAnonymousFunctions } = require('../scripts/normalize-v8.cjs');
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
assert.deepEqual(pythonSummary(fixture, { 'electron/fixture.py': { total: 2, covered: 1 } })['electron/fixture.py'].functions, { total: 4, covered: 2 });
assert.throws(() => pythonSummary(fixture, {}), /lambda measurement is missing/);
assert.equal(check(python).length, 4);
assert.throws(() => pythonSummary({ ...fixture, meta: {} }), /branch coverage/);
delete fixture.files['electron/fixture.py'].functions;
assert.throws(() => pythonSummary(fixture), /function measurement/);
assert.deepEqual(declarationFiles().sort(), ['src/chatTypes.ts', 'src/types.ts', 'src/vite-env.d.ts']);
const source = path.resolve(__dirname, '../src/chatClient.ts');
const map = { version: 3, sources: ['chatClient.ts', 'platform.ts'], sourcesContent: ['export const value = 1;', 'export const other = 2;'], names: [], mappings: 'AAAA' };
const entry = { scriptId: 'fixture', url: pathToFileURL(source).href, source: `export const value = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`, functions: [] };
const browser = normalize([entry, { ...entry, url: 'not a valid URL' }, { ...entry, url: 'https://fixture.invalid/../../etc/passwd.js' }]);
assert.equal(browser.result.length, 1);
assert.deepEqual(browser['source-map-cache'][entry.url].data.sources, [source, path.resolve(__dirname, '../src/platform.ts')], 'Multi-source browser maps must use filesystem paths or C8 silently drops branch/function measurements');
assert.deepEqual(normalize([{ ...entry, url: source }]), browser, 'Electron preload coverage may use a native path rather than a file URL');
assert.throws(() => normalize([{ ...entry, source: undefined }]), /omitted the generated source/);
const v8 = { result: [{ url: entry.url, functions: [
  { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
  { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 20, endOffset: 30, count: 0 }] },
  { functionName: 'known', isBlockCoverage: true, ranges: [{ startOffset: 40, endOffset: 50, count: 2 }] },
] }] };
const named = nameAnonymousFunctions(v8);
assert.deepEqual(named.result[0].functions.map((fn) => fn.functionName), ['', '(anonymous@20)', 'known']);
assert.equal(v8.result[0].functions[1].functionName, '', 'Raw V8 evidence must remain untouched');
assert.deepEqual(named.result[0].functions.map((fn) => fn.ranges), v8.result[0].functions.map((fn) => fn.ranges));
assert.throws(() => nameAnonymousFunctions({}), /Invalid V8 process/);
console.log('PASS exact-count coverage enforcement, missing/invalid metrics, empty reports, Python function accounting, declaration-only exclusions, and browser source-map attribution');
