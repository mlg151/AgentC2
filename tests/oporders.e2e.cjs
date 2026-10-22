// Live SSH fixture for OpOrder preview, enrollment, conflict, and pause behavior.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store, defaults } = require('../electron/config.cjs');
const { createService } = require('../electron/service.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const host = process.env.AGENTC2_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an isolated SSH test host');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-oporders-test-'));
const repository = `/tmp/agentc2-oporders-${crypto.randomBytes(8).toString('hex')}`;
const ssh = sshBinary();
function remote(source) {
  return execFileSync(ssh, ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3', '-', repository], { input: source, encoding: 'utf8', timeout: 20000 }).trim();
}

(async () => {
  try {
    remote('import pathlib,subprocess,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(); subprocess.run(["git","init","-q",str(p)],check=True); (p/"AGENTS.md").write_text("Unrelated team note\\n")');
    const store = new Store(directory);
    const settings = defaults();
    settings.hosts[0].target = host;
    store.save('settings', settings);
    const service = createService({ directory, home: os.homedir() });
    const order = { version: 1, id: `qa_${crypto.randomBytes(6).toString('hex')}`, hostId: 'default', repository, enabled: false, instructions: 'Isolated QA guidance', overrides: { codex: '', claude: 'Claude QA guidance', antigravity: '' }, mcp: [] };
    const preview = await service.previewOpOrder(order);
    assert.equal(preview.ready, true);
    assert.ok(preview.changes.some((change) => change.path === 'AGENTS.md' && change.status === 'update'));
    const saved = await service.enrollOpOrder(order, preview.revision);
    assert.equal(saved.opOrders[0].enabled, true);
    assert.equal(remote('import pathlib,sys; print((pathlib.Path(sys.argv[1])/"AGENTS.md").read_text())').includes('Isolated QA guidance'), true);
    assert.equal((await service.previewOpOrder({ ...order, enabled: true })).changes.every((change) => change.status === 'unchanged'), true);
    remote('import pathlib,sys; p=pathlib.Path(sys.argv[1])/"AGENTS.md"; p.write_text(p.read_text().replace("Isolated QA guidance","Remote edit"))');
    const conflict = await service.previewOpOrder({ ...order, enabled: true });
    assert.equal(conflict.ready, false);
    await assert.rejects(service.enrollOpOrder(order, conflict.revision), /conflicts/);
    assert.equal(remote('import pathlib,sys; print("Remote edit" in (pathlib.Path(sys.argv[1])/"AGENTS.md").read_text())'), 'True');
    await service.saveSettings({ ...saved, opOrders: [{ ...saved.opOrders[0], enabled: false }] });
    await service.inventory();
    assert.equal(remote('import pathlib,sys; print("Remote edit" in (pathlib.Path(sys.argv[1])/"AGENTS.md").read_text())'), 'True');
    console.log('PASS SSH OpOrder preview, enrollment, idempotence, remote conflict preservation, and paused sync');
  } finally {
    try { remote('import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); assert p.name.startswith("agentc2-oporders-") and p.parent==pathlib.Path("/tmp"); shutil.rmtree(p,ignore_errors=True)'); } catch (_) { /* Host may be offline. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
