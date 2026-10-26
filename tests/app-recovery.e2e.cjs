// Real renderer, real keyboard/DOM events, and a public preload fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const { defaults } = require('../electron/config.cjs');
const { defaults: commanderDefaults } = require('../electron/centcom.cjs');
const { installAppBridge } = require('./fixtures/app-bridge.cjs');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-app-recovery-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-vite-recovery-'));
const errors = [];
let server, browser, page;
async function until(predicate) { await page.waitForFunction(predicate); }
async function key(chord) { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(chord); }
(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: cache, server: { port: 0, strictPort: false, host: '127.0.0.1' } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const settings = defaults(); settings.hosts = [{ id: 'alpha', name: 'Alpha theater', target: 'alpha.invalid', port: 22, enabled: true }, { id: 'beta', name: 'Beta theater', target: 'beta.invalid', port: 22, enabled: true }];
    await context.addInitScript(installAppBridge, { settings, commander: commanderDefaults() });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    await page.goto(url + '?scenario=browser-only');
    await page.getByRole('alert').filter({ hasText: 'Open AgentC2 as a desktop app to connect over SSH.' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Open AgentC2 as a desktop app' }).waitFor();
    assert.equal(await page.evaluate(() => window.qa.calls.length), 0);

    await page.goto(url + '?scenario=single'); await page.locator('.session-row').waitFor();
    await key('Alt+L'); await page.locator('.command-feedback').filter({ hasText: 'This viewport has no unit' }).waitFor();
    await key('Alt+J'); await key('Alt+K');
    assert.equal(await page.getByRole('tab').count(), 1, 'Cycling a one-unit fleet must not invent a target');
    await page.getByRole('button', { name: 'Unpin anchor', exact: true }).click();
    await until(() => window.qa.workspace.situation.anchorKey === null && window.qa.workspace.situation.targetKey === window.qa.units[0].key);
    await key('Alt+H'); await page.locator('.command-feedback').filter({ hasText: 'This viewport has no unit' }).waitFor();
    await page.getByRole('button', { name: 'Pin to A', exact: true }).filter({ visible: true }).click();
    await until(() => window.qa.workspace.situation.anchorKey === window.qa.units[0].key);
    await page.getByRole('button', { name: 'Pin Alpha unit', exact: true }).click();
    await page.getByRole('button', { name: 'Unpin Alpha unit', exact: true }).waitFor();
    const saved = await page.evaluate(() => window.qa.calls.filter((call) => call[0] === 'saveWorkspace').length);
    await page.evaluate(() => { window.qa.emit('onSessionPinned', window.qa.units[0].key, true); window.qa.emit('onSessionPinned', window.qa.units[0].key, true); });
    assert.equal(await page.evaluate(() => window.qa.calls.filter((call) => call[0] === 'saveWorkspace').length), saved, 'Duplicate pin events must not write the workspace again');

    await page.goto(url + '?scenario=empty'); await page.getByRole('heading', { name: 'Select a session', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Filter SSH host', exact: true }).selectOption('beta');
    await page.locator('.no-selection').getByRole('button', { name: 'New session', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
    assert.equal(await dialog.getByRole('combobox', { name: 'Host', exact: true }).inputValue(), 'beta');
    await dialog.getByRole('textbox', { name: 'Session name', exact: true }).fill('Delayed Beta fixture');
    await page.evaluate(() => { window.qa.visibilityDelay = 100; });
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('alert').filter({ hasText: 'The session started but has not appeared in inventory' }).waitFor();
    await page.evaluate(() => { window.qa.visibilityDelay = 0; });
    await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click(); await page.locator('.session-row').filter({ hasText: 'Delayed Beta fixture' }).waitFor();
    await until(() => window.qa.workspace.selectedKey.startsWith('beta/tmux:'));
    assert.deepEqual(await page.evaluate(() => window.qa.calls.filter((call) => call[0] === 'create').map((call) => call[1].hostId)), ['beta']);

    await page.goto(url + '?scenario=deletions'); await page.locator('.session-row').first().waitFor();
    for (const title of ['Bravo unit', 'Charlie unit']) await page.locator('.session-row').filter({ hasText: title }).click();
    async function deleted(index) {
      await page.evaluate((index) => { const removed = window.qa.units[index]; window.qa.units = window.qa.units.filter((unit) => unit.key !== removed.key); window.qa.emit('onSessionsDeleted', [removed.key]); }, index);
    }
    await deleted(2); await until(() => window.qa.workspace.situation.anchorKey === window.qa.units[0].key && window.qa.workspace.situation.targetKey === null);
    await deleted(0); await until(() => window.qa.workspace.situation.anchorKey === window.qa.units[0].key);
    await deleted(0); await page.getByRole('heading', { name: 'Select a session', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.qa.workspace.metadata), {});

    await page.goto(url + '?scenario=capacity'); await page.locator('.roster-heading').filter({ hasText: '(120)' }).waitFor();
    await key('Alt+J'); await key('Alt+K');
    assert.equal(await page.evaluate(() => Object.keys(window.qa.workspace.situation.callsigns).length), 99);
    assert.equal(await page.locator('.session-row').count(), 120, 'Units beyond callsign capacity remain visible and selectable');
    await page.locator('.session-row').filter({ hasText: /^.*Fleet unit 120$/ }).click();
    await until(() => window.qa.workspace.selectedKey === window.qa.units[119].key);
    await page.screenshot({ path: path.join(directory, 'app-callsign-capacity.png') });

    for (const reject of [false, true]) {
      await page.goto(url + '?scenario=poll-held'); await page.locator('.session-row').first().waitFor();
      await until(() => window.qa.calls.filter((call) => call[0] === 'listFlashTraffic').length === 2);
      // The actual five-second poll must not overlap an outstanding request.
      await page.waitForTimeout(5200);
      assert.equal(await page.evaluate(() => window.qa.calls.filter((call) => call[0] === 'listFlashTraffic').length), 2);
      await page.evaluate((reject) => window.qa.release('listFlashTraffic', reject), reject);
      if (!reject) await page.getByRole('button', { name: 'FLASH TRAFFIC 1', exact: true }).waitFor();
      else await until(() => !window.qa.hold.listFlashTraffic);
    }
    assert.deepEqual(errors, []);
    console.log('PASS desktop browser-only recovery, one/zero-unit focus and cycling, idempotent pin events, delayed cross-host creation without replay, target/anchor/last-unit deletion, 120-unit callsign capacity, and real poll overlap/StrictMode cancellation');
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'app-recovery-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); } throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(cache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
