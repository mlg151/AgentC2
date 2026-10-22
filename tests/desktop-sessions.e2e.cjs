// Built desktop renderer with a deterministic bridge; real worker deletion is
// covered by chat-launch.e2e.cjs. No SSH hosts or provider accounts are used.
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { preview } = require('vite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  let server, browser;
  const screenshots = process.env.AGENTC2_QA_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-managed-ui-'));
  try {
    fs.mkdirSync(screenshots, { recursive: true });
    server = await preview({ root: path.resolve(__dirname, '..'), preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      const unit = (id, title, extra = {}) => ({ key: 'default/tmux:' + id, id, title, branch: 'long-feature-branch-that-must-not-obscure-the-session-name', cwd: '/workspace/managed', provider: 'codex', kind: 'managed', managed: true, canStop: true, state: 'exited', hostId: 'default', hostName: 'QA host', updatedAt: null, ...extra });
      let sessions = [unit('hq-111111111111', 'Managed alpha'), unit('hq-222222222222', 'Managed beta'), unit('external', 'External tmux', { kind: 'external-tmux', managed: false, cwd: '/external-only' }), unit('process', 'Unmanaged process', { kind: 'unmanaged', managed: false }), unit('background', 'Background process', { kind: 'background', managed: false }), unit('saved', 'Saved conversation', { key: 'default/codex:saved', kind: 'conversation', managed: false, canResume: true, canStop: false })];
      const deleted = new Set(JSON.parse(localStorage.getItem('deleted') || '[]'));
      sessions = sessions.filter((session) => !deleted.has(session.key));
      const settings = { hosts: [{ id: 'default', name: 'QA host', target: 'fixture.invalid', enabled: true, port: 22 }], presets: [], notifications: false };
      let workspace = { tabs: ['default/tmux:process'], selectedKey: 'default/tmux:process', splitKey: null, metadata: {} };
      const inventory = () => ({ hosts: [{ id: 'default', name: 'QA host', connected: true }], sessions, attention: [], faults: [] });
      let onDeleted = () => {};
      const off = () => () => {};
      window.qa = { previews: [], deleteCalls: 0, failDelete: false };
      window.agentHQ = {
        getState: async () => ({ settings, workspace, attention: [] }), inventory: async () => inventory(),
        saveWorkspace: async (next) => { workspace = next; return next; },
        onInventory: off, onSessionPinned: off, onSessionsDeleted: (listener) => { onDeleted = listener; return () => {}; }, onAttentionOpen: off,
        listFlashTraffic: async () => [], onHealth: off, health: async () => [],
        devUrls: async () => [], onDevUrls: off, onTerminalExit: off, onTerminalData: off, onTerminalState: off,
        terminalPreviews: async (keys) => { window.qa.previews.push(...keys); return keys.map((key) => ({ key, text: 'Managed snapshot', sampledAt: Date.now(), error: false })); },
        deleteSession: async (key) => {
          window.qa.deleteCalls++;
          if (window.qa.failDelete) throw new Error('Take control before deleting this session');
          deleted.add(key); localStorage.setItem('deleted', JSON.stringify([...deleted]));
          sessions = sessions.filter((session) => session.key !== key); onDeleted([key]);
        },
      };
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    await page.goto(url);
    assert.equal(await page.title(), 'AgentC2'); assert.equal(page.url(), url);
    try { await page.locator('.session-row').filter({ hasText: 'Managed alpha' }).waitFor({timeout:10000}); } catch (cause) { console.error(errors, await page.locator('body').innerText()); throw cause; }
    assert.equal(await page.locator('.session-row').count(), 2);
    assert.equal(await page.locator('.session-row').getByText(/Context (unknown|unsupported)/).count(), 0);
    const title = page.locator('.session-row .unit-session-name').first();
    assert.equal(await title.innerText(), 'Managed alpha');
    await page.screenshot({ path: path.join(screenshots, 'managed-session-names.png') });
    assert.ok(await title.evaluate((element) => element.clientHeight >= 14), 'Session name was squeezed out of the roster');
    assert.equal(await page.getByRole('tab', { name: 'Unmanaged process', exact: true }).count(), 0);
    assert.equal(await page.locator('.session-row').filter({ hasText: /External|Unmanaged|Background|Saved conversation/ }).count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Filter project', exact: true }).locator('option').filter({ hasText: '/external-only' }).count(), 0);
    await page.getByRole('textbox', { name: 'Search sessions', exact: true }).fill('Unmanaged');
    assert.equal(await page.locator('.session-row').count(), 0);
    await page.getByRole('textbox', { name: 'Search sessions', exact: true }).fill('');
    await page.getByRole('button', { name: 'Search units, hosts, and repositories' }).click();
    await page.getByRole('textbox', { name: 'Quick switcher search' }).fill('Saved conversation');
    assert.equal(await page.getByRole('option').filter({ hasText: 'Saved conversation' }).count(), 1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /OVERWATCH/ }).click();
    const overwatch = page.getByRole('dialog', { name: 'Overwatch', exact: true });
    assert.equal(await overwatch.locator('.overwatch-unit').count(), 2);
    await overwatch.getByText('Managed snapshot').first().waitFor();
    assert.deepEqual(new Set(await page.evaluate(() => window.qa.previews)), new Set(['default/tmux:hq-111111111111', 'default/tmux:hq-222222222222']));
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'managed-overwatch.png') });
    await overwatch.getByRole('button', { name: /Close Overwatch/ }).click();
    await page.getByRole('button', { name: 'Delete session', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Delete session', exact: true });
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'delete-confirmation.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => window.qa.deleteCalls), 0);
    await page.evaluate(() => { window.qa.failDelete = true; });
    await page.getByRole('button', { name: 'Delete session', exact: true }).first().click();
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Take control' }).waitFor();
    assert.equal(await page.locator('.session-row').count(), 2);
    await page.evaluate(() => { window.qa.failDelete = false; });
    await page.screenshot({ path: path.join(screenshots, 'delete-error.png') });
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.session-row').count(), 1);
    assert.equal(await page.getByRole('tab', { name: 'Managed alpha', exact: true }).count(), 0);
    await page.reload(); await page.locator('.session-row').waitFor();
    assert.equal(await page.locator('.session-row').count(), 1);
    assert.equal(await page.locator('.session-row').filter({ hasText: 'Managed alpha' }).count(), 0);
    await page.setViewportSize({ width: 1000, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('vite-error-overlay').count(), 0); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(screenshots, 'managed-roster-after-delete.png') });
    console.log('PASS built desktop managed-only ORBAT, project/search scopes, Overwatch preview isolation, saved-history access, delete cancel/error/success/reload, and narrow layout. Screenshots: ' + screenshots);
  } finally { await browser?.close(); await new Promise((resolve) => server ? server.httpServer.close(resolve) : resolve()); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
