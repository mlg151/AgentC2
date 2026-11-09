const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function productionFile(file) {
  return /\.(?:[cm]?js|tsx?|kt)$/.test(file) && !/(?:^|\/)(?:tests?|androidTest|node_modules|dist|release|build|\.gradle)\//.test(file) && !/\.d\.ts$/.test(file);
}

function executableSource(file, source) {
  if (!/\.tsx?$/.test(file)) return true;
  const ts = require('typescript');
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, removeComments: true } }).outputText;
  return output.replace(/export\s*\{\s*\}\s*;?/g, '').replace(/;/g, '').trim().length > 0;
}

function baseline({ explicit, release, run }) {
  if (explicit) return explicit;
  return run(release ? ['describe', '--tags', '--abbrev=0', 'HEAD^'] : ['merge-base', 'HEAD', process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main']).trim();
}

function parseDiff(diff) {
  const lines = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let i = 0; i < count; i += 1) lines.add(Number(match[1]) + i);
  }
  return lines;
}

function evaluate(file, record, changed, sourceLines = Infinity) {
  if (!record) return [`Missing coverage: ${file}`];
  if (!record.statementMap || !record.s || !record.branchMap || !record.b || Object.keys(record.s).some((key) => !record.statementMap[key])) return [`Invalid source mapping: ${file}`];
  const invalid = (location) => location.start.line < 1 || location.end.line > sourceLines || location.end.line < location.start.line;
  if (Object.keys(record.statementMap).length === 0 || Object.entries(record.statementMap).some(([key, location]) => !(key in record.s) || invalid(location))) return [`Invalid source mapping: ${file}`];
  const errors = [];
  const relevant = (start, end) => changed === null || [...changed].some((line) => line >= start && line <= end);
  for (const [key, location] of Object.entries(record.statementMap)) {
    if (relevant(location.start.line, location.end.line) && !(record.s[key] > 0)) errors.push(`${file}: uncovered line ${location.start.line}`);
  }
  for (const [key, branch] of Object.entries(record.branchMap)) {
    const locations = branch.locations;
    if (!locations || !record.b[key] || locations.length !== record.b[key].length || locations.some(invalid)) {
      errors.push(`Invalid branch source mapping: ${file}:${key}`);
      continue;
    }
    if (locations.some((location) => relevant(location.start.line, location.end.line))) {
      record.b[key].forEach((count, index) => {
        if (!(count > 0)) errors.push(`${file}: uncovered branch ${key}:${index}`);
      });
    }
  }
  return errors;
}

function check({ cwd, base, report }) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const files = new Set([...git(['diff', '--name-only', '--diff-filter=ACMR', base]).trim().split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).trim().split('\n')].filter(productionFile));
  const coverage = JSON.parse(fs.readFileSync(report, 'utf8'));
  const normalized = Object.fromEntries(Object.entries(coverage).map(([file, value]) => [path.relative(cwd, path.resolve(file)).split(path.sep).join('/'), value]));
  const errors = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(cwd, file), 'utf8');
    if (!executableSource(file, source)) continue;
    let existsAtBase = true;
    try { git(['cat-file', '-e', `${base}:${file}`]); } catch { existsAtBase = false; }
    const changed = existsAtBase ? parseDiff(git(['diff', '--unified=0', base, '--', file])) : null;
    errors.push(...evaluate(file, normalized[file], changed, source.split('\n').length));
  }
  return { files: [...files], errors };
}

function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const git = (command) => execFileSync('git', command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const base = baseline({ explicit: option('--base') || process.env.AGENTC2_COVERAGE_BASE, release: args.includes('--release'), run: git });
  const result = check({ cwd, base, report: path.resolve(cwd, option('--report') || 'coverage/coverage-final.json') });
  if (result.errors.length) throw new Error(`100% changed-code coverage required:\n${result.errors.join('\n')}`);
  console.log(`100% line and branch coverage verified for ${result.files.length} changed production files against ${base}`);
}

module.exports = { executableSource, productionFile, baseline, parseDiff, evaluate, check, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
