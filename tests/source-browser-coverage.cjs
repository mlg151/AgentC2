const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = require('../scripts/source-coverage.cjs');
const { instrumentSourceCoverage } = require('./helpers/source-browser-coverage.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-source-browser-unit-'));
  const previous = process.env.AGENTC2_SOURCE_COVERAGE_DIR;
  process.env.AGENTC2_SOURCE_COVERAGE_DIR = directory;
  try {
    const listeners = new Map();
    const realm = vm.createContext({ exports: {}, addEventListener: (name, listener) => listeners.set(name, listener) });
    const file = 'src/chatTimeline.ts';
    const instrumented = source.instrument(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    vm.runInContext(ts.transpileModule(instrumented.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, realm);
    const page = {
      isClosed: () => false,
      evaluate: async (callback) => vm.runInContext(`(${callback.toString()})()`, realm),
      goto: async () => {}, reload: async () => {}, close: async () => {},
    };
    let closed = false;
    const context = {
      exposeBinding: async (name, callback) => { realm[name] = (data) => Promise.resolve(callback({}, data)); },
      addInitScript: async () => {}, on: () => {}, pages: () => [page], serviceWorkers: () => [],
      close: async () => { closed = true; },
    };
    const save = await instrumentSourceCoverage(context);
    assert.equal(await instrumentSourceCoverage(context), save, 'Instrumentation must remain idempotent');
    realm.exports.reduceChatTimeline(realm.exports.emptyChatTimeline, { events: [], cursor: 0, retainedFrom: 1, pendingRequests: [] });
    // Electron teardown can remove Playwright bindings while the page and its
    // instrumented source counters remain alive. No counters may be lost.
    delete realm.__agentc2SourceCoverageSink;
    await save();
    assert.doesNotThrow(() => listeners.get('pagehide')());
    await page.reload();
    const reports = fs.readdirSync(directory).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name))));
    assert.equal(reports.length, 2, 'Explicit save and navigation retain counters without the binding');
    assert.equal(reports[0].context, reports[1].context, 'Snapshots retain the same document epoch');
    const counters = reports[0].files[file];
    const reducer = Object.entries(counters.fnMap).find(([, value]) => value.name === 'reduceChatTimeline')[0];
    assert.equal(counters.f[reducer], 1, 'Record actual executed source counters');
    realm.__agentc2SourceHashes = {};
    await assert.rejects(context.close(), /hash is missing/, 'Collector validation failures must still fail the suite');
    assert.equal(closed, true, 'Coverage errors must not prevent browser shutdown and hang CI');
    console.log('PASS browser source snapshots survive binding teardown, preserve epoch/counts, and close the context while propagating validation failures');
  } finally {
    if (previous === undefined) delete process.env.AGENTC2_SOURCE_COVERAGE_DIR; else process.env.AGENTC2_SOURCE_COVERAGE_DIR = previous;
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.join(os.tmpdir(), 'agentc2-source-browser-unit-')));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
