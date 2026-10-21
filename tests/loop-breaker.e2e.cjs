// Live SSH fixture: a Claude-labelled managed shell receives synthetic provider
// hook outcomes. This verifies remote revalidation and scoped Ctrl+C without login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store, defaults, validateSettings } = require('../electron/config.cjs');
const { createService } = require('../electron/service.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const host = process.env.AGENTC2_HOST;
if (!host) throw new Error('Set AGENTC2_HOST to an isolated SSH test host');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-loop-live-'));
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host];
function remote(source, name) { return execFileSync(sshBinary(), [...sshArgs, 'python3', '-', name], { input: source, encoding: 'utf8', timeout: 20000 }).trim(); }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let service, faulty, manual, healthy;
  try {
    const settings = defaults();
    settings.hosts[0].target = host;
    settings.presets.push({ ...settings.presets[1], id: 'loop-qa', name: 'Loop fixture', command: 'bash', args: "-c 'sleep 300'", attentionHooks: false, fullPermissions: false });
    settings.presets.push({ ...settings.presets[1], id: 'loop-manual-qa', name: 'Manual loop fixture', command: 'bash', args: "-c 'sleep 300'", attentionHooks: false, fullPermissions: false });
    new Store(directory).save('settings', validateSettings(settings));
    service = createService({ directory, home: os.homedir() });
    faulty = await service.create({ provider: 'claude', hostId: 'default', presetId: 'loop-qa', roeProfile: 'provider-default', title: 'Faulty fixture', instructions: '' });
    manual = await service.create({ provider: 'claude', hostId: 'default', presetId: 'loop-manual-qa', roeProfile: 'provider-default', title: 'Manual fixture', instructions: '' });
    healthy = await service.create({ provider: 'terminal', hostId: 'default', title: 'Healthy neighbor', cwd: '' });
    await service.inventory();
    const enabled = structuredClone(service.store.data.settings);
    const preset = enabled.presets.find((item) => item.id === 'loop-qa');
    preset.attentionHooks = true;
    preset.loopBreaker = { enabled: true, autoInterrupt: true, threshold: 4, windowMinutes: 10, cooldownMinutes: 15 };
    const manualPreset = enabled.presets.find((item) => item.id === 'loop-manual-qa');
    manualPreset.attentionHooks = true;
    manualPreset.loopBreaker = { ...preset.loopBreaker, autoInterrupt: false };
    service.store.save('settings', validateSettings(enabled));
    const at = new Date().toISOString();
    const lines = Array.from({ length: 4 }, (_, index) => ({ id: (index + 1).toString(16).padStart(32, '0'), at, kind: 'tool_failed', source: 'claude', failureSignature: 'a'.repeat(32), failureLabel: 'Bash Exit code 1' }));
    const data = Buffer.from(lines.map((item) => JSON.stringify(item)).join('\n') + '\n').toString('base64');
    remote(`import base64,pathlib,re,sys\nname=sys.argv[1]\nassert re.fullmatch(r'hq-[a-f0-9]{12}',name)\nroot=pathlib.Path.home()/'.cache'/'agent-hq'/name\nroot.mkdir(parents=True,exist_ok=True)\n(root/'events.jsonl').write_bytes(base64.b64decode('${data}'))\n`, faulty.name);
    remote(`import base64,pathlib,re,sys\nname=sys.argv[1]\nassert re.fullmatch(r'hq-[a-f0-9]{12}',name)\nroot=pathlib.Path.home()/'.cache'/'agent-hq'/name\nroot.mkdir(parents=True,exist_ok=True)\n(root/'events.jsonl').write_bytes(base64.b64decode('${data}'))\n`, manual.name);
    const observed = await service.inventory();
    assert.equal(observed.faults.length, 2);
    for (let attempt = 0; attempt < 100 && ['pending', 'attempted'].includes(service.loopBreaker.faults().find((item) => item.sessionKey.endsWith(faulty.name))?.status); attempt++) await wait(100);
    const fault = service.loopBreaker.faults().find((item) => item.sessionKey.endsWith(faulty.name));
    assert.equal(fault.status, 'interrupted', fault.result);
    assert.equal(fault.result, 'Remote tmux accepted one scoped Ctrl+C');
    const next = await service.inventory();
    assert.equal(next.sessions.find((item) => item.id === healthy.name)?.state, 'live', 'Neighbor must remain live');
    assert.equal(service.loopBreaker.faults().length, 2, 'Replayed inventory must not re-interrupt');
    const denied = await service.interruptFaults({ id: 'phone' });
    assert.equal(denied.length, 1, 'All-stop targets only eligible faults');
    assert.match(denied[0].result, /Open the session and take control/);
    const accepted = await service.interruptFaults({ id: 'desktop' });
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].status, 'interrupted');
    assert.deepEqual(await service.interruptFaults({ id: 'desktop' }), [], 'Already interrupted faults are not all-stop targets');
    service.resetFault(fault.sessionKey);
    service.resetFault(accepted[0].sessionKey);
    assert.equal(service.loopBreaker.faults().length, 0);
    console.log('PASS live SSH scoped automatic/manual Ctrl+C, mobile ownership rejection, neighbor isolation, and replay deduplication');
  } finally {
    for (const item of [faulty, manual, healthy]) if (service && item) { try { await service.action({ id: 'desktop' }, 'stop', item.name, 'default'); } catch (_) { /* Fixture exited. */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
