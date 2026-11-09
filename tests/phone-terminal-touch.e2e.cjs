// Browser plugin is unavailable: Chromium sends real touchscreen gestures to the
// production phone terminal. No terminal internals or private buffers are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createServer } = require('vite');
const directory = process.env.AGENTC2_SUITE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-phone-touch-'));
const calls = [], errors = [];
const viteCache = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-vite-qa-'));
let server, browser, page, sequence = 0;
(async () => {
  try {
    fs.mkdirSync(directory, { recursive: true });
    server = await createServer({ root: path.resolve(__dirname, '..'), cacheDir: viteCache, server: { host: '127.0.0.1', port: 0, strictPort: false } }); await server.listen();
    browser = await chromium.launch({ executablePath: process.env.AGENTC2_CHROMIUM || chromium.executablePath(), headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await context.newPage(); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => errors.push(error.message)); page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
    await page.exposeFunction('invokeTerminal', async (method, ...args) => {
      calls.push([method, ...args]);
      if (method === 'terminal:open') return 'observer-' + ++sequence;
      if (method === 'terminal:ready') return { state: { id: args[0], cols: 80, rows: 25, connection: 'connected', exitCode: null, canControl: false, controller: { id: 'desktop', name: 'Desktop' } }, sequence: 1, text: Array.from({ length: 200 }, (_, index) => `LOCAL_HISTORY_${String(index + 1).padStart(4, '0')}\r\n`).join('') + 'LOCAL_LATEST> ' };
      if (method === 'terminal:close') return;
      throw Error('Unexpected terminal action: ' + method);
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/phone-terminal.html`);
    const rows = page.locator('.phone-terminal .xterm-rows'), screen = page.locator('.phone-terminal .xterm-screen');
    await rows.filter({ hasText: 'LOCAL_LATEST>' }).waitFor();
    await screen.scrollIntoViewIfNeeded();
    const before = await rows.innerText();
    const cdp = await context.newCDPSession(page);
    async function swipe(direction) {
      const box = await screen.boundingBox();
      const x = Math.round(box.x + Math.min(box.width / 2, 130));
      const start = Math.round(box.y + (direction > 0 ? 40 : Math.min(box.height - 40, 240)));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y: start }] });
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x, y: start + direction * step * 20 }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await swipe(1);
    await page.waitForFunction((before) => document.querySelector('.phone-terminal .xterm-rows')?.textContent?.includes('LOCAL_HISTORY_') && document.querySelector('.phone-terminal .xterm-rows').innerText !== before, before, { timeout: 5000 });
    const after = await rows.innerText();
    const firstHistory = (text) => Number(text.match(/LOCAL_HISTORY_(\d+)/)?.[1]);
    assert.ok(firstHistory(after) < firstHistory(before), 'Finger down must reveal older local history');
    await page.screenshot({ path: path.join(directory, 'phone-touch-older-history.png') });
    await swipe(-1); await rows.filter({ hasText: 'LOCAL_LATEST>' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    assert.deepEqual(calls.filter(([method]) => !['terminal:open', 'terminal:ready', 'terminal:close'].includes(method)), [], 'Observer gestures must not send remote input, resize, or take control');
    await page.getByRole('button', { name: 'Detach', exact: true }).click(); await screen.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Attach', exact: true }).click(); await rows.filter({ hasText: 'LOCAL_LATEST>' }).waitFor();
    await swipe(1); await page.waitForFunction(() => !document.querySelector('.phone-terminal .xterm-rows')?.textContent?.includes('LOCAL_LATEST>'));
    await cdp.detach();
    fs.writeFileSync(path.join(directory, 'touch-evidence.json'), JSON.stringify({ before, after, calls }, null, 2));
    assert.deepEqual(errors, []);
    console.log('PASS real phone touch swipes reveal older/newer normal-buffer history, preserve observer control/input boundaries, and survive StrictMode disposal and detach/reattach');
  } catch (error) { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'phone-touch-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure-rows.txt'), await page.locator('.phone-terminal .xterm-rows').innerText().catch(() => 'Terminal unavailable')); } fs.writeFileSync(path.join(directory, 'browser-errors.json'), JSON.stringify(errors, null, 2)); throw error; }
  finally { await browser?.close(); await server?.close(); fs.rmSync(viteCache, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
