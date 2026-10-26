// Actual DOM focus, keyboard and form behavior through production components.
const assert = require('node:assert/strict');
const { poll } = require('./helpers/poll.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-navigation-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-navigation-vite-'));
const calls = [], errors = [];
let server, browser, page, deleteAction;
async function mount(name, props = {}) { await page.evaluate(({ name, props }) => window.qaMount(name, props), { name, props }); }
async function closed() { await page.getByText('Dialog closed', { exact: true }).waitFor(); }
(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: cache, server: { port: 0, host: '127.0.0.1', strictPort: false } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await page.exposeFunction('invokeBridge', async (name, ...args) => { calls.push([name, ...args]); if (name === 'deleteSession') return deleteAction(...args); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/component-ui.html`);
    const opener = page.locator('#launch'); await opener.focus();
    await mount('modal');
    const first = page.getByRole('button', { name: 'First dialog action', exact: true }), last = page.getByRole('button', { name: 'Last dialog action', exact: true });
    await first.waitFor(); await page.waitForFunction(() => document.activeElement?.textContent === 'First dialog action');
    await first.press('Shift+Tab'); assert.equal(await last.evaluate((node) => node === document.activeElement), true);
    await last.press('Tab'); assert.equal(await first.evaluate((node) => node === document.activeElement), true);
    await first.press('Tab'); assert.equal(await last.evaluate((node) => node === document.activeElement), true, 'Disabled controls must be excluded from the focus cycle');
    await page.getByText('Inside dialog content', { exact: true }).click(); assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await closed();
    assert.equal(await opener.evaluate((node) => node === document.activeElement), true, 'Closing restores the opener');
    await mount('modal', { restoreFocus: { current: false }, wide: true }); await first.waitFor();
    await page.locator('.dialog-backdrop').click({ position: { x: 2, y: 2 } }); await closed();
    assert.equal(await opener.evaluate((node) => node === document.activeElement), false, 'Explicitly suppressed restoration must not refocus the opener');
    await mount('modal', { empty: true }); await page.getByText('No dialog controls', { exact: true }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('dialog').evaluate((node) => node.contains(document.activeElement)), true, 'A dialog without controls must retain keyboard focus');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await page.getByRole('dialog').evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press('Escape'); await closed();

    await mount('modal', { disabledFirst: true }); await last.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Last dialog action');
    await opener.focus(); await page.keyboard.press('Tab'); assert.equal(await last.evaluate((node) => node === document.activeElement), true);
    await opener.focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await last.evaluate((node) => node === document.activeElement), true);
    await page.getByRole('dialog').focus(); await page.keyboard.press('Tab'); assert.equal(await last.evaluate((node) => node === document.activeElement), true);
    await page.getByRole('dialog').focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await last.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press('Escape'); await closed();

    await mount('keyboard', { overrides: {}, actions: { search: { available: false, reason: 'No available fixture units' } } });
    await page.getByText('No available fixture units', { exact: true }).waitFor();
    await page.getByText('Primary means Control.', { exact: false }).waitFor();
    const cycle = page.getByRole('textbox', { name: 'Shortcut Cycle Pane B forward', exact: true });
    await cycle.fill('Primary+K'); await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'conflicts' }).waitFor(); assert.equal(calls.filter((call) => call[0] === 'saveShortcuts').length, 0);
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click(); assert.equal(await page.getByRole('alert').count(), 0); assert.equal(await cycle.inputValue(), 'Alt+J');
    await cycle.fill('Ctrl+'); await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Choose a modified key' }).waitFor();
    await cycle.fill('Ctrl+Shift+J'); await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click(); await closed();
    assert.deepEqual(calls.findLast((call) => call[0] === 'saveShortcuts'), ['saveShortcuts', { cycleNext: 'Ctrl+Shift+J' }]);
    await mount('keyboard', { overrides: {}, actions: {} }); await page.getByRole('button', { name: 'Close keyboard help', exact: true }).click(); await closed();

    await mount('model', { model: 'fixture-model', disabled: false });
    const model = page.getByLabel('Chat model', { exact: true });
    await model.waitFor();
    const submitModel = () => page.locator('form.chat-model-selector').evaluate((form) => form.requestSubmit());
    await submitModel(); assert.equal(calls.filter((call) => call[0] === 'modelChange').length, 0, 'Submitting the current model is inert');
    await model.fill('invalid model'); await submitModel(); assert.equal(calls.filter((call) => call[0] === 'modelChange').length, 0, 'Programmatic form submission still enforces the model identifier contract');
    await model.fill('valid-next-model'); await page.getByRole('button', { name: 'Apply model', exact: true }).click();
    await poll(() => calls.some((call) => call[0] === 'modelChange'), 'Valid model submission was not delivered');
    assert.deepEqual(calls.findLast((call) => call[0] === 'modelChange'), ['modelChange', 'valid-next-model']);
    await mount('model', { model: null, disabled: true }); await submitModel(); assert.equal(calls.filter((call) => call[0] === 'modelChange').length, 1);
    for (const provider of ['codex', 'claude', 'antigravity', 'opencode', 'terminal']) {
      await mount('provider', { provider });
      const mark = page.locator('.provider-mark'); await mark.waitFor(); assert.equal(await mark.getAttribute('aria-label'), provider);
      assert.equal(await mark.evaluate((node) => node.classList.contains('provider-mark-small')), false);
    }
    await mount('provider', { provider: 'codex', small: true }); await page.locator('.provider-mark-small').waitFor();
    const session = { key: 'fixture/tmux:hq-123456abcdef', title: 'Owned fixture unit', hostName: 'Fixture host' };
    await mount('delete', { session }); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await closed();
    await mount('delete', { session });
    await page.evaluate(() => { window.qaSavedApi = window.agentHQ; window.agentHQ = undefined; });
    const beforeDelete = calls.filter((call) => call[0] === 'deleteSession').length;
    await page.getByRole('button', { name: 'Delete session', exact: true }).click();
    assert.equal(calls.filter((call) => call[0] === 'deleteSession').length, beforeDelete); assert.equal(await page.getByRole('dialog').count(), 1);
    await page.evaluate(() => { window.agentHQ = window.qaSavedApi; });
    deleteAction = async () => { throw Error('Native deletion fixture refused'); };
    await page.getByRole('button', { name: 'Delete session', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Native deletion fixture refused' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
    let deleted;
    deleteAction = async () => new Promise((resolve) => { deleted = resolve; });
    await page.getByRole('button', { name: 'Delete session', exact: true }).click();
    await page.getByRole('button', { name: 'Deleting…', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.locator('.dialog-backdrop').click({ position: { x: 2, y: 2 } });
    assert.equal(await page.getByRole('dialog').count(), 1, 'A pending deletion must keep its confirmation visible');
    await page.keyboard.press('Tab'); assert.equal(await page.getByRole('dialog').evaluate((node) => node.contains(document.activeElement)), true, 'A busy deletion with disabled buttons must retain focus');
    assert.equal(calls.filter((call) => call[0] === 'deleted').length, 0);
    await page.screenshot({ path: path.join(directory, 'busy-delete-focus.png') });
    assert.ok(deleted); deleted(); await page.getByText('Dialog unmounted', { exact: true }).waitFor();
    assert.deepEqual(calls.findLast((call) => call[0] === 'deleteSession'), ['deleteSession', session.key]);

    await context.addInitScript(() => { window.qaPlatform = 'darwin'; window.agentHQ = { platform: 'darwin' }; });
    const mac = await context.newPage(); mac.setDefaultNavigationTimeout(60000);
    mac.on('pageerror', (error) => errors.push(error.message)); mac.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await mac.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await mac.exposeFunction('invokeBridge', async (name, ...args) => { calls.push([name, ...args]); });
    await mac.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/component-ui.html`);
    await mac.evaluate(() => window.qaMount('keyboard', { overrides: {}, actions: {} }));
    await mac.getByText('Primary means Command.', { exact: false }).waitFor();
    await mac.screenshot({ path: path.join(directory, 'keyboard-macos.png') });
    await mac.getByRole('button', { name: 'Close keyboard help', exact: true }).click(); await mac.getByText('Dialog closed', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS modal focus wrapping/restoration and empty dialogs, keyboard remapping conflict/reset/close behavior, and guarded current/invalid/disabled model form submission, provider defaults, exact delete/recovery/busy focus, and macOS shortcut labels');
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'navigation-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); } throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(cache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
