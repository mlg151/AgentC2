// Live SSH regression test. Creates isolated shell/fullscreen fixtures, never sends a model
// prompt, restores the clipboard, and deletes only its own fixture sessions.
const { _electron } = require('playwright-core');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const labels = ['A', 'B', 'KEYS', 'MOUSE'];
const names = labels.map(() => `hq-${crypto.randomBytes(6).toString('hex')}`);
const host = process.env.AGENTC2_HOST || process.env.AGENT_HQ_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an explicitly configured SSH test host');
const ssh = require('../electron/platform.cjs').sshBinary();

function remote(action) {
  const payload = Buffer.from(JSON.stringify({ action, names,
    fixture: fs.readFileSync(path.join(__dirname, 'fixtures', 'scroll-app.py'), 'utf8'),
    helper: fs.readFileSync(path.join(root, 'electron', 'remote.py'), 'utf8'),
  })).toString('base64');
  const source = `
import sys,json,base64,subprocess,shlex
p=json.loads(base64.b64decode('${payload}')); names=p['names']
def run(*args):
 r=subprocess.run(args,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
if p['action']=='setup':
 for name,label in zip(names,['A','B','KEYS','MOUSE']):
  run('tmux','new-session','-d','-s',name,'-n','setup')
  for key,value in [('provider','claude' if label=='MOUSE' else 'codex'),('title','AgentC2 terminal regression '+label),('cwd','/tmp')]:
   run('tmux','set-option','-t',name,'@hq_'+key,value)
  run('tmux','set-option','-t',name,'history-limit','50000')
  program="import os; [print('HQ_HISTORY_"+label+"_%05d'%i,flush=True) for i in range(1,5001)]; os.execvpe('bash',['bash','--noprofile','--norc'],dict(os.environ,PS1='HQ_TEST_"+label+"> '))"
  if label in ('KEYS','MOUSE'): program=p['fixture']
  run('tmux','new-window','-t',name,'-n','chat','-c','/tmp',shlex.join(['python3','-u','-c',program,label]))
  run('tmux','kill-window','-t',name+':setup')
 print(json.dumps({'ok':True}))
elif p['action']=='state':
 print(json.dumps([{'name':n,'mode':run('tmux','display-message','-p','-t',n,'#{pane_in_mode}'),'position':run('tmux','display-message','-p','-t',n,'#{scroll_position}'),'mouse':run('tmux','show-option','-v','-t',n,'mouse'),'text':run('tmux','capture-pane','-p','-t',n)} for n in names]))
elif p['action']=='image-input':
 print(json.dumps(run('tmux','capture-pane','-p','-J','-t',names[0])))
elif p['action'].startswith('fallback-'):
 scope={'__name__':'hq_test'}; exec(compile(p['helper'],'remote.py','exec'),scope)
 direction=p['action'].split('-',1)[1]
 print(json.dumps(scope['scroll_session']({'name':names[2],'direction':direction,'lines':12})))
elif p['action']=='legacy-copy':
 run('tmux','copy-mode','-t',names[2]); print('{}')
elif p['action']=='image-state':
 import os,stat,pathlib,re
 root=pathlib.Path.home()/'.cache'/'agent-hq'/'uploads'
 print(json.dumps([{'name':f.name,'size':f.stat().st_size,'mode':stat.S_IMODE(f.stat().st_mode),'magic':f.open('rb').read(8).hex()} for f in root.iterdir() if re.fullmatch(r'agentc2-[a-f0-9]{32}\.png',f.name)] if root.is_dir() else []))
elif p['action']=='cleanup':
 for n in names: subprocess.run(['tmux','kill-session','-t',n],capture_output=True)
 print('{}')
`;
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-'], { windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', (data) => output += data);
    child.stderr.on('data', (data) => error += data);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code) reject(new Error(error));
      else { try { resolve(JSON.parse(output)); } catch (cause) { reject(cause); } }
    });
    child.stdin.end(source);
  });
}

async function poll(check, message, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(message);
}

async function waitForInput(pane) {
  // A handle is allocated before the snapshot/control handshake and SSH
  // output arrive. This also applies when reattaching an existing shell.
  await pane.locator('.terminal-panel.is-attached').waitFor({ timeout: 30000 });
  await pane.locator('.control-owner').filter({ hasText: 'You control' }).waitFor({ timeout: 30000 });
  await pane.locator('.xterm-rows').filter({ hasText: /\S/ }).waitFor({ timeout: 30000 });
}

