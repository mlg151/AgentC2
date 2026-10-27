const { poll } = require('./helpers/poll.cjs');
// Browser plugin not available: exercise the production Electron entry point.
// Requires default WSL Python 3/tmux. Uses a disposable HOME, no provider account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { Store } = require('../electron/config.cjs');
const { localCommand } = require('../electron/local.cjs');

(async () => {
  if (process.platform !== 'win32') { console.log('SKIP Windows/WSL local startup: Windows required'); return; }
  const wsl = (command, args, env = process.env) => {
    const execution = localCommand(command, args, 'win32', env);
    return execFileSync(execution.binary, execution.args, { encoding: 'utf8', windowsHide: true, env, timeout: 40000 }).trim();
  };
  try { wsl('python3', ['-c', 'import shutil; assert shutil.which("tmux")']); }
  catch (error) {
    throw error;
  }
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-windows-local-'));
  const fixture = path.join(directory, "Project space 'quoted' & literal");
  fs.mkdirSync(fixture);
  const home = wsl('mktemp', ['-d', '/tmp/agentc2-windows-local-XXXXXX']);
  const env = { ...process.env, AGENTC2_TEST_HOME: home, NODE_ENV: 'production', AGENTC2_DATA_DIR: directory };
  const store = new Store(directory);
  store.save('settings', { ...store.data.settings, hosts: [{ id: 'default', kind: 'local', name: 'Windows local fixture', enabled: true }], presets: [{ ...store.data.settings.presets[0], id: 'path-fixture', name: 'Codex path fixture', command: '/bin/sh', args: "-c 'pwd; exec sleep 300'", attentionHooks: false }] });
  let app, page;
  const created = [], errors = [];
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'helpers/windows-local-app.cjs'), `--user-data-dir=${path.join(directory, 'browser')}`], cwd: root, env, timeout: 60000 });
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    assert.equal(await page.title(), 'AgentC2'); assert.ok(page.url().startsWith('file:'));
    await page.getByRole('button', { name: 'New unit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
    await dialog.getByLabel('Working directory', { exact: true }).fill(path.join(directory, 'missing'));
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'working directory does not exist' }).waitFor({ timeout: 60000 });
    assert.equal(await dialog.getByRole('button', { name: 'Start session', exact: true }).isEnabled(), true);
    const screenshots = process.env.AGENTC2_QA_SCREENSHOT_DIR || os.tmpdir();
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'windows-local-startup-error.png') });
    await dialog.getByLabel('Working directory', { exact: true }).fill(fixture + '\\');
    await dialog.getByLabel('Session name', { exact: true }).fill('Recovered Windows path fixture');
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 60000 });
    let inventory = await page.evaluate(() => window.agentHQ.inventory());
    const recovered = inventory.sessions.find((session) => session.title === 'Recovered Windows path fixture');
    assert.ok(recovered); created.push(recovered.id);
    assert.equal(recovered.cwd, wsl('realpath', [wsl('wslpath', ['-a', '-u', fixture])]));
    for (const cwd of [path.parse(os.homedir()).root, os.homedir() + '\\', wsl('wslpath', ['-a', '-u', fixture])]) {
      const result = await page.evaluate((cwd) => window.agentHQ.create({ provider: 'codex', transport: 'terminal', presetId: 'path-fixture', hostId: 'default', cwd, title: 'Windows path fixture' }), cwd);
      created.push(result.name);
      await poll(async () => {
        inventory = await page.evaluate(() => window.agentHQ.inventory());
        return inventory.sessions.some((session) => session.id === result.name);
      }, 'Created Windows path fixture did not appear in inventory');
      const expected = wsl('realpath', [/^[a-z]:/i.test(cwd) ? wsl('wslpath', ['-a', '-u', cwd]) : cwd]);
      assert.equal(inventory.sessions.find((session) => session.id === result.name)?.cwd, expected);
    }
    // Check both the bridge state and rendered typing: ConPTY can redraw the
    // CLI while stripping the escape sequences used by the readiness gate.
    const shell = await page.evaluate(() => window.agentHQ.create({ provider: 'terminal', hostId: 'default', cwd: '/tmp', title: 'WSL reattach fixture' }));
    created.push(shell.name);
    await page.locator('.session-row').filter({ hasText: 'WSL reattach fixture' }).click();
    const pane = page.locator('.session-pane.is-focused');
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = await page.evaluate((name) => window.agentHQ.openTerminal(name, 100, 30, 'default'), shell.name);
      await poll(() => page.evaluate(async (id) => (await window.agentHQ.terminalState(id)).connection === 'connected', handle), 'WSL tmux did not acknowledge startup');
      await pane.locator('.control-owner').filter({ hasText: 'You control' }).waitFor();
      await pane.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(`printf 'WSL_READY_%s\\n' '${attempt}'`);
      await page.keyboard.press('Enter');
      await poll(() => page.evaluate(async ({ handle, attempt }) => (await window.agentHQ.readyTerminal(handle)).text.includes(`WSL_READY_${attempt}`), { handle, attempt }), 'WSL first input after attach was lost');
      await pane.locator('.xterm-rows').filter({ hasText: `WSL_READY_${attempt}` }).waitFor();
      await page.evaluate((id) => window.agentHQ.closeTerminal(id), handle);
      if (attempt === 0) {
        await pane.getByRole('button', { name: 'Detach', exact: true }).click();
        await pane.getByRole('button', { name: 'Attach', exact: true }).click();
      }
    }
    assert.equal(await page.locator('vite-error-overlay').count(), 0); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(screenshots, 'windows-local-startup-recovered.png') });
    console.log('PASS production Electron/WSL Codex-labelled CLI fixture: missing directory error and retry, drive root, user directory, trailing slash, spaces/quotes, POSIX path, renderer survival, and ConPTY tmux readiness/reattach input');
  } finally {
    if (page) for (const name of created) await page.evaluate((name) => window.agentHQ.stop(name, 'default'), name).catch(() => {});
    await app?.close();
    // Delete only the mktemp directory created above, including its private worker.
    wsl('python3', ['-c', `import json,pathlib,shutil,socket,sys,time
p=pathlib.Path(sys.argv[1])
assert str(p).startswith('/tmp/agentc2-windows-local-')
location=p/'.cache/agentc2/chat-v1/worker.sock'
if location.exists():
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(15)
        client.connect(str(location))
        client.sendall(b'{"protocolVersion":1,"action":"retire"}\\n')
        response=json.loads(client.makefile('rb').readline())
        assert response.get('ok'), response
    for _ in range(100):
        if not location.exists(): break
        time.sleep(.05)
    assert not location.exists(), 'Fixture worker did not retire'
shutil.rmtree(p)`, home]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
