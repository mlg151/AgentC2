const { poll } = require('./helpers/poll.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { Store, validateSettings } = require('../electron/config.cjs');
const { createAutomations } = require('../electron/centcom-automations.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-centcom-ui-'));
  let app;
  try {
    const store = new Store(directory);
    store.save('settings', validateSettings({
      ...store.data.settings,
      hosts: [{ id: 'default', name: 'Primary Theater', target: '127.0.0.1', port: 1, enabled: true }],
    }));
    const draftPreview = await createAutomations({ service: { store } }).preview('preset', {
      id: 'node22-unit', name: 'Node 22 Test', provider: 'codex', command: 'codex', args: '--model fixture', fullPermissions: false,
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
        status: 'halted',
        providerTurn: { commandId: 'fixture-command', turnId: 'fixture-provider-turn', status: 'uncertain', hostId: 'default', sessionId: 'chat-' + 'f'.repeat(32), cursor: 712, dispatchStarted: true },
        costUsd: 1.25,
        costKnown: false,
        directives: [
          {
            id: 'd-1',
            turnId: 'turn-1',
            kind: 'unit.stop',
            summary: 'Halt stalled unit hq-task-91',
            rationale: 'Unit is unresponsive for >15 minutes',
            params: { name: 'hq-task-91', hostId: 'default' },
            binding: { version: 1, requestHash: 'b'.repeat(64), evidenceHash: 'c'.repeat(64), evidence: {
              targets: [{ identity: { key: 'default/tmux:hq-task-91', hostId: 'default', name: 'hq-task-91', processId: '491', startedAt: '2026-01-01T00:00:00.000Z' }, controller: 'desktop' }],
              authority: { mode: 'gated', hosts: [{ id: 'default', name: 'Primary Theater' }] }, requestEvidence: null, operationEvidence: null,
            } },
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
            payload: draftPreview.payload,
            preview: draftPreview,
            state: 'proposed',
            createdAt: Date.now() - 30000,
            appliedAt: null,
          },
          { id: 'a-2', turnId: 'turn-2', kind: 'oporder', title: 'Uncertain enrollment', rationale: 'Readback could not confirm persistence', payload: {}, evidence: [], state: 'uncertain', error: 'OpOrder enrollment readback failed', createdAt: Date.now(), appliedAt: null },
          { id: 'a-3', turnId: 'turn-3', kind: 'preset', title: 'Verified saved preset', rationale: 'Readback observed the saved artifact', payload: {}, evidence: [], state: 'applied', result: { artifact: { id: 'saved-fixture' }, revision: 'a'.repeat(64) }, createdAt: Date.now(), appliedAt: Date.now() },
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
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.match(await page.title(), /AgentC2/);
    assert.ok(page.url().startsWith('file:'));
    assert.equal(await page.locator('vite-error-overlay').count(), 0);

    // Verify CENTCOM button exists in header
    const centcomBtn = page.locator('button.centcom-btn');
    await centcomBtn.waitFor();
    await page.waitForFunction(() => document.querySelector('button.centcom-btn')?.textContent?.includes('CENTCOM'));

    // Open CENTCOM Console
    await centcomBtn.click();
    await page.getByText('CENTCOM COMMAND CONSOLE').waitFor();
    await page.getByText('KNOWN SPEND: $1.25 · INCOMPLETE').waitFor();
    await page.getByText('Provider shutdown is unconfirmed.', { exact: false }).waitFor();

    // Verify tabs
    await page.getByRole('button', { name: 'Command Deck' }).waitFor();
    await page.getByRole('button', { name: /^Directives/ }).waitFor();
    await page.getByRole('button', { name: /^Automations/ }).waitFor();
    await page.getByRole('button', { name: 'Configuration & ROE' }).waitFor();

    const screenshotDir = process.env.AGENTC2_QA_SCREENSHOT_DIR || process.env.AGENTC2_SUITE_ARTIFACTS || path.join(os.tmpdir(), 'agentc2-centcom-screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'centcom-console.png') });

    // Switch to Directives tab and verify pending directive card
    await page.getByRole('button', { name: /^Directives/ }).click();
    await page.getByText('Halt stalled unit hq-task-91').waitFor();
    await page.getByRole('button', { name: 'Approve & Execute' }).waitFor();
    await page.getByText('Reviewed targets and authorization', { exact: true }).click();
    await page.getByText('"processId": "491"', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(screenshotDir, 'centcom-approval-scope.png') });

    // Switch to Automations tab and verify suggestion
    await page.getByRole('button', { name: /^Automations/ }).click();
    await page.getByText('Node 22 Unit Test Preset').waitFor();
    await page.getByRole('button', { name: 'Apply Configuration' }).waitFor();
    const proposed = page.locator('.centcom-automation-card').filter({ hasText: 'Node 22 Unit Test Preset' });
    await proposed.getByText('Reviewed change and revision', { exact: true }).click();
    await proposed.getByText(draftPreview.revision, { exact: false }).waitFor();
    await page.locator('.centcom-tab-content').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(screenshotDir, 'centcom-automation-preview.png') });
    assert.ok(!JSON.parse(fs.readFileSync(store.file)).settings.presets.some((p) => p.id === 'node22-unit'), 'No permanent mutation before UI approval');
    await proposed.getByRole('button', { name: 'Apply Configuration' }).click();
    await proposed.getByText('APPLIED', { exact: true }).waitFor();
    const savedPreset = JSON.parse(fs.readFileSync(store.file)).settings.presets.find((p) => p.id === 'node22-unit');
    assert.deepEqual(savedPreset, draftPreview.after);
    await proposed.getByText('Reviewed change and revision', { exact: true }).click();
    const uncertain = page.locator('.centcom-automation-card.uncertain');
    await uncertain.getByText('UNCERTAIN', { exact: true }).waitFor();
    assert.equal(await uncertain.getByRole('button', { name: 'Apply Configuration' }).count(), 0);
    await uncertain.getByText('The change may have been saved.', { exact: false }).waitFor();
    await page.locator('.centcom-automation-card').filter({ hasText: 'Verified saved preset' }).getByText('Saved artifact and revision', { exact: true }).click();
    await page.getByText('saved-fixture', { exact: false }).waitFor();
    await page.locator('.centcom-automation-card').filter({ hasText: 'Verified saved preset' }).getByText('Saved artifact and revision', { exact: true }).click();
    await proposed.getByText('Saved artifact and revision', { exact: true }).click();
    await page.locator('.centcom-tab-content').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(screenshotDir, 'centcom-automation-outcomes.png') });

    // Switch to Configuration tab and verify authority mode
    await page.getByRole('button', { name: 'Configuration & ROE' }).click();
    await page.getByText('Gated C2 (Recommended)').waitFor();
    await page.getByText('Autonomous C2').waitFor();
    const fallback = page.getByLabel('Fallback status interval (seconds)', { exact: false });
    assert.equal(await fallback.inputValue(), '600');
    await fallback.fill('0');
    await page.getByLabel('Provider turn deadline (seconds)', { exact: true }).fill('1200');
    await page.getByLabel('Cancellation reconciliation deadline (seconds)', { exact: true }).fill('20');
    await page.getByRole('button', { name: 'Save Configuration', exact: true }).click();
    await poll(() => page.evaluate(async () => (await window.agentHQ.centcomState()).config.triggers.fallbackSeconds === 0), 'CENTCOM fallback setting was not saved');
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'centcom/centcom.json')));
    assert.equal(persisted.config.triggers.fallbackSeconds, 0);
    assert.equal(persisted.config.turnDeadlineSeconds, 1200);
    assert.equal(persisted.config.cancellationDeadlineSeconds, 20);

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