(async () => {
  let app, page, clipboardBefore;
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-terminal-test-'));
  const errors = [];
  try {
    const { Store } = require('../electron/config.cjs');
    const firstKey = `default/tmux:${names[0]}`;
    new Store(dataDirectory).save('workspace', { tabs: [firstKey], selectedKey: firstKey, splitKey: null, metadata: {} });
    await remote('setup');
    assert.equal((await remote('state')).length, names.length, 'SSH fixtures did not survive disconnect');
    const packaged = process.env.AGENT_HQ_QA_EXECUTABLE;
    app = await _electron.launch({ executablePath: packaged || require('electron'), args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(dataDirectory, 'browser')}`], cwd: root, env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: dataDirectory } });
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    assert.equal(await page.title(), 'AgentC2');
    assert.ok(page.url().startsWith('file:'));
    await page.locator('.session-row').filter({ hasText: 'AgentC2 terminal regression A' }).waitFor({ timeout: 60000 });
    clipboardBefore = await page.evaluate(() => window.agentHQ.readClipboard());
    await app.evaluate(async ({ clipboard }) => {
      const image = (await clipboard.read()).find((item) => item.types.includes('image/png'));
      globalThis.__agentc2ClipboardBefore = { text: await clipboard.readText(), png: image ? await image.getType('image/png') : null };
    });
    await page.getByRole('textbox', { name: 'Search sessions' }).fill('AgentC2 terminal regression');
    async function select(label) {
      await page.locator('.session-row').filter({ hasText: `AgentC2 terminal regression ${label}` }).click();
      await waitForInput(page.locator('.session-pane.is-focused'));
      assert.equal(await page.locator('.session-pane.is-focused .detail-footer code').innerText(), names[labels.indexOf(label)]);
    }
    await select('A');
    await select('B');
    await select('A');
    console.log('PASS managed selection auto-attaches and switches chats');
    const screen = await page.locator('.session-pane.is-focused .xterm-screen').boundingBox();
    assert.ok(screen);
    const beforeHistory = await page.locator('.session-pane.is-focused .xterm-rows').innerText();
    await page.mouse.move(screen.x + 120, screen.y + 100);
    await page.mouse.wheel(0, -700);
    await poll(async () => {
      const state = (await remote('state'))[0];
      return state.mode === '1' && Number(state.position) > 0;
    }, 'Wheel did not scroll tmux history');
    await poll(async () => (await page.locator('.session-pane.is-focused .xterm-rows').innerText()) !== beforeHistory, 'Shell history did not move on screen');
    console.log('PASS mouse wheel scrolls history retained before attachment');
    await page.mouse.wheel(0, 700);
    await poll(async () => (await remote('state'))[0].mode === '0', 'Scrolling back to the bottom did not restore live input');
    await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Latest', exact: true }).click();
    await poll(async () => (await remote('state'))[0].mode === '0', 'Latest did not exit history');
    await page.mouse.move(screen.x + 120, screen.y + 100);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    assert.equal((await remote('state'))[0].mode, '0', 'Scrolling down at latest trapped input in copy mode');
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
    await page.keyboard.press('Shift+PageUp');
    await poll(async () => (await remote('state'))[0].mode === '1', 'Shift+PageUp did not scroll');
    await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Latest', exact: true }).click();
    await poll(async () => (await remote('state'))[0].mode === '0', 'Latest did not exit history');
    // Select actual rendered output with an ordinary mouse drag.
    await page.mouse.move(screen.x + 1, screen.y + 8);
    await page.mouse.down();
    await page.mouse.move(screen.x + 210, screen.y + 8, { steps: 10 });
    await page.mouse.up();
    await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Copy', exact: true }).waitFor();
    await poll(() => page.locator('.session-pane.is-focused').getByRole('button', { name: 'Copy', exact: true }).isEnabled(), 'Mouse drag did not select text');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+Shift+C');
    await poll(async () => (await page.evaluate(() => window.agentHQ.readClipboard())).includes('HQ_HISTORY_A'), 'Copy shortcut did not copy rendered output');
    await page.evaluate(() => window.agentHQ.writeClipboard('clipboard reset'));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    await poll(async () => (await page.evaluate(() => window.agentHQ.readClipboard())).includes('HQ_HISTORY_A'), 'Ctrl+C did not copy the selection');
    await page.evaluate(() => window.agentHQ.writeClipboard('clipboard reset'));
    await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Copy', exact: true }).click();
    await poll(async () => (await page.evaluate(() => window.agentHQ.readClipboard())).includes('HQ_HISTORY_A'), 'Copy button did not copy the selection');
    if (process.platform === 'darwin') {
      await page.evaluate(() => window.agentHQ.writeClipboard('interrupt must preserve clipboard'));
      await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
      await page.keyboard.press('Control+c');
      await poll(async () => (await remote('state'))[0].text.includes('^C'), 'macOS Ctrl+C did not reach the shell');
      assert.equal(await page.evaluate(() => window.agentHQ.readClipboard()), 'interrupt must preserve clipboard');
    }
    console.log(`PASS mouse selection, platform copy shortcuts, and Copy button${process.platform === 'darwin' ? '; Ctrl+C interrupts without changing the clipboard' : ''}`);
    for (const [shortcut, marker] of [[process.platform === 'darwin' ? 'Meta+v' : 'Control+v', 'HQ_PASTE_CTRL_V'], ['Control+Shift+v', 'HQ_PASTE_CTRL_SHIFT_V'], ['Shift+Insert', 'HQ_PASTE_SHIFT_INSERT']]) {
      await page.evaluate((text) => window.agentHQ.writeClipboard(text), marker);
      await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
      await page.keyboard.press('Control+u');
      await page.keyboard.press(shortcut);
      await poll(async () => (await remote('state'))[0].text.includes(marker), `${shortcut} did not paste`);
      assert.equal((await remote('state'))[0].text.split(marker).length - 1, 1, `${shortcut} pasted more than once`);
    }
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+u');
    await page.keyboard.press('Shift+PageUp');
    await poll(async () => (await remote('state'))[0].mode === '1', 'History setup failed before paste');
    await page.evaluate(() => window.agentHQ.writeClipboard('HQ_PASTE_BUTTON_λ'));
    await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Paste', exact: true }).click();
    await poll(async () => (await remote('state'))[0].text.includes('HQ_PASTE_BUTTON_λ'), 'Paste button did not paste Unicode');
    assert.equal((await remote('state'))[0].mode, '0', 'Paste must return to live input');
    console.log('PASS Ctrl+V, Ctrl+Shift+V, Shift+Insert, and Paste button');
    const imagesBefore = new Set((await remote('image-state')).map((image) => image.name));
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
      const image = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 });
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
    });
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+u');
    await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Paste', exact: true }).click();
    let uploadedImage;
    await poll(async () => {
      uploadedImage = (await remote('image-state')).find((image) => !imagesBefore.has(image.name));
      return Boolean(uploadedImage);
    }, 'Image paste did not upload a remote PNG');
    assert.equal(uploadedImage.mode, 0o600);
    assert.equal(uploadedImage.magic, '89504e470d0a1a0a');
    await poll(async () => (await remote('image-input')).includes(uploadedImage.name), 'Image paste did not insert the uploaded path', 60);
    assert.equal((await remote('image-input')).split(uploadedImage.name).length - 1, 1, 'Image path pasted more than once');
    console.log('PASS clipboard image upload and one quoted remote path');
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+u');
    // Select the real native menu's Paste action without OS menu automation.
    await app.evaluate(({ Menu }) => {
      const original = Menu.prototype.popup;
      Menu.prototype.popup = function(options) {
        Menu.prototype.popup = original;
        globalThis.qaMenuLabels = this.items.map((item) => item.label);
        this.items.find((item) => item.label === 'Paste').click();
        options.callback?.();
      };
    });
    await page.evaluate(() => window.agentHQ.writeClipboard('_CONTEXT_MENU'));
    await page.mouse.click(screen.x + 100, screen.y + 100, { button: 'right' });
    await poll(async () => (await remote('state'))[0].text.includes('_CONTEXT_MENU'), 'Right-click Paste did not reach the terminal');
    assert.ok((await app.evaluate(() => globalThis.qaMenuLabels)).includes('Copy'));
    console.log('PASS right-click Copy/Paste menu plumbing');
    const hintedPort = 41000 + Math.floor(Math.random() * 1000);
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+u');
    await page.keyboard.type(`printf 'http://localhost:${hintedPort}/preview?q=1\\n'`);
    await page.keyboard.press('Enter');
    await page.locator('.session-pane.is-focused .toolbar-button').filter({ hasText: `Tunnel :${hintedPort}` }).first().waitFor();
    console.log('PASS remote loopback URL discovery appears as a manual tunnel action');
    // Verify rendered movement, not just tmux's mode flag. Fullscreen agents
    // retain their transcript internally and have no tmux scrollback to browse.
    for (const label of ['KEYS', 'MOUSE']) {
      await select(label);
      const output = page.locator('.session-pane.is-focused .xterm-rows');
      const atLatest = `HQ_FULLSCREEN_${label}_POSITION_0`;
      await poll(async () => (await output.innerText()).includes(atLatest), 'Fullscreen fixture did not render');
      const box = await page.locator('.session-pane.is-focused .xterm-screen').boundingBox();
      await page.mouse.move(box.x + 100, box.y + 60);
      await page.mouse.wheel(0, -400);
      await poll(async () => !(await output.innerText()).includes(atLatest), `${label} wheel did not move rendered transcript`);
      assert.ok((await output.innerText()).includes(label === 'MOUSE' ? 'wheel-up' : 'page-up'));
      await page.locator('.session-pane.is-focused').screenshot({ path: path.join(os.tmpdir(), `agent-hq-scroll-${label.toLowerCase()}.png`) });
      assert.equal((await remote('state'))[labels.indexOf(label)].mode, '0', 'Fullscreen scrolling entered tmux copy mode');
      const scrolled = await output.innerText();
      await page.mouse.wheel(0, 120);
      await poll(async () => (await output.innerText()) !== scrolled, `${label} wheel down did not move transcript`);
      await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Latest', exact: true }).click();
      await poll(async () => (await output.innerText()).includes(atLatest), `${label} Latest did not restore transcript`);
      await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
      await page.keyboard.press('Shift+PageUp');
      await poll(async () => !(await output.innerText()).includes(atLatest), `${label} Shift+PageUp did not scroll`);
      await page.keyboard.press('Shift+PageDown');
      await poll(async () => (await output.innerText()).includes(atLatest), `${label} Shift+PageDown did not scroll`);
      if (label === 'KEYS') {
        await remote('legacy-copy');
        await page.mouse.move(box.x + 100, box.y + 60);
        await page.mouse.wheel(0, -400);
        await poll(async () => !(await output.innerText()).includes(atLatest), 'Could not recover fullscreen session from legacy copy mode');
        await page.locator('.session-pane.is-focused').getByRole('button', { name: 'Latest', exact: true }).click();
        await poll(async () => (await output.innerText()).includes(atLatest), 'Recovery did not return to latest');
        await remote('fallback-up');
        await poll(async () => !(await output.innerText()).includes(atLatest), 'SSH fallback did not scroll fullscreen transcript');
        await remote('fallback-latest');
        await poll(async () => (await output.innerText()).includes(atLatest), 'SSH fallback Latest failed');
      }
    }
    console.log('PASS fullscreen keyboard/mouse scrolling, rendered up/down, Shift+PageUp/Down, Latest, legacy-mode recovery, and SSH fallback');
    await select('A');
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+u');
    await page.keyboard.press('Shift+PageUp');
    await poll(async () => (await remote('state'))[0].mode === '1', 'History setup failed before typing');
    await page.keyboard.type('HQ_TYPING_AFTER_SCROLL');
    await poll(async () => (await remote('state'))[0].text.includes('HQ_TYPING_AFTER_SCROLL'), 'Typing after history did not return to live input');
    assert.equal((await remote('state'))[0].mode, '0');
    await page.keyboard.press('Control+u');
    console.log('PASS typing after shell history resumes live input');
    await page.getByRole('textbox', { name: 'Search sessions' }).fill('');
    await page.getByRole('button', { name: 'New unit', exact: true }).click();
    await page.getByRole('combobox', { name: 'Session type', exact: true }).selectOption('terminal');
    assert.equal(await page.getByRole('combobox', { name: 'Launch preset', exact: true }).count(), 0);
    const shellTitle = `HQ_SHELL_${crypto.randomBytes(4).toString('hex')}`;
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(shellTitle);
    await page.getByRole('textbox', { name: 'Working directory', exact: true }).fill('/tmp');
    await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
    await page.getByRole('dialog', { name: 'New session', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
    let shell;
    await poll(async () => {
      shell = (await page.evaluate(() => window.agentHQ.inventory())).sessions.find((session) => session.title === shellTitle);
      return Boolean(shell);
    }, 'Created shell did not appear in inventory');
    assert.ok(shell); names.push(shell.id);
    assert.equal(shell.provider, 'terminal'); assert.equal(shell.cwd, '/tmp');
    assert.ok(shell.canAttach && shell.canStop && shell.canInterrupt && shell.managed);
    const pane = page.locator('.session-pane.is-focused');
    await waitForInput(pane);
    // Keep the test shell isolated and print links at known terminal cells.
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("export HQ_REATTACH=retained; printf '\\033[2J\\033[Hhttps://example.com/agent-hq?from=desktop\\n'");
    await page.keyboard.press('Enter');
    await poll(async () => (await pane.locator('.xterm-rows').innerText()).includes('https://example.com/agent-hq?from=desktop'), 'Link output did not render');
    await app.evaluate(({ shell }) => { globalThis.qaExternalLinks = []; shell.openExternal = async (url) => { globalThis.qaExternalLinks.push(url); }; });
    const linkScreen = await pane.locator('.xterm-screen').boundingBox();
    await page.mouse.move(linkScreen.x + 40, linkScreen.y + 8);
    await page.waitForTimeout(250);
    await page.mouse.click(linkScreen.x + 40, linkScreen.y + 8);
    await poll(async () => (await app.evaluate(() => globalThis.qaExternalLinks)).includes('https://example.com/agent-hq?from=desktop'), 'Desktop URL did not open in the system browser');
    await page.evaluate(() => { window.open('file:///C:/Windows/win.ini'); window.open('javascript:alert(1)'); });
    await page.waitForTimeout(200);
    assert.equal((await app.evaluate(() => globalThis.qaExternalLinks)).length, 1);
    assert.equal(app.windows().length, 1);
    console.log('PASS clicking a chat URL routes to the system browser; unsafe schemes and Electron popups remain blocked');
    await pane.getByRole('button', { name: 'Detach', exact: true }).click();
    await pane.locator('.terminal-panel.is-attached').waitFor({ state: 'hidden' });
    assert.ok((await page.evaluate(() => window.agentHQ.inventory())).sessions.some((s) => s.id === shell.id && s.state === 'live'));
    await pane.getByRole('button', { name: 'Attach', exact: true }).click();
    await waitForInput(pane);
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf "REATTACH_%s\\n" "$HQ_REATTACH"');
    await page.keyboard.press('Enter');
    await poll(async () => (await pane.locator('.xterm-rows').innerText()).includes('REATTACH_retained'), 'Detach did not retain the shell environment');
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-shell-desktop.png') });
    page.once('dialog', (dialog) => dialog.accept());
    await pane.getByRole('button', { name: 'Stop', exact: true }).click();
    await poll(async () => !(await page.evaluate(() => window.agentHQ.inventory())).sessions.some((s) => s.id === shell.id), 'Stop did not remove the shell session');
    console.log('PASS desktop terminal creation, remote directory, managed controls, detach/reattach with retained state, and stop');
    const screenshot = path.join(os.tmpdir(), 'agent-hq-terminal-0.1.1.png');
    await page.screenshot({ path: screenshot });
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    console.log('PASS no renderer errors');
    console.log(`Screenshot: ${screenshot}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-terminal-failure.png') }).catch(() => {});
    if (page) {
      const snapshot = await page.evaluate(() => window.agentHQ.inventory()).catch(() => null);
      if (snapshot) console.error('Fixture connection diagnostics:', snapshot.hosts, snapshot.sessions.filter((session) => names.includes(session.id)).map((session) => session.id));
    }
    throw error;
  } finally {
    if (app && clipboardBefore !== undefined) await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const before = globalThis.__agentc2ClipboardBefore;
      if (before.png) await clipboard.write([new ClipboardItem({ 'image/png': before.png, 'text/plain': before.text })]);
      else await clipboard.writeText(before.text);
      delete globalThis.__agentc2ClipboardBefore;
    }).catch(() => {});
    if (app) await app.close();
    await remote('cleanup');
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
