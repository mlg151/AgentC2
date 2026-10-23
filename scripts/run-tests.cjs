const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const inventory = require('../tests/suites.json');

function validate(base = root, data = inventory) {
  const files = fs.readdirSync(path.join(base, 'tests'), { recursive: true })
    .map((file) => `tests/${file.replaceAll('\\', '/')}`)
    .filter((file) => /\.(cjs|mjs|js|py|ts)$/.test(file) && !/^tests\/(fixtures|helpers)\//.test(file));
  const groups = new Set(['core', 'desktop', 'packaged', 'updater', 'windows', 'linux-python', 'linux-web', 'linux-ui', 'linux-chat', 'cleanup']);
  const ids = new Set();
  const registered = new Set([...Object.keys(data.nested), ...Object.keys(data.optional)]);
  for (const suite of data.suites) {
    if (!suite.id || ids.has(suite.id) || !groups.has(suite.group) || !files.includes(suite.file)) throw Error(`Invalid suite: ${JSON.stringify(suite)}`);
    ids.add(suite.id); registered.add(suite.file);
  }
  for (const [file, parents] of Object.entries(data.nested)) {
    if (!parents.length || parents.some((id) => !ids.has(id))) throw Error(`Invalid nested suite: ${file}`);
  }
  for (const [file, reason] of Object.entries(data.optional)) if (!reason) throw Error(`Missing optional reason: ${file}`);
  for (const file of files) if (!registered.has(file)) throw Error(`Unregistered test entrypoint: ${file}`);
  for (const file of registered) if (!files.includes(file)) throw Error(`Missing test entrypoint: ${file}`);
}

async function run(group) {
  validate();
  const suites = inventory.suites.filter((suite) => suite.group === group);
  if (!suites.length) throw Error(`Unknown or empty suite group: ${group}`);
  const results = [];
  const output = path.resolve(process.env.AGENTC2_TEST_RESULTS || path.join(root, 'test-results'));
  fs.mkdirSync(output, { recursive: true });
  for (const suite of suites) {
    const directory = path.join(output, suite.id);
    fs.mkdirSync(directory, { recursive: true });
    const log = fs.createWriteStream(path.join(directory, 'process.log'));
    const started = Date.now();
    const python = suite.file.endsWith('.py');
    const command = python ? (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) : process.execPath;
    const args = python ? [] : ['--require', path.join(root, 'tests/helpers/diagnostics.cjs')];
    args.push(suite.file, ...(python ? ['-v'] : []), ...(suite.args || []));
    let tail = '';
    console.log(`\nRUN ${suite.id}`);
    const result = await new Promise((resolve) => {
      const child = spawn(command, args, { cwd: root, env: { ...process.env, ...suite.env, AGENTC2_SUITE_ARTIFACTS: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', (chunk) => {
        log.write(chunk); destination.write(chunk); tail = (tail + chunk.toString()).slice(-100000);
      });
      child.on('error', (error) => { log.write(String(error)); });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve) => log.end(resolve));
    const skips = tail.split(/\r?\n/).filter((line) => /\bskip(?:ped)?\b/i.test(line));
    const status = result.code === 0 ? 'success' : 'failure';
    results.push({ id: suite.id, status, durationSeconds: (Date.now() - started) / 1000, ...result, skips });
    fs.writeFileSync(path.join(output, `${group}.json`), JSON.stringify(results, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- **${suite.id}**: ${status}, ${results.at(-1).durationSeconds.toFixed(1)}s${skips.length ? `; skips: ${skips.join('; ').replaceAll('\n', ' ')}` : ''}\n`);
  }
  if (results.some((result) => result.status !== 'success')) process.exitCode = 1;
}
module.exports = { validate };
if (require.main === module) {
  Promise.resolve().then(() => process.argv[2] === '--validate' ? validate() : run(process.argv[2])).catch((error) => { console.error(error); process.exitCode = 1; });
}
