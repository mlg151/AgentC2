const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  pythonBootstrap = path.join(directory, 'python-bootstrap');
  // Private SDK venvs deliberately have no system site packages. Copy only the
  // test collector so coverage follows children without exposing host SDKs.
  fs.cpSync(source, path.join(pythonBootstrap, 'coverage'), { recursive: true, filter: (file) => !file.split(path.sep).includes('__pycache__') });
  return pythonBootstrap;
}

function coverageEnvironment(environment = process.env) {
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

function declarationFiles() {
  const ts = require('typescript');
  const excluded = [];
  for (const relative of fs.readdirSync(path.join(root, 'src'), { recursive: true })) {
    if (!/\.tsx?$/.test(relative)) continue;
    const file = path.join('src', relative).replaceAll('\\', '/');
    if (file.endsWith('.d.ts')) { excluded.push(file); continue; }
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // Exclude only files whose AST consists entirely of erased declarations.
    // An added runtime export immediately puts the file into the denominator.
    if (parsed.statements.every((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) || ts.isImportDeclaration(node) && node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && node.isTypeOnly)) excluded.push(file);
  }
  return excluded;
}

function c8Arguments() {
  return [
    require.resolve('c8/bin/c8.js'), 'report', '--all', '--src', 'electron', '--src', 'src',
    '--extension', '.cjs', '--extension', '.ts', '--extension', '.tsx', '--extension', '.js',
    '--include', 'electron/**/*.cjs', '--include', 'src/**/*.{ts,tsx}', '--include', 'dist/**/*.js',
    '--exclude-after-remap', '--exclude', '**/node_modules/**',
    ...declarationFiles().flatMap((file) => ['--exclude', file]),
    '--temp-directory', path.join(directory, 'v8'), '--reports-dir', path.join(directory, 'javascript'),
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

function pythonSummary(report) {
  if (report.meta?.branch_coverage !== true) throw Error('Python branch coverage was not enabled');
  return Object.fromEntries(Object.entries(report.files).map(([file, value]) => {
    if (!value.functions) throw Error(`Python function measurement is missing for ${file}`);
    const functions = Object.entries(value.functions).filter(([name]) => name);
    const measured = (total, covered) => ({ total, covered });
    return [file, {
      statements: measured(value.summary.num_statements, value.summary.covered_lines),
      lines: measured(value.summary.num_statements, value.summary.covered_lines),
      branches: measured(value.summary.num_branches, value.summary.covered_branches),
      functions: measured(functions.length, functions.filter(([, region]) => region.executed_lines.length > 0).length),
    }];
  }));
}

function report() {
  if (!fs.existsSync(path.join(directory, 'v8')) || !fs.readdirSync(path.join(directory, 'v8')).some((file) => file.endsWith('.json'))) throw Error('JavaScript coverage data is missing; collect suites first');
  if (!run(process.execPath, c8Arguments())) return false;
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const env = { ...process.env, PYTHONPATH: [path.join(root, 'tests/helpers/coverage-python'), preparePython(process.env), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  // --keep permits repeated reporting without discarding raw process evidence.
  if (!run(python, ['-m', 'coverage', 'combine', '--append', '--keep'], { env })) return false;
  const pythonFile = path.join(directory, 'python/coverage.json');
  if (!run(python, ['-m', 'coverage', 'json', '-o', pythonFile], { env })) return false;
  if (!run(python, ['-m', 'coverage', 'html'], { env })) return false;
  const javascript = JSON.parse(fs.readFileSync(path.join(directory, 'javascript/coverage-summary.json'), 'utf8'));
  const pythonData = pythonSummary(JSON.parse(fs.readFileSync(pythonFile, 'utf8')));
  const summary = { ...Object.fromEntries(Object.entries(javascript).filter(([file]) => file !== 'total').map(([file, value]) => [path.relative(root, file).replaceAll('\\', '/'), value])), ...pythonData };
  const declarations = new Set(declarationFiles());
  for (const base of ['electron', 'src']) {
    const expected = fs.readdirSync(path.join(root, base), { recursive: true }).map((file) => `${base}/${file.replaceAll('\\', '/')}`).filter((file) => /\.(cjs|py|tsx?)$/.test(file) && !declarations.has(file));
    for (const file of expected) if (!summary[file]) throw Error(`Production file missing from coverage: ${file}`);
  }
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

async function main() {
  if (process.argv[2] === 'report') { if (!report()) process.exitCode = 1; return; }
  if (process.argv[2] === 'reset') {
    for (const file of ['v8', 'python', 'javascript', 'summary.json']) fs.rmSync(path.join(directory, file), { recursive: true, force: true });
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
