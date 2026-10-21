// Live Electron + SSH fixtures; never submit prompts to provider CLIs.
const { _electron } = require('playwright-core');
const { spawn, execFileSync } = require('node:child_process');
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
const names = Array.from({ length: 10 }, (_, index) => index).map(() => `hq-${crypto.randomBytes(6).toString('hex')}`);
const created = [];
const marker = `HQ_WORKSPACE_${crypto.randomBytes(4).toString('hex')}`;
const errors = [];
let app, page, clipboardBefore;
function remote(action) {
  const source = `
import subprocess,sys,json,base64,shlex,shutil
from pathlib import Path
p=json.loads(base64.b64decode(sys.argv[1])); names=p['names']
fixture_root=Path.home()/('agentc2-qa-'+p['marker'])
def run(*args):
 r=subprocess.run(args,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
if p['action']=='setup':
 for label in ['anchor','target']:
  repo=fixture_root/label;repo.mkdir(parents=True)
  run('git','init','-b','qa/'+label,str(repo))
  run('git','-C',str(repo),'-c','user.name=AgentC2 fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','Fixture')
 for i,name in enumerate(names):
  run('tmux','new-session','-d','-s',name,'-n','setup')
  for k,v in [('provider','codex'),('title',p['marker']+' '+str(i)),('cwd',str(fixture_root/('anchor' if i%2==0 else 'target')))]: run('tmux','set-option','-t',name,'@hq_'+k,v)
  run('tmux','set-option','-t',name,'history-limit','50000')
  run('tmux','set-option','-t',name,'status-left',' AGENTC2 QA ')
  run('tmux','set-option','-t',name,'status-right','')
  program="import os; [print('HQ_SEARCH_%05d'%i,flush=True) for i in range(1,3001)]; os.execvpe('bash',['bash','--noprofile','--norc'],dict(os.environ,PS1='HQ_FIXTURE> '))"
  run('tmux','new-window','-t',name,'-n','chat','-c',str(fixture_root/('anchor' if i%2==0 else 'target')),shlex.join(['python3','-u','-c',program]))
  run('tmux','kill-window','-t',name+':setup')
 print('{}')
elif p['action']=='pane-pid':
 print(run('tmux','display-message','-p','-t',names[0],'#{pane_pid}'))
elif p['action']=='state':
 print(json.dumps([run('tmux','capture-pane','-p','-t',name) for name in names[:2]]))
elif p['action']=='cleanup':
 for name in names: subprocess.run(['tmux','kill-session','-t',name],capture_output=True)
 if fixture_root.exists(): shutil.rmtree(fixture_root)
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
async function select(index) { await page.locator('.session-row').filter({ hasText: `${marker} ${index}` }).click(); await page.locator('.session-pane.is-focused .terminal-panel.is-attached').waitFor({ timeout: 30000 }); }

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
    const gitUnit = (await page.evaluate(() => window.agentHQ.inventory())).sessions.find((session) => session.id === names[0]);
    assert.equal(gitUnit.branch, 'qa/anchor');
    assert.ok(gitUnit.repository.endsWith('/anchor'));
    await page.getByLabel('Roster options', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Group roster', exact: true }).selectOption('repository');
    assert.ok((await page.locator('.roster-group-heading').allTextContents()).some((text) => text.includes('anchor')));
    await page.getByRole('combobox', { name: 'Group roster', exact: true }).selectOption('host');
    await page.getByLabel('Roster options', { exact: true }).click();
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
    if (process.platform === 'linux') {
      // Kill only this fixture's local SSH attachment. The remote tmux pane must survive.
      const extra = await page.evaluate((name) => window.agentHQ.openTerminal(name, 100, 32, 'default'), names[0]);
      const before = await page.evaluate((id) => window.agentHQ.terminalState(id), extra);
      const panePid = await remote('pane-pid');
      const alertsBefore = (await state()).attention.filter((item) => item.sessionKey === `default/tmux:${names[0]}`).map((item) => item.id);
      const candidates = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes('ssh ') && line.includes('-tt') && line.includes(`tmux attach-session -t ${names[0]}`));
      assert.equal(candidates.length, 1, `Expected one local SSH PTY attachment, found ${candidates.length}`);
      process.kill(Number(candidates[0].trim().split(/\s+/)[0]), 'SIGKILL');
      await poll(async () => (await page.evaluate((id) => window.agentHQ.terminalState(id), extra)).connection === 'reconnecting', 'SSH transport drop was not recognized');
      await assert.rejects(page.evaluate((id) => window.agentHQ.writeTerminal(id, 'must not be queued'), extra), /reconnecting/);
      await poll(async () => (await page.evaluate((id) => window.agentHQ.terminalState(id), extra)).connection === 'connected', 'SSH attachment did not reconnect');
      assert.deepEqual(await page.evaluate((id) => window.agentHQ.terminalState(id), extra), before);
      assert.equal(await remote('pane-pid'), panePid, 'Reconnect restarted the remote process');
      assert.deepEqual((await state()).attention.filter((item) => item.sessionKey === `default/tmux:${names[0]}`).map((item) => item.id), alertsBefore, 'Reconnect duplicated attention');
      await page.evaluate((id) => window.agentHQ.closeTerminal(id), extra);
      console.log('PASS forced SSH transport drop reconnects one attachment without restarting tmux, queuing input, resizing, or duplicating alerts');
    }

    // Pane B cycling may not focus, remount, or resize the anchor.
    const anchor = page.locator(`[data-session-key="default/tmux:${names[0]}"].session-pane`);
    await anchor.locator('.xterm-helper-textarea').focus();
    const anchorElement = await anchor.elementHandle();
    const anchorBounds = await anchor.boundingBox();
    await page.keyboard.press('Alt+j');
    await page.waitForTimeout(400);
    assert.ok(await anchorElement.evaluate((element) => element.isConnected));
    assert.deepEqual(await anchor.boundingBox(), anchorBounds);
    assert.ok(await anchor.locator('.xterm-helper-textarea').evaluate((element) => element === document.activeElement), 'Cycling B stole anchor focus');
    await poll(async () => Boolean((await state()).workspace.situation.callsigns[`default/tmux:${names[1]}`]), 'Callsigns not persisted');
    let room = (await state()).workspace.situation;
    await select(1);
    await page.keyboard.press('Alt+l');
    const promptBefore = await remote('state');
    await page.keyboard.press('Control+Space');
    await page.keyboard.type(room.callsigns[`default/tmux:${names[1]}`]);
    await poll(async () => (await state()).workspace.situation.targetKey === `default/tmux:${names[1]}`, 'Callsign command did not select the target');
    await page.keyboard.press('Control+Space');
    await page.keyboard.press('Escape');
    assert.ok((await page.locator('.command-feedback').innerText()).includes('cancelled'));
    await page.keyboard.press('Control+Space');
    await poll(async () => (await page.locator('.command-feedback').innerText()).includes('timed out'), 'Command mode did not time out');
    assert.equal(await remote('state'), promptBefore, 'Command digits or cancellation leaked into a fixture PTY');
    await page.getByRole('textbox', { name: 'Search sessions' }).focus();
    await page.keyboard.press('Control+Space');
    await page.keyboard.type('01');
    assert.equal(await page.getByRole('textbox', { name: 'Search sessions' }).inputValue(), marker + '01');
    await page.getByRole('textbox', { name: 'Search sessions' }).fill(marker);
    await select(0);
    await page.locator('.session-pane.is-focused .xterm-helper-textarea').evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, isComposing: true, bubbles: true })));
    assert.equal(await page.getByRole('dialog', { name: 'Overwatch', exact: true }).count(), 0, 'IME composition triggered a command');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.waitForTimeout(400);
    const previewHandle = await page.evaluate((name) => window.agentHQ.openTerminal(name, 100, 32, 'default'), names[0]);
    const terminalBefore = await page.evaluate((id) => window.agentHQ.terminalState(id), previewHandle);
    await page.keyboard.press('Control+g');
    const overwatch = page.getByRole('dialog', { name: 'Overwatch', exact: true });
    await overwatch.waitFor();
    assert.equal(await overwatch.locator('.xterm').count(), 0);
    assert.ok(await overwatch.locator('.overwatch-unit').count() <= 12);
    await page.getByRole('combobox', { name: 'Overwatch grid size' }).selectOption('16');
    const preview = overwatch.locator(`[data-session-key="default/tmux:${names[0]}"]`);
    await poll(async () => (await preview.locator('pre').innerText()).includes('HQ_FIXTURE'), 'Read-only terminal snapshot missing');
    await page.screenshot({ path: path.join(os.tmpdir(), 'agentc2-overwatch.png') });
    assert.deepEqual(await page.evaluate((id) => window.agentHQ.terminalState(id), previewHandle), terminalBefore, 'Overwatch changed control ownership or PTY dimensions');
    await page.evaluate((id) => window.agentHQ.closeTerminal(id), previewHandle);
    await preview.click();
    await overwatch.waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+Space'); await page.keyboard.press('z');
    await poll(async () => page.locator('.session-pane:visible').count().then((count) => count === 1), 'Zen did not isolate the focused pane');
    await page.keyboard.press('Control+Space'); await page.keyboard.press('z');
    await poll(async () => page.locator('.session-pane:visible').count().then((count) => count === 2), 'Zen did not restore both panes');
    await page.keyboard.press('F1');
    await page.getByRole('textbox', { name: 'Shortcut Cycle Pane B forward', exact: true }).fill('Ctrl+K');
    await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
    assert.ok((await page.getByRole('alert').innerText()).includes('conflicts'));
    await page.getByRole('textbox', { name: 'Shortcut Cycle Pane B forward', exact: true }).fill('Alt+U');
    await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
    await poll(async () => (await state()).workspace.situation.shortcuts.cycleNext === 'Alt+U', 'Shortcut remapping not persisted');
    await select(0);
    console.log('PASS stable anchor focus/dimensions, callsign commands, cancel/timeout, read-only Overwatch, Zen restoration, and validated shortcut persistence');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-workspace.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agent-hq-workspace-narrow.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.ok(await page.evaluate(() => { const host = document.querySelector('.situation-header .host-picker select').getBoundingClientRect(); const settings = document.querySelector('.situation-header [aria-label="Settings"]').getBoundingClientRect(); return host.right + 4 <= settings.left; }), 'Theater selector overlaps Settings in a narrow window');
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
    await poll(async () => (await page.locator('.session-pane.is-focused .detail-footer code').innerText()) === names[1], 'Quick switcher did not focus the selected target');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.getByRole('textbox', { name: 'Quick switcher search' }).fill('HQ_SEARCH_00001');
    await page.getByRole('button', { name: 'Search retained terminal history', exact: true }).click();
    await page.getByRole('region', { name: 'History search results' }).waitFor({ timeout: 30000 });
    assert.ok((await page.getByRole('region', { name: 'History search results' }).innerText()).includes('HQ_SEARCH_00001'));
    await page.keyboard.press('Escape');
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
    assert.ok((await page.locator('.roster-group').first().innerText()).includes('Mirror QA'));
    // Launch harmless fixture commands with the preset pipeline and quoted instructions.
    const config = saved.settings;
    await app.evaluate(({ Notification }) => {
      globalThis.qaNotifications = [];
      if (!Notification.isSupported()) throw new Error('Notification QA requires libnotify and a desktop notification service (CI uses Dunst in a private D-Bus session)');
      // Keep native availability/construction, but record display and clicks.
      Notification.prototype.show = function() { globalThis.qaNotifications.push(this); };
    });
    config.notifications = true;
    config.presets.push({ id: 'fixture', name: 'Fixture launcher', provider: 'claude', command: 'python3', args: `-u -c 'import sys; print("HQ_PRESET_ARG="+sys.argv[-1],flush=True); sys.exit(7)'`, cwd: '/tmp', instructions: 'literal $(touch /tmp/never-execute-this) "quotes"', fullPermissions: false, attentionHooks: false, hostId: mirror.id });
    await page.evaluate((c) => window.agentHQ.saveSettings(c), config);
    // Reload reads the saved preset exactly as a restart would.
    await page.reload(); await page.locator('.session-row').first().waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'New unit', exact: true }).click();
    await page.getByRole('combobox', { name: 'Launch preset' }).selectOption('fixture');
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(`${marker} failed preset`);
    assert.equal(await page.getByRole('combobox', { name: 'SSH host', exact: true }).inputValue(), mirror.id);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.getByRole('dialog', { name: 'New session', exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
    let latest = await page.evaluate(() => window.agentHQ.inventory());
    await poll(async () => { latest = await page.evaluate(() => window.agentHQ.inventory()); return latest.sessions.some((s) => s.title === `${marker} failed preset` && s.hostId === mirror.id); }, 'Created session was not reconciled into inventory');
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
    assert.equal(await page.locator('.session-pane.is-focused .detail-footer code').innerText(), failed.id);
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
    assert.equal(saved.workspace.situation.shortcuts.cycleNext, 'Alt+U');
    assert.equal(saved.workspace.situation.callsigns[`default/tmux:${names[1]}`], room.callsigns[`default/tmux:${names[1]}`]);
    assert.ok(saved.attention.every((a) => a.acknowledged));
    await refresh();
    assert.ok((await state()).attention.every((a) => a.acknowledged), 'Restart duplicated attention events');
    const outageFile = process.env.AGENTC2_SSH_QA_BLOCK_FILE;
    if (outageFile && process.platform === 'linux') {
      await app.close(); app = null;
      fs.writeFileSync(outageFile, 'blocked');
      try {
        await launch();
        const offlineInventory = await page.evaluate(() => window.agentHQ.inventory());
        assert.equal(offlineInventory.hosts.find((item) => item.id === 'default').connected, false);
        assert.ok(offlineInventory.sessions.some((unit) => unit.key === `default/tmux:${names[0]}` && unit.stale && unit.title === `${marker} 0`), 'Restart lost its bounded cached unit');
        assert.equal((await state()).workspace.situation.anchorKey, `default/tmux:${names[0]}`);
        assert.equal((await state()).workspace.situation.targetKey, `default/tmux:${names[1]}`);
        assert.ok((await page.locator('.session-row.anchored').innerText()).includes('UNKNOWN'));
      } finally { fs.rmSync(outageFile, { force: true }); }
      await poll(async () => (await page.evaluate(() => window.agentHQ.inventory())).hosts.find((item) => item.id === 'default').connected, 'Host did not recover after outage');
      await poll(async () => await page.locator('.session-pane:visible .terminal-panel.is-attached').count() === 2, 'Cached panes did not reattach after host recovery');
      assert.ok((await state()).attention.every((item) => item.acknowledged), 'Offline restart duplicated attention');
      console.log('PASS offline desktop restart preserves stale units and A/B assignments, then reattaches on host recovery');
    }

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
    if (page) {
      const snapshot = await page.evaluate(() => window.agentHQ.inventory()).catch(() => null);
      if (snapshot) console.error('Workspace fixture diagnostics:', snapshot.hosts, snapshot.sessions.filter((session) => names.includes(session.id) || created.includes(session.id)).map(({ id, hostId, state, exitCode, outputTail }) => ({ id, hostId, state, exitCode, outputTail })), snapshot.attention.map(({ sessionKey, kind, confidence }) => ({ sessionKey, kind, confidence })));
    }
    throw error;
  } finally {
    if (page && clipboardBefore !== undefined) await page.evaluate((text) => window.agentHQ.writeClipboard(text), clipboardBefore).catch(() => {});
    if (process.env.AGENTC2_SSH_QA_BLOCK_FILE) fs.rmSync(process.env.AGENTC2_SSH_QA_BLOCK_FILE, { force: true });
    if (app) await app.close();
    await remote('cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
