// Browser plugin not available: Playwright launches Electron against disposable
// SSH provider storage. Explicit QA home prevents accidental use of user history.
const { _electron } = require('playwright-core');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../electron/config.cjs');

const host = process.env.AGENTC2_HOST;
const remoteHome = process.env.AGENTC2_CLEANUP_QA_HOME;
if (!host || !remoteHome || !path.posix.isAbsolute(remoteHome) || !remoteHome.startsWith('/tmp/agentc2-cleanup-ssh-')) throw new Error('Use an isolated SSH daemon: set AGENTC2_HOST and AGENTC2_CLEANUP_QA_HOME=/tmp/agentc2-cleanup-ssh-*/remote-home');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-cleanup-ui-'));
const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
const marker = `CLEANUP_QA_${crypto.randomBytes(4).toString('hex')}`;
const key = (index) => `default/claude:${ids[index]}`;
const errors = [];
let app, page;
function remote(action) {
  const source = `
import os,sys,json,base64,time,shutil
from pathlib import Path
p=json.loads(base64.b64decode(sys.argv[1])); home=Path.home(); ids=p['ids']; marker=p['marker']
assert str(home)==p['home'] and str(home).startswith('/tmp/agentc2-cleanup-ssh-'), 'Disposable provider HOME required'
project=home/'.claude'/'projects'/marker
def write(index, old=True):
 project.mkdir(parents=True,exist_ok=True)
 path=project/(ids[index]+'.jsonl')
 path.write_text(json.dumps({'type':'user','sessionId':ids[index],'cwd':'/tmp','message':{'content':marker+' '+str(index)}})+'\\n')
 when=time.time()-(90 if old else 1)*86400; os.utime(path,(when,when))
if p['action']=='setup':
 assert not (home/'.claude').exists(), 'Use a fresh disposable home'
 for i in range(3): write(i,i<2)
 (project/'sessions-index.json').write_text(json.dumps({'version':1,'entries':[{'sessionId':i} for i in ids[:3]]}))
elif p['action']=='change':
 path=project/(ids[1]+'.jsonl'); path.write_text(path.read_text()+'{}\\n')
elif p['action']=='automatic':
 write(3); write(4)
elif p['action']=='check':
 print(json.dumps({'present':[i for i in range(5) if (project/(ids[i]+'.jsonl')).exists()]}))
elif p['action']=='cleanup':
 if (home/'.claude').exists(): shutil.rmtree(home/'.claude')
`;
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-', Buffer.from(JSON.stringify({ action, ids, marker, home: remoteHome })).toString('base64')]);
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject); child.on('close', (code) => code ? reject(new Error(error)) : resolve(output)); child.stdin.end(source);
  });
}
async function poll(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
  throw new Error(message);
}
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], cwd: root, env: { ...process.env, NODE_ENV: 'production', AGENTC2_DATA_DIR: directory } });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  assert.equal(await page.title(), 'AgentC2');
  await page.getByRole('textbox', { name: 'Search sessions', exact: true }).waitFor();
  await page.locator('.session-row').filter({ hasText: marker }).first().waitFor({ timeout: 60000 });
}
(async () => {
  try {
    await remote('setup');
    const store = new Store(directory);
    store.save('workspace', { tabs: [key(0), key(1)], selectedKey: key(0), splitKey: null, metadata: { [key(0)]: { pinned: true, project: 'Cleanup QA', notes: 'First fixture' }, [key(1)]: { pinned: false, project: 'Cleanup QA', notes: 'Preserve failed history' } } });
    await launch();
    await page.getByRole('button', { name: 'Delete history', exact: true }).click();
    await page.getByRole('button', { name: 'Preview selected history', exact: true }).click();
    await page.getByText('Pinned history is protected', { exact: false }).waitFor();
    assert.equal(await page.getByLabel(`Delete history ${marker} 0`, { exact: true }).isEnabled(), false);
    await page.getByLabel('Allow manual deletion of pinned histories in this preview', { exact: true }).check();
    await page.getByRole('button', { name: 'Preview selected history', exact: true }).click();
    await page.getByLabel(`Delete history ${marker} 0`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(`Delete history ${marker} 0`, { exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Delete selected histories', exact: true }).isEnabled(), false);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agentc2-cleanup-preview.png') });
    await page.getByRole('button', { name: 'Close session cleanup', exact: true }).click();
    await page.evaluate((key) => window.agentHQ.setSessionPinned(key, false), key(0));
    const stale = (await page.evaluate(() => window.agentHQ.getState())).workspace;
    await page.getByRole('button', { name: 'Session cleanup', exact: true }).click();
    await page.getByRole('combobox', { name: 'History provider', exact: true }).selectOption('claude');
    await page.getByRole('button', { name: 'Preview old histories', exact: true }).click();
    await page.getByRole('heading', { name: 'Review 2 histories', exact: true }).waitFor();
    await remote('change');
    await page.getByLabel('Confirm permanent history deletion', { exact: true }).check();
    await page.getByRole('button', { name: 'Delete selected histories', exact: true }).click();
    await page.getByRole('region', { name: 'Cleanup results', exact: true }).waitFor();
    await poll(async () => (await page.evaluate(() => window.agentHQ.cleanupState())).results.some((result) => result.key === key(0) && result.status === 'deleted'), 'Confirmed deletion missing');
    const state = await page.evaluate(() => window.agentHQ.getState());
    assert.equal(state.workspace.metadata[key(0)], undefined);
    assert.equal(state.workspace.metadata[key(1)].notes, 'Preserve failed history');
    assert.ok((await page.evaluate(() => window.agentHQ.cleanupState())).results.some((result) => result.key === key(1) && result.status === 'changed'));
    assert.deepEqual(JSON.parse(await remote('check')).present, [1, 2]);
    await page.evaluate((workspace) => window.agentHQ.saveWorkspace(workspace), stale);
    assert.equal((await page.evaluate(() => window.agentHQ.getState())).workspace.metadata[key(0)], undefined);
    await page.getByRole('region', { name: 'Cleanup results', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'agentc2-cleanup-results.png') });
    await page.getByRole('button', { name: 'Close session cleanup', exact: true }).click();
    await page.locator('.session-row').filter({ hasText: marker + ' 1' }).click();
    await page.getByRole('button', { name: 'Delete history', exact: true }).click();
    await page.getByRole('button', { name: 'Preview selected history', exact: true }).click();
    await page.getByLabel('Confirm permanent history deletion', { exact: true }).check();
    await page.getByRole('button', { name: 'Delete selected histories', exact: true }).click();
    await poll(async () => (await page.evaluate(() => window.agentHQ.cleanupState())).results.some((result) => result.key === key(1) && result.status === 'deleted'), 'Fresh preview did not recover changed history');
    assert.deepEqual(JSON.parse(await remote('check')).present, [2]);
    await page.getByRole('button', { name: 'Close session cleanup', exact: true }).click();
    await remote('automatic');
    await page.evaluate(() => window.agentHQ.inventory());
    await page.evaluate((key) => window.agentHQ.setSessionPinned(key, true), key(4));
    await page.getByRole('button', { name: 'Session cleanup', exact: true }).click();
    await page.getByRole('combobox', { name: 'History provider', exact: true }).selectOption('claude');
    await page.getByLabel('Enable automatic history cleanup', { exact: true }).check();
    await page.getByRole('button', { name: 'Save retention', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Retention saved' }).waitFor();
    await app.close(); app = null;
    await launch();
    await poll(async () => (await page.evaluate(() => window.agentHQ.cleanupState())).results.some((result) => result.key === key(3) && result.automatic && result.status === 'deleted'), 'Due retention did not run after restart');
    assert.deepEqual(JSON.parse(await remote('check')).present, [2, 4]);
    assert.equal((await page.evaluate(() => window.agentHQ.getState())).workspace.metadata[key(4)].pinned, true);
    await page.getByRole('button', { name: 'Session cleanup', exact: true }).click();
    await page.getByRole('combobox', { name: 'History provider', exact: true }).selectOption('claude');
    assert.equal(await page.getByLabel('Enable automatic history cleanup', { exact: true }).isChecked(), true);
    await page.getByRole('combobox', { name: 'History provider', exact: true }).selectOption('antigravity');
    assert.equal(await page.getByLabel('Enable automatic history cleanup', { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel('Enable automatic history cleanup', { exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Preview retention / run now', exact: true }).isEnabled(), true);
    await page.getByText('Antigravity cleanup uses the provider’s exact-ID', { exact: false }).waitFor();
    await page.screenshot({ path: path.join(os.tmpdir(), 'agentc2-cleanup-antigravity.png') });
    await page.getByRole('combobox', { name: 'History provider', exact: true }).selectOption('claude');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'agentc2-cleanup-retention.png') });
    assert.deepEqual(errors, []);
    console.log('PASS cleanup single/bulk previews, pinned override, permanent confirmation, stale-file rejection, partial results, remote file deletion, local metadata preservation/tombstones, retry, persisted retention, automatic restart catch-up, protected/fresh exclusions, and narrow layout');
  } catch (error) {
    await page?.screenshot({ path: path.join(os.tmpdir(), 'agentc2-cleanup-failure.png') }).catch(() => {});
    console.error('Cleanup UI failure:', await page?.locator('body').innerText().catch(() => 'Page unavailable'));
    throw error;
  } finally {
    await app?.close();
    await remote('cleanup').catch((error) => console.error('Fixture cleanup:', error.message));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
