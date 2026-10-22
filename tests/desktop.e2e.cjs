// Browser plugin not available: Playwright launches the actual Electron entry point.
// No SSH host or provider CLI is required. All data and PTY input are isolated.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { Store } = require('../electron/config.cjs');
const { packagePath } = require('../scripts/package-path.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-desktop-'));
  const store = new Store(directory);
  store.save('settings', { ...store.data.settings, hosts: [{ id: 'default', name: 'Offline smoke fixture', target: '127.0.0.1', port: 1, enabled: true }] });
  let app, clipboardBefore;
  const errors = [];
  let stage = 'Electron launch';
  const deadline = setTimeout(() => { console.error(`Desktop smoke timed out during ${stage}`); process.exit(1); }, 180000);
  deadline.unref();
  try {
    app = await _electron.launch({
      executablePath: packaged ? packagePath(root) : require('electron'),
      args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(directory, 'browser')}`], cwd: root,
      env: { ...process.env, NODE_ENV: 'production', AGENTC2_DATA_DIR: directory }, timeout: 60000,
    });
    stage = 'initial renderer';
    let page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    assert.equal(await page.title(), 'AgentC2'); assert.ok(page.url().startsWith('file:'));
    await page.getByRole('textbox', { name: 'Search sessions' }).waitFor();
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => window.agentHQ.platform), process.platform);
    await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      const image = items.find((item) => item.types.includes('image/png'));
      globalThis.__agentc2ClipboardBefore = { text: await clipboard.readText(), png: image ? await image.getType('image/png') : null };
    });
    clipboardBefore = await page.evaluate(() => window.agentHQ.readClipboard());
    await page.evaluate(() => window.agentHQ.writeClipboard('AgentC2 clipboard λ'));
    assert.equal(await page.evaluate(() => window.agentHQ.readClipboard()), 'AgentC2 clipboard λ');
    stage = 'native image clipboard';
    const imageClipboard = await app.evaluate(async ({ app, clipboard, ClipboardItem, nativeImage }, helper) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const image = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 });
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
      const types = (await clipboard.read()).flatMap((item) => item.types);
      const png = await load(helper).readClipboardPng(clipboard, nativeImage);
      return { length: png?.length, signature: png?.subarray(0, 8).toString('hex'), types, sourceLength: image.toPNG().length };
    }, path.join(root, 'electron', 'clipboard-image.cjs'));
    assert.ok(imageClipboard.length > 24, JSON.stringify(imageClipboard));
    assert.equal(imageClipboard.signature, '89504e470d0a1a0a');
    stage = 'native PTY';
    const native = await app.evaluate(async ({ app }, helper) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const rounds = process.platform === 'win32' ? 3 : 1;
      let result;
      for (let round = 0; round < rounds; round++) {
        result = await load(helper).nativePtySmoke(load('node-pty'), { platform: process.platform, env: { ...process.env }, cwd: app.getPath('home') });
      }
      return { ...result, rounds, packaged: app.isPackaged, platform: process.platform, arch: process.arch };
    }, path.join(__dirname, 'helpers', 'native-pty-smoke.cjs'));
    assert.equal(native.packaged, packaged); assert.equal(native.output, true);
    console.log(`PASS ${packaged ? 'packaged' : 'development'} Electron startup, isolated preload, node-pty spawn/input/resize/exit (${native.platform}/${native.arch}, ${native.rounds} rounds)`);
    stage = 'shortcuts and settings';
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+k`);
    await page.getByRole('textbox', { name: 'Quick switcher search' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Remote access', exact: true }).click();
    await page.getByText('Enable remote access and tray operation', { exact: true }).waitFor();
    assert.ok(!(await page.locator('.remote-access').innerText()).includes('Windows PC'));
    await page.getByRole('textbox', { name: 'Companion origin', exact: true }).fill('https://agentc2-smoke.example.ts.net');
    const screenshots = process.env.AGENTC2_QA_SCREENSHOT_DIR || os.tmpdir();
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `agentc2-${process.platform}-${process.arch}-${packaged ? 'package' : 'desktop'}.png`) });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    stage = 'remote-access close/reopen';
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise((resolve) => server.close(resolve));
    await page.evaluate((port) => window.agentHQ.saveRemote({ enabled: true, port, url: 'https://agentc2-smoke.example.ts.net' }), port);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal((await page.evaluate(() => window.agentHQ.remoteStatus())).running, true);
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
      file.submenu.items.find((item) => item.label === 'Open AgentC2').click();
    });
    await page.waitForFunction(() => document.visibilityState === 'visible');
    await page.evaluate(() => window.agentHQ.saveRemote({ enabled: false, port: 43127, url: '' }));
    assert.equal((await page.evaluate(() => window.agentHQ.remoteStatus())).enabled, false);
    if (process.platform === 'darwin') {
      stage = 'macOS last-window close';
      const closed = page.waitForEvent('close', { timeout: 30000 });
      await page.close();
      await closed;
      stage = 'macOS Dock activation';
      // Playwright's page-close event can precede Electron removing the native
      // BrowserWindow. Activating during that gap can target a closing window.
      for (let attempt = 0; attempt < 50; attempt++) {
        if (!await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) await app.evaluate(({ app }) => app.emit('activate'));
      // Activation may also arrive from the OS during the preceding close.
      // Resolve an existing window as well as one still being announced.
      page = await app.firstWindow({ timeout: 30000 });
      stage = 'macOS restored renderer';
      await page.getByRole('textbox', { name: 'Search sessions' }).waitFor();
      assert.equal((await page.evaluate(() => window.agentHQ.getState())).settings.hosts[0].name, 'Offline smoke fixture');
    }
    assert.deepEqual(errors, []);
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const before = globalThis.__agentc2ClipboardBefore;
      if (before.png) await clipboard.write([new ClipboardItem({ 'image/png': before.png, 'text/plain': before.text })]);
      else await clipboard.writeText(before.text);
      delete globalThis.__agentc2ClipboardBefore;
    }); clipboardBefore = undefined;
    console.log('PASS native clipboard, primary switcher shortcut, settings rendering, remote-access window lifecycle, native Open menu, and renderer health');
  } catch (error) {
    console.error(`Desktop smoke failed during ${stage}:`, error);
    throw error;
  } finally {
    stage = 'Electron shutdown';
    if (clipboardBefore !== undefined && app) await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const before = globalThis.__agentc2ClipboardBefore;
      if (before.png) await clipboard.write([new ClipboardItem({ 'image/png': before.png, 'text/plain': before.text })]);
      else await clipboard.writeText(before.text);
      delete globalThis.__agentc2ClipboardBefore;
    }).catch(() => {});
    await app?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    clearTimeout(deadline);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
