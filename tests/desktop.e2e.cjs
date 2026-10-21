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
    clipboardBefore = await page.evaluate(() => window.agentHQ.readClipboard());
    await page.evaluate(() => window.agentHQ.writeClipboard('AgentC2 clipboard λ'));
    assert.equal(await page.evaluate(() => window.agentHQ.readClipboard()), 'AgentC2 clipboard λ');
    stage = 'native PTY';
    const native = await app.evaluate(async ({ app }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const pty = load('node-pty');
      const marker = `NATIVE_${Date.now()}`;
      const terminal = pty.spawn(process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh', process.platform === 'win32' ? ['/d', '/q'] : [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: app.getPath('home'), env: { ...process.env } });
      return await new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => { terminal.kill(); reject(new Error('Native PTY smoke timed out')); }, 15000);
        terminal.onData((data) => { output += data; });
        terminal.onExit(({ exitCode }) => {
          clearTimeout(timeout);
          if (exitCode !== 0 || !output.includes(marker)) reject(new Error(`Native PTY failed (${exitCode}): ${output}`));
          else resolve({ packaged: app.isPackaged, platform: process.platform, arch: process.arch, output: true });
        });
        terminal.resize(100, 32);
        terminal.write(`echo ${marker}\r`);
        terminal.write('exit\r');
      });
    });
    assert.equal(native.packaged, packaged); assert.equal(native.output, true);
    console.log(`PASS ${packaged ? 'packaged' : 'development'} Electron startup, isolated preload, node-pty spawn/input/resize/exit (${native.platform}/${native.arch})`);
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
    if (process.platform === 'darwin') {
      stage = 'macOS last-window close';
      const closed = page.waitForEvent('close', { timeout: 30000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
      stage = 'macOS Dock activation';
      await app.evaluate(({ app }) => app.emit('activate'));
      // Activation may also arrive from the OS during the preceding close.
      // Resolve an existing window as well as one still being announced.
      page = await app.firstWindow({ timeout: 30000 });
      stage = 'macOS restored renderer';
      await page.getByRole('textbox', { name: 'Search sessions' }).waitFor();
      assert.equal((await page.evaluate(() => window.agentHQ.getState())).settings.hosts[0].name, 'Offline smoke fixture');
    }
    assert.deepEqual(errors, []);
    await page.evaluate((text) => window.agentHQ.writeClipboard(text), clipboardBefore); clipboardBefore = undefined;
    console.log('PASS native clipboard, primary switcher shortcut, settings rendering, remote-access window lifecycle, native Open menu, and renderer health');
  } catch (error) {
    console.error(`Desktop smoke failed during ${stage}:`, error);
    throw error;
  } finally {
    stage = 'Electron shutdown';
    if (clipboardBefore !== undefined && app?.windows()[0]) await app.windows()[0].evaluate((text) => window.agentHQ.writeClipboard(text), clipboardBefore).catch(() => {});
    await app?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    clearTimeout(deadline);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
