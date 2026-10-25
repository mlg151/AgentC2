const { poll } = require('./helpers/poll.cjs');
// Browser plugin not available: exercise actual Electron windows/preload/IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { Store } = require('../electron/config.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-overwatch-'));
  const screenshots = process.env.AGENTC2_QA_SCREENSHOT_DIR || path.join(directory, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
  const store = new Store(directory);
  store.save('settings', { ...store.data.settings, hosts: [{ id: 'default', name: 'Fixture host', target: '127.0.0.1', port: 1, enabled: true }], notifications: false });
  let app;
  const errors = [];
  const observe = (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  };
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'helpers/overwatch-app.cjs'), `--user-data-dir=${path.join(directory, 'browser')}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', AGENTC2_DATA_DIR: directory }, timeout: 60000 });
    const main = await app.firstWindow(); observe(main);
    await main.waitForFunction(() => Boolean(window.agentHQ));
    await main.evaluate(() => window.agentHQ.getState());
    await main.locator('.session-row').first().waitFor();
    assert.equal(await main.title(), 'AgentC2'); assert.ok(main.url().startsWith('file:'));
    await main.getByRole('button', { name: /OVERWATCH$/ }).click();
    await main.getByRole('dialog', { name: 'Overwatch', exact: true }).waitFor();
    await main.screenshot({ path: path.join(screenshots, 'overwatch-docked.png') });
    assert.equal(await main.locator('.workspace').evaluate((node) => node.inert), true);
    let next = app.waitForEvent('window');
    await main.getByRole('button', { name: 'Undock window', exact: true }).click();
    let detached;
    try { detached = await next; } catch (error) { console.error(await main.locator('body').innerText(), errors); throw error; }
    observe(detached);
    await detached.getByRole('main', { name: 'Overwatch', exact: true }).waitFor();
    await main.getByRole('dialog', { name: 'Overwatch', exact: true }).waitFor({ state: 'hidden' });
    assert.ok(detached.url().endsWith('?view=overwatch'));
    assert.equal(await detached.title(), 'AgentC2 — Overwatch');
    assert.equal(await main.locator('.workspace').evaluate((node) => node.inert), false);
    await detached.locator('.overwatch-unit pre').first().getByText('Fixture task completed.', { exact: false }).waitFor();
    assert.equal(await detached.locator('.overwatch-unit').count(), 12);
    await detached.getByRole('button', { name: 'Next Overwatch page' }).click();
    assert.equal(await detached.locator('.overwatch-unit').count(), 5);
    await detached.keyboard.press('ArrowLeft');
    await detached.getByText('Page 1 of 2', { exact: true }).waitFor();
    await detached.getByLabel('Overwatch grid size').selectOption('16');
    assert.equal(await detached.locator('.overwatch-unit').count(), 16);
    await detached.getByRole('button', { name: 'Inspect unit 02', exact: true }).click();
    await main.locator('.session-pane[data-session-key="default/tmux:hq-000000000002"]').waitFor();
    assert.equal(detached.isClosed(), false);
    await detached.keyboard.press('f');
    await main.locator('.session-pane[data-session-key="default/tmux:hq-000000000004"]').waitFor();
    // Reopening from main focuses the same window, without a duplicate modal.
    await main.getByRole('button', { name: /OVERWATCH$/ }).click();
    assert.equal(app.windows().length, 2);
    assert.equal(await main.getByRole('dialog', { name: 'Overwatch', exact: true }).count(), 0);
    const denied = await detached.evaluate(async () => {
      const api = window.agentHQ;
      const operations = [() => api.create({}), () => api.saveSettings({}), () => api.saveWorkspace({}), () => api.writeClipboard('must not write'), () => api.undockOverwatch()];
      return Promise.all(operations.map(async (operation) => { try { await operation(); return 'allowed'; } catch (error) { return String(error); } }));
    });
    assert.ok(denied.every((error) => error.includes('Untrusted window')), JSON.stringify(denied));
    assert.equal(await detached.evaluate(() => typeof window.require), 'undefined');
    const invalidSelection = await detached.evaluate(async () => { try { await window.agentHQ.selectOverwatchUnit('default/tmux:external'); return 'allowed'; } catch (error) { return String(error); } });
    assert.match(invalidSelection, /Managed unit is no longer available/);
    await detached.reload();
    await detached.getByRole('main', { name: 'Overwatch', exact: true }).waitFor();
    await detached.locator('.overwatch-unit pre').first().getByText('Fixture task completed.', { exact: false }).waitFor();
    await detached.getByLabel('Overwatch grid size').selectOption('16');
    await detached.screenshot({ path: path.join(screenshots, 'overwatch-undocked.png') });
    await (await app.browserWindow(detached)).evaluate((window) => window.setSize(800, 620));
    await detached.getByRole('button', { name: 'Dock to main window', exact: true }).waitFor();
    await detached.screenshot({ path: path.join(screenshots, 'overwatch-undocked-narrow.png') });
    assert.equal(await detached.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await detached.getByRole('button', { name: 'Dock to main window', exact: true }).click();
    await main.getByRole('dialog', { name: 'Overwatch', exact: true }).waitFor();
    assert.equal(app.windows().length, 1);
    next = app.waitForEvent('window');
    await main.getByRole('button', { name: 'Undock window', exact: true }).click();
    detached = await next; observe(detached);
    await detached.getByRole('main', { name: 'Overwatch', exact: true }).waitFor();
    await (await app.browserWindow(detached)).evaluate((window) => window.close());
    await poll(() => main.evaluate(async () => !(await window.agentHQ.overwatchWindowState()).undocked), 'Native close did not restore docked state');
    assert.equal(main.isClosed(), false);
    assert.equal(await main.getByRole('dialog', { name: 'Overwatch', exact: true }).count(), 0);
    await main.getByRole('button', { name: /OVERWATCH$/ }).click();
    next = app.waitForEvent('window');
    await main.getByRole('button', { name: 'Undock window', exact: true }).click();
    detached = await next; observe(detached);
    await detached.getByRole('main', { name: 'Overwatch', exact: true }).waitFor();
    for (const page of [main, detached]) assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.deepEqual(errors, []);
    // Main close must close the auxiliary window, including on macOS.
    const closed = detached.waitForEvent('close');
    await (await app.browserWindow(main)).evaluate((window) => window.close()).catch(() => {});
    await closed;
    console.log('PASS production Overwatch undock/dock, paging, unit/keyboard selection, main interactivity, singleton focus, restricted IPC, narrow layout, native close, and main-window cleanup');
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
