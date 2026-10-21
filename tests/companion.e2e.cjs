// Browser plugin not available: Playwright drives Chromium and Electron.
// A local transport proxy exercises the production HTTPS-origin/cookie checks
// without signing into Tailscale. Only isolated shell fixtures receive input.
const { _electron, chromium, webkit } = require('playwright-core');
const { WebSocket } = require('ws');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-companion-test-'));
const host = process.env.AGENTC2_HOST || process.env.AGENT_HQ_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an explicitly configured SSH test host');
const ssh = require('../electron/platform.cjs').sshBinary();
const name = `hq-${crypto.randomBytes(6).toString('hex')}`;
const marker = `HQ_PHONE_${crypto.randomBytes(4).toString('hex')}`;
const created = [];
const errors = [];
let app, browser;
const proxySockets = new Set();
function remote(action) {
  const source = `
import subprocess,sys,json,base64,shlex
p=json.loads(base64.b64decode(sys.argv[1])); name=p['name']
def run(*args):
 r=subprocess.run(args,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
if p['action']=='setup':
 run('tmux','new-session','-d','-s',name,'-n','setup')
 for k,v in [('provider','codex'),('title',p['marker']),('cwd','/tmp')]: run('tmux','set-option','-t',name,'@hq_'+k,v)
 run('tmux','set-option','-t',name,'history-limit','50000')
 program="import os; [print('PHONE_HISTORY_%05d'%i,flush=True) for i in range(1,2001)]; os.execvpe('bash',['bash','--noprofile','--norc'],dict(os.environ,PS1='PHONE_FIXTURE> '))"
 run('tmux','new-window','-t',name,'-n','chat',shlex.join(['python3','-u','-c',program]))
 run('tmux','kill-window','-t',name+':setup')
 print('{}')
elif p['action']=='cleanup':
 for n in [name]+p['created']: subprocess.run(['tmux','kill-session','-t',n],capture_output=True)
 print('{}')
`;
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, 'python3', '-', Buffer.from(JSON.stringify({ action, name, marker, created })).toString('base64')], { windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject); child.on('close', (code) => code ? reject(new Error(error)) : resolve(output)); child.stdin.end(source);
  });
}
async function poll(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
  throw new Error(message);
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}

