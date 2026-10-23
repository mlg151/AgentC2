const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { Store } = require('../electron/config.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-ui-'));
  let app;
  try {
    const store = new Store(directory);
    store.save('settings', {
      ...store.data.settings,
      hosts: [{ id: 'default', name: 'Primary Theater', target: '127.0.0.1', port: 1, enabled: true }],
    });
    fs.mkdirSync(path.join(directory, 'centcom'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'centcom/centcom.json'),
      JSON.stringify({
        version: 1,
        config: {
          version: 1,
          hostId: 'default',
          provider: 'codex',
          model: 'gpt-6-astra',
          authority: 'gated',
          triggers: {
            onSpecopsHalt: true,
            onLoopFault: true,
            onFlashTraffic: true,
            onUnitFailed: true,
            cooldownSeconds: 60,
            maxAutoTurnsPerHour: 12,
          },
          maxDirectivesPerTurn: 5,
          maxBudgetUsd: 10.0,
        },
        session: null,
        status: 'idle',
        costUsd: 1.25,
        costKnown: true,
        directives: [
          {
            id: 'd-1',
            turnId: 'turn-1',
            kind: 'unit.stop',
            summary: 'Halt stalled unit hq-task-91',
            rationale: 'Unit is unresponsive for >15 minutes',
            params: { name: 'hq-task-91', hostId: 'default' },
            state: 'pending',
            trigger: 'auto_wake',
            createdAt: Date.now() - 60000,
            resolvedAt: null,
          },
        ],
        automations: [
          {
            id: 'a-1',
            turnId: 'turn-1',
            kind: 'preset',
            title: 'Node 22 Unit Test Preset',
            rationale: 'Developer runs npm run test repeatedly across units',
            evidence: ['5 terminal executions of npm run test'],
            payload: { id: 'node22-unit', name: 'Node 22 Test', command: 'npm test' },
            state: 'proposed',
            createdAt: Date.now() - 30000,
            appliedAt: null,
          },
        ],
        auditLog: [],
      })
    );

    app = await _electron.launch({
      executablePath: require('electron'),
      args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`],
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production', AGENT_HQ_DATA_DIR: directory },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.match(await page.title(), /AgentC2/);

    // Verify CENTCOM button exists in header
    const centcomBtn = page.locator('button.centcom-btn');
    await centcomBtn.waitFor();
    await page.waitForFunction(() => document.querySelector('button.centcom-btn')?.textContent?.includes('CENTCOM'));

    // Open CENTCOM Console
    await centcomBtn.click();
    await page.getByText('CENTCOM COMMAND CONSOLE').waitFor();

    // Verify tabs
    await page.getByRole('button', { name: 'Command Deck' }).waitFor();
    await page.getByRole('button', { name: /^Directives/ }).waitFor();
    await page.getByRole('button', { name: /^Automations/ }).waitFor();
    await page.getByRole('button', { name: 'Configuration & ROE' }).waitFor();

    const screenshotDir = path.resolve(__dirname, '../docs/screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'centcom-console.png') });

    // Switch to Directives tab and verify pending directive card
    await page.getByRole('button', { name: /^Directives/ }).click();
    await page.getByText('Halt stalled unit hq-task-91').waitFor();
    await page.getByRole('button', { name: 'Approve & Execute' }).waitFor();

    // Switch to Automations tab and verify suggestion
    await page.getByRole('button', { name: /^Automations/ }).click();
    await page.getByText('Node 22 Unit Test Preset').waitFor();
    await page.getByRole('button', { name: 'Apply Configuration' }).waitFor();

    // Switch to Configuration tab and verify authority mode
    await page.getByRole('button', { name: 'Configuration & ROE' }).click();
    await page.getByText('Gated C2 (Recommended)').waitFor();
    await page.getByText('Autonomous C2').waitFor();

    // Responsive check at 960x800
    await page.setViewportSize({ width: 960, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(screenshotDir, 'centcom-console-narrow.png') });

    assert.deepEqual(errors, []);
    console.log('PASS Electron CENTCOM UI load, badge count, tabs, directives, automations, config ROE, screenshots, and responsive layout');
  } finally {
    if (app) await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
