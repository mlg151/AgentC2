const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { stopFixtureProcess } = require('./helpers/stop-fixture-process.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-fixture-cleanup-'));
  const journal = path.join(directory, 'shutdown.txt');
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(process.argv[1], 'shutdown complete');
      process.exit(0);
    }, 200));
    setInterval(() => {}, 1000);
    console.log('ready');
  `, journal], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    await stopFixtureProcess(child.pid);
    assert.equal(fs.readFileSync(journal, 'utf8'), 'shutdown complete', 'wait for shutdown writes before removing the fixture');
    assert.deepEqual(await exited, [0, null]);
    await stopFixtureProcess(child.pid);
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(fs.existsSync(directory), false);
    console.log('PASS fixture cleanup waits for delayed shutdown writes and tolerates an already exited process');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
