// Built renderer, deterministic bridge. Native mutations have separate helper tests.
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { preview } = require('vite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  let server, browser;
  const screenshots = process.env.AGENTC2_QA_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-renames-ui-'));
  fs.mkdirSync(screenshots, { recursive: true });
  try {
    server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      let session = { key: 'default/tmux:hq-111111111111', id: 'hq-111111111111', title: localStorage.getItem('title') || 'OpenCode task', provider: 'opencode', transport: 'terminal', hostId: 'default', hostName: 'This computer', cwd: '/workspace/project', kind: 'managed', managed: true, canAttach: false, canStop: true, state: 'live', updatedAt: null };
      let workspace = { tabs: [session.key], selectedKey: session.key, splitKey: null, metadata: {} };
      const preset = (provider) => ({ id: provider, provider, name: provider === 'opencode' ? 'OpenCode' : 'Codex', command: provider, args: '', cwd: '', instructions: '', fullPermissions: true, attentionHooks: false, hostId: 'default' });
      const settings = { hosts: [{ id: 'default', kind: 'local', name: 'This computer', enabled: true, port: 22, target: 'localhost' }], presets: [preset('codex'), preset('opencode')], notifications: false };
      const inventory = () => ({ hosts: [{ id: 'default', name: 'This computer', connected: true }], sessions: [session], attention: [], faults: [] });
      const off = () => () => {};
      window.qa = { failRename: false, opened: 0, updateAvailable: localStorage.getItem('no-update') !== 'true' };
      window.agentHQ = {
        getState: async () => ({ settings, workspace, attention: [] }), inventory: async () => inventory(),
        saveWorkspace: async (value) => { workspace = value; return value; },
        onInventory: off, onSessionPinned: off, onSessionsDeleted: off, onAttentionOpen: off, onHealth: off,
        onDevUrls: off, onTerminalExit: off, onTerminalData: off, onTerminalState: off,
        listFlashTraffic: async () => [], health: async () => [], devUrls: async () => [],
        renameSession: async (key, title) => { if (window.qa.failRename) throw new Error('Rename fixture refused'); if (key !== session.key) throw new Error('Wrong target'); session = { ...session, title }; localStorage.setItem('title', title); return title; },
        checkForUpdates: async () => ({ available: window.qa.updateAvailable, version: '0.4.1', revision: 'a'.repeat(40), kind: 'release', label: 'Update to v0.4.2', url: 'https://github.com/mlg151/AgentC2/releases/latest' }),
        openUpdate: async () => { window.qa.opened++; },
      };
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    await page.goto(url);
    assert.equal(page.url(), url); assert.equal(await page.title(), 'AgentC2');
    await page.locator('.session-row').filter({ hasText: 'OpenCode task' }).waitFor();
    await page.getByRole('button', { name: 'Update to v0.4.2', exact: true }).click();
    assert.equal(await page.evaluate(() => window.qa.opened), 1);
    const pane = page.locator('.session-pane.is-focused');
    await pane.getByRole('button', { name: 'Rename', exact: true }).click();
    const input = pane.getByRole('textbox', { name: 'Session name', exact: true });
    assert.equal(await input.inputValue(), 'OpenCode task');
    await input.fill('');
    assert.equal(await input.isEnabled(), true, 'Clearing a title must leave the input usable');
    assert.equal(await pane.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await input.fill('Reviewed OpenCode task');
    await page.evaluate(() => { window.qa.failRename = true; });
    await pane.getByRole('button', { name: 'Save', exact: true }).click();
    await pane.getByRole('alert').filter({ hasText: 'Rename fixture refused' }).waitFor();
    assert.equal(await input.isVisible(), true);
    await page.evaluate(() => { window.qa.failRename = false; });
    await pane.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.session-row').filter({ hasText: 'Reviewed OpenCode task' }).waitFor();
    assert.equal(await input.count(), 0);
    await pane.getByRole('button', { name: 'Rename', exact: true }).click();
    assert.equal(await input.inputValue(), 'Reviewed OpenCode task');
    await page.screenshot({ path: path.join(screenshots, 'session-rename-update.png') });
    await input.press('Escape'); assert.equal(await input.count(), 0);
    await page.reload();
    await pane.getByText('Reviewed OpenCode task', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'New unit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
    await dialog.getByRole('combobox', { name: 'Launch preset', exact: true }).selectOption('opencode');
    assert.equal(await dialog.getByRole('combobox', { name: 'Provider', exact: true }).inputValue(), 'opencode');
    assert.equal(await dialog.getByRole('combobox', { name: 'Interaction mode', exact: true }).inputValue(), 'chat');
    await page.screenshot({ path: path.join(screenshots, 'opencode-launch.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 940, height: 650 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Update button overflowed the minimum desktop viewport');
    const update = await page.getByRole('button', { name: 'Update to v0.4.2', exact: true }).boundingBox();
    assert.ok(update && update.x >= 0 && update.x + update.width <= 940);
    await page.evaluate(() => localStorage.setItem('no-update', 'true'));
    await page.reload();
    await pane.waitFor();
    assert.equal(await page.getByRole('button', { name: /Update to/ }).count(), 0);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS desktop rename recovery, server errors, keyboard cancel, persisted roster/tab titles, update action/absence, OpenCode launch, and 1440/940px layout; screenshots: ${screenshots}`);
  } finally { await browser?.close(); await server?.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
