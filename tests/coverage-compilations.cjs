const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { normalize } = require('../scripts/normalize-v8.cjs');

// macOS exposes /var as an alias of /private/var; Node's CJS loader reports
// canonical source paths. Use that same identity for the disposable source.
const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-coverage-compilations-')));
try {
  fs.mkdirSync(path.join(directory, 'src'));
  const file = path.join(directory, 'src/fixture.ts');
  fs.writeFileSync(file, 'export const yes = (value = 1) => value;\nexport const never = (value = 2) => value;\n');
  const raw = path.join(directory, 'raw');
  const compiled = path.join(directory, 'src/compiled.cjs');
  const code = `
    const fs = require('node:fs');
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    const filename = process.argv[1];
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: Number(process.argv[2]), inlineSourceMap: true, inlineSources: true }
    }).outputText;
    fs.writeFileSync(process.argv[3], source);
    const loaded = require(process.argv[3]);
    if (loaded.yes() !== 1) throw Error('Fixture was not executed');
  `;
  for (const target of [require('typescript').ScriptTarget.ES5, require('typescript').ScriptTarget.ES2022]) {
    const result = spawnSync(process.execPath, ['--enable-source-maps', '-e', code, file, String(target), compiled], { env: { ...process.env, NODE_V8_COVERAGE: raw }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const generated = path.join(directory, 'normalized');
  normalize(raw, generated, directory);
  const urls = new Set();
  for (const name of fs.readdirSync(generated)) {
    const data = JSON.parse(fs.readFileSync(path.join(generated, name), 'utf8'));
    for (const entry of data.result) {
      if (!entry.url.includes('coverage-generated')) continue;
      urls.add(entry.url);
      assert.notEqual(entry.url, pathToFileURL(file).href);
      assert.deepEqual(data['source-map-cache'][entry.url].data.sources, [file]);
    }
  }
  assert.equal(urls.size, 2, 'Different compiled layouts of one TypeScript file cannot share V8 offsets or overwrite their source maps');
  const output = path.join(directory, 'reports');
  const reported = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/coverage-javascript.cjs'), 'report', '--all', '--src', 'src', '--extension', '.ts', '--extension', '.js', '--include', 'src/**/*.ts', '--include', 'dist/**/*.js', '--exclude-after-remap', '--temp-directory', generated, '--reports-dir', output, '--reporter', 'json', '--reporter', 'json-summary'], { cwd: directory, encoding: 'utf8' });
  assert.equal(reported.status, 0, reported.stdout + reported.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'coverage-final.json'), 'utf8'));
  assert.deepEqual(Object.keys(report), [file], 'Generated compiler layouts must remap to original source');
  const value = report[file];
  const never = Object.entries(value.fnMap).filter(([, fn]) => fn.loc.start.line === 2);
  assert.ok(never.length > 0, 'The uncalled source callback must remain in the denominator');
  assert.ok(never.every(([id]) => value.f[id] === 0), 'Neither compiler layout may make an uncalled callback appear executed');
  assert.ok(Object.entries(value.fnMap).some(([id, fn]) => fn.loc.start.line === 1 && value.f[id] > 0));
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'coverage-summary.json'), 'utf8'));
  assert.ok(summary.total.functions.pct < 100);
  const damaged = path.join(directory, 'damaged'); fs.mkdirSync(damaged);
  const sample = JSON.parse(fs.readFileSync(path.join(raw, fs.readdirSync(raw)[0]), 'utf8'));
  fs.writeFileSync(path.join(damaged, 'missing-map.json'), JSON.stringify({ result: sample.result.filter((entry) => entry.url === pathToFileURL(compiled).href).map((entry) => ({ ...entry, url: pathToFileURL(file).href })) }));
  const missingMap = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/coverage-javascript.cjs'), 'report', '--src', 'src', '--extension', '.ts', '--include', 'src/**/*.ts', '--exclude-after-remap', '--temp-directory', damaged, '--reports-dir', output], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(missingMap.status, 0, 'Missing production TypeScript maps cannot become an apparently complete report');
  assert.match(missingMap.stderr, /Compiled TypeScript source map is missing/);
} catch (error) {
  // Keep real failing native reports: source-map cache aliases cannot be
  // diagnosed from a percentage or a synthetic map alone.
  if (process.env.AGENTC2_SUITE_ARTIFACTS) fs.cpSync(directory, path.join(process.env.AGENTC2_SUITE_ARTIFACTS, 'compiler-fixture'), { recursive: true });
  throw error;
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('PASS independent compiled source maps and exact source counters retain uncalled callbacks across real V8 subprocess reports');
