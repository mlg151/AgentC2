// Isolated live SSH/Electron Joint Exercise fixture with shell stand-ins.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { Store, defaults } = require('../electron/config.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const host = process.env.AGENTC2_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an isolated SSH test host');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-exercise-live-'));
const repository = `/tmp/agentc2-exercise-${crypto.randomBytes(8).toString('hex')}`;
const python = String.raw`
import base64,hashlib,json,pathlib,shutil,subprocess,sys
p=json.loads(base64.b64decode(sys.argv[1])); root=pathlib.Path(p['repository']); action=p['action']; owned=pathlib.Path.home()/'.cache'/'agent-hq'/'worktrees'
def git(*args): return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
if action=='setup':
 root.mkdir(); git('init','-q'); git('config','user.name','Exercise QA'); git('config','user.email','qa@example.invalid'); (root/'file.txt').write_text('base\n'); git('add','file.txt'); git('commit','-qm','base'); print(json.dumps({'base':git('rev-parse','HEAD')}))
elif action=='mutate':
 record=json.loads((owned/'records'/(p['id']+'.json')).read_text()); (pathlib.Path(record['path'])/'file.txt').write_text(p['content']); print('{}')
elif action=='target':
 print(json.dumps({'content':(root/'file.txt').read_text(),'status':git('status','--porcelain')}))
elif action=='cleanup':
 assert root.name.startswith('agentc2-exercise-') and root.parent==pathlib.Path('/tmp')
 for item in p['ids']:
  record_path=owned/'records'/(item+'.json')
  if not record_path.exists(): continue
  record=json.loads(record_path.read_text()); subprocess.run(['tmux','kill-session','-t',record['name']],capture_output=True)
  subprocess.run(['git','-C',str(root),'worktree','remove','--force',record['path']],capture_output=True)
  subprocess.run(['git','-C',str(root),'branch','-D',record['branch']],capture_output=True)
  record_path.unlink()
 shutil.rmtree(root,ignore_errors=True); print('{}')
`;
function remote(action, more = {}) {
  const encoded = Buffer.from(JSON.stringify({ action, repository, ...more })).toString('base64');
  return JSON.parse(execFileSync(sshBinary(), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-', encoded], { input: python, encoding: 'utf8', timeout: 25000 }).trim());
}

(async () => {
  let app, ids = [];
  try {
    const setup = remote('setup');
    const store = new Store(directory);
    const settings = defaults();
    settings.hosts[0].target = host;
    const shell = { command: 'bash', args: "-c 'sleep 300'", fullPermissions: false, attentionHooks: false };
    settings.presets.push({ ...settings.presets[0], ...shell, id: 'exercise-codex-qa', name: 'Exercise Codex QA', hostId: 'default' });
    settings.presets.push({ ...settings.presets[1], ...shell, id: 'exercise-claude-qa', name: 'Exercise Claude QA', hostId: 'default' });
    store.save('settings', settings);
    app = await _electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: directory } });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    assert.equal(await page.title(), 'AgentC2');
    await page.getByRole('button', { name: 'New unit' }).waitFor();
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await page.keyboard.press('Control+Space'); await page.keyboard.press('b');
    const dialog = page.getByRole('dialog', { name: 'Joint Exercises' });
    await dialog.getByRole('textbox', { name: 'Primary Git checkout' }).fill(repository);
    await dialog.getByRole('textbox', { name: 'Identical task for every contestant' }).fill('Implement the same reviewed task.');
    await dialog.getByRole('textbox', { name: 'Verification command (optional)' }).fill("python3 -c 'print(\"EXERCISE_PASS\")'");
    await dialog.getByRole('combobox', { name: 'Launch preset' }).nth(0).selectOption('exercise-codex-qa');
    await dialog.getByRole('combobox', { name: 'Launch preset' }).nth(1).selectOption('exercise-claude-qa');
    await dialog.getByRole('combobox', { name: 'Rules of Engagement' }).nth(0).selectOption('provider-default');
    await dialog.getByRole('combobox', { name: 'Rules of Engagement' }).nth(1).selectOption('provider-default');
    await dialog.getByRole('button', { name: 'Launch exercise' }).click();
    await dialog.getByText(`Shared base`).waitFor({ timeout: 30000 });
    const record = (await page.evaluate(() => window.agentHQ.listExercises()))[0];
    ids = record.contestants.map((item) => item.id);
    assert.equal(record.baseCommit, setup.base);
    assert.equal(record.contestants.length, 2);
    if (!record.contestants.every((item) => item.state === 'launched')) console.error(record.contestants.map((item) => ({ provider: item.provider, state: item.state, error: item.error })));
    assert.ok(record.contestants.every((item) => item.state === 'launched'));
    remote('mutate', { id: ids[0], content: 'winner\n' });
    remote('mutate', { id: ids[1], content: 'loser\n' });
    assert.equal(remote('target').content, 'base\n');
    const cards = dialog.locator('.exercise-result');
    await cards.nth(0).getByRole('button', { name: 'Mark complete' }).click();
    await cards.nth(0).getByRole('button', { name: 'Run verification' }).click();
    await cards.nth(0).locator('pre').last().getByText('EXERCISE_PASS', { exact: true }).waitFor();
    await cards.nth(1).getByRole('button', { name: 'Mark complete' }).click();
    await cards.nth(1).getByRole('button', { name: 'Run verification' }).click();
    await cards.nth(1).locator('pre').last().getByText('EXERCISE_PASS', { exact: true }).waitFor();
    await cards.nth(0).getByRole('button', { name: 'Preview promotion' }).click();
    await dialog.getByRole('heading', { name: 'Promotion preview' }).waitFor();
    if (process.env.AGENTC2_QA_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.AGENTC2_QA_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENTC2_QA_SCREENSHOT_DIR, 'exercise-review.png') });
      await dialog.getByRole('heading', { name: 'Promotion preview' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.AGENTC2_QA_SCREENSHOT_DIR, 'exercise-promotion.png') });
    }
    assert.equal(remote('target').content, 'base\n', 'preview must not write target');
    await dialog.getByRole('button', { name: 'Promote selected result' }).click();
    await dialog.getByText(/Promoted codex into/).waitFor();
    assert.equal(remote('target').content, 'winner\n');
    assert.match(remote('target').status, /file.txt/);
    assert.deepEqual(errors, []);
    console.log('PASS live SSH/Electron Joint Exercise same-base launch, side-by-side verification, reviewed promotion, and staged target');
  } finally {
    if (app) await app.close();
    try { remote('cleanup', { ids }); } catch (_) { /* Host may be offline. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
