// Live Electron + SSH fixtures; never submit prompts to provider CLIs.
const { _electron } = require('playwright-core');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-workspace-test-'));
const host = process.env.AGENTC2_HOST || process.env.AGENT_HQ_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an explicitly configured SSH test host');
const ssh = require('../electron/platform.cjs').sshBinary();
const names = [0, 1].map(() => `hq-${crypto.randomBytes(6).toString('hex')}`);
const created = [];
const marker = `HQ_WORKSPACE_${crypto.randomBytes(4).toString('hex')}`;
const errors = [];
let app, page, clipboardBefore;
function remote(action) {
  const source = `
import subprocess,sys,json,base64,shlex
p=json.loads(base64.b64decode(sys.argv[1])); names=p['names']
def run(*args):
 r=subprocess.run(args,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
if p['action']=='setup':
 for i,name in enumerate(names):
  run('tmux','new-session','-d','-s',name,'-n','setup')
  for k,v in [('provider','codex'),('title',p['marker']+' '+str(i)),('cwd','/tmp')]: run('tmux','set-option','-t',name,'@hq_'+k,v)
  run('tmux','set-option','-t',name,'history-limit','50000')
  program="import os; [print('HQ_SEARCH_%05d'%i,flush=True) for i in range(1,3001)]; os.execvpe('bash',['bash','--noprofile','--norc'],dict(os.environ,PS1='HQ_FIXTURE> '))"
  run('tmux','new-window','-t',name,'-n','chat',shlex.join(['python3','-u','-c',program]))
  run('tmux','kill-window','-t',name+':setup')
 print('{}')
elif p['action']=='cleanup':
 for name in names: subprocess.run(['tmux','kill-session','-t',name],capture_output=True)
 print('{}')
`;
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host, 'python3', '-', Buffer.from(JSON.stringify({ action, names: [...names, ...created], marker })).toString('base64')], { windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject); child.on('close', (code) => code ? reject(new Error(error)) : resolve(output)); child.stdin.end(source);
  });
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.AGENT_HQ_QA_EXECUTABLE || require('electron'), args: [...(process.env.AGENT_HQ_QA_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(directory, 'browser')}`], cwd: root, env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: directory } });
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('textbox', { name: 'Search sessions' }).waitFor();
  await page.locator('.session-row').first().waitFor({ timeout: 60000 });
}
async function poll(check, message) {
  for (let i = 0; i < 40; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error(message);
}
async function state() { return page.evaluate(() => window.agentHQ.getState()); }
async function refresh() { await page.evaluate(() => window.agentHQ.inventory()); }
async function select(index) { await page.locator('.session-row').filter({ hasText: `${marker} ${index}` }).click(); await page.locator('.session-pane:visible .terminal-panel.is-attached').waitFor({ timeout: 30000 }); }

(async () => {
  try {
    const { Store } = require('../electron/config.cjs');
    const firstKey = `default/tmux:${names[0]}`;
    new Store(directory).save('workspace', { tabs: [firstKey], selectedKey: firstKey, splitKey: null, metadata: {} });
    await remote('setup'); await launch();
    assert.equal(await page.title(), 'AgentC2');
    assert.ok((await page.url()).includes('/dist/index.html'));
    await poll(async () => {
      const readings = await page.evaluate(() => window.agentHQ.health());
      return readings.some((h) => h.hostId === 'default' && h.connected && h.cpuPercent !== null && h.cpuPercent >= 0 && h.cpuPercent <= 100 && h.memoryUsed >= 0 && h.memoryUsed <= h.memoryTotal && h.disks.length && h.disks.every((d) => d.free >= 0 && d.total > 0));
    }, 'Live CPU, memory, and disk measurements missing');
    assert.ok((await page.getByRole('complementary', { name: 'Live host resources' }).innerText()).includes('GiB'));
    const firstSample = (await page.evaluate(() => window.agentHQ.health()))[0].sampledAt;
    await poll(async () => (await page.evaluate(() => window.agentHQ.health()))[0].sampledAt > firstSample, 'Host resources did not refresh');
    console.log('PASS always-visible live CPU utilization, memory usage, disk capacity/free space, and refreshed sample timestamps');
    clipboardBefore = await page.evaluate(() => window.agentHQ.readClipboard());
    await page.getByRole('textbox', { name: 'Search sessions' }).fill(marker);
    await select(0);
    // Pins, project groups, notes, and handoff clipboard.
    await page.getByRole('button', { name: `Pin ${marker} 0`, exact: true }).click();
    await page.getByRole('combobox', { name: 'Session project' }).fill('Workspace QA');
    await page.getByRole('button', { name: 'Notes & handoff', exact: true }).click();
    await page.getByRole('textbox', { name: 'Session notes and handoff' }).fill('Objective: release safely\nNext: inspect fixture output\nhttps://example.com/issue/123');
    await page.getByRole('button', { name: 'Copy handoff', exact: true }).click();
    await poll(async () => (await page.evaluate(() => window.agentHQ.readClipboard())).includes('Next: inspect fixture output'), 'Handoff was not copied');
    await page.getByRole('button', { name: 'Hide notes', exact: true }).click();
    await select(1); await select(0);
    assert.equal(await page.locator('.session-pane .terminal-panel.is-attached').count() >= 2, true);
    await page.getByRole('combobox', { name: 'Split terminal', exact: true }).selectOption(`default/tmux:${names[1]}`);
    assert.equal(await page.locator('.session-pane:visible').count(), 2);
    console.log('PASS pins, project groups, notes/handoff, persistent terminals, and split panes');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-workspace.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-workspace-narrow.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.ok(await page.evaluate(() => {
      const grid = document.querySelector('.pane-grid').getBoundingClientRect();
      return [...document.querySelectorAll('.session-pane:not(.pane-hidden) .terminal-panel')].every((p) => p.getBoundingClientRect().bottom <= grid.bottom + 1);
    }), 'Split terminal overflowed the workspace at the narrow viewport');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.getByRole('combobox', { name: 'Split terminal', exact: true }).selectOption('');
    await page.locator('.session-pane:visible').getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByRole('textbox', { name: 'Find in history' }).fill('HQ_SEARCH_0000');
    await poll(async () => (await page.getByRole('dialog', { name: 'Search terminal history' }).innerText()).includes('1 of 9 matches'), 'Pre-attachment history not searched');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.ok((await page.getByRole('dialog', { name: 'Search terminal history' }).innerText()).includes('2 of 9 matches'));
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByRole('button', { name: 'Close history search' }).click();
    await page.locator('.session-pane:visible .xterm-helper-textarea').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.getByRole('textbox', { name: 'Quick switcher search' }).fill(`${marker} 1`);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.session-pane:visible .detail-footer code').innerText(), names[1]);
    console.log('PASS retained-history search, next/previous, and Ctrl+K from the terminal');
    // Configure hosts and a claude3 preset through the real UI.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add SSH host' }).click();
    const hostEditor = page.locator('.host-editor').last();
    await hostEditor.getByLabel('Name', { exact: true }).fill('Mirror QA');
    await hostEditor.getByLabel('SSH target', { exact: true }).fill(host);
    await page.getByRole('button', { name: 'Launch presets', exact: true }).click();
    await page.getByRole('button', { name: 'Add preset', exact: true }).click();
    await page.getByRole('textbox', { name: 'Preset name', exact: true }).fill('Claude OpenRouter QA');
    await page.getByRole('textbox', { name: 'Launch command', exact: true }).fill('claude3');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' });
    let saved = await state();
    const mirror = saved.settings.hosts.find((h) => h.name === 'Mirror QA');
    assert.ok(mirror); assert.equal(saved.settings.presets.at(-1).command, 'claude3');
    await refresh();
    await page.getByRole('combobox', { name: 'Filter SSH host' }).selectOption(mirror.id);
    await page.locator('.session-row').filter({ hasText: `${marker} 0` }).waitFor();
    assert.ok((await page.locator('.session-row').first().innerText()).includes('Mirror QA'));
    // Launch harmless fixture commands with the preset pipeline and quoted instructions.
    const config = saved.settings;
    await app.evaluate(({ Notification }) => {
      globalThis.qaNotifications = [];
      // Headless Linux has no notification daemon. Exercise dispatch/click
      // routing deterministically; real OS delivery is a separate manual check.
      Notification.isSupported = () => true;
      Notification.prototype.show = function() { globalThis.qaNotifications.push(this); };
    });
    config.notifications = true;
    config.presets.push({ id: 'fixture', name: 'Fixture launcher', provider: 'claude', command: 'python3', args: `-u -c 'import sys; print("HQ_PRESET_ARG="+sys.argv[-1],flush=True); sys.exit(7)'`, cwd: '/tmp', instructions: 'literal $(touch /tmp/never-execute-this) "quotes"', fullPermissions: false, attentionHooks: false, hostId: mirror.id });
    await page.evaluate((c) => window.agentHQ.saveSettings(c), config);
    // Reload reads the saved preset exactly as a restart would.
    await page.reload(); await page.locator('.session-row').first().waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('combobox', { name: 'Launch preset' }).selectOption('fixture');
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(`${marker} failed preset`);
    assert.equal(await page.getByRole('combobox', { name: 'SSH host', exact: true }).inputValue(), mirror.id);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.getByRole('dialog', { name: 'New session', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
    let latest = await page.evaluate(() => window.agentHQ.inventory());
    const failed = latest.sessions.find((s) => s.title === `${marker} failed preset` && s.hostId === mirror.id);
    assert.ok(failed); created.push(failed.id);
    await poll(async () => { latest = await page.evaluate(() => window.agentHQ.inventory()); return latest.attention.some((a) => a.sessionKey === failed.key && a.kind === 'failed'); }, 'Confirmed failure missing from inbox');
    assert.equal(latest.sessions.find((s) => s.key === failed.key).exitCode, 7);
    assert.ok(await app.evaluate((_electron, title) => globalThis.qaNotifications.some((n) => n.body === title), `${marker} failed preset`));
    const id = await page.evaluate((s) => window.agentHQ.openTerminal(s.id, 100, 32, s.hostId), failed);
    const history = await page.evaluate((terminal) => window.agentHQ.terminalHistory(terminal), id);
    assert.ok(history.text.includes('HQ_PRESET_ARG=literal $(touch /tmp/never-execute-this) "quotes"'));
    await page.evaluate((terminal) => window.agentHQ.closeTerminal(terminal), id);
    // A second command exits zero and must produce confirmed completion.
    config.presets.push({ ...config.presets.at(-1), id: 'complete', name: 'Complete fixture', args: `-u -c 'print("Do you want to proceed? [y/n]",flush=True); import time; time.sleep(3)'`, instructions: '' });
    await page.evaluate((c) => window.agentHQ.saveSettings(c), config);
    const completed = await page.evaluate((input) => window.agentHQ.create(input), { provider: 'claude', hostId: mirror.id, presetId: 'complete', cwd: '/tmp', title: `${marker} completion` });
    created.push(completed.name);
    await refresh();
    await poll(async () => { latest = await page.evaluate(() => window.agentHQ.inventory()); return latest.attention.some((a) => a.sessionKey === `${mirror.id}/tmux:${completed.name}` && a.kind === 'completed'); }, 'Confirmed completion missing from inbox');
    await page.getByRole('button', { name: /Attention inbox/ }).click();
    assert.ok(await page.getByRole('complementary', { name: 'Live host resources' }).isVisible());
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-attention.png') });
    assert.ok((await page.locator('.attention-inbox').innerText()).includes('Process failed'));
    assert.ok((await page.locator('.attention-inbox').innerText()).includes('Process completed'));
    await app.evaluate((_electron, title) => globalThis.qaNotifications.find((n) => n.body === title).emit('click'), `${marker} failed preset`);
    await page.locator('.attention-inbox').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.session-pane:visible .detail-footer code').innerText(), failed.id);
    await page.getByRole('button', { name: /Attention inbox/ }).click();
    await page.getByRole('button', { name: 'Acknowledge all', exact: true }).click();
    await poll(async () => (await state()).attention.every((a) => a.acknowledged), 'Acknowledgement not saved');
    console.log('PASS host configuration/routing, custom presets, literal argument quoting, confirmed attention events, notification dispatch/click routing, and acknowledgement');
    // Save the intended workspace layout, close Electron, and verify restoration.
    await page.getByRole('combobox', { name: 'Filter SSH host' }).selectOption('default');
    await select(0);
    await page.getByRole('combobox', { name: 'Split terminal', exact: true }).selectOption(`default/tmux:${names[1]}`);
    await poll(async () => (await state()).workspace.splitKey === `default/tmux:${names[1]}`, 'Split layout not persisted');
    await app.close(); app = null; await launch();
    await poll(async () => await page.locator('.session-pane:visible .terminal-panel.is-attached').count() === 2, 'Split terminals did not reconnect after restart');
    saved = await state();
    assert.equal(saved.workspace.metadata[`default/tmux:${names[0]}`].project, 'Workspace QA');
    assert.equal(saved.workspace.metadata[`default/tmux:${names[0]}`].pinned, true);
    assert.ok(saved.workspace.metadata[`default/tmux:${names[0]}`].notes.includes('Next: inspect fixture output'));
    assert.equal(saved.settings.presets.find((p) => p.name === 'Claude OpenRouter QA').command, 'claude3');
    assert.ok(saved.attention.every((a) => a.acknowledged));
    await refresh();
    assert.ok((await state()).attention.every((a) => a.acknowledged), 'Restart duplicated attention events');
    // One unavailable host must not hide working hosts or infer task completion.
    const recoveryConfig = saved.settings;
    recoveryConfig.hosts.push({ id: 'offline', name: 'Offline QA', target: '127.0.0.1', port: 1, enabled: true });
    await page.evaluate((c) => window.agentHQ.saveSettings(c), recoveryConfig);
    const recovery = await page.evaluate(() => window.agentHQ.inventory());
    assert.equal(recovery.hosts.find((h) => h.id === 'offline').connected, false);
    assert.ok(recovery.hosts.find((h) => h.id === 'default').connected);
    assert.ok(recovery.sessions.some((s) => s.key === `default/tmux:${names[0]}` && !s.stale));
    await page.locator('.host-errors').waitFor();
    assert.ok((await page.locator('.host-errors').innerText()).includes('Offline QA'));
    const health = await page.evaluate(() => window.agentHQ.health());
    assert.equal(health.find((h) => h.hostId === 'offline').connected, false);
    assert.ok(health.find((h) => h.hostId === 'default').connected);
    await assert.rejects(page.evaluate(() => window.agentHQ.stop('external-not-managed', 'default')), /Invalid session name/);
    await assert.rejects(page.evaluate(() => window.agentHQ.create({ provider: 'claude', hostId: 'not-configured', cwd: '/tmp', title: 'Must not launch' })), /Host is unavailable/);
    console.log('PASS unavailable-host isolation, visible recovery controls, managed-only stop, and rejected unknown-host routing');
    assert.deepEqual(errors, []);
    console.log('PASS restart restores tabs, split connections, pins, projects, notes, settings, and attention acknowledgement; no renderer/console errors');
    console.log(`Screenshots: ${path.join(os.tmpdir(), 'agent-hq-workspace.png')}, ${path.join(os.tmpdir(), 'agent-hq-workspace-narrow.png')}, ${path.join(os.tmpdir(), 'agent-hq-attention.png')}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-workspace-failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (page && clipboardBefore !== undefined) await page.evaluate((text) => window.agentHQ.writeClipboard(text), clipboardBefore).catch(() => {});
    if (app) await app.close();
    await remote('cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
