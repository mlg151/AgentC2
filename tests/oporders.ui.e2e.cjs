// Live Electron and SSH smoke for the OpOrders settings flow.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { Store, defaults } = require('../electron/config.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const host = process.env.AGENTC2_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an isolated SSH test host');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-oporders-ui-'));
const repository = `/tmp/agentc2-oporders-ui-${crypto.randomBytes(8).toString('hex')}`;
function remote(source) {
  return execFileSync(sshBinary(), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-', repository], { input: source, encoding: 'utf8', timeout: 20000 }).trim();
}

(async () => {
  let app;
  try {
    remote('import pathlib,subprocess,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(); subprocess.run(["git","init","-q",str(p)],check=True)');
    const store = new Store(directory);
    const settings = defaults();
    settings.hosts[0].target = host;
    store.save('settings', settings);
    app = await _electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: directory } });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'OpOrders', exact: true }).click();
    await page.getByRole('button', { name: 'Add OpOrder' }).click();
    await page.getByRole('textbox', { name: 'Remote Git worktree root' }).fill(repository);
    await page.getByRole('textbox', { name: 'Shared instructions' }).fill('UI QA guidance');
    await page.getByRole('button', { name: 'Preview remote changes' }).click();
    await page.getByText('Ready to apply').waitFor();
    await page.getByText('AGENTS.md · create', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Apply and enable sync' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Apply and enable sync' }).click();
    await page.getByRole('button', { name: 'Pause sync' }).waitFor();
    assert.equal((await page.evaluate(() => window.agentHQ.getState())).settings.opOrders?.[0]?.enabled, true);
    assert.equal(remote('import pathlib,sys; print("UI QA guidance" in (pathlib.Path(sys.argv[1])/"AGENTS.md").read_text())'), 'True');
    await page.getByRole('button', { name: 'Pause sync' }).click();
    await page.waitForFunction(() => document.querySelector('.oporder-settings select option:checked')?.textContent?.includes('· paused'));
    assert.equal((await page.evaluate(() => window.agentHQ.getState())).settings.opOrders?.[0]?.enabled, false);
    assert.deepEqual(errors, []);
    console.log('PASS Electron OpOrders preview, apply, persisted enrollment, and pause controls');
  } finally {
    if (app) await app.close();
    try { remote('import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); assert p.name.startswith("agentc2-oporders-ui-") and p.parent==pathlib.Path("/tmp"); shutil.rmtree(p,ignore_errors=True)'); } catch (_) { /* Host may be offline. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
