// Delayed public IPC responses reproduce the desktop-sync draft race seen in
// the native macOS Intel trace. Production React is rendered in Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-peer-draft-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-peer-draft-vite-'));
let server, browser, page, loading, saving;
const calls = [], errors = [], handlers = new Map();
const status = (extra = {}) => ({ id: 'fixture', enabled: false, running: false, deviceName: 'Machine hostname', bindAddress: '127.0.0.1', port: 43128, address: '', error: '', peers: [], ...extra });
async function until(predicate, label) { for (let tick = 0; tick < 100; tick++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw Error(label); }
async function settled(name) { const count = calls.filter((call) => call[0] === name).length; await page.waitForFunction(({ name, count }) => window.qaBridgeSettled.filter((value) => value === name).length >= count, { name, count }); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function mount() { loading = null; await page.evaluate(() => window.qaMount('peers')); await until(() => loading, 'Initial status read missing'); }
(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: cache, server: { port: 0, host: '127.0.0.1', strictPort: false } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    handlers.set('peerSyncStatus', async () => new Promise((resolve, reject) => { loading = { resolve, reject }; }));
    handlers.set('savePeerSync', async (input) => new Promise((resolve) => { saving = { input, resolve }; }));
    await page.exposeFunction('invokeBridge', async (name, ...args) => { calls.push([name, ...structuredClone(args)]); assert.ok(handlers.has(name), name); return handlers.get(name)(...args); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/component-ui.html`);
    await mount();
    const name = page.getByRole('textbox', { name: 'Device name', exact: true });
    const address = page.getByRole('textbox', { name: 'LAN / VPN bind address', exact: true });
    const port = page.getByRole('spinbutton', { name: 'Sync port', exact: true });
    const enabled = page.getByRole('checkbox', { name: 'Enable desktop sync', exact: true });
    const apply = page.getByRole('button', { name: 'Apply desktop sync', exact: true });
    await name.fill('Command desktop'); await enabled.check(); await address.fill('10.0.0.2'); await port.fill('0');
    loading.resolve(status()); await settled('peerSyncStatus');
    assert.equal(await name.inputValue(), 'Command desktop', 'A delayed initial status must not overwrite an edited device name');
    assert.equal(await enabled.isChecked(), true); assert.equal(await address.inputValue(), '10.0.0.2'); assert.equal(await port.inputValue(), '0');
    await apply.click(); await until(() => saving, 'Save missing');
    assert.deepEqual(saving.input, { enabled: true, deviceName: 'Command desktop', bindAddress: '10.0.0.2', port: 0 });
    await name.fill('Draft after request'); await port.fill('43210');
    saving.resolve(status({ ...saving.input, running: true, address: 'ws://10.0.0.2:43000' })); await settled('savePeerSync');
    assert.equal(await name.inputValue(), 'Draft after request', 'Save acknowledgement must preserve edits made while saving');
    assert.equal(await port.inputValue(), '43210');
    saving = null; await apply.click(); await until(() => saving, 'Second save missing');
    assert.equal(saving.input.deviceName, 'Draft after request'); assert.equal(saving.input.port, 43210);
    saving.resolve(status({ ...saving.input, running: true, address: 'ws://10.0.0.2:43210' })); await settled('savePeerSync');
    await page.getByRole('status').filter({ hasText: 'Listening at ws://10.0.0.2:43210' }).waitFor();
    await page.screenshot({ path: path.join(directory, 'peer-preserved-draft.png') });

    // Push status supersedes an older initial read, including its errors.
    for (const reject of [false, true]) {
      await mount();
      await page.evaluate((value) => window.qaEmit('onPeerSyncStatus', value), status({ enabled: true, running: true, address: 'ws://127.0.0.1:43211' }));
      await name.fill('Unsent peer draft');
      if (reject) loading.reject(Error('Stale initial status error')); else loading.resolve(status());
      await settled('peerSyncStatus');
      await page.getByRole('status').filter({ hasText: 'Listening at ws://127.0.0.1:43211' }).waitFor();
      assert.equal(await name.inputValue(), 'Unsent peer draft'); assert.equal(await page.getByRole('alert').count(), 0);
    }
    // Editing one field must still load the saved values of untouched fields.
    await mount(); await name.fill('Partially edited peer');
    loading.resolve(status({ enabled: true, deviceName: 'Old name', bindAddress: '10.0.0.9', port: 43219 })); await settled('peerSyncStatus');
    assert.equal(await name.inputValue(), 'Partially edited peer');
    assert.equal(await enabled.isChecked(), true, 'Untouched enabled state must load from saved configuration');
    assert.equal(await address.inputValue(), '10.0.0.9'); assert.equal(await port.inputValue(), '43219');
    await name.fill('  Trim this saved name  '); saving = null; await apply.click(); await until(() => saving, 'Partial edit save missing');
    await port.fill('43220');
    saving.resolve(status({ ...saving.input, deviceName: 'Trim this saved name' })); await settled('savePeerSync');
    assert.equal(await name.inputValue(), 'Trim this saved name', 'Acknowledgement must normalize fields not edited during the save');
    assert.equal(await port.inputValue(), '43220');
    await mount(); loading.reject(Error('Current desktop-sync status unavailable')); await settled('peerSyncStatus');
    await page.getByRole('alert').filter({ hasText: 'Current desktop-sync status unavailable' }).waitFor();
    await name.fill('Recoverable initial draft'); assert.equal(await name.inputValue(), 'Recoverable initial draft');
    // Ordinary untouched initialization and explicit save still read back the
    // server's normalized configuration.
    await mount(); loading.resolve(status({ deviceName: 'Loaded peer' })); await settled('peerSyncStatus');
    assert.equal(await name.inputValue(), 'Loaded peer');
    await name.fill('  Normalized peer  '); saving = null; await apply.click(); await until(() => saving, 'Normalized save missing');
    saving.resolve(status({ ...saving.input, deviceName: 'Normalized peer' })); await settled('savePeerSync');
    assert.equal(await name.inputValue(), 'Normalized peer');
    await page.evaluate(() => window.qaUnmount()); await page.getByText('Dialog unmounted', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS desktop-sync edited initialization/save drafts, exact submitted config, newer status/error ordering, normalized readback and disposal');
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'peer-draft-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable')); } throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(cache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
