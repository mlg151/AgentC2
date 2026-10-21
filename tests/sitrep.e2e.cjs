// Live SSH SitRep fixture; a shell preset stands in for a provider CLI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { Store, defaults } = require('../electron/config.cjs');
const { createService } = require('../electron/service.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const host = process.env.AGENTC2_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an isolated SSH test host');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-sitrep-live-'));
const fixture = { root: `/tmp/agentc2-sitrep-${crypto.randomBytes(8).toString('hex')}`, sourceId: crypto.randomBytes(16).toString('hex'), targetId: crypto.randomBytes(16).toString('hex') };
const python = String.raw`
import base64,hashlib,json,pathlib,shutil,subprocess,sys
p=json.loads(base64.b64decode(sys.argv[1])); root=pathlib.Path(p['root']); home=pathlib.Path.home()
owned=home/'.cache'/'agent-hq'/'worktrees'; source=root/'source'; target=root/'target'
def git(*args): return subprocess.check_output(['git',*map(str,args)],text=True).strip()
def name(op): return 'hq-'+hashlib.sha256(op.encode()).hexdigest()[:12]
def worktree(op,repo): return owned/'paths'/hashlib.sha256(str(repo).encode()).hexdigest()[:16]/op
if p['action']=='setup':
 root.mkdir(); source.mkdir(); git('-C',source,'init','-q'); git('-C',source,'config','user.name','SitRep QA'); git('-C',source,'config','user.email','qa@example.invalid')
 (source/'README.md').write_text('base\n'); git('-C',source,'add','README.md'); git('-C',source,'commit','-qm','base'); base=git('-C',source,'rev-parse','HEAD')
 git('clone','-q',source,target)
 token=hashlib.sha256(p['sourceId'].encode()).hexdigest(); branch='agentc2/source-'+token[:16]; tree=worktree(p['sourceId'],source)
 tree.parent.mkdir(parents=True,exist_ok=True); git('-C',source,'worktree','add','--no-track','-b',branch,tree,base)
 (tree/'README.md').write_text('base\nhandoff\n')
 (tree/'large.txt').write_text(''.join(f'QA handoff line {i:04d} '+('x'*55)+'\n' for i in range(1800)))
 git('-C',tree,'add','large.txt')
 record={'operationId':p['sourceId'],'requestDigest':'fixture','repository':str(source),'baseRef':base,'baseCommit':base,'branch':branch,'path':str(tree),'name':name(p['sourceId']),'provider':'codex','slug':'source','title':'Source QA','presetName':'','hasInstructions':False,'state':'launched'}
 records=owned/'records'; records.mkdir(parents=True,exist_ok=True); (records/(p['sourceId']+'.json')).write_text(json.dumps(record))
 subprocess.run(['tmux','new-session','-d','-s',record['name'],'-n','chat','-c',str(tree),'sleep 300'],check=True)
 for key,value in [('provider','codex'),('title','Source QA'),('cwd',str(tree)),('worktree',p['sourceId'])]: subprocess.run(['tmux','set-option','-t',record['name'],'@hq_'+key,value],check=True)
 print(json.dumps({'sourceName':record['name'],'target':str(target),'base':base}))
elif p['action']=='verify':
 record=json.loads((owned/'records'/(p['targetId']+'.json')).read_text()); tree=pathlib.Path(record['path'])
 print(json.dumps({'content':(tree/'README.md').read_text(),'largeBytes':(tree/'large.txt').stat().st_size,'source':record.get('sitrepSource'),'name':record['name'],'state':record['state'],'sourceContent':(worktree(p['sourceId'],source)/'README.md').read_text()}))
elif p['action']=='mutate':
 (worktree(p['sourceId'],source)/'README.md').write_text('base\nhandoff\nlate edit\n'); print('{}')
elif p['action']=='restore':
 (worktree(p['sourceId'],source)/'README.md').write_text('base\nhandoff\n'); print('{}')
elif p['action']=='mark-ready':
 record=owned/'records'/(p['targetId']+'.json'); data=json.loads(record.read_text()); subprocess.run(['tmux','kill-session','-t',data['name']],check=True); data['state']='ready'; record.write_text(json.dumps(data)); print('{}')
elif p['action']=='cleanup':
 assert root.name.startswith('agentc2-sitrep-') and root.parent==pathlib.Path('/tmp')
 records=owned/'records'
 extra=[]
 if records.exists():
  for candidate in records.glob('*.json'):
   try:
    data=json.loads(candidate.read_text())
    if data.get('sitrepSource',{}).get('operationId')==p['sourceId'] and data.get('repository')==str(target): extra.append(data['operationId'])
   except (ValueError,KeyError,AttributeError): pass
 for op,repo in [(p['sourceId'],source),*[(item,target) for item in set([p['targetId'],*extra])]]:
  subprocess.run(['tmux','kill-session','-t',name(op)],capture_output=True)
  record=owned/'records'/(op+'.json')
  if record.exists():
   data=json.loads(record.read_text()); tree=pathlib.Path(data['path'])
   if repo.exists():
    subprocess.run(['git','-C',str(repo),'worktree','remove','--force',str(tree)],capture_output=True)
    subprocess.run(['git','-C',str(repo),'branch','-D',data['branch']],capture_output=True)
   record.unlink()
 shutil.rmtree(root,ignore_errors=True)
 print('{}')
`;
function remote(action) {
  const encoded = Buffer.from(JSON.stringify({ ...fixture, action })).toString('base64');
  return JSON.parse(execFileSync(sshBinary(), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-', encoded], { input: python, encoding: 'utf8', timeout: 25000 }).trim());
}

(async () => {
  let app, service;
  try {
    const setup = remote('setup');
    const store = new Store(directory);
    const settings = defaults();
    settings.hosts[0].target = host;
    settings.hosts.push({ id: 'recipient', name: 'Recipient SSH route', target: host, port: 22, enabled: true });
    settings.presets.push({ ...settings.presets[0], id: 'sitrep-qa', name: 'SitRep QA shell', hostId: 'recipient', command: 'bash', args: "-c 'sleep 300'", fullPermissions: false, attentionHooks: false });
    settings.presets.push({ ...settings.presets[1], id: 'sitrep-claude-qa', name: 'SitRep Claude QA shell', hostId: 'recipient', command: 'bash', args: "-c 'sleep 300'", fullPermissions: false, attentionHooks: false });
    store.save('settings', settings);
    service = createService({ directory, home: os.homedir() });
    const client = { id: 'desktop', name: 'Desktop QA' };
    const preview = await service.previewSitrep(client, { sourceHostId: 'default', name: setup.sourceName, operationId: fixture.sourceId, targetHostId: 'recipient', repository: setup.target, testCommand: "python3 -c 'print(\"SITREP_OK\")'" });
    assert.equal(preview.ready, true);
    assert.ok(preview.patchBytes > 100000, 'Fixture must exercise stdin transport for large patches');
    assert.equal(preview.patchPreviewTruncated, true);
    assert.equal(preview.test.exitCode, 0);
    assert.ok(preview.test.output.includes('SITREP_OK'));
    const sameHost = await service.previewSitrep(client, { sourceHostId: 'default', name: setup.sourceName, operationId: fixture.sourceId, targetHostId: 'default', repository: '', testCommand: '' });
    assert.equal(sameHost.target.ready, true);
    const launch = { id: preview.id, operationId: fixture.targetId, objective: 'Continue the QA change', summary: 'Add handoff line', nextSteps: 'Inspect README', title: 'Recipient QA', slug: 'recipient', provider: 'codex', presetId: 'sitrep-qa', roeProfile: 'provider-default' };
    remote('mutate');
    await assert.rejects(service.launchSitrep(client, launch), /Source changed/);
    remote('restore');
    const first = await service.launchSitrep(client, launch);
    assert.equal(first.hostId, 'recipient');
    const verified = remote('verify');
    assert.equal(verified.content, 'base\nhandoff\n');
    assert.ok(verified.largeBytes > 100000);
    assert.equal(verified.sourceContent, 'base\nhandoff\n');
    assert.equal(verified.source.operationId, fixture.sourceId);
    assert.equal(verified.state, 'launched');
    assert.equal((await service.launchSitrep(client, launch)).name, first.name, 'Retry must reuse the existing recipient');
    remote('mark-ready');
    await service.inventory();
    console.log('PASS cross-route SSH SitRep evidence, patch-before-launch, source preservation, tracing, and deduplicated retry');
    app = await _electron.launch({ executablePath: require('electron'), args: ['.', `--user-data-dir=${path.join(directory, 'browser')}`], cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', AGENTC2_HOST: host, AGENT_HQ_DATA_DIR: directory } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'New unit' }).click();
    const newUnit = page.getByRole('dialog', { name: 'New session' });
    await newUnit.getByRole('combobox', { name: 'SSH host' }).selectOption('recipient');
    await newUnit.getByRole('checkbox', { name: 'Isolate this task in a Git worktree' }).check();
    await newUnit.getByRole('button', { name: 'Recover SitRep' }).click();
    await newUnit.getByRole('textbox', { name: 'Starting instructions' }).fill('Continue the reviewed SitRep objective after restart.');
    await newUnit.getByRole('button', { name: 'Start session' }).click();
    await page.getByRole('dialog', { name: 'New session' }).waitFor({ state: 'hidden', timeout: 30000 });
    assert.equal(remote('verify').state, 'launched');
    console.log('PASS ready SitRep recovery reuses the target worktree after re-entered instructions');
    await page.locator('.session-row').filter({ hasText: 'Source QA' }).first().click();
    await page.getByRole('button', { name: 'Notes & handoff' }).click();
    await page.getByRole('button', { name: 'SitRep handoff' }).click();
    await page.getByRole('combobox', { name: 'Target SSH host' }).selectOption('recipient');
    await page.getByRole('textbox', { name: 'Primary Git checkout on target host' }).fill(setup.target);
    await page.getByRole('combobox', { name: 'Recipient provider' }).selectOption('claude');
    await page.getByRole('combobox', { name: 'Launch preset' }).selectOption('sitrep-claude-qa');
    await page.getByRole('combobox', { name: 'Rules of Engagement' }).selectOption('provider-default');
    await page.getByRole('textbox', { name: 'What changed' }).fill('Apply the reviewed README handoff change.');
    await page.getByRole('button', { name: 'Preview SitRep and target' }).click();
    await page.getByText('Ready to send').waitFor();
    const screenshotDirectory = process.env.AGENTC2_QA_SCREENSHOT_DIR || os.tmpdir();
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDirectory, 'agentc2-sitrep-preview.png') });
    await page.getByRole('button', { name: 'Send and launch recipient' }).click();
    await page.getByRole('dialog', { name: 'SitRep handoff' }).waitFor({ state: 'hidden', timeout: 30000 });
    await page.locator('.session-row').filter({ hasText: 'Handoff: Source QA' }).first().waitFor({ timeout: 15000 });
    console.log('PASS Electron SitRep review, target selection, and recipient launch');
  } finally {
    if (app) await app.close();
    try { remote('cleanup'); } catch (_) { /* Host may be offline. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
