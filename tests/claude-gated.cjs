// Exercise the installed Claude CLI's permission boundary with a local model
// fixture. No account, model call, repository, or user provider config is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentc2-claude-gated-'));
const witness = path.join(directory, 'witness.txt');
const command = 'printf fixture > witness.txt';
const hookPath = path.join(directory, 'permission-hook.py');
let requests = 0;

function event(name, value) {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

function modelResponse(model, tool) {
  const block = tool ? { type: 'tool_use', id: 'toolu_agentc2fixture', name: 'Bash', input: {} } : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Create disposable witness' }) } : { type: 'text_delta', text: 'finished' };
  return [
    event('message_start', { type: 'message_start', message: { id: `msg_agentc2fixture${requests}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: directory, env, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        assert.equal(payload.stream, true);
        assert.ok(payload.tools.some((tool) => tool.name === 'Bash'));
        const output = modelResponse(payload.model, requests++ === 0);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(output) });
        res.end(output);
      } catch { res.writeHead(400); res.end(); }
    });
  });
  try {
    const installed = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(installed.status, 0, 'Install Claude Code CLI before running this provider test');
    const python = `import json\nfrom pathlib import Path\nr=Path(${JSON.stringify(path.join(root, 'electron'))})\ns={'__name__':'claude_gate_fixture'}\nexec((r/'provider_telemetry.py').read_text()+'\\n'+(r/'remote.py').read_text(),s)\nprint(json.dumps({'command':s['agent_command']('claude',roe_profile='gated'),'hookArgs':s['hook_arguments']('claude','hq-123456abcdef',{'roeProfile':'gated'})}))`;
    const generated = spawnSync('python3', ['-c', python], { encoding: 'utf8', timeout: 5000 });
    assert.equal(generated.status, 0, generated.stderr);
    const launch = JSON.parse(generated.stdout);
    assert.deepEqual(launch.command, ['claude', '--permission-mode', 'default']);
    assert.equal(launch.hookArgs[0], '--settings');
    const settings = JSON.parse(launch.hookArgs[1]);
    assert.ok(settings.permissions.ask.includes('Bash'));
    fs.writeFileSync(hookPath, `import json\nimport sys\nfrom pathlib import Path\npayload = json.load(sys.stdin)\nPath(__file__).with_name('permission-request.json').write_text(json.dumps({'event': payload.get('hook_event_name'), 'tool': payload.get('tool_name'), 'command': payload.get('tool_input', {}).get('command')}))\ndecision = Path(__file__).with_name('decision.txt').read_text().strip()\nprint(json.dumps({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {'behavior': decision, 'message': 'Disposable fixture decision'}}}))\n`);
    settings.hooks = { PermissionRequest: [{ hooks: [{ type: 'command', command: `python3 '${hookPath.replace(/'/g, "'\\''")}'`, timeout: 5 }] }] };
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, ANTHROPIC_API_KEY: 'agentc2-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CONFIG_DIR: path.join(directory, 'config'), DISABLE_TELEMETRY: '1' };
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    const args = [...launch.command, '--settings', JSON.stringify(settings), '--print', '--no-session-persistence', '--output-format', 'json', 'Create witness.txt using Bash'];
    fs.writeFileSync(path.join(directory, 'decision.txt'), 'deny');
    const result = await runCli(args, env);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(requests >= 2, 'Claude did not return a tool result to the local model fixture');
    assert.ok(output.permission_denials.some((denial) => denial.tool_name === 'Bash' && denial.tool_input?.command === command));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'permission-request.json'), 'utf8')), { event: 'PermissionRequest', tool: 'Bash', command });
    assert.equal(fs.existsSync(witness), false, 'The denied command must not run');
    requests = 0;
    fs.writeFileSync(path.join(directory, 'decision.txt'), 'allow');
    const allowed = await runCli(args, env);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.ok(requests >= 2, 'Claude did not return the allowed tool result to the local model fixture');
    assert.deepEqual(JSON.parse(allowed.stdout).permission_denials, []);
    assert.equal(fs.readFileSync(witness, 'utf8'), 'fixture');
    console.log(`PASS installed ${installed.stdout.trim()} gated Bash request reached PermissionRequest hook; deny blocked the file and allow executed it`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
