const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'test-results/coverage');
const metrics = ['statements', 'branches', 'functions', 'lines'];
let pythonBootstrap;

function preparePython(environment) {
  if (pythonBootstrap) return pythonBootstrap;
  const python = environment.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(python, ['-c', 'import coverage,json,pathlib;print(json.dumps([coverage.__version__,str(pathlib.Path(coverage.__file__).parent)]))'], { encoding: 'utf8', env: environment });
  if (probe.status !== 0) throw Error('Install Python test dependencies with python3 -m pip install -r tests/requirements.txt');
  const [version, source] = JSON.parse(probe.stdout);
  if (version !== '7.16.0') throw Error(`Coverage.py 7.16.0 is required; found ${version}`);
  const base = path.join(directory, 'python-bootstrap');
  if (source.startsWith(base + path.sep)) { pythonBootstrap = path.dirname(source); return pythonBootstrap; }
  const identity = createHash('sha256').update(version + source).digest('hex').slice(0, 12);
  pythonBootstrap = path.join(base, identity);
  // Private SDK venvs deliberately have no system site packages. Copy only the
  // test collector so coverage follows children without exposing host SDKs.
  // Publish a completed copy atomically. Parallel suites must never truncate a
  // collector extension that another Python process has memory-mapped.
  if (!fs.existsSync(pythonBootstrap)) {
    fs.mkdirSync(base, { recursive: true });
    const staging = fs.mkdtempSync(path.join(base, 'staging-'));
    try {
      fs.cpSync(source, path.join(staging, 'coverage'), { recursive: true, filter: (file) => !file.split(path.sep).includes('__pycache__') });
      try { fs.renameSync(staging, pythonBootstrap); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !fs.existsSync(pythonBootstrap)) throw error; }
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return pythonBootstrap;
}

function coverageEnvironment(environment = process.env) {
  require('./coverage-artifacts.cjs').collection(root, directory);
  const python = path.join(directory, 'python');
  const javascript = path.join(directory, 'v8');
  for (const folder of [python, javascript]) fs.mkdirSync(folder, { recursive: true });
  return {
    ...environment,
    AGENTC2_COVERAGE: '1',
    NODE_V8_COVERAGE: javascript,
    NODE_OPTIONS: /(?:^|\s)--enable-source-maps(?:\s|$)/.test(environment.NODE_OPTIONS || '') ? environment.NODE_OPTIONS : `${environment.NODE_OPTIONS || ''} --enable-source-maps`.trim(),
    COVERAGE_PROCESS_START: path.join(root, '.coveragerc'),
    COVERAGE_FILE: path.join(python, '.coverage'),
    PYTHONPATH: [path.join(root, 'tests/helpers/coverage-python'), preparePython(environment), environment.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status === 0;
}

function declarationFiles(base = root) {
  const ts = require('typescript');
  const excluded = [];
  for (const relative of fs.readdirSync(path.join(base, 'src'), { recursive: true })) {
    if (!/\.tsx?$/.test(relative)) continue;
    const file = path.join('src', relative).replaceAll('\\', '/');
    if (file.endsWith('.d.ts')) { excluded.push(file); continue; }
    const source = fs.readFileSync(path.join(base, file), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // Exclude only files whose AST consists entirely of erased declarations.
    // An added runtime export immediately puts the file into the denominator.
    if (parsed.statements.every((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) || ts.isImportDeclaration(node) && node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && node.isTypeOnly)) excluded.push(file);
  }
  return excluded;
}

function c8Arguments() {
  return [
    path.join(root, 'scripts/coverage-javascript.cjs'), 'report', '--all', '--src', 'electron', '--src', 'src',
    '--extension', '.cjs', '--extension', '.ts', '--extension', '.tsx', '--extension', '.js',
    '--include', 'electron/**/*.cjs', '--include', 'src/**/*.{ts,tsx}', '--include', 'dist/**/*.js',
    '--exclude-after-remap', '--exclude', '**/node_modules/**',
    ...declarationFiles().flatMap((file) => ['--exclude', file]),
    '--temp-directory', path.join(directory, 'v8-normalized'), '--reports-dir', path.join(directory, 'javascript'),
    '--reporter', 'json-summary', '--reporter', 'json', '--reporter', 'html', '--reporter', 'text-summary',
  ];
}

function check(summary) {
  const gaps = [];
  for (const [file, values] of Object.entries(summary)) {
    for (const metric of metrics) {
      const value = values[metric];
      if (!value || !Number.isInteger(value.total) || !Number.isInteger(value.covered) || value.total < 0 || value.covered < 0 || value.covered > value.total) throw Error(`Invalid ${metric} measurement for ${file}`);
      if (value.covered !== value.total) gaps.push({ file, metric, covered: value.covered, total: value.total, missing: value.total - value.covered });
    }
  }
  if (!Object.keys(summary).some((file) => file !== 'total')) throw Error('Empty coverage cannot pass');
  return gaps;
}

function pythonSummary(report, lambdas = null) {
  if (report.meta?.branch_coverage !== true) throw Error('Python branch coverage was not enabled');
  return Object.fromEntries(Object.entries(report.files).map(([name, value]) => {
    const file = name.replaceAll('\\', '/');
    if (!value.functions) throw Error(`Python function measurement is missing for ${file}`);
    const functions = Object.entries(value.functions).filter(([name]) => name);
    if (lambdas && !Object.hasOwn(lambdas, file)) throw Error(`Python lambda measurement is missing for ${file}`);
    const callbacks = lambdas?.[file] || { total: 0, covered: 0 };
    const measured = (total, covered) => ({ total, covered });
    return [file, {
      statements: measured(value.summary.num_statements, value.summary.covered_lines),
      lines: measured(value.summary.num_statements, value.summary.covered_lines),
      branches: measured(value.summary.num_branches, value.summary.covered_branches),
      functions: measured(functions.length + callbacks.total, functions.filter(([, region]) => region.executed_lines.length > 0).length + callbacks.covered),
    }];
  }));
}

function javascriptReport() {
  if (!fs.existsSync(path.join(directory, 'v8')) || !fs.readdirSync(path.join(directory, 'v8')).some((file) => file.endsWith('.json'))) throw Error('JavaScript coverage data is missing; collect suites first');
  fs.rmSync(path.join(directory, 'v8-normalized'), { recursive: true, force: true });
  require('./normalize-v8.cjs').normalize(path.join(directory, 'v8'), path.join(directory, 'v8-normalized'));
  if (!run(process.execPath, c8Arguments())) throw Error('JavaScript coverage reporting failed');
}

function report() {
  require('./coverage-artifacts.cjs').verifyCollection(root, directory);
  javascriptReport();
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const reportData = path.join(directory, 'python-report/.coverage');
  fs.mkdirSync(path.dirname(reportData), { recursive: true });
  const env = { ...process.env, COVERAGE_PROCESS_START: '', COVERAGE_FILE: reportData, PYTHONPATH: [path.join(root, 'tests/helpers/coverage-python'), preparePython(process.env), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const normalized = path.join(directory, 'python-normalized');
  fs.rmSync(normalized, { recursive: true, force: true });
  fs.rmSync(reportData, { force: true });
  if (!run(python, ['scripts/normalize-coverage.py', path.join(directory, 'python'), normalized], { env })) return false;
  const reportConfig = path.join(directory, 'report.coveragerc');
  fs.writeFileSync(reportConfig, fs.readFileSync(path.join(root, '.coveragerc'), 'utf8').replace(/^plugins = agentc2_coverage\r?$/m, ''));
  // Rebuild from every retained raw process report. No execution is discarded
  // when reporting repeatedly, and incompatible tracer labels cannot mix.
  if (!run(python, ['-m', 'coverage', 'combine', '--rcfile', reportConfig, '--keep', normalized], { env })) return false;
  const pythonFile = path.join(directory, 'python/coverage.json');
  if (!run(python, ['-m', 'coverage', 'json', '--rcfile', reportConfig, '-o', pythonFile], { env })) return false;
  if (!run(python, ['-m', 'coverage', 'html', '--rcfile', reportConfig], { env })) return false;
  const lambdaFile = path.join(directory, 'python/lambdas.json');
  if (!run(python, ['scripts/normalize-coverage.py', '--functions', reportData, path.join(root, 'electron'), lambdaFile], { env })) return false;
  return summarize(pythonFile, lambdaFile);
}

function summarize(pythonFile, lambdaFile) {
  const javascript = JSON.parse(fs.readFileSync(path.join(directory, 'javascript/coverage-summary.json'), 'utf8'));
  const pythonData = pythonSummary(JSON.parse(fs.readFileSync(pythonFile, 'utf8')), JSON.parse(fs.readFileSync(lambdaFile, 'utf8')));
  const summary = { ...Object.fromEntries(Object.entries(javascript).filter(([file]) => file !== 'total').map(([file, value]) => [path.relative(root, file).replaceAll('\\', '/'), value])), ...pythonData };
  const declarations = new Set(declarationFiles());
  const ts = require('typescript');
  const expectedFiles = [];
  for (const base of ['electron', 'src']) {
    const expected = fs.readdirSync(path.join(root, base), { recursive: true }).map((file) => `${base}/${file.replaceAll('\\', '/')}`).filter((file) => /\.(cjs|py|tsx?)$/.test(file) && !declarations.has(file));
    expectedFiles.push(...expected);
    for (const file of expected) {
      if (!summary[file]) throw Error(`Production file missing from coverage: ${file}`);
      if (file.endsWith('.py') || summary[file].functions.total > 0) continue;
      let functions = false;
      const visit = (node) => { if (ts.isFunctionLike(node) && node.body) functions = true; ts.forEachChild(node, visit); };
      visit(ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true));
      if (functions) throw Error(`Function measurement was lost for ${file}; verify browser source maps before trusting this report`);
    }
  }
  if (!require('node:util').isDeepStrictEqual(Object.keys(summary).sort(), expectedFiles.sort())) throw Error('Coverage contains unexpected source files or generated bundles');
  const gaps = check(summary);
  const totals = Object.fromEntries(metrics.map((metric) => {
    const total = Object.values(summary).reduce((sum, values) => sum + values[metric].total, 0);
    const covered = Object.values(summary).reduce((sum, values) => sum + values[metric].covered, 0);
    return [metric, { covered, total, percent: total ? covered / total * 100 : 100 }];
  }));
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ target: 100, totals, files: summary, gaps }, null, 2) + '\n');
  for (const [metric, value] of Object.entries(totals)) console.log(`${metric}: ${value.percent.toFixed(2)}% (${value.covered}/${value.total})`);
  console.log(`${gaps.length} production file/metric gaps remain; target: 100% statements, branches, functions, and lines in every file.`);
  for (const gap of gaps.slice(0, 20)) console.log(`${gap.file}: ${gap.metric} ${gap.covered}/${gap.total} (${gap.missing} missing)`);
  return gaps.length === 0;
}

function pythonReportEnvironment(dataFile) {
  const reportConfig = path.join(directory, 'report.coveragerc');
  fs.writeFileSync(reportConfig, fs.readFileSync(path.join(root, '.coveragerc'), 'utf8').replace(/^plugins = agentc2_coverage\r?$/m, ''));
  return { reportConfig, env: { ...process.env, COVERAGE_PROCESS_START: '', COVERAGE_FILE: dataFile, PYTHONPATH: [path.join(root, 'tests/helpers/coverage-python'), preparePython(process.env), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } };
}

function exportShard(label) {
  const artifactTools = require('./coverage-artifacts.cjs');
  const metadata = artifactTools.verifyCollection(root, directory);
  if (metadata.dirty) throw Error('Export coverage from a clean checkout');
  const policy = artifactTools.SHARDS[label];
  if (!policy || process.platform !== policy.platform || process.arch !== policy.arch) throw Error('Coverage shard must match this native runner');
  const suites = Object.fromEntries(policy.groups.map((group) => [group, JSON.parse(fs.readFileSync(path.join(root, 'test-results', `${group}.json`), 'utf8'))]));
  artifactTools.suiteEvidence(label, suites, require('../tests/suites.json'));
  javascriptReport();
  const javascript = artifactTools.javascriptData(JSON.parse(fs.readFileSync(path.join(directory, 'javascript/coverage-final.json'), 'utf8')), root);
  const pythonFile = path.join(directory, 'portable-python.json');
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const env = { ...process.env, COVERAGE_PROCESS_START: '' };
  if (!run(python, ['scripts/coverage-data.py', 'export', path.join(directory, 'python'), root, pythonFile], { env })) throw Error('Python coverage export failed');
  const artifact = { version: 1, label, platform: process.platform, arch: process.arch, metadata, suites, javascript, python: JSON.parse(fs.readFileSync(pythonFile, 'utf8')) };
  artifactTools.validateArtifact(artifact, metadata, require('../tests/suites.json'), artifactTools.expectedFiles(root));
  const output = path.join(directory, 'artifact', `${label}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(artifact) + '\n');
  console.log(`Exported ${label}: ${output}. A single shard does not establish the complete coverage target.`);
}

function aggregate(input) {
  const artifactTools = require('./coverage-artifacts.cjs');
  const expected = artifactTools.metadata(root);
  const files = fs.readdirSync(input, { recursive: true }).filter((file) => file.endsWith('.json')).map((file) => path.resolve(input, file)).sort();
  const artifacts = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const coverage = artifactTools.mergeArtifacts(artifacts, expected, require('../tests/suites.json'), artifactTools.expectedFiles(root));
  fs.mkdirSync(directory, { recursive: true });
  artifactTools.writeJavascriptReports(coverage, root, path.join(directory, 'javascript'));
  const manifest = path.join(directory, 'artifact-inputs.json');
  fs.writeFileSync(manifest, JSON.stringify(files) + '\n');
  const dataFile = path.join(directory, 'python-report/.coverage');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const { reportConfig, env } = pythonReportEnvironment(dataFile);
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const pythonFile = path.join(directory, 'python/coverage.json'), lambdaFile = path.join(directory, 'python/lambdas.json');
  fs.mkdirSync(path.dirname(pythonFile), { recursive: true });
  for (const args of [
    ['scripts/coverage-data.py', 'merge', manifest, dataFile],
    ['-m', 'coverage', 'json', '--rcfile', reportConfig, '-o', pythonFile],
    ['-m', 'coverage', 'html', '--rcfile', reportConfig],
    ['scripts/normalize-coverage.py', '--functions', dataFile, path.join(root, 'electron'), lambdaFile],
  ]) if (!run(python, args, { env })) throw Error('Combined Python coverage reporting failed');
  fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify({ metadata: expected, shards: artifacts.map(({ label, platform, arch, suites }) => ({ label, platform, arch, suites })) }, null, 2) + '\n');
  return summarize(pythonFile, lambdaFile);
}

async function main() {
  if (process.argv[2] === 'report') { if (!report()) process.exitCode = 1; return; }
  if (process.argv[2] === 'export') { if (process.argv.length !== 4) throw Error('Usage: coverage.cjs export <shard>'); exportShard(process.argv[3]); return; }
  if (process.argv[2] === 'aggregate') { if (process.argv.length !== 4) throw Error('Usage: coverage.cjs aggregate <artifact-directory>'); if (!aggregate(process.argv[3])) process.exitCode = 1; return; }
  if (process.argv[2] === 'reset') {
    for (const file of ['v8', 'v8-normalized', 'python', 'python-normalized', 'python-report', 'javascript', 'summary.json', 'collection.json', 'artifact', 'portable-python.json', 'artifact-inputs.json', 'provenance.json']) fs.rmSync(path.join(directory, file), { recursive: true, force: true });
    return;
  }
  const env = coverageEnvironment();
  const python = env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (!run(python, ['-m', 'coverage', '--version'])) throw Error('Install Python test dependencies with python3 -m pip install -r tests/requirements.txt');
  const groups = process.argv.slice(2);
  let success = true;
  for (const group of groups.length ? groups : ['core']) if (!run(process.execPath, ['scripts/run-tests.cjs', group], { env })) success = false;
  if (!report() || !success) process.exitCode = 1;
}
module.exports = { check, pythonSummary, declarationFiles, coverageEnvironment };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
