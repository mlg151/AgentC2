// Live SSH/Electron Flash Traffic fixture; Claude's hook protocol is exercised without a provider login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { _electron } = require('playwright-core');
const { Store, defaults } = require('../electron/config.cjs');
const { createService } = require('../electron/service.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const host = process.env.AGENTC2_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an isolated SSH test host');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-flash-live-'));
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host];

function remote(source, name) {
  return execFileSync(sshBinary(), [...sshArgs, 'python3', '-', name], { input: source, encoding: 'utf8', timeout: 20000 }).trim();
}
function startHook(name, command) {
  const process = spawn(sshBinary(), [...sshArgs, 'python3', String.raw`~/.cache/agent-hq/${name}/hook.py`, 'claude', 'hook'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', (chunk) => { stdout += chunk; });
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => process.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `Hook exited ${code}`))));
  process.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'qa-session', prompt_id: 'qa-turn', tool_name: 'Bash', tool_input: { command } }));
  return { process, done };
}

(async () => {
  let app, service, foreground, background;
  try {
    const settings = defaults();
    settings.hosts[0].target = host;
    settings.presets.push({ ...settings.presets[1], id: 'flash-claude-qa', name: 'Flash Claude shell', hostId: 'default', command: 'bash', args: "-c 'sleep 300'", attentionHooks: false, fullPermissions: false });
    new Store(directory).save('settings', settings);
    service = createService({ directory, home: os.homedir() });
    background = await service.create({ provider: 'claude', hostId: 'default', presetId: 'flash-claude-qa', roeProfile: 'provider-default', title: 'Flash background QA', instructions: '' });
    foreground = await service.create({ provider: 'terminal', hostId: 'default', title: 'Flash foreground QA', cwd: '' });
    const hookSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'session-hook.py'), 'utf8');
    remote(`import base64,pathlib,re,sys\nname=sys.argv[1]\nassert re.fullmatch(r'hq-[a-f0-9]{12}',name)\nroot=pathlib.Path.home()/'.cache'/'agent-hq'/name\nroot.mkdir(parents=True,exist_ok=True)\nroot.chmod(0o700)\n(root/'hook.py').write_bytes(base64.b64decode('${Buffer.from(hookSource).toString('base64')}'))\n`, background.name);
    app = await _electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: directory } });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: 'New unit' }).waitFor();
    await page.locator('.session-row').filter({ hasText: 'Flash foreground QA' }).first().click();
    const terminal = page.locator('.session-pane:not(.pane-hidden) .xterm-helper-textarea').first();
    await terminal.waitFor({ state: 'attached' });
    const first = startHook(background.name, 'echo FIRST_EXACT_ACTION');
    await page.waitForFunction((name) => window.agentHQ.listFlashTraffic().then((items) => items.some((item) => item.state === 'pending' && item.name === name && item.action.includes('FIRST_EXACT_ACTION'))), background.name, { timeout: 15000 });
    const second = startHook(background.name, 'echo SECOND_EXACT_ACTION');
    await page.waitForFunction((name) => window.agentHQ.listFlashTraffic().then((items) => items.filter((item) => item.state === 'pending' && item.name === name).length >= 2), background.name, { timeout: 15000 });
    await page.getByRole('button', { name: /FLASH TRAFFIC 2/ }).click();
    const queue = page.getByLabel('Flash Traffic permission queue');
    await queue.getByText(/FIRST_EXACT_ACTION|SECOND_EXACT_ACTION/).first().waitFor();
    if (process.env.AGENTC2_QA_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.AGENTC2_QA_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENTC2_QA_SCREENSHOT_DIR, 'flash-traffic.png') });
    }
    await terminal.evaluate((element) => element.focus());
    await page.keyboard.press('Alt+y');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true, 'Foreground terminal keeps focus');
    const firstResult = JSON.parse(await first.done);
    assert.equal(firstResult.hookSpecificOutput.decision.behavior, 'allow');
    const queued = await page.evaluate(() => window.agentHQ.listFlashTraffic());
    assert.equal(queued.filter((item) => item.name === background.name && item.state === 'pending').length, 1);
    await page.keyboard.press('Alt+n');
    const secondResult = JSON.parse(await second.done);
    assert.equal(secondResult.hookSpecificOutput.decision.behavior, 'deny');
    const completed = await page.evaluate(() => window.agentHQ.listFlashTraffic());
    assert.equal(completed.filter((item) => item.name === background.name && item.state === 'resolved').length, 2);
    await assert.rejects(page.evaluate(({ name, id }) => window.agentHQ.decideFlashTraffic({ hostId: 'default', name, id, decision: 'allow' }), { name: background.name, id: completed.find((item) => item.decision === 'deny').id }), /different decision/);
    assert.deepEqual(errors, []);
    console.log('PASS live SSH/Electron Flash Traffic exact-action queue, scoped one-shot allow/deny, foreground focus, and duplicate rejection');
  } finally {
    if (app) await app.close();
    for (const item of [background, foreground]) if (service && item) { try { await service.action({ id: 'desktop' }, 'stop', item.name, 'default'); } catch (_) { /* Fixture may have exited. */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
