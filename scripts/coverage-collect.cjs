const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawnSync, execFileSync } = require('node:child_process');

function mergeReports(reports) {
  const { createCoverageMap } = require('istanbul-lib-coverage');
  const map = createCoverageMap({});
  for (const report of reports) map.merge(report);
  return map.toJSON();
}

async function convertBrowser(entries, cwd) {
  const convert = require('v8-to-istanbul');
  const reports = [];
  for (const entry of entries) {
    const url = new URL(entry.url);
    let file = url.protocol === 'file:' ? fileURLToPath(url) : path.join(cwd, decodeURIComponent(url.pathname));
    if (url.protocol !== 'file:' && !fs.existsSync(file) && fs.existsSync(path.join(cwd, 'dist', decodeURIComponent(url.pathname)))) file = path.join(cwd, 'dist', decodeURIComponent(url.pathname));
    if (!file.startsWith(`${cwd}${path.sep}`) || file.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    if (!entry.source) throw new Error(`Missing browser source mapping: ${entry.url}`);
    const converter = convert(file, 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    reports.push(converter.toIstanbul());
  }
  return mergeReports(reports);
}

function jacocoRecords(xml, cwd, sourceFiles = []) {
  const records = {};
  for (const pkg of xml.matchAll(/<package name="([^"]*)">([\s\S]*?)<\/package>/g)) {
    for (const source of pkg[2].matchAll(/<sourcefile name="([^"]*)">([\s\S]*?)<\/sourcefile>/g)) {
      const suffix = `${pkg[1]}/${source[1]}`;
      const candidates = sourceFiles.filter((file) => file.endsWith(suffix));
      if (candidates.length !== 1) throw new Error(`Missing or ambiguous Kotlin source mapping: ${suffix}`);
      const file = path.resolve(cwd, candidates[0]);
      const record = { path: file, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} };
      for (const line of source[2].matchAll(/<line\s+([^>]+)\/>/g)) {
        const attributes = Object.fromEntries([...line[1].matchAll(/(\w+)="(\d+)"/g)].map((value) => [value[1], Number(value[2])]));
        const { nr, ci, mi, cb, mb } = attributes;
        const location = { start: { line: nr, column: 0 }, end: { line: nr, column: 0 } };
        if (ci + mi > 0) { record.statementMap[nr] = location; record.s[nr] = Number(ci > 0); }
        if (cb + mb > 0) {
          record.branchMap[nr] = { line: nr, type: 'branch', locations: Array.from({ length: cb + mb }, () => location) };
          record.b[nr] = [...Array(cb).fill(1), ...Array(mb).fill(0)];
        }
      }
      records[file] = record;
    }
  }
  return records;
}

async function collect({ cwd, nodeDir, browserDir, jacoco, output }) {
  const { Report } = require('c8');
  const report = new Report({ tempDirectory: nodeDir, reportsDirectory: path.dirname(output), reporter: ['json'], all: false, resolve: cwd, exclude: ['node_modules/**', 'tests/**'], excludeAfterRemap: true });
  await report.run();
  const reports = [JSON.parse(fs.readFileSync(path.join(path.dirname(output), 'coverage-final.json'), 'utf8'))];
  if (fs.existsSync(browserDir)) {
    for (const file of fs.readdirSync(browserDir).filter((name) => name.endsWith('.json'))) reports.push(await convertBrowser(JSON.parse(fs.readFileSync(path.join(browserDir, file), 'utf8')), cwd));
  }
  if (jacoco) {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' }).trim().split('\n');
    reports.push(jacocoRecords(fs.readFileSync(jacoco, 'utf8'), cwd, files));
  }
  fs.writeFileSync(output, JSON.stringify(mergeReports(reports)));
}

async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const directory = path.resolve(cwd, 'coverage');
  const nodeDir = path.resolve(cwd, option('--node-dir', 'coverage/node'));
  fs.mkdirSync(nodeDir, { recursive: true });
  const browserDir = path.resolve(cwd, option('--browser-dir', process.env.AGENTC2_COVERAGE_BROWSER_DIR || 'coverage/browser'));
  const separator = args.indexOf('--');
  if (separator !== -1) {
    fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.rmSync(browserDir, { recursive: true, force: true });
    const result = spawnSync(args[separator + 1], args.slice(separator + 2), { cwd, env: { ...process.env, NODE_V8_COVERAGE: nodeDir }, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Coverage test command failed: ${result.status}`);
  }
  await collect({ cwd, nodeDir, browserDir, jacoco: option('--jacoco', process.env.AGENTC2_JACOCO_REPORT), output: path.join(directory, 'coverage-final.json') });
}

module.exports = { mergeReports, convertBrowser, jacocoRecords, collect, main };
if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
