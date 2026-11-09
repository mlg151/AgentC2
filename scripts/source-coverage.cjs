const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '..');
const format = 'istanbul-source-v1';
const version = '6.0.3';
let dependencies;

function compiler() {
  if (dependencies) return dependencies;
  const location = require.resolve('istanbul-lib-instrument');
  const library = require(location);
  if (require('istanbul-lib-instrument/package.json').version !== version) throw Error(`Source coverage requires istanbul-lib-instrument ${version}`);
  const babel = require(require.resolve('@babel/core', { paths: [path.dirname(location)] }));
  dependencies = { library, babel };
  return dependencies;
}

function relative(file, base = root) {
  return require('./coverage-artifacts.cjs').canonical(file, base);
}

function instrument(file, source, base = root) {
  const name = relative(file, base);
  if (!/\.(cjs|mjs|js|tsx?)$/.test(name)) throw Error(`Unsupported source coverage file: ${name}`);
  const normalized = source.replaceAll('\r\n', '\n');
  const sourceHash = createHash('sha256').update(normalized).digest('hex');
  const { library, babel } = compiler();
  let coverage;
  const result = babel.transformSync(normalized, {
    filename: path.resolve(base, name), babelrc: false, configFile: false, sourceMaps: true, ast: false,
    parserOpts: { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: name.endsWith('.tsx') ? ['typescript', 'jsx'] : name.endsWith('.ts') ? ['typescript'] : [] },
    generatorOpts: { compact: false, comments: false },
    plugins: [({ types }) => {
      const visitor = library.programVisitor(types, name, { coverageVariable: '__agentc2SourceCoverage', coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false, ignoreClassMethods: [] });
      return { visitor: { Program: {
        enter(program) {
          if ((program.parent.comments || []).some((comment) => /\b(?:istanbul|c8)\s+ignore\b|node:coverage\s+(?:disable|ignore)/.test(comment.value))) throw Error(`Production coverage exclusions are forbidden: ${name}`);
          visitor.enter(program);
        },
        exit(program) {
          const output = visitor.exit(program);
          if (!output?.fileCoverage) throw Error(`Source instrumentation was omitted: ${name}`);
          coverage = output.fileCoverage;
          const hashes = types.memberExpression(types.identifier('globalThis'), types.identifier('__agentc2SourceHashes'));
          // Insert after source instrumentation, preserving Babel's directive
          // prologue and keeping collector bookkeeping out of the denominator.
          program.unshiftContainer('body', [
            types.expressionStatement(types.assignmentExpression('=', types.cloneNode(hashes), types.logicalExpression('||', types.cloneNode(hashes), types.objectExpression([])))),
            types.expressionStatement(types.assignmentExpression('=', types.memberExpression(types.cloneNode(hashes), types.stringLiteral(name), true), types.stringLiteral(sourceHash))),
          ]);
        },
      } } };
    }],
  });
  if (!coverage) throw Error(`Source counters are missing: ${name}`);
  result.map.sources = [path.resolve(base, name)];
  result.map.sourceRoot = '';
  return { code: result.code, map: result.map, coverage: { ...JSON.parse(JSON.stringify(coverage)), path: name, sourceHash }, sourceHash, name };
}

function manifest(base = root) {
  const output = {};
  for (const file of require('./coverage-artifacts.cjs').expectedFiles(base)) {
    const value = instrument(file, fs.readFileSync(path.join(base, file), 'utf8'), base);
    output[file] = { ...value.coverage, all: true };
  }
  return output;
}

function shape(data) {
  return { path: data.path, statementMap: data.statementMap, fnMap: data.fnMap, branchMap: data.branchMap };
}

function validate(data, expected, file, allowPlaceholder = false) {
  if (!expected || data.path !== file || data.sourceHash !== expected.sourceHash || !isDeepStrictEqual(shape(data), shape(expected))) throw Error(`Source counters do not match the production source: ${file}`);
  require('./coverage-artifacts.cjs').counters(data, file);
  if (!allowPlaceholder && data.all === true) throw Error(`Runtime source evidence cannot be a placeholder: ${file}`);
}

function snapshot(coverage, hashes, context, directory) {
  const files = {};
  for (const [file, data] of Object.entries(coverage || {})) {
    if (!require('./production-sources.cjs').isSource(file)) throw Error(`Unexpected source counter path: ${file}`);
    if (!hashes?.[file]) throw Error(`Source counter hash is missing: ${file}`);
    files[file] = { ...data, path: file, sourceHash: hashes[file] };
  }
  if (!Object.keys(files).length) return;
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `source-${process.pid}-${randomUUID()}.json`);
  const staging = output + '.tmp';
  try {
    fs.writeFileSync(staging, JSON.stringify({ format, instrumenter: version, context, files }) + '\n', { flag: 'wx' });
    fs.renameSync(staging, output);
  } finally { fs.rmSync(staging, { force: true }); }
  return output;
}

function report(directory, base = root) {
  const expected = manifest(base);
  const contexts = new Map();
  let reports = 0;
  if (!fs.existsSync(directory)) throw Error('Source coverage data is missing; collect suites first');
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (data.format !== format || data.instrumenter !== version || typeof data.context !== 'string' || !data.context || !data.files || Array.isArray(data.files)) throw Error(`Invalid source coverage report: ${name}`);
    if (!contexts.has(data.context)) contexts.set(data.context, {});
    const target = contexts.get(data.context);
    for (const [file, value] of Object.entries(data.files)) {
      validate(value, expected[file], file);
      if (!target[file]) target[file] = structuredClone(value);
      else for (const key of ['s', 'f', 'b']) for (const [id, count] of Object.entries(value[key])) {
        // A context can be saved before navigation and again on page close.
        // Its cumulative counters count once; independent contexts add later.
        target[file][key][id] = Array.isArray(count) ? count.map((hit, index) => Math.max(hit, target[file][key][id][index])) : Math.max(count, target[file][key][id]);
      }
    }
    reports++;
  }
  if (!reports) throw Error('Source process/browser coverage is missing; collect suites first');
  return merge([expected, ...contexts.values()], expected);
}

function merge(reports, expected) {
  const output = require('istanbul-lib-coverage').createCoverageMap({});
  for (const [file, seed] of Object.entries(expected)) {
    const target = structuredClone(seed);
    target.all = true;
    for (const report of reports) {
      const value = report[file];
      if (!value) continue;
      validate(value, seed, file, true);
      if (value.all === true) continue;
      target.all = false;
      const add = (left, right) => { const sum = left + right; if (!Number.isSafeInteger(sum)) throw Error('Source coverage execution count overflow'); return sum; };
      for (const key of ['s', 'f', 'b']) for (const [id, count] of Object.entries(value[key])) target[key][id] = Array.isArray(count) ? count.map((hit, index) => add(hit, target[key][id][index])) : add(count, target[key][id]);
    }
    output.addFileCoverage(target);
  }
  for (const report of reports) for (const file of Object.keys(report)) if (!expected[file]) throw Error(`Unexpected source coverage file: ${file}`);
  return output;
}

function requireObserved(coverage) {
  for (const file of coverage.files()) if (coverage.fileCoverageFor(file).data.all === true) throw Error(`Executable production source was never loaded: ${file}`);
}

module.exports = { format, version, instrument, manifest, shape, validate, snapshot, report, merge, requireObserved };
