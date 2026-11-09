const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const YAML = require('yaml');
const { Store } = require('../electron/config.cjs');
const { profiles, templates } = require('../electron/specops.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-specops-ui-'));
  let app;
  try {
    const store = new Store(directory);
    store.save('settings', { ...store.data.settings, hosts: [{ id: 'default', name: 'Offline fixture', target: '127.0.0.1', port: 1, enabled: true }] });
    fs.mkdirSync(path.join(directory, 'specops'));
    fs.writeFileSync(path.join(directory, 'specops/runs.json'), JSON.stringify([{ version: 1, id: 'a'.repeat(32), hostId: 'default', repo: 'example/project', state: 'halted', stage: 'plan_review', error: 'Denial retry limit exceeded. Watch Officer arbitration required.', workflow: templates[0], visits: [{ id: 'b'.repeat(32), stage: 'plan_review', name: 'hq-123456789abc', output: 'Add regression coverage for reconnect.\nAGENTC2_VERDICT: DENY', outcome: 'DENY', completion: { outcome: 'completed' } }], costUsd: 0.2, costKnown: false }]));
    app = await _electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', AGENT_HQ_DATA_DIR: directory } });
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.match(await page.title(), /AgentC2/);
    await page.getByRole('button', { name: 'SPECOPS', exact: true }).click();
    await page.getByRole('dialog', { name: 'SPECOPS and GitHub' }).waitFor();
    await page.getByText('Mission activity', { exact: true }).waitFor();
    await page.getByText('[!HALT] · reported spend $0.20 (partial / unknown)', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'workflows & ranks', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Workflow and rank YAML' });
    await editor.fill('profiles: []\nworkflows: []');
    await page.getByRole('button', { name: 'Save workflows and ranks' }).click();
    await page.getByRole('alert').filter({ hasText: 'Invalid SPECOPS configuration' }).waitFor();
    const custom = structuredClone(templates[0]); custom.id = 'custom-review'; custom.name = 'Custom review';
    await editor.fill(YAML.stringify({ profiles, workflows: [...templates, custom] }));
    await page.getByRole('button', { name: 'Save workflows and ranks' }).click();
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    assert.equal(YAML.parse(fs.readFileSync(path.join(directory, 'specops/specops.yaml'), 'utf8')).workflows.length, 3);
    await page.getByRole('button', { name: 'missions', exact: true }).click();
    await page.getByLabel('Mission template').selectOption('custom-review');
    assert.equal(await page.getByLabel('Mission template').inputValue(), 'custom-review');
    await page.getByText('Stage artifacts and review feedback (1)').click();
    await page.getByText('Add regression coverage for reconnect.', { exact: false }).waitFor();
    if (process.env.AGENTC2_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.AGENTC2_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENTC2_SCREENSHOT_DIR, 'specops-desktop.png') });
    }
    await page.setViewportSize({ width: 960, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.AGENTC2_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENTC2_SCREENSHOT_DIR, 'specops-narrow.png') });
    await page.getByRole('button', { name: 'GitHub', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed PR ready' }).isEnabled(), false);
    assert.deepEqual(errors, []);
    console.log('PASS Electron SPECOPS load, HALT state, invalid YAML, saved workflow clone, template selection, artifacts, responsive layout, and guarded GitHub action');
  } finally { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
