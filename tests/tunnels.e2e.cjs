const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Tunnels } = require('../electron/tunnels.cjs');
const { sshBinary } = require('../electron/platform.cjs');

const target = process.env.AGENTC2_HOST;
if (!target) throw new Error('Set AGENTC2_HOST to a disposable SSH test host');
const binary = sshBinary();
const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', '22'];
function remote(source) {
  const encoded = Buffer.from(source).toString('base64');
  const invocation = `'exec(__import__("base64").b64decode("${encoded}"))'`;
  const result = spawnSync(binary, [...args, target, 'python3', '-c', invocation], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'SSH fixture failed');
  return JSON.parse(result.stdout);
}

(async () => {
  const fixture = remote(`import json,subprocess,socket,sys,tempfile
from pathlib import Path
root=Path(tempfile.mkdtemp(prefix='agentc2-tunnel-'))
(root/'index.html').write_text('AgentC2 tunnel fixture')
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
child=subprocess.Popen([sys.executable,'-m','http.server',str(port),'--bind','127.0.0.1'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
sock=socket.socket();sock.bind(('127.0.0.1',0));closed=sock.getsockname()[1];sock.close()
print(json.dumps({'port':port,'closed':closed,'pid':child.pid,'root':str(root)}))`);
  const updates = [];
  let launchAttempts = 0;
  const tunnels = new Tunnels({ binary, argsForHost: () => args, onUpdate: (key, urls) => updates.push({ key, urls }), spawnProcess: (command, invocation, options) => {
    launchAttempts++;
    assert.ok(invocation[invocation.indexOf('-L') + 1].startsWith('127.0.0.1:'));
    if (launchAttempts > 1) return spawn(command, invocation, options);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => { child.stderr.emit('data', Buffer.from('bind: Address already in use')); child.emit('exit', 255); });
    return child;
  } });
  const host = { id: 'fixture', target, enabled: true, autoForward: false };
  try {
    const url = `http://localhost:${fixture.port}/index.html?token=fixture`;
    tunnels.feed(host, 'fixture/tmux:one', `Ready at ${url}\n`);
    assert.equal(tunnels.list('fixture/tmux:one')[0].status, 'available');
    const first = await tunnels.open(host, 'fixture/tmux:one', url);
    assert.ok(launchAttempts >= 2, 'Occupied local port was not retried');
    assert.equal(new URL(first).pathname, '/index.html');
    assert.equal(new URL(first).search, '?token=fixture');
    assert.equal(await (await fetch(first)).text(), 'AgentC2 tunnel fixture');
    const second = await tunnels.open(host, 'fixture/tmux:two', url);
    assert.equal(first, second, 'Two units must share one host/port tunnel');
    assert.equal(tunnels.records.size, 1);
    const oldChild = [...tunnels.records.values()][0].child;
    oldChild.kill();
    let recovered = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const record = [...tunnels.records.values()][0];
      if (record?.status === 'ready' && record.child !== oldChild) { recovered = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(recovered, 'SSH tunnel did not reconnect after transport loss');
    const recoveredUrl = tunnels.list('fixture/tmux:two').find((item) => item.url === url).localUrl;
    assert.equal(await (await fetch(recoveredUrl)).text(), 'AgentC2 tunnel fixture');
    tunnels.release('fixture/tmux:one');
    assert.equal(await (await fetch(recoveredUrl)).text(), 'AgentC2 tunnel fixture');
    tunnels.release('fixture/tmux:two');
    assert.equal(tunnels.records.size, 0);
    await assert.rejects(() => tunnels.open(host, 'fixture/tmux:failed', `http://localhost:${fixture.closed}/`), /unavailable|disconnected|failed/i);
    assert.equal(tunnels.list('fixture/tmux:one').length, 0);
    assert.ok(updates.some((update) => update.urls.some((item) => item.status === 'ready')));
    console.log('PASS verified SSH loopback forward, URL path/query, shared references, transport recovery, unavailable server, and teardown');
  } finally {
    tunnels.closeAll();
    remote(`import json,os,shutil,signal
from pathlib import Path
pid=${fixture.pid}; root=Path(${JSON.stringify(fixture.root)})
try: os.killpg(pid,signal.SIGTERM)
except ProcessLookupError: pass
if root.name.startswith('agentc2-tunnel-'): shutil.rmtree(root)
print(json.dumps({'ok':True}))`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