(async () => {
  try {
    const { Store } = require('../electron/config.cjs');
    const store = new Store(directory);
    store.save('workspace', { tabs: [`default/tmux:${name}`], selectedKey: `default/tmux:${name}`, splitKey: null, metadata: { [`default/tmux:${name}`]: { pinned: true, project: 'Phone QA', notes: 'Review the phone fixture.' } } });
    const settings = store.data.settings;
    settings.presets.push({ id: 'phone-qa', name: 'Phone QA shell', provider: 'claude', command: 'python3', args: `-u -c 'import sys; print("PHONE_LAUNCH_OK",flush=True); sys.exit(0)'`, cwd: '/tmp', instructions: '', fullPermissions: false, attentionHooks: false, hostId: 'default' });
    store.save('settings', settings);
    await remote('setup');
    const packaged = process.env.AGENT_HQ_QA_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || require('electron'), args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(directory, 'browser')}`], cwd: root, env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: directory } });
    const desktop = await app.firstWindow();
    desktop.on('pageerror', (error) => errors.push(`desktop: ${error.message}`));
    await desktop.locator('.session-row').filter({ hasText: marker }).waitFor({ timeout: 60000 });
    await desktop.locator('.session-pane:visible .terminal-panel.is-attached').waitFor({ timeout: 30000 });
    assert.equal((await desktop.evaluate(() => window.agentHQ.remoteStatus())).enabled, false);
    const port = await freePort();
    const ipMode = process.env.AGENT_HQ_COMPANION_IP === '1';
    const origin = ipMode ? 'http://100.64.0.10:8080' : 'https://agent-hq-qa.test.ts.net';
    const config = { enabled: true, port, url: origin, transport: ipMode ? 'tailnet-http' : 'https' };
    await desktop.evaluate((value) => window.agentHQ.saveRemote(value), config);
    await desktop.getByRole('button', { name: 'Settings', exact: true }).click();
    await desktop.getByRole('button', { name: 'Remote access', exact: true }).click();
    await desktop.getByRole('button', { name: 'Pair a device', exact: true }).click();
    await desktop.getByAltText('Scan to pair your phone').waitFor();
    await desktop.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-remote-settings.png') });
    // Generate a fresh link through the narrow desktop bridge (never log it).
    const pair = await desktop.evaluate(() => window.agentHQ.pairRemote());
    browser = process.env.AGENT_HQ_COMPANION_BROWSER === 'webkit'
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ headless: true, channel: process.platform === 'win32' && process.env.AGENTC2_COMPANION_CHROMIUM !== '1' ? 'msedge' : undefined });
    // Service-worker installation bypasses Playwright's local HTTP proxy routes.
    // Its static source is checked separately; real installation needs Tailscale.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('401')) errors.push(`console: ${message.text()}`); });
    await page.route(origin + '/**', async (route) => {
      try {
        const request = route.request();
        const target = new URL(request.url());
        const response = await route.fetch({ url: `http://127.0.0.1:${port}${target.pathname}${target.search}`, headers: { ...request.headers(), host: new URL(origin).host, ...(request.method() !== 'GET' ? { origin } : {}) } });
        await route.fulfill({ response });
      } catch { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Gateway offline"}' }).catch(() => {}); }
    });
    await page.routeWebSocket(origin.replace('https:', 'wss:').replace('http:', 'ws:') + '/**', async (socket) => {
      const cookies = await context.cookies(origin);
      const proxy = new WebSocket(`ws://127.0.0.1:${port}/api/v1/socket`, { headers: { host: new URL(origin).host, origin, cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') } });
      proxySockets.add(proxy);
      const pending = [];
      socket.onMessage((data) => { if (proxy.readyState === WebSocket.OPEN) proxy.send(data); else pending.push(data); });
      proxy.on('open', () => { for (const data of pending) proxy.send(data); });
      proxy.on('message', (data) => socket.send(data.toString()));
      proxy.on('error', () => socket.close({ code: 1011, reason: 'Proxy unavailable' }));
      proxy.on('close', (code, reason) => { proxySockets.delete(proxy); socket.close({ code: code === 1006 ? 1011 : code, reason: reason.toString() }); });
      socket.onClose(() => { proxy.close(); proxySockets.delete(proxy); });
    });
    await page.goto(pair.url);
    assert.equal(await page.title(), 'AgentC2 Companion');
    await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search sessions', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('textbox', { name: 'Search sessions', exact: true }).fill(marker);
    await page.locator('.phone-session-row').filter({ hasText: marker }).waitFor({ timeout: 60000 });
    assert.equal(await page.evaluate(() => isSecureContext), !ipMode);
    if (ipMode) assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-phone-sessions.png') });
    console.log('PASS production-cookie pairing and mobile session list');
    await page.locator('.phone-session-row').filter({ hasText: marker }).click();
    await page.getByRole('button', { name: 'Take control', exact: true }).waitFor();
    await poll(() => page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), 'Phone terminal did not attach');
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    console.log('Phone requested control');
    await poll(() => desktop.locator('.session-pane:visible .control-owner').innerText().then((text) => text.includes('My phone controls')), 'Desktop did not show phone ownership');
    const handle = await desktop.evaluate((sessionName) => window.agentHQ.openTerminal(sessionName, 100, 32, 'default'), name);
    await assert.rejects(desktop.evaluate((id) => window.agentHQ.writeTerminal(id, 'MUST_NOT_WRITE'), handle), /Take control/);
    await page.getByLabel('Prompt or reply').fill(`printf '${marker}_REPLY\\n'`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    console.log('Phone composer submitted fixture command');
    await poll(async () => (await desktop.evaluate((id) => window.agentHQ.terminalHistory(id), handle)).text.split('\n').some((line) => line.trim() === `${marker}_REPLY`), 'Phone composer did not send to the fixture');
    await page.getByRole('button', { name: 'Find history', exact: true }).click();
    await page.getByRole('textbox', { name: 'Find in history' }).fill('PHONE_HISTORY_00001');
    await poll(async () => (await page.locator('.phone-history').innerText()).includes('1 of 1'), 'Retained history search failed');
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-phone-terminal.png'), fullPage: true });
    await desktop.getByRole('button', { name: 'Close settings', exact: true }).click();
    await desktop.locator('.session-pane:visible').getByRole('button', { name: 'Take control', exact: true }).click();
    await poll(async () => (await page.locator('.phone-control').innerText()).includes('Desktop controls'), 'Phone did not show desktop reclaim');
    console.log('PASS mobile pairing, responsive session list, live terminal, composer, retained-history search, server-enforced handoff, and desktop reclaim');
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (process.platform === 'linux') {
        // Force the asynchronous window-manager acknowledgement seen in CI.
        // The real native minimize still runs; an immediate assertion must fail.
        const minimize = window.minimize.bind(window);
        window.minimize = () => { window.minimize = minimize; setTimeout(minimize, 100); };
      }
      window.close();
    });
    await poll(() => app.evaluate(({ BrowserWindow }) => process.platform === 'linux' ? BrowserWindow.getAllWindows()[0].isMinimized() : !BrowserWindow.getAllWindows()[0].isVisible()), 'Window close did not minimize/hide the native window');
    assert.equal((await desktop.evaluate(() => window.agentHQ.remoteStatus())).running, true);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].restore(); BrowserWindow.getAllWindows()[0].show(); });
    await desktop.evaluate((value) => window.agentHQ.saveRemote({ ...value, enabled: false }), config);
    await poll(async () => (await page.locator('.phone-connection').innerText()) !== 'Connected', 'Phone did not notice gateway shutdown');
    await desktop.evaluate((value) => window.agentHQ.saveRemote(value), config);
    await poll(async () => (await page.locator('.phone-connection').innerText()) === 'Connected', 'Phone did not reconnect');
    await poll(() => page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), 'Reconnect did not reopen the terminal');
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
    const state = await desktop.evaluate((id) => window.agentHQ.terminalState(id), handle);
    assert.equal(state.canControl, true);
    const sleepingSocket = [...proxySockets].find((socket) => socket.readyState === WebSocket.OPEN);
    assert.ok(sleepingSocket);
    const disconnectForSleep = once(sleepingSocket, 'close', { signal: AbortSignal.timeout(15000) });
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
    const [sleepCode] = await disconnectForSleep;
    assert.equal(sleepCode, 4004);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await poll(async () => (await page.locator('.phone-connection').innerText()) === 'Connected', 'Phone did not reconnect after simulated sleep');
    await poll(() => page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), 'Sleep reconnect did not restore observation');
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
    await desktop.evaluate((id) => window.agentHQ.closeTerminal(id), handle);
    console.log('PASS platform window close keeps gateway accessible and active, disable disconnects clients, and reconnect/simulated sleep restore viewing without reclaiming input');
    const savedSettings = (await desktop.evaluate(() => window.agentHQ.getState())).settings;
    await desktop.evaluate((settings) => window.agentHQ.saveSettings({ ...settings, presets: [] }), savedSettings);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('combobox', { name: 'Session type', exact: true }).selectOption('terminal');
    assert.equal(await page.getByRole('combobox', { name: 'Launch preset', exact: true }).count(), 0);
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(`${marker} terminal`);
    await page.getByRole('textbox', { name: 'Working directory', exact: true }).fill('/tmp');
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    await page.getByRole('dialog', { name: 'New session', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
    const shell = (await desktop.evaluate(() => window.agentHQ.inventory())).sessions.find((session) => session.title === `${marker} terminal`);
    assert.ok(shell); created.push(shell.id);
    assert.equal(shell.provider, 'terminal'); assert.equal(shell.cwd, '/tmp');
    await poll(() => page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), 'New shell did not attach');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByLabel('Command', { exact: true }).fill("export HQ_PHONE_REATTACH=retained; printf '\\033[2J\\033[Hhttps://example.com/hq\\n'");
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await poll(async () => (await page.locator('.phone-terminal .xterm-rows').innerText()).includes('https://example.com/hq'), 'Shell link did not render');
    await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>AgentC2 link test</title>Browser tab opened' }));
    const shellScreen = await page.locator('.phone-terminal .xterm-screen').boundingBox();
    await page.mouse.move(shellScreen.x + 40, shellScreen.y + 8);
    await page.waitForTimeout(250);
    const popupPromise = context.waitForEvent('page');
    await page.mouse.click(shellScreen.x + 40, shellScreen.y + 8);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), 'https://example.com/hq');
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.ok(page.url().startsWith(origin));
    await popup.close();
    await page.getByRole('button', { name: 'Detach', exact: true }).click();
    await page.locator('.phone-terminal').waitFor({ state: 'hidden' });
    assert.ok((await desktop.evaluate(() => window.agentHQ.inventory())).sessions.some((s) => s.id === shell.id && s.state === 'live'));
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await poll(() => page.getByRole('button', { name: 'Take control', exact: true }).isEnabled(), 'Shell did not reattach');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByLabel('Command', { exact: true }).fill('printf "PHONE_REATTACH_%s\\n" "$HQ_PHONE_REATTACH"');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await poll(async () => (await page.locator('.phone-terminal .xterm-rows').innerText()).includes('PHONE_REATTACH_retained'), 'Phone detach did not preserve shell state');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-shell-mobile.png'), fullPage: true });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await poll(async () => !(await desktop.evaluate(() => window.agentHQ.inventory())).sessions.some((s) => s.id === shell.id), 'Phone stop did not remove the shell');
    await desktop.evaluate((settings) => window.agentHQ.saveSettings(settings), savedSettings);
    console.log('PASS companion terminal creation without any saved presets, links opening a separate browser tab without an opener, detach/reattach with retained state, and stop');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('combobox', { name: 'Launch preset', exact: true }).selectOption('phone-qa');
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(`${marker} launched`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.getByRole('dialog', { name: 'New session', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
    let inventory = await desktop.evaluate(() => window.agentHQ.inventory());
    const launched = inventory.sessions.find((session) => session.title === `${marker} launched`); assert.ok(launched); created.push(launched.id);
    await desktop.evaluate(() => window.agentHQ.inventory());
    await page.getByRole('button', { name: /^Attention/ }).click();
    await poll(async () => { inventory = await desktop.evaluate(() => window.agentHQ.inventory()); return inventory.attention.some((item) => item.sessionKey === launched.key); }, 'Launch completion did not appear');
    await page.locator('.phone-attention').filter({ hasText: `${marker} launched` }).waitFor();
    await page.locator('.phone-attention').filter({ hasText: `${marker} launched` }).getByRole('button', { name: 'Acknowledge', exact: true }).click();
    await poll(async () => (await desktop.evaluate(() => window.agentHQ.getState())).attention.filter((item) => item.sessionKey === launched.key).every((item) => item.acknowledged), 'Acknowledgment did not reach desktop');
    await page.setViewportSize({ width: 900, height: 900 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-companion-wide.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const paired = await desktop.evaluate(() => window.agentHQ.remoteStatus());
    await desktop.evaluate((id) => window.agentHQ.revokeRemote(id), paired.devices[0].id);
    await page.getByRole('heading', { name: 'Your agents, within reach.', exact: true }).waitFor();
    console.log('PASS companion session creation using saved presets, confirmed attention events, shared acknowledgment, wide layout, and device revocation');
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Companion QA failed:', error);
    throw error;
  } finally {
    for (const socket of proxySockets) socket.terminate();
    await browser?.close();
    if (app) {
      const windows = app.windows();
      if (windows[0]) await windows[0].evaluate(async () => { const config = await window.agentHQ.remoteStatus(); await window.agentHQ.saveRemote({ ...config, enabled: false }); }).catch(() => {});
      await app.close();
    }
    await remote('cleanup').catch((error) => console.error('Fixture cleanup:', error.message));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
