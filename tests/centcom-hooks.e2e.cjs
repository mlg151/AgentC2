const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { centcomService } = require('./fixtures/centcom-service.cjs');
const { poll } = require('./fixtures/isolated-chat-ssh.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-c2-hooks-'));
let h;
const children = [];
(async () => {
  try {
    h = await centcomService(directory);
    const { service, action, query } = h;
    const preset = { ...service.store.data.settings.presets.find((item) => item.provider === 'claude'), id: 'hook-fixture', name: 'Hook protocol fixture', hostId: 'default', command: 'bash', args: "-c 'sleep 900'", attentionHooks: false, fullPermissions: false,
      loopBreaker: { enabled: false, autoInterrupt: false, threshold: 4, windowMinutes: 10, cooldownMinutes: 15 } };
    await action('configuration.save', { settings: { presets: [...service.store.data.settings.presets, preset] } });
    const created = (await action('unit.create', { hostId: 'default', provider: 'claude', transport: 'terminal', presetId: preset.id, roeProfile: 'provider-default', title: 'Reviewed hook fixture', cwd: h.home })).result;
    const secondDirectory = path.join(h.home, 'second'); fs.mkdirSync(secondDirectory);
    const faulty = (await action('unit.create', { hostId: 'default', provider: 'claude', transport: 'terminal', presetId: preset.id, roeProfile: 'provider-default', title: 'Fault interrupt fixture', cwd: secondDirectory })).result;
    await action('configuration.save', { settings: { presets: service.store.data.settings.presets.map((item) => item.id === preset.id ? { ...item, attentionHooks: true, loopBreaker: { ...item.loopBreaker, enabled: true } } : item) } });
    const sessionKey = `default/tmux:${created.name}`;
    const cache = path.join(h.home, '.cache/agent-hq', created.name); fs.mkdirSync(cache, { recursive: true });
    const hook = path.join(cache, 'hook.py'); fs.copyFileSync(path.join(__dirname, '../electron/session-hook.py'), hook);
    function event(payload) { return execFileSync('python3', [hook, 'claude', 'hook'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000 }); }
    for (let index = 0; index < 4; index++) event({ hook_event_name: 'PostToolUseFailure', session_id: 'fixture', prompt_id: 'turn', tool_use_id: `tool-${index}`, tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1\nFixture failure' });
    let inventory = await service.inventory();
    assert.equal(inventory.faults.find((item) => item.sessionKey === sessionKey).status, 'review');
    const attention = inventory.attention.find((item) => item.sessionKey === sessionKey && !item.acknowledged); assert.ok(attention);
    await action('attention.acknowledge', { sessionKey, id: attention.id });
    assert.equal((await service.inventory()).attention.find((item) => item.id === attention.id).acknowledged, true);
    await action('fault.reset', { sessionKey });
    assert.ok(!service.loopBreaker.faults().some((item) => item.sessionKey === sessionKey));

    const child = spawn('python3', [hook, 'claude', 'hook'], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let output = '', error = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    const done = new Promise((resolve, reject) => child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error || `Hook exited ${code}`))));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'fixture', prompt_id: 'reviewed-request', tool_name: 'Bash', tool_input: { command: 'echo REVIEWED_HOOK' } }));
    await poll(async () => (await service.flashQueue()).some((item) => item.name === created.name && item.state === 'pending'), 'Hook request did not arrive');
    const requests = await query('flash.list');
    const request = requests.find((item) => item.name === created.name && item.state === 'pending'); assert.ok(request);
    await action('flash.decide', { sessionKey, id: request.id, decision: 'deny' });
    assert.equal(JSON.parse(await done).hookSpecificOutput.decision.behavior, 'deny');
    assert.equal((await service.flashQueue()).find((item) => item.id === request.id).state, 'resolved');

    // A distinct unit has its own fresh breaker state and interrupt target.
    const secondCache = path.join(h.home, '.cache/agent-hq', faulty.name); fs.mkdirSync(secondCache, { recursive: true });
    const secondHook = path.join(secondCache, 'hook.py'); fs.copyFileSync(hook, secondHook);
    for (let index = 0; index < 4; index++) execFileSync('python3', [secondHook, 'claude', 'hook'], { input: JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: 'second', prompt_id: 'turn', tool_use_id: `tool-${index}`, tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' }), timeout: 10000 });
    inventory = await service.inventory();
    const secondKey = `default/tmux:${faulty.name}`;
    assert.equal(inventory.faults.find((item) => item.sessionKey === secondKey).status, 'review');
    const interrupted = await action('fault.interrupt', { sessionKey: secondKey });
    assert.equal(interrupted.result.status, 'interrupted');
    assert.equal((await service.inventory()).sessions.find((item) => item.key === sessionKey).state, 'live', 'Unrelated managed unit must remain live');
    h.assertCoverage('centcom-hooks.e2e');
    console.log('PASS actual CENTCOM attention, fault reset/interrupt, Flash Traffic list/deny, and terminal control adapters against isolated native hooks');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    if (h) {
      const artifacts = process.env.AGENTC2_SUITE_ARTIFACTS || path.join(os.tmpdir(), 'agentc2-centcom-hook-evidence'); fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'operations.json'), JSON.stringify([...h.covered].sort(), null, 2));
      for (const file of ['sshd.log', 'home/requests.jsonl', 'home/centcom-prompts.jsonl', 'desktop/centcom/centcom.json']) if (fs.existsSync(path.join(directory, file))) fs.copyFileSync(path.join(directory, file), path.join(artifacts, path.basename(file)));
    }
    h?.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
