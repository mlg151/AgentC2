const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const source = require('../scripts/source-coverage.cjs');
const catalog = require('../scripts/production-sources.cjs');
const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-source-counters-')));
const file = 'src/fixture.ts';
try {
  for (const folder of ['src', 'electron', 'public', 'scripts']) fs.mkdirSync(path.join(directory, folder));
  const text = '"use strict";\nexport function outer(create: boolean) { const sameLine = 1; const second = 2; if (create) return () => sameLine + second; return null; }\nexport function never() { return this; }\n';
  fs.writeFileSync(path.join(directory, file), text);
  fs.writeFileSync(path.join(directory, 'src/types.ts'), 'export interface OnlyTypes { value: string }');
  fs.writeFileSync(path.join(directory, 'electron/never.cjs'), 'module.exports = () => 1;');
  fs.writeFileSync(path.join(directory, 'public/companion-sw.js'), 'self.addEventListener("install", () => self.skipWaiting());');
  fs.writeFileSync(path.join(directory, 'scripts/pair-companion.cjs'), 'console.log("fixture only");');
  const expected = source.manifest(directory);
  assert.deepEqual(Object.keys(expected).sort(), ['electron/never.cjs', 'public/companion-sw.js', 'scripts/pair-companion.cjs', file].sort());
  assert.equal(Object.keys(expected[file].fnMap).length, 3, 'Uncreated nested callbacks must have counters');
  const sameLine = Object.values(expected[file].statementMap).filter((entry) => entry.start.line === 2);
  assert.ok(sameLine.length >= 5, 'Multiple statements on a source line must remain separate statements');
  const instrumented = source.instrument(file, text, directory);
  assert.deepEqual(source.instrument(file, text.replaceAll('\n', '\r\n'), directory).coverage, instrumented.coverage);
  const raw = path.join(directory, 'raw');
  for (const [index, compiler] of [
    (code) => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    (code) => require('esbuild').transformSync(code, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
  ].entries()) {
    const context = vm.createContext({ exports: {}, module: { exports: {} } });
    if (index === 0) context.module.exports = context.exports;
    vm.runInContext(compiler(instrumented.code), context);
    const api = index === 0 ? context.exports : context.module.exports;
    assert.equal(api.outer(false), null);
    const functions = context.__agentc2SourceCoverage[file];
    const never = Object.entries(functions.fnMap).find(([, value]) => value.name === 'never')[0];
    assert.equal(functions.f[never], 0);
    source.snapshot(context.__agentc2SourceCoverage, context.__agentc2SourceHashes, 'compiler-' + index, raw);
    // The identical cumulative snapshot cannot double execution counts.
    source.snapshot(context.__agentc2SourceCoverage, context.__agentc2SourceHashes, 'compiler-' + index, raw);
    assert.equal(api.never.call(undefined), undefined, 'Strict directive prologues must retain their semantics');
  }
  const report = source.report(raw, directory);
  const value = report.fileCoverageFor(file).toJSON();
  const outer = Object.entries(value.fnMap).find(([, fn]) => fn.name === 'outer')[0];
  assert.equal(value.f[outer], 2, 'Independent contexts add; cumulative snapshots use the maximum');
  assert.equal(Object.values(value.f).filter((count) => count === 0).length, 2, 'An uncalled function and an uncreated callback stay uncovered');
  assert.equal(report.fileCoverageFor('electron/never.cjs').data.all, true);
  assert.throws(() => source.requireObserved(report), /never loaded/);
  const emptyModule = source.instrument('electron/empty.cjs', '"use strict";', directory).coverage;
  assert.throws(() => source.requireObserved(require('istanbul-lib-coverage').createCoverageMap({ 'electron/empty.cjs': { ...emptyModule, all: true } })), /never loaded/);
  const runtime = structuredClone(value);
  delete runtime.all;
  for (const mutate of [
    (data) => { data.sourceHash = 'wrong'; },
    (data) => { delete data.fnMap[outer]; delete data.f[outer]; },
    (data) => { data.f[outer] = -1; },
    (data) => { data.f[outer] = 0.5; },
    (data) => { data.statementMap[0].end.column++; },
    (data) => { data.b[0].push(1); },
    (data) => { data.all = true; },
    (data) => { data.path = 'electron/other.cjs'; },
  ]) { const damaged = structuredClone(runtime); mutate(damaged); assert.throws(() => source.validate(damaged, expected[file], file)); }
  assert.throws(() => source.merge([{ 'electron/unexpected.cjs': runtime }], expected), /Unexpected/);
  assert.throws(() => source.snapshot({ [file]: runtime }, {}, 'missing-hash', raw), /hash is missing/);
  const writeFile = fs.writeFileSync;
  let interrupted = false;
  fs.writeFileSync = (filename, data, options) => {
    if (path.dirname(filename) !== raw) return writeFile(filename, data, options);
    // Simulate a concurrent reporter after the producer has written half its
    // JSON. A partially written snapshot must not be visible as report input.
    writeFile(filename, data.slice(0, Math.floor(data.length / 2)), options);
    interrupted = true;
    assert.doesNotThrow(() => source.report(raw, directory));
    writeFile(filename, data);
  };
  try { source.snapshot({ [file]: runtime }, { [file]: runtime.sourceHash }, 'atomic', raw); }
  finally { fs.writeFileSync = writeFile; }
  assert.equal(interrupted, true);
  assert.equal(fs.readdirSync(raw).some((name) => name.endsWith('.tmp')), false);
  const invalid = path.join(directory, 'invalid'); fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'old.json'), JSON.stringify({ format: 'v8', instrumenter: source.version, context: 'old', files: {} }));
  assert.throws(() => source.report(invalid, directory), /Invalid source coverage report/);
  for (const comment of ['/* istanbul ignore next */', '// c8 ignore start\n', '// node:coverage disable\n']) assert.throws(() => source.instrument(file, comment + 'function ignored() {}', directory), /exclusions are forbidden/);
  assert.doesNotThrow(() => source.instrument(file, 'const message = "istanbul ignore next";', directory), 'Strings containing instructions are ordinary source, not exclusion directives');
  const bootstrap = spawnSync(process.execPath, ['--require', path.resolve(__dirname, '../scripts/source-coverage-hook.cjs'), '-e', `
    const assert=require('node:assert/strict');
    const artifacts=require('./scripts/coverage-artifacts.cjs');
    const hook=require('./scripts/source-coverage-hook.cjs');
    assert.equal(typeof artifacts.expectedFiles,'function');
    assert.equal(hook.canonicalSource(require.resolve('./scripts/coverage-artifacts.cjs')),null);
    require('./electron/centcom-dispatch.cjs');
    const filename=require.resolve('./electron/centcom-dispatch.cjs');
    assert.throws(()=>hook.prepare(filename,require('node:fs').readFileSync(filename,'utf8')+'\\nmodified();'),/modified executable source/);
  `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AGENTC2_COVERAGE: '1', AGENTC2_SOURCE_COVERAGE: '1', AGENTC2_SOURCE_COVERAGE_DIR: path.join(directory, 'bootstrap'), NODE_V8_COVERAGE: path.join(directory, 'v8-bootstrap') }, encoding: 'utf8' });
  assert.equal(bootstrap.status, 0, bootstrap.stdout + bootstrap.stderr);
  assert.ok(fs.readdirSync(path.join(directory, 'bootstrap')).some((name) => name.endsWith('.json')));
  // Audit every original AST, not V8's list of instantiated functions. This is
  // deliberately independent of Babel's instrumentation traversal.
  const root = path.resolve(__dirname, '..');
  for (const name of catalog.javascriptFiles(root)) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    let functions = 0;
    const visit = (node) => { if (ts.isFunctionLike(node) && node.body) functions++; ts.forEachChild(node, visit); }; visit(tree);
    assert.equal(Object.keys(source.instrument(name, text, root).coverage.fnMap).length, functions, `Every original source function must be counted: ${name}`);
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS original-source statements and every function, uncreated callbacks, cross-compiler counters, strict semantics, immutable maps, context deduplication, and missing runtime rejection');
