// Test-only source counters. Ordinary application launches never load this hook.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = require('./source-coverage.cjs');
const production = require('./production-sources.cjs');
const root = path.resolve(__dirname, '..');
const context = `node-${process.pid}-${randomUUID()}`;
const cache = new Map();
let expected;

function coverageEnabled() { return process.env.AGENTC2_COVERAGE === '1' && process.env.AGENTC2_SOURCE_COVERAGE === '1'; }
function coverageState() {
  globalThis.__agentc2SourceCoverage ||= {};
  globalThis.__agentc2SourceHashes ||= {};
  return { __agentc2SourceCoverage: globalThis.__agentc2SourceCoverage, __agentc2SourceHashes: globalThis.__agentc2SourceHashes };
}
function canonicalSource(filename) {
  if (typeof filename !== 'string') return null;
  const resolved = path.resolve(filename);
  let relative;
  if (resolved.startsWith(root + path.sep)) relative = path.relative(root, resolved).replaceAll('\\', '/');
  else {
    const packaged = resolved.replaceAll('\\', '/').split('/app.asar/electron/');
    if (packaged.length !== 2) return null;
    relative = 'electron/' + packaged[1];
  }
  if (!production.isSource(relative) || !/\.(cjs|mjs|js|tsx?)$/.test(relative)) return null;
  expected ||= new Set(production.javascriptFiles(root));
  return expected.has(relative) ? relative : null;
}
function prepare(filename, code) {
  if (!coverageEnabled()) return code;
  const relative = canonicalSource(filename);
  if (!relative) return code;
  const original = fs.readFileSync(path.join(root, relative), 'utf8');
  if (original.replaceAll('\r\n', '\n') !== code.replaceAll('\r\n', '\n')) throw Error(`Cannot attribute modified executable source: ${relative}`);
  if (!cache.has(relative)) cache.set(relative, source.instrument(relative, original));
  const value = cache.get(relative);
  return value.code + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(value.map)).toString('base64') + '\n';
}
function flush() {
  const directory = process.env.AGENTC2_SOURCE_COVERAGE_DIR || path.join(root, 'test-results/coverage/source');
  return source.snapshot(globalThis.__agentc2SourceCoverage, globalThis.__agentc2SourceHashes, context, directory);
}

if (coverageEnabled()) {
  coverageState();
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = (module, filename) => {
    if (!canonicalSource(filename)) return original(module, filename);
    module._compile(prepare(filename, fs.readFileSync(filename, 'utf8')), filename);
  };
  const compile = vm.compileFunction;
  vm.compileFunction = (code, parameters, options) => {
    if (options?.filename?.endsWith('.cjs') && canonicalSource(options.filename)) {
      code = prepare(options.filename, code);
      // Fixture VMs keep their existing sandbox and dependency boundary. Only
      // counter objects are shared, so their execution is retained on exit.
      if (options.parsingContext) Object.assign(options.parsingContext, coverageState());
    }
    return compile(code, parameters, options);
  };
  process.on('exit', () => {
    try { flush(); }
    catch (error) { console.error('Source coverage collection failed:', error); process.exitCode = 1; }
  });
}
module.exports = { prepare, coverageState, flush, canonicalSource };
